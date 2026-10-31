"""Reads modeling code (docs/MODELING.md section 1) into an editable document model.

Nothing is executed: parameters are evaluated with a small arithmetic evaluator and
sketch statements are replayed through the declaration-only `steve.sketch.Sketch`, so the
browser gets the same entities and constraints the runtime will solve. Spans are UTF-16
code-unit offsets so the browser can replace them in its JavaScript strings directly.
"""
from __future__ import annotations

import ast
import io
import math
import re
import sys
import tokenize
from pathlib import Path

try:
    from steve.sketch import Sketch, SketchError
except ImportError:  # Local runs: the library lives in runtime/.
    sys.path.append(str(Path(__file__).resolve().parents[2] / "runtime"))
    from steve.sketch import Sketch, SketchError

UNITS = {"mm", "cm", "m", "in", "ft", "deg", "rad", "count", "%", "kg", "g", "N", "mm2", "mm3"}
MATH = {"pi": math.pi, "tau": math.tau, "e": math.e, "sqrt": math.sqrt, "sin": math.sin, "cos": math.cos, "tan": math.tan,
        "asin": math.asin, "acos": math.acos, "atan": math.atan, "atan2": math.atan2, "radians": math.radians,
        "degrees": math.degrees, "abs": abs, "min": min, "max": max, "round": round, "floor": math.floor, "ceil": math.ceil,
        "hypot": math.hypot}
BINOPS = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b, ast.Mult: lambda a, b: a * b, ast.Div: lambda a, b: a / b,
          ast.FloorDiv: lambda a, b: a // b, ast.Mod: lambda a, b: a % b, ast.Pow: lambda a, b: a ** b}
FEATURE_KINDS = {"plane", "axis", "extrude", "revolve", "sweep", "loft", "fillet", "chamfer", "shell", "hole", "draft", "mirror",
                 "linear_pattern", "circular_pattern", "combine", "split", "move", "box", "cylinder", "sphere", "cone", "torus", "wedge",
                 "text", "thicken", "point", "add", "import_step", "decal", "point_pattern"}
FEATURE_KINDS.update({"sheet_base", "sheet_flange", "sheet_hem", "sheet_jog", "sheet_cut", "sheet_relief", "sheet_unfold", "sheet_refold"})
FEATURE_KINDS.update({"sheet_convert", "sheet_contour", "sheet_bend", "sheet_roll", "sheet_tab"})
FEATURE_KINDS.add("sheet_corner")
FEATURE_KINDS.update({"sheet_rip", "sheet_form"})
FEATURE_KINDS.update({"fill", "boundary_surface", "solidify"})  # Surface bodies (thicken is above).
FEATURE_KINDS.add("boundary_fill")


class NotSimple(Exception):
    """An expression the evaluator won't evaluate (calls, attributes, comprehensions …)."""


class _SheetSymbol:
    def __init__(self, name, kind):
        self.name,self.kind = name,kind


