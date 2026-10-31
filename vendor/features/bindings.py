"""Source bindings for captured (steve.features/0.2) arguments, and verified source edits.

Pure syntax analysis: this module never executes submitted code and does not import
CadQuery. The sandbox recorder uses it to map executed arguments to exact source spans;
the API uses it to rewrite those spans. Only numeric literals and numeric top-level
variables assigned once are bound. Everything else stays read-only, with a reason.
"""
import ast
from collections import Counter
import inspect
from itertools import zip_longest
import math

from .model import FeatureError, MAX_DIMENSION, location

NUMBERS = (int, float)
# Name lookups these can perform are invisible to reference counting.
DYNAMIC = {"globals", "locals", "vars", "eval", "exec", "compile", "__import__"}
POSITIVE = {"exclusive_min": 0, "max": MAX_DIMENSION}
COUNT = {"min": 1, "max": 1000, "integer": True}
LIMITS = {(operation, name): POSITIVE for operation, names in {
    "fillet": "radius", "chamfer": "length length2", "hole": "diameter depth",
    "cboreHole": "diameter cboreDiameter cboreDepth depth", "cskHole": "diameter cskDiameter depth",
    "circle": "radius", "rect": "xLen yLen", "box": "length width height", "sphere": "radius",
    "cylinder": "height radius", "polygon": "diameter", "ellipse": "x_radius y_radius", "slot2D": "length diameter",
}.items() for name in names.split()}
LIMITS.update({("revolve", "angleDegrees"): {"exclusive_min": 0, "max": 360},
               ("cskHole", "cskAngle"): {"exclusive_min": 0, "exclusive_max": 180},
               ("polygon", "nSides"): {"min": 3, "max": 1000, "integer": True},
               ("rarray", "xCount"): COUNT, ("rarray", "yCount"): COUNT, ("polarArray", "count"): COUNT})
# Direction is meaningful: these keep the sign of the value they were captured with.
SIGNED = {("extrude", "until"), ("cutBlind", "until"), ("twistExtrude", "distance"), ("shell", "thickness")}


def is_number(value):
    return type(value) in NUMBERS


def numeric(value, depth=0):
    """A number, or a small (nested) list/tuple of numbers such as points."""
    if is_number(value):
        return True
    return depth < 2 and isinstance(value, (list, tuple)) and 0 < len(value) <= 64 and all(numeric(v, depth + 1) for v in value)


def same(a, b):
    return is_number(a) and is_number(b) and math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12)


def numeric_literal(node):
    """Value of an int/float literal, optionally signed (-4, +6.0); None for anything else."""
    sign = 1
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        sign, node = (-1 if isinstance(node.op, ast.USub) else 1), node.operand
    if isinstance(node, ast.Constant) and is_number(node.value) and math.isfinite(node.value):
        return sign * node.value
    return None


def limits_for(operation, name, value):
    if (operation, name) in SIGNED and is_number(value) and value:
        return dict(POSITIVE) if value > 0 else {"min": -MAX_DIMENSION, "exclusive_max": 0}
    rule = LIMITS.get((operation, name))
    return dict(rule) if rule else None


def merge_limits(current, extra):
    """Strictest combination, for a design parameter that feeds several bound arguments."""
    merged = dict(current or extra)
    for key, pick in (("exclusive_min", max), ("min", max), ("exclusive_max", min), ("max", min)):
        if key in extra:
            merged[key] = pick(merged.get(key, extra[key]), extra[key])
    if extra.get("integer"):
        merged["integer"] = True
    return merged


def code_signature(code):
    """inspect.Signature of the function executing ``code`` (the frame's own code object)."""
    Parameter, names = inspect.Parameter, code.co_varnames
    positional, keyword = code.co_argcount, code.co_kwonlyargcount
    parameters = [Parameter(name, Parameter.POSITIONAL_ONLY if i < code.co_posonlyargcount else Parameter.POSITIONAL_OR_KEYWORD)
                  for i, name in enumerate(names[:positional])]
    index = positional + keyword
    if code.co_flags & inspect.CO_VARARGS:
        parameters.append(Parameter(names[index], Parameter.VAR_POSITIONAL))
        index += 1
    parameters += [Parameter(name, Parameter.KEYWORD_ONLY) for name in names[positional:positional + keyword]]
    if code.co_flags & inspect.CO_VARKEYWORDS:
        parameters.append(Parameter(names[index], Parameter.VAR_KEYWORD))
    return inspect.Signature(parameters)


def assignment(statement):
    if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
        return statement.targets[0].id, statement.value
    if isinstance(statement, ast.AnnAssign) and statement.simple and isinstance(statement.target, ast.Name) and statement.value:
        return statement.target.id, statement.value
    return None, None


