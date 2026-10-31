"""Recognize a small ordinary-CadQuery grammar and bind edits to exact source spans.

This module never executes submitted code. Unsupported syntax invalidates the whole
editable plan; it is not guessed or silently dropped from the feature history.
"""
import ast
from collections import Counter
from copy import deepcopy
import hashlib
import math

SCHEMA = "steve.features/0.1"
TOLERANCE = 1e-6
MAX_DIMENSION = 10_000


class FeatureError(ValueError):
    def __init__(self, code, message, node=None):
        super().__init__(message)
        self.code, self.node = code, node

    def diagnostic(self):
        return {"code": self.code, "message": str(self), "source": location(self.node)}


def location(node):
    if node is None or not hasattr(node, "lineno"):
        return None
    return {"line": node.lineno, "column_utf8": node.col_offset,
            "end_line": node.end_lineno, "end_column_utf8": node.end_col_offset}


def source_hash(source):
    return hashlib.sha256(source.encode()).hexdigest()


class Plan:
    def __init__(self, source):
        self.source = source
        self.calls = []
        self.features = []
        self.diagnostics = []
        self.status = "supported"
        self.numbers, self.geometry = {}, {}
        self.module_alias = self.class_alias = None
        self.tree = None
        self.points = None
        self.width = self.height = self.thickness = self.diameter = None
        self.counts = Counter()

    def public(self):
        design = self.design_parameters() if self.status == "supported" else []
        return {"schema_version": SCHEMA, "source_sha256": source_hash(self.source),
                "status": self.status, "execution_verified": False,
                "editable": self.status == "supported" and (any(p["editable"] for f in self.features for p in f["parameters"].values()) or bool(design)),
                "features": deepcopy(self.features) if self.status == "supported" else [],
                "design_parameters": design,
                "diagnostics": self.diagnostics,
                "identity_scope": "IDs survive supported parameter edits; use document revision for every edit."}

    def design_parameters(self):
        """Top-level numeric parameters. Editing one intentionally updates every consumer."""
        uses = {}
        for feature in self.features:
            for parameter in feature["parameters"].values():
                if parameter["binding"]["kind"] == "parameter":
                    uses.setdefault(parameter["binding"]["name"], {})[feature["id"]] = None
        return [{"name": name, "value": value, "source": location(node), "used_by": list(uses.get(name, {})),
                 "references": self.read_counts[name], "editable": True,
                 "limits": {"exclusive_min": TOLERANCE, "max": MAX_DIMENSION}}
                for name, (value, node) in self.numbers.items()]

    def fail(self, code, message, node=None):
        raise FeatureError(code, message, node)

    def value(self, node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float, str, bool, type(None)):
            value = node.value
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)) and isinstance(node.operand, ast.Constant) and type(node.operand.value) in (int, float):
            value = node.operand.value * (-1 if isinstance(node.op, ast.USub) else 1)
        elif isinstance(node, ast.Name) and node.id in self.numbers:
            value = self.numbers[node.id][0]
        elif isinstance(node, (ast.Tuple, ast.List)):
            return [self.value(item) for item in node.elts]
        else:
            self.fail("unsupported_expression", "Use a numeric literal or a single top-level numeric parameter; formulas and dynamic expressions are not editable in this prototype.", node)
        if type(value) in (int, float) and (not math.isfinite(value) or abs(value) > MAX_DIMENSION):
            self.fail("invalid_dimension", f"Numeric values must be finite and within ±{MAX_DIMENSION} mm.", node)
        return value

    def bind(self, node, names, required=(), defaults=None):
        if len(node.args) > len(names) or any(isinstance(arg, ast.Starred) for arg in node.args):
            self.fail("unsupported_arguments", "Expanded or extra positional arguments are not supported.", node)
        arguments = dict(zip(names, node.args))
        for keyword in node.keywords:
            if keyword.arg not in names or keyword.arg in arguments:
                self.fail("unsupported_arguments", "Unknown, expanded, or duplicate keyword arguments.", keyword)
            arguments[keyword.arg] = keyword.value
        for name in required:
            if name not in arguments:
                self.fail("missing_argument", f"Missing required argument: {name}.", node)
        values = {name: self.value(value) for name, value in arguments.items()}
        for name, expected in (defaults or {}).items():
            same_type = name not in values or type(values[name]) is type(expected) or (type(expected) in (int, float) and type(values[name]) in (int, float))
            if name in values and (not same_type or values[name] != expected):
                self.fail("unsupported_option", f"This prototype requires {name}={expected!r}.", arguments[name])
        return arguments, values

    def parameter(self, node, label):
        value = self.value(node)
        if type(value) not in (int, float) or value <= TOLERANCE:
            self.fail("invalid_dimension", f"{label} must be greater than {TOLERANCE} mm.", node)
        if isinstance(node, ast.Name):
            binding_node = self.numbers[node.id][1]
            binding = {"kind": "parameter", "name": node.id, "source": location(binding_node)}
            editable = self.read_counts[node.id] == 1
            reason = None if editable else "This parameter has multiple uses; a feature-local edit would change other inputs. Edit the source explicitly."
        else:
            binding_node = node
            binding = {"kind": "literal", "source": location(node)}
            editable, reason = True, None
        return {"value": value, "unit": "mm", "editable": editable, "reason": reason,
                "binding": binding, "expression_source": location(node),
                "limits": {"exclusive_min": TOLERANCE, "max": MAX_DIMENSION}}

    def feature(self, node, operation, label, category, stage, parent=None, parameters=None, reference=None):
        self.counts[operation] += 1
        feature_id = f"{operation}-{self.counts[operation]}"
        feature = {"id": feature_id, "operation": operation, "label": label, "category": category,
                   "depends_on": [parent["id"]] if parent else [], "source": location(node),
                   "parameters": parameters or {}, "reference": reference,
                   "executed": False}
        self.features.append(feature)
        call = {"id": feature_id, "node": node, "stage": stage, "method": "Workplane" if parent is None else node.func.attr}
        self.calls.append(call)
        return call

    def geom(self, node):
        if isinstance(node, ast.Name) and node.id in self.geometry:
            return self.geometry[node.id]
        if not isinstance(node, ast.Call):
            self.fail("unsupported_geometry", "Geometry must use the supported CadQuery Workplane chain.", node)
        function = node.func
        constructor = (isinstance(function, ast.Attribute) and isinstance(function.value, ast.Name)
                       and function.value.id == self.module_alias and function.attr == "Workplane") or (
                       isinstance(function, ast.Name) and function.id == self.class_alias)
        if constructor:
            if self.calls:
                self.fail("unsupported_branch", "Multiple modeling roots and boolean branches are outside this prototype.", node)
            args, values = self.bind(node, ["inPlane"], defaults={"inPlane": "XY"})
            return self.feature(node, "plane", "XY plane", "reference", "plane", reference={"plane": "XY"})
        if not isinstance(function, ast.Attribute):
            self.fail("unsupported_call", "Only supported CadQuery methods can create geometry.", node)
        parent = self.geom(function.value)
        if parent is not self.calls[-1]:
            self.fail("unsupported_branch", "Reusing an earlier modeling state creates a branch; it is not editable in this prototype.", node)
        method, stage = function.attr, parent["stage"]
        if method == "rect" and stage == "plane":
            args, values = self.bind(node, ["xLen", "yLen", "centered", "forConstruction"], ("xLen", "yLen"), {"centered": True, "forConstruction": False})
            parameters = {"width": self.parameter(args["xLen"], "Width"), "height": self.parameter(args["yLen"], "Height")}
            self.width, self.height = values["xLen"], values["yLen"]
            return self.feature(node, "rectangle", "Rectangular sketch", "sketch", "profile", parent, parameters)
        if method == "extrude" and stage == "profile":
            args, values = self.bind(node, ["until", "combine", "clean", "both", "taper"], ("until",), {"combine": True, "clean": True, "both": False})
            if values.get("taper") is not None and not (type(values["taper"]) in (int, float) and values["taper"] == 0):
                self.fail("unsupported_option", "Tapered extrusions are outside this prototype.", node)
            parameters = {"thickness": self.parameter(args["until"], "Thickness")}
            self.thickness = values["until"]
            return self.feature(node, "extrusion", "Extrusion", "solid", "solid", parent, parameters)
        if method == "faces" and stage == "solid" and self.diameter is None:
            args, values = self.bind(node, ["selector"], ("selector",))
            if values["selector"] != ">Z":
                self.fail("unresolved_reference", "Only the unique top face selector '>Z' is supported; other face references are not inferred.", node)
            return self.feature(node, "face", "Top face", "reference", "face", parent, reference={"selector": ">Z", "expected_count": 1})
        if method == "workplane" and stage == "face":
            self.bind(node, ["offset", "invert", "centerOption", "origin"], defaults={"offset": 0, "invert": False, "centerOption": "ProjectedOrigin", "origin": None})
            return self.feature(node, "workplane", "Hole workplane", "reference", "face_plane", parent)
        if method == "pushPoints" and stage == "face_plane":
            args, values = self.bind(node, ["pntList"], ("pntList",))
            points = values["pntList"]
            if not isinstance(points, list) or not 1 <= len(points) <= 16 or any(not isinstance(p, list) or len(p) != 2 or any(type(v) not in (int, float) for v in p) for p in points):
                self.fail("invalid_points", "Use 1–16 explicit XY point pairs for hole locations.", node)
            self.points = points
            return self.feature(node, "points", "Hole locations", "reference", "points", parent, reference={"points_mm": points, "editable": False})
        if method == "hole" and stage in ("face_plane", "points"):
            args, values = self.bind(node, ["diameter", "depth", "clean"], ("diameter",), {"depth": None, "clean": True})
            parameters = {"diameter": self.parameter(args["diameter"], "Hole diameter")}
            self.diameter = values["diameter"]
            self.points = self.points or [[0, 0]]
            return self.feature(node, "holes", "Through-holes", "solid", "solid", parent, parameters,
                                {"count": len(self.points), "points_mm": self.points, "extent": "through_all"})
        self.fail("unsupported_operation", f"Operation '{method}' in state '{stage}' is outside the rectangular-sketch/extrusion/through-hole scope.", node)

    def validate_geometry_inputs(self):
        if self.diameter is None:
            return
        radius = self.diameter / 2
        for x, y in self.points:
            if abs(x) + radius >= self.width / 2 - TOLERANCE or abs(y) + radius >= self.height / 2 - TOLERANCE:
                self.fail("topology_change", "A hole would touch or cross the plate boundary. The edit was rejected; move the hole or change the source explicitly.")
        for i, point in enumerate(self.points):
            for other in self.points[:i]:
                if math.dist(point, other) <= self.diameter + TOLERANCE:
                    self.fail("topology_change", "Holes would overlap or touch. This would change the supported topology.")

    def parse(self):
        self.tree = ast.parse(self.source)
        nodes = list(ast.walk(self.tree))
        if len(nodes) > 5000:
            self.fail("unsupported_complexity", "This prototype accepts at most 5,000 syntax nodes.")
        self.read_counts = Counter(n.id for n in nodes if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load))
        for statement in self.tree.body:
            if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, str):
                continue
            if isinstance(statement, ast.Import) and len(statement.names) == 1 and statement.names[0].name == "cadquery" and not self.module_alias and not self.class_alias and not self.numbers and not self.calls:
                self.module_alias = statement.names[0].asname or "cadquery"
                if self.module_alias.startswith("__ft_"):
                    self.fail("ambiguous_binding", "Import aliases beginning __ft_ are reserved for tracing.", statement)
                continue
            if isinstance(statement, ast.ImportFrom) and statement.module == "cadquery" and not statement.level and len(statement.names) == 1 and statement.names[0].name == "Workplane" and not self.module_alias and not self.class_alias and not self.numbers and not self.calls:
                self.class_alias = statement.names[0].asname or "Workplane"
                if self.class_alias.startswith("__ft_"):
                    self.fail("ambiguous_binding", "Import aliases beginning __ft_ are reserved for tracing.", statement)
                continue
            if not isinstance(statement, ast.Assign) or len(statement.targets) != 1 or not isinstance(statement.targets[0], ast.Name):
                self.fail("unsupported_statement", f"{type(statement).__name__} is outside the prototype grammar. Loops, branches, functions, and mutations are not inferred.", statement)
            name, value = statement.targets[0].id, statement.value
            if name in (self.module_alias, self.class_alias) or name.startswith("__ft_"):
                self.fail("ambiguous_binding", "Reserved/imported names cannot be rebound.", statement)
            if isinstance(value, (ast.Constant, ast.UnaryOp)) and name != "result":
                if name in self.numbers or name in self.geometry:
                    self.fail("ambiguous_binding", f"Parameter '{name}' is assigned more than once.", statement)
                number = self.value(value)
                if type(number) not in (int, float):
                    self.fail("unsupported_parameter", "Top-level parameters must be numeric literals.", statement)
                self.numbers[name] = (number, value)
            else:
                if name in self.numbers:
                    self.fail("ambiguous_binding", "Numeric parameters cannot be rebound as geometry.", statement)
                self.geometry[name] = self.geom(value)
        result = self.geometry.get("result")
        if not result or result is not self.calls[-1] or result["stage"] != "solid":
            self.fail("incomplete_result", "Assign the completed plate solid to result; every captured operation must contribute to it.")
        self.validate_geometry_inputs()
        return self