def evaluate(node: ast.AST, env: dict):
    """Arithmetic over numbers, parameters and math functions; lists/tuples/strings/bools/None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float, str, bool, type(None))):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in env:
            if isinstance(env[node.id],_SheetSymbol):
                raise NotSimple('sheet-metal rule object')
            return env[node.id]
        if node.id in MATH and not callable(MATH[node.id]):
            return MATH[node.id]
        raise NotSimple(f"unknown name {node.id}")
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = evaluate(node.operand, env)
        return -value if isinstance(node.op, ast.USub) else +value
    if isinstance(node, ast.BinOp) and type(node.op) in BINOPS:
        return BINOPS[type(node.op)](evaluate(node.left, env), evaluate(node.right, env))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and callable(MATH.get(node.func.id)) and not node.keywords:
        return MATH[node.func.id](*(evaluate(arg, env) for arg in node.args))
    if isinstance(node, (ast.Tuple, ast.List)):
        return [evaluate(item, env) for item in node.elts]
    # Option records such as a sheet contour's segments: [{"length": 20, "angle": 90}, ...].
    if isinstance(node, ast.Dict) and all(isinstance(key, ast.Constant) and isinstance(key.value, str) for key in node.keys):
        return {key.value: evaluate(value, env) for key, value in zip(node.keys, node.values)}
    raise NotSimple(type(node).__name__)


def _names(node: ast.AST) -> list[str]:
    return sorted({n.id for n in ast.walk(node) if isinstance(n, ast.Name)})


class Source:
    """Offsets: ast gives (line, UTF-8 byte column); the browser wants UTF-16 offsets."""

    def __init__(self, code: str):
        self.code = code
        self.lines = code.splitlines(keepends=True)
        self.starts16 = []
        total = 0
        for line in self.lines:
            self.starts16.append(total)
            total += _u16(line)
        self.starts16.append(total)

    def offset(self, line: int, col_utf8: int) -> int:
        if line - 1 >= len(self.lines):
            return self.starts16[-1]
        text = self.lines[line - 1]
        prefix = text.encode("utf-8")[:col_utf8].decode("utf-8", errors="ignore")
        return self.starts16[line - 1] + _u16(prefix)

    def span(self, node: ast.AST) -> list[int]:
        return [self.offset(node.lineno, node.col_offset), self.offset(node.end_lineno, node.end_col_offset)]

    def statement_span(self, node: ast.stmt) -> list[int]:
        """Whole lines of a statement, including its trailing newline, for replacement."""
        start = self.starts16[node.lineno - 1]
        end = self.starts16[min(node.end_lineno, len(self.lines))]
        return [start, end]

    def text(self, node: ast.AST) -> str:
        return ast.get_source_segment(self.code, node) or ""


def _u16(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _comments(code: str) -> dict[int, str]:
    out = {}
    try:
        for token in tokenize.generate_tokens(io.StringIO(code).readline):
            if token.type == tokenize.COMMENT:
                out[token.start[0]] = token.string[1:].strip()
    except (tokenize.TokenError, IndentationError, SyntaxError):
        pass
    return out


def _parameter_comment(comment: str | None) -> tuple[str | None, str]:
    if not comment:
        return None, ""
    head, _, rest = comment.partition(" ")
    if head in UNITS:
        return head, rest.strip()
    return None, comment


def _foreign(node: ast.AST) -> tuple[str, str] | None:
    """A design's reference into another component: `disk.face("body.end")` → ("disk", "body.end")."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) \
            and node.func.attr in {"face", "edge", "vertex", "ref"} and len(node.args) == 1 and not node.keywords \
            and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
        return node.func.value.id, node.args[0].value
    return None


def _arg(node: ast.AST, src: Source, env: dict) -> dict:
    out = {"source": src.text(node), "span": src.span(node)}
    if isinstance(node,ast.Name) and isinstance(env.get(node.id),_SheetSymbol):
        symbol=env[node.id]
        return {**out,'kind':symbol.kind,'value':symbol.name}
    if (foreign := _foreign(node)):
        return {**out, "value": foreign[1], "kind": "reference", "component": foreign[0]}
    try:
        value = evaluate(node, env)
        out["value"] = value
        out["kind"] = "literal" if isinstance(node, (ast.Constant, ast.Tuple, ast.List, ast.UnaryOp)) and not _names(node) else "expression"
        if isinstance(value, str):
            out["kind"] = "reference"
        uses = [name for name in _names(node) if name in env]
        if uses:
            out["parameters"] = uses
    except (NotSimple, ArithmeticError, TypeError, ValueError) as error:
        out["kind"] = "code"
        out["error"] = str(error)
    return out


def _call_parts(call: ast.Call, src: Source, env: dict) -> tuple[list[dict], dict[str, dict]]:
    return [_arg(a, src, env) for a in call.args], {kw.arg: _arg(kw.value, src, env) for kw in call.keywords if kw.arg}