class SourceIndex:
    """Design parameters of one source and classification of its call arguments."""

    def __init__(self, source, tree=None):
        self.source = source
        self.tree = tree or ast.parse(source)
        nodes = list(ast.walk(self.tree))
        names = [n for n in nodes if isinstance(n, ast.Name)]
        self.references = Counter(n.id for n in names if isinstance(n.ctx, ast.Load))
        # Every way Python can bind a name, in any scope. A name bound more than once
        # (loop target, function argument, reassignment, global, ...) is not a parameter.
        bindings = Counter(n.id for n in names if not isinstance(n.ctx, ast.Load))
        star = False
        for node in nodes:
            if isinstance(node, ast.arg):
                bindings[node.arg] += 1
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                bindings[node.name] += 1
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                star = star or any(alias.name == "*" for alias in node.names)
                bindings.update((alias.asname or alias.name).split(".")[0] for alias in node.names)
            elif isinstance(node, (ast.Global, ast.Nonlocal)):
                bindings.update(node.names)
            elif isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)) and node.name:
                bindings[node.name] += 1
            elif isinstance(node, ast.MatchMapping) and node.rest:
                bindings[node.rest] += 1
        self.dynamic = star or any(self.references[name] for name in DYNAMIC)
        self.parameters, self.derived = {}, {}
        for statement in self.tree.body:
            name, value = assignment(statement)
            if name is None or bindings[name] != 1 or self.dynamic:
                continue
            number = numeric_literal(value)
            if number is not None:
                self.parameters[name] = (number, value)
            else:
                self.derived[name] = (self.mentions(value), value)

    def mentions(self, node):
        """Design parameters an expression reads, directly or via a top-level variable, in source order."""
        found = {}
        loads = [n for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)]
        for name in sorted(loads, key=lambda n: (n.lineno, n.col_offset)):
            if name.id in self.parameters:
                found[name.id] = None
            elif name.id in self.derived:
                found.update(dict.fromkeys(self.derived[name.id][0]))
        return list(found)

    def arguments(self, node, signature):
        """Explicitly passed argument expressions by parameter name; None if not statically bindable."""
        if any(isinstance(arg, ast.Starred) for arg in node.args) or any(kw.arg is None for kw in node.keywords):
            return None
        receiver = object()
        first = next(iter(signature.parameters.values()), None)
        implicit = [receiver] if first is not None and first.name in {"self", "cls"} and first.kind in (
            inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD) else []
        try:
            bound = signature.bind_partial(*implicit, *node.args, **{kw.arg: kw.value for kw in node.keywords})
        except TypeError:
            return None
        return {name: value for name, value in bound.arguments.items() if value is not receiver
                and signature.parameters[name].kind not in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)}

    def text(self, node, limit=60):
        text = " ".join((ast.get_source_segment(self.source, node) or "").split())
        return text if len(text) <= limit else text[:limit - 1] + "…"

    def classify(self, node, value):
        """Binding fields for one explicitly passed numeric argument, or a read-only reason."""
        literal = numeric_literal(node)
        if literal is not None:
            if not same(literal, value):
                return {"reason": "The executed value differs from this source literal. Edit the source."}
            span = location(node)
            return {"binding": {"kind": "literal", "source": span}, "expression_source": span}
        if isinstance(node, ast.Name) and node.id in self.parameters:
            number, literal_node = self.parameters[node.id]
            if not same(number, value):
                return {"reason": f"The executed value differs from {node.id}. Edit the source."}
            return {"binding": {"kind": "parameter", "name": node.id, "source": location(literal_node)},
                    "expression_source": location(node)}
        uses = self.mentions(node)
        hint = f"Edit the design parameter{'s' if len(uses) > 1 else ''} {', '.join(uses)}." if uses else "Edit the source."
        if isinstance(node, ast.Name):
            if node.id in self.derived:
                return {"reason": f"Computed from {node.id} = {self.text(self.derived[node.id][1])}. {hint}"}
            return {"reason": f"Set by {node.id}, which is not a single top-level numeric assignment. {hint}"}
        if isinstance(node, (ast.Tuple, ast.List)):
            return {"reason": f"Lists and tuples are not graphically editable yet. {hint}"}
        return {"reason": f"Computed from an expression: {self.text(node)}. {hint}"}


def check_value(value, limits, label):
    if not is_number(value) or not math.isfinite(value) or abs(value) > MAX_DIMENSION:
        raise FeatureError("invalid_dimension", f"{label} must be a finite number within ±{MAX_DIMENSION}.")
    limits = limits or {}
    for key, valid, words in (("exclusive_min", float.__gt__, "greater than"), ("min", float.__ge__, "at least"),
                              ("exclusive_max", float.__lt__, "less than"), ("max", float.__le__, "at most")):
        if key in limits and not valid(float(value), float(limits[key])):
            raise FeatureError("invalid_dimension", f"{label} must be {words} {limits[key]:g}.")
    if limits.get("integer") and not float(value).is_integer():
        raise FeatureError("invalid_dimension", f"{label} must be a whole number.")