def analyze(source):
    plan = Plan(source)
    try:
        plan.parse()
    except SyntaxError as exc:
        plan.status = "invalid"
        plan.diagnostics = [{"code": "syntax_error", "message": str(exc), "source": {"line": exc.lineno, "column_utf8": None}}]
    except (RecursionError, ValueError, OverflowError) as exc:
        if isinstance(exc, FeatureError):
            plan.status = "invalid" if exc.code in {"invalid_dimension", "invalid_points", "topology_change", "incomplete_result", "missing_argument"} else "unsupported"
            plan.diagnostics = [exc.diagnostic()]
        else:
            plan.status = "invalid"
            plan.diagnostics = [{"code": "invalid_source", "message": "Source could not be analyzed within the prototype limits.", "source": None}]
    return plan


def edit_source(source, changes):
    plan = analyze(source)
    if plan.status != "supported":
        raise FeatureError("unsupported_model", plan.diagnostics[0]["message"])
    features = {feature["id"]: feature for feature in plan.features}
    encoded = source.encode()
    lines = encoded.splitlines(keepends=True)
    offsets, total = [], 0
    for line in lines:
        offsets.append(total)
        total += len(line)
    replacements, used = [], set()
    for change in changes:
        if change.get("design_parameter") is not None:
            # A design parameter edit deliberately changes every consumer; the
            # candidate is re-analyzed and regenerated like any other edit.
            number = plan.numbers.get(change["design_parameter"])
            if not number:
                raise FeatureError("unknown_parameter", "The requested design parameter does not exist in this revision.")
            span = location(number[1])
        else:
            feature = features.get(change.get("feature_id"))
            parameter = feature and feature["parameters"].get(change.get("parameter"))
            if not parameter:
                raise FeatureError("unknown_parameter", "The requested feature or parameter does not exist in this revision.")
            if not parameter["editable"]:
                raise FeatureError("ambiguous_binding", parameter["reason"])
            span = parameter["binding"]["source"]
        value = change["value"]
        if type(value) not in (int, float) or not math.isfinite(value) or not TOLERANCE < value <= MAX_DIMENSION:
            raise FeatureError("invalid_dimension", f"Edited dimensions must be finite, greater than {TOLERANCE}, and at most {MAX_DIMENSION} mm.")
        start = offsets[span["line"] - 1] + span["column_utf8"]
        end = offsets[span["end_line"] - 1] + span["end_column_utf8"]
        if (start, end) in used:
            raise FeatureError("duplicate_edit", "A parameter can only be edited once per request.")
        used.add((start, end))
        replacements.append((start, end, repr(value).encode()))
    for start, end, replacement in sorted(replacements, reverse=True):
        encoded = encoded[:start] + replacement + encoded[end:]
    candidate = encoded.decode()
    changed = analyze(candidate)
    if changed.status != "supported":
        diagnostic = changed.diagnostics[0]
        raise FeatureError(diagnostic["code"], diagnostic["message"])
    if [f["id"] for f in changed.features] != [f["id"] for f in plan.features]:
        raise FeatureError("identity_change", "A parameter edit unexpectedly changed the feature structure.")
    return candidate


def instrument(plan):
    """Wrap validated call sites only in the executed copy; saved code is untouched."""
    ids = {id(call["node"]): call["id"] for call in plan.calls}
    class Capture(ast.NodeTransformer):
        def visit_Call(self, node):
            feature_id = ids[id(node)]
            node = self.generic_visit(node)
            return ast.copy_location(ast.Call(func=ast.Name(id="__ft_capture", ctx=ast.Load()),
                args=[ast.Constant(feature_id), node.func, *node.args], keywords=node.keywords), node)
    tree = Capture().visit(plan.tree)
    tree.body.insert(0, ast.ImportFrom(module="app.features.trace", names=[ast.alias(name="capture", asname="__ft_capture")], level=0))
    ast.fix_missing_locations(tree)
    return ast.unparse(tree)