def _sheet_declaration(stmt, src, env):
    """Read authored rule/table statements and their editable spans without executing them."""
    if not isinstance(stmt,ast.Assign) or len(stmt.targets)!=1 or not isinstance(stmt.targets[0],ast.Name) or not isinstance(stmt.value,ast.Call):
        return None
    call=stmt.value
    constructor=getattr(call.func,'id',getattr(call.func,'attr',None))
    kind={'SheetMetalRule':'sheet_rule','BendTable':'bend_table','GaugeTable':'gauge_table','SheetMetalForm':'sheet_form_tool'}.get(constructor)
    if kind is None and isinstance(call.func,ast.Attribute) and call.func.attr=='rule' and isinstance(call.func.value,ast.Name):
        owner=env.get(call.func.value.id)
        if isinstance(owner,_SheetSymbol) and owner.kind=='gauge_table':
            kind,constructor='sheet_rule','GaugeTable.rule'
    if kind is None:
        return None
    args,kwargs=_call_parts(call,src,env)
    name=stmt.targets[0].id
    env[name]=_SheetSymbol(name,kind)
    return dict(variable=name,kind=kind,constructor=constructor,args=args,kwargs=kwargs,
                editable=not any(a.get('kind')=='code' for a in [*args,*kwargs.values()]) and not any(k.arg is None for k in call.keywords),
                span=src.statement_span(stmt),call_span=src.span(call),line=stmt.lineno)


def _invalidate_sheet_bindings(stmt, env, declarations):
    """Opaque Python writes cannot retain a previously editable rule binding."""
    names = {n.id for n in ast.walk(stmt) if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del))}
    for name in names:
        if isinstance(env.get(name), _SheetSymbol):
            env.pop(name)
            for declaration in declarations:
                if declaration['variable'] == name:
                    declaration['editable'] = False
                    declaration['reason'] = 'This name is assigned more than once; edit its source directly.'


def _model_call(node: ast.AST, model_var: str) -> ast.Call | None:
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == model_var:
        return node
    return None


MODEL_CLASSES = {"Model", "Component"}  # A design's component file is modeled exactly like a part.


def _is_model_ctor(value: ast.AST) -> bool:
    if not isinstance(value, ast.Call):
        return False
    func = value.func
    return (isinstance(func, ast.Name) and func.id in MODEL_CLASSES) or (isinstance(func, ast.Attribute) and func.attr in MODEL_CLASSES)