def replace_numbers(source, edits):
    """Rewrite numeric literals at recorded spans, bottom-up, in UTF-8 bytes; formatting elsewhere is kept."""
    encoded = source.encode()
    starts, total = [], 0
    for line in encoded.splitlines(keepends=True):
        starts.append(total)
        total += len(line)
    replacements = {}
    stale = FeatureError("binding_changed", "The source no longer matches its captured history. Regenerate before editing.")
    for span, value, recorded in edits:
        try:
            start = starts[span["line"] - 1] + span["column_utf8"]
            end = starts[span["end_line"] - 1] + span["end_column_utf8"]
            previous = numeric_literal(ast.parse(encoded[start:end].decode(), mode="eval").body)
        except (IndexError, KeyError, TypeError, ValueError, SyntaxError):
            raise stale from None
        if previous is None or not same(previous, recorded):
            raise stale
        if (start, end) in replacements:
            raise FeatureError("duplicate_edit", "A source value can only be edited once per request.")
        # Keep an integer literal an integer when the new value is integral.
        replacements[(start, end)] = (str(int(value)) if type(previous) is int and float(value).is_integer() else repr(float(value))).encode()
    for (start, end), text in sorted(replacements.items(), reverse=True):
        encoded = encoded[:start] + text + encoded[end:]
    candidate = encoded.decode()
    try:
        ast.parse(candidate)
    except SyntaxError:
        raise stale from None
    return candidate


def captured_edit(source, tree, changes):
    """Candidate source for feature/design-parameter changes, plus the values the new capture must report."""
    features = {feature["id"]: feature for feature in tree.get("features", [])}
    design = {item["name"]: item for item in tree.get("design_parameters", [])}
    edits, expected = [], []
    for change in changes:
        name = change.get("design_parameter")
        if name is not None:
            target, label = design.get(name), name
            if target is None:
                raise FeatureError("unknown_parameter", f"Design parameter {name} does not exist in this revision.")
            if not target.get("editable"):
                raise FeatureError("read_only_parameter", target.get("reason") or f"{name} is read-only. Edit the source.")
            span = target["source"]
            expected.append({"design_parameter": name, "value": change["value"]})
        else:
            feature = features.get(change.get("feature_id"))
            target = feature and feature["parameters"].get(change.get("parameter"))
            if not target:
                raise FeatureError("unknown_parameter", "The requested feature or parameter does not exist in this revision.")
            label = f"{feature['label']} {change['parameter']}"
            if not target.get("editable") or not target.get("binding"):
                raise FeatureError("ambiguous_binding" if target.get("binding") else "read_only_parameter",
                                   target.get("reason") or f"{label} is read-only. Edit the source.")
            span = target["binding"]["source"]
            expected.append({"feature_id": feature["id"], "parameter": change["parameter"], "value": change["value"]})
        check_value(change["value"], target.get("limits"), label)
        edits.append((span, change["value"], target["value"]))
    return replace_numbers(source, edits), expected


def verify_captured(before, after, expected):
    """None when the regenerated capture is exactly the requested edit; otherwise a diagnostic."""
    def failure(code, message):
        return {"code": code, "message": f"{message} The document was not changed.", "source": None}
    if not after.get("execution_verified"):
        return failure("geometry_failure", "The edited source did not reproduce a verified valid solid.")
    old = [(f["id"], f["operation"]) for f in before["features"]]
    new = [(f["id"], f["operation"]) for f in after.get("features", [])]
    if old != new:
        first = next(a or b for a, b in zip_longest(old, new) if a != b)
        return failure("topology_change", f"The edit changed which operations run ({len(old)} before, {len(new)} after; first difference at {first[0]}).")
    features = {f["id"]: f for f in after["features"]}
    for feature in before["features"]:
        if feature.get("executed") and not features[feature["id"]].get("executed"):
            return failure("geometry_failure", f"{feature['label']} no longer completes with the edited value.")
    design_before = {d["name"]: d for d in before.get("design_parameters", [])}
    design = {d["name"]: d for d in after.get("design_parameters", [])}
    if set(design) != set(design_before):
        return failure("binding_changed", "The edit changed the source's design parameters.")
    for item in expected:
        if "design_parameter" in item:
            name = item["design_parameter"]
            if design[name]["used_by"] != design_before[name]["used_by"]:
                return failure("binding_changed", f"The edit changed which features use {name}.")
            if not same(design[name]["value"], item["value"]):
                return failure("value_not_applied", f"{name} reads {design[name]['value']} instead of {item['value']}.")
            consumers = [(f, p) for f in after["features"] for p in f["parameters"].values()
                         if (p.get("binding") or {}).get("kind") == "parameter" and p["binding"].get("name") == name]
        else:
            recorded = next(f for f in before["features"] if f["id"] == item["feature_id"])["parameters"][item["parameter"]]["binding"]
            parameter = features[item["feature_id"]]["parameters"].get(item["parameter"]) or {}
            binding = parameter.get("binding") or {}
            if (binding.get("kind"), binding.get("name")) != (recorded.get("kind"), recorded.get("name")):
                return failure("binding_changed", f"{features[item['feature_id']]['label']} {item['parameter']} is no longer bound to the edited source text.")
            consumers = [(features[item["feature_id"]], parameter)]
        for feature, parameter in consumers:
            if not same(parameter.get("value"), item["value"]):
                return failure("value_not_applied", f"{feature['label']} reports {parameter.get('value')} instead of {item['value']}.")
    return None