def parse(code: str, imported: dict | None = None) -> dict:
    """`imported`: parameter values this file imports (a design's params.py), for evaluating arguments."""
    src = Source(code)
    try:
        tree = ast.parse(code)
    except SyntaxError as error:
        return {"version": 1, "canonical": False, "parameters": [], "features": [], "model": None,
                "diagnostics": [{"severity": "error", "message": f"Syntax error: {error.msg}", "line": error.lineno or 1}]}
    comments = _comments(code)
    body = tree.body
    model_index = next((i for i, stmt in enumerate(body) if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1
                        and isinstance(stmt.targets[0], ast.Name) and _is_model_ctor(stmt.value)), None)
    env: dict = dict(imported or {})
    parameters, diagnostics = [], []
    sheet_rules = []
    features: list[dict] = []
    limit = model_index if model_index is not None else len(body)

    for stmt in body[:limit]:
        _invalidate_sheet_bindings(stmt, env, sheet_rules)
        declaration=_sheet_declaration(stmt,src,env)
        if declaration is not None:
            sheet_rules.append(declaration)
            continue
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            name = stmt.targets[0].id
            try:
                value = evaluate(stmt.value, env)
            except (NotSimple, ArithmeticError, TypeError, ValueError):
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            if name in env:
                diagnostics.append({"severity": "warning", "message": f"Parameter {name} is assigned twice; the later value wins.", "line": stmt.lineno})
            env[name] = value
            unit, description = _parameter_comment(comments.get(stmt.lineno))
            parameters.append({"name": name, "expression": src.text(stmt.value), "value": value, "unit": unit, "description": description,
                               "span": src.statement_span(stmt), "value_span": src.span(stmt.value), "uses": [n for n in _names(stmt.value) if n in env],
                               "literal": isinstance(stmt.value, ast.Constant) or (isinstance(stmt.value, ast.UnaryOp) and isinstance(stmt.value.operand, ast.Constant)),
                               "line": stmt.lineno})

    if model_index is None:
        return {"version": 1, "canonical": False, "parameters": parameters, "features": [], "model": None, "diagnostics": diagnostics,
                "sheet_rules": [r for r in sheet_rules if r['kind']!='sheet_form_tool'],
                "sheet_forms": [r for r in sheet_rules if r['kind']=='sheet_form_tool']}

    model_stmt = body[model_index]
    model_var = model_stmt.targets[0].id
    ids: set[str] = set()
    code_block: list[ast.stmt] = []

    def flush_code():
        if code_block:
            first, last = code_block[0], code_block[-1]
            span = [src.statement_span(first)[0], src.statement_span(last)[1]]
            features.append({"kind": "code", "id": None, "name": "Code", "editable": False, "span": span,
                             "source": code[_char(code, span[0]):_char(code, span[1])], "line": first.lineno})
            code_block.clear()

    result_stmt = None
    body_names: list[dict] = []
    materials: list[dict] = []
    appearances: list[dict] = []
    for stmt in body[model_index + 1:]:
        _invalidate_sheet_bindings(stmt, env, sheet_rules)
        declaration=_sheet_declaration(stmt,src,env)
        if declaration is not None:
            flush_code()
            sheet_rules.append(declaration)
            continue
        call = None
        if isinstance(stmt, ast.Expr):
            call = _model_call(stmt.value, model_var)
            if call and call.func.attr == "body_name":
                flush_code()
                body_names.append(_body_name(stmt, call, src))
                continue
            if call and call.func.attr == "material":
                flush_code()
                materials.append(_material(stmt, call, src))
                continue
            if call and call.func.attr == "appearance":
                flush_code()
                appearances.append(_appearance(stmt, call, src))
                continue
        elif isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
            call = _model_call(stmt.value, model_var)
            if call and call.func.attr == "result":
                result_stmt = stmt
                continue
        if isinstance(stmt, ast.With) and len(stmt.items) == 1 and _model_call(stmt.items[0].context_expr, model_var) \
                and stmt.items[0].context_expr.func.attr == "sketch":
            flush_code()
            features.append(_sketch(stmt, src, env, ids, diagnostics))
            continue
        if call is not None and call.func.attr in FEATURE_KINDS:
            flush_code()
            features.append(_feature(stmt, call, src, env, ids, diagnostics))
            continue
        code_block.append(stmt)
    flush_code()
    return {"version": 1, "canonical": True, "parameters": parameters, "features": features,
            **({"imported": [{"name": k, "value": v} for k, v in imported.items()]} if imported else {}),
            "model": {"variable": model_var, "span": src.statement_span(model_stmt), "line": model_stmt.lineno,
                      "result_span": src.statement_span(result_stmt) if result_stmt else None, **_component(model_stmt.value)},
            "body_names": body_names, "materials": materials, "appearances": appearances,
            "sheet_rules": [r for r in sheet_rules if r['kind']!='sheet_form_tool'],
            "sheet_forms": [r for r in sheet_rules if r['kind']=='sheet_form_tool'], "diagnostics": diagnostics}


def _component(ctor: ast.Call) -> dict:
    """For `x = Component("disk", name="Disk")`: {"component": {"id", "name"}}, and `hardware: False` for a component
    written `hardware=False` (not a part: a fluid volume, an envelope)."""
    func = ctor.func
    if (func.id if isinstance(func, ast.Name) else func.attr) != "Component":
        return {}
    first = ctor.args[0] if ctor.args else next((k.value for k in ctor.keywords if k.arg == "id"), None)
    name = ctor.args[1] if len(ctor.args) > 1 else next((k.value for k in ctor.keywords if k.arg == "name"), None)
    hardware = ctor.args[2] if len(ctor.args) > 2 else next((k.value for k in ctor.keywords if k.arg == "hardware"), None)
    text = lambda node: node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None  # noqa: E731
    return {"component": {"id": text(first) if first is not None else None, "name": text(name) if name is not None else None,
                          **({"hardware": False} if isinstance(hardware, ast.Constant) and hardware.value is False else {})}}


def _char(code: str, offset16: int) -> int:
    """UTF-16 offset → Python string index."""
    count = 0
    for index, ch in enumerate(code):
        if count >= offset16:
            return index
        count += 2 if ord(ch) > 0xFFFF else 1
    return len(code)


def _identity(call: ast.Call, src: Source, env: dict, ids: set, diagnostics: list, line: int) -> tuple[str | None, str | None]:
    fid = None
    if call.args and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str):
        fid = call.args[0].value
    if not fid:
        diagnostics.append({"severity": "warning", "message": "A feature call needs a literal id as its first argument.", "line": line})
    elif fid in ids:
        diagnostics.append({"severity": "error", "message": f"Feature id {fid!r} is used twice.", "line": line})
    elif fid:
        ids.add(fid)
    name = next((kw.value.value for kw in call.keywords if kw.arg == "name" and isinstance(kw.value, ast.Constant)), None)
    return fid, name


def _feature(stmt: ast.stmt, call: ast.Call, src: Source, env: dict, ids: set, diagnostics: list) -> dict:
    fid, name = _identity(call, src, env, ids, diagnostics, stmt.lineno)
    args, kwargs = _call_parts(call, src, env)
    editable = fid is not None and all(a.get("kind") != "code" for a in args[1:] + list(kwargs.values()))
    return {"kind": call.func.attr, "id": fid, "name": name or (fid or call.func.attr).replace("_", " ").capitalize(),
            "editable": editable, "span": src.statement_span(stmt), "call_span": src.span(call), "line": stmt.lineno,
            "args": args[1:], "kwargs": kwargs, "suppressed": bool(kwargs.get("suppressed", {}).get("value"))}


def _body_name(stmt: ast.stmt, call: ast.Call, src: Source) -> dict:
    """`model.body_name("<body>", "<name>")`: a body's display name. Not a feature: ids stay as they are."""
    def arg(index: int, key: str):
        return call.args[index] if len(call.args) > index else next((kw.value for kw in call.keywords if kw.arg == key), None)

    def text(node):
        return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None

    body, name = arg(0, "body"), arg(1, "name")
    return {"body": text(body), "name": text(name), "span": src.statement_span(stmt), "name_span": src.span(name) if name else None,
            "line": stmt.lineno}


def _material(stmt: ast.stmt, call: ast.Call, src: Source) -> dict:
    """`model.material("<id>", bodies=[...], finish=..., color=...)`: the part's or some bodies' material. Not a feature."""
    def arg(index: int, key: str):
        return call.args[index] if len(call.args) > index else next((kw.value for kw in call.keywords if kw.arg == key), None)

    def text(node):
        return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None

    material, bodies, finish, color = arg(0, "material"), arg(1, "bodies"), arg(2, "finish"), arg(3, "color")
    listed = [text(item) for item in bodies.elts] if isinstance(bodies, (ast.List, ast.Tuple)) else [text(bodies)] if text(bodies) else None
    literal = all(node is None or text(node) is not None for node in (material, finish, color)) and \
        (bodies is None or (listed is not None and None not in listed)) and len(call.args) + len(call.keywords) <= 4
    return {"material": text(material), "bodies": listed if bodies is not None and literal else None, "finish": text(finish), "color": text(color),
            "editable": literal, "span": src.statement_span(stmt), "call_span": src.span(call), "line": stmt.lineno,
            "material_span": src.span(material) if material else None, "bodies_span": src.span(bodies) if bodies else None}


APPEARANCE_ARGS = ("color", "finish", "opacity", "roughness", "metalness", "bodies", "faces")


def _appearance(stmt: ast.stmt, call: ast.Call, src: Source) -> dict:
    """`model.appearance(color=..., finish=..., opacity=..., roughness=..., metalness=..., bodies=[...] | faces=[...])`:
    how the part, some bodies or some faces look, apart from their material. Not a feature. `faces` lists the face
    references when they're all literal strings (else None; `faces_span` says the call has them)."""
    def arg(index: int, key: str):
        return call.args[index] if len(call.args) > index else next((kw.value for kw in call.keywords if kw.arg == key), None)

    def text(node):
        return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None

    def number(node):
        return float(node.value) if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool) else None

    def strings(node):
        return [text(item) for item in node.elts] if isinstance(node, (ast.List, ast.Tuple)) else [text(node)] if text(node) else None

    color, finish, opacity, roughness, metalness, bodies, faces = (arg(i, key) for i, key in enumerate(APPEARANCE_ARGS))
    listed, refs = strings(bodies), strings(faces)
    literal = all(node is None or text(node) is not None for node in (color, finish)) and \
        all(node is None or number(node) is not None for node in (opacity, roughness, metalness)) and \
        (bodies is None or (listed is not None and None not in listed)) and \
        (faces is None or (refs is not None and None not in refs)) and \
        all(kw.arg in APPEARANCE_ARGS for kw in call.keywords) and len(call.args) + len(call.keywords) <= len(APPEARANCE_ARGS)
    return {"color": text(color), "finish": text(finish), "opacity": number(opacity), "roughness": number(roughness), "metalness": number(metalness),
            "bodies": listed if bodies is not None and literal else None, "faces": refs if faces is not None and literal else None,
            "editable": literal, "span": src.statement_span(stmt), "call_span": src.span(call), "line": stmt.lineno,
            "bodies_span": src.span(bodies) if bodies else None, "faces_span": src.span(faces) if faces else None}


def _sketch(stmt: ast.With, src: Source, env: dict, ids: set, diagnostics: list) -> dict:
    call = stmt.items[0].context_expr
    fid, name = _identity(call, src, env, ids, diagnostics, stmt.lineno)
    args, kwargs = _call_parts(call, src, env)
    alias = stmt.items[0].optional_vars.id if isinstance(stmt.items[0].optional_vars, ast.Name) else None
    sketch = Sketch(fid or "sketch", None, name)
    statements, errors = [], []
    editable = fid is not None and alias is not None
    for inner in stmt.body:
        entry = {"span": src.statement_span(inner), "line": inner.lineno}
        icall = inner.value if isinstance(inner, ast.Expr) and isinstance(inner.value, ast.Call) else None
        if not (icall and isinstance(icall.func, ast.Attribute) and isinstance(icall.func.value, ast.Name) and icall.func.value.id == alias
                and not icall.func.attr.startswith("_") and hasattr(Sketch, icall.func.attr)):
            entry.update({"op": "code", "source": src.text(inner)})
            editable = False
            statements.append(entry)
            continue
        iargs, ikwargs = _call_parts(icall, src, env)
        entry.update({"op": icall.func.attr, "args": iargs, "kwargs": ikwargs})
        before_entities, before_constraints = set(sketch.entities), len(sketch.constraints)
        if any(a.get("kind") == "code" for a in iargs + list(ikwargs.values())):
            editable = False
            entry["error"] = "Uses values the sketcher can't evaluate."
        else:
            try:
                getattr(sketch, icall.func.attr)(*(a["value"] for a in iargs), **{k: v["value"] for k, v in ikwargs.items()})
            except (SketchError, TypeError, ValueError, ArithmeticError) as error:
                entry["error"] = str(error)
                errors.append({"line": inner.lineno, "message": str(error)})
        entry["entities"] = [e for e in sketch.entities if e not in before_entities]
        entry["constraints"] = [c["id"] for c in sketch.constraints[before_constraints:]]
        statements.append(entry)
    return {"kind": "sketch", "id": fid, "name": name or (fid or "Sketch").replace("_", " ").capitalize(), "editable": editable,
            "span": src.statement_span(stmt), "call_span": src.span(call), "line": stmt.lineno, "alias": alias,
            "body_indent": _indent(src, stmt.body[0]) if stmt.body else "    ",
            "header_span": [src.statement_span(stmt)[0], src.offset(stmt.body[0].lineno, 0)] if stmt.body else src.statement_span(stmt),
            "args": args[1:], "kwargs": kwargs, "statements": statements, "document": sketch.document(), "errors": errors,
            "suppressed": bool(kwargs.get("suppressed", {}).get("value"))}


def _indent(src: Source, stmt: ast.stmt) -> str:
    line = src.lines[stmt.lineno - 1]
    return line[: len(line) - len(line.lstrip())]


def validate_id(value: str) -> bool:
    return bool(re.fullmatch(r"[a-z][a-z0-9_]*", value))
