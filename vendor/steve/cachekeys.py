"""Build-cache keys for a design's components (docs/MODELING.md §6), and a part's geometry key.

The runtime (which reads and writes cache entries) and the dispatcher (which decides which entries
a job gets, and which new ones it keeps) compute them the same way, from a component file and,
transitively, every design file it imports, plus the kernel's runtime version. A part's geometry key
(part_key) is the dispatcher's alone: it finds an earlier build of the same geometry by it. Pure Python:
the dispatcher has no CadQuery.
"""
from __future__ import annotations

import ast
import hashlib
import json

VERSION = 2
# Statements that only change how a component looks, never its geometry: left out of its key (see _geometry_text).
LOOKS = {"appearance", "material", "decal"}


def _literal(node: ast.AST) -> bool:
    try:
        ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return False
    return True


def _models(tree: ast.Module) -> set[str]:
    """Names bound once, at the file's top level, to `Component(...)` or `Model(...)` imported from steve, and bound
    nowhere else in the file: the only receivers whose look statements are left out of the key."""
    constructors: dict[str, int] = {}
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and not node.level and node.module and node.module.split(".")[0] == "steve":
            for alias in node.names:
                if alias.name in ("Component", "Model"):
                    constructors[alias.asname or alias.name] = 0
    candidates: dict[str, int] = {}
    for node in tree.body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id in constructors):
            candidates[node.targets[0].id] = 0
    bindings = {name: 0 for name in [*constructors, *candidates]}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Load):
            names = [node.id]
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [(alias.asname or alias.name).split(".")[0] for alias in node.names]
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.ExceptHandler,
                               ast.MatchAs, ast.MatchStar)):
            names = [node.name] if getattr(node, "name", None) else []
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names = list(node.names)
        elif isinstance(node, ast.MatchMapping):
            names = [node.rest] if node.rest else []
        elif isinstance(node, ast.arg):
            names = [node.arg]
        else:
            continue
        for name in names:
            if name in bindings:
                bindings[name] += 1
    if any(bindings[name] != 1 for name in constructors):
        return set()
    return {name for name in candidates if bindings[name] == 1}


def _look(node: ast.stmt, models: set[str], keep: set[str]) -> bool:
    """A top-level `<model>.appearance/material/decal(...)` statement whose every argument is a literal."""
    if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)):
        return False
    call = node.value
    return (isinstance(call.func, ast.Attribute) and call.func.attr in LOOKS - keep
            and isinstance(call.func.value, ast.Name) and call.func.value.id in models
            and all(not isinstance(arg, ast.Starred) and _literal(arg) for arg in call.args)
            and all(item.arg is not None and _literal(item.value) for item in call.keywords))


def _parse(text: str) -> ast.Module | None:
    try:
        return ast.parse(text)
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return None


def _keeps(tree: ast.Module | None) -> set[str]:
    """Which look statements must stay in the key of every file in a closure, because of what this file does: all of
    them when it doesn't parse or could redefine them (assigns to `.appearance`, uses setattr, exec …); material
    statements beside sheet-metal features (`sheet_base`, `sheet_rip` …), which assign materials themselves."""
    if tree is None:
        return set(LOOKS)
    keep = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            if node.attr in LOOKS and not isinstance(node.ctx, ast.Load) or node.attr in ("__dict__", "__class__"):
                return set(LOOKS)
            if node.attr.startswith("sheet"):
                keep.add("material")
        elif isinstance(node, ast.Name) and node.id in ("setattr", "delattr", "vars", "globals", "exec", "eval", "__import__"):
            return set(LOOKS)
    return keep


def _geometry_text(text: str, tree: ast.Module | None, keep: set[str]) -> str:
    """A design file's text without its look-only statements (`LOOKS` but `keep`): top-level calls on the file's own
    Component or Model whose arguments are all literals, on lines of their own. Anything else (an argument that's a
    name, a call or an f-string, a statement inside an `if`, a loop or a function, another receiver) stays, so it can
    still rebuild the component; so does all of a file that doesn't parse."""
    if tree is None or keep >= LOOKS or "\r" in text:  # \r: Python's own line breaks may not be text.split("\n")'s.
        return text
    models = _models(tree)
    if not models:
        return text
    lines = text.split("\n")
    dropped: set[int] = set()
    body = tree.body
    for i, node in enumerate(body):
        if not _look(node, models, keep):
            continue
        # Only a statement alone on its lines (no `a; b`) is left out, whole lines at a time.
        if (i and body[i - 1].end_lineno >= node.lineno) or (i + 1 < len(body) and body[i + 1].lineno <= node.end_lineno):
            continue
        dropped.update(range(node.lineno - 1, node.end_lineno))
    if not dropped:
        return text
    return "\n".join(line for n, line in enumerate(lines) if n not in dropped)


def _imports(text: str) -> list[tuple[str, list[str]]]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and not node.level:
            found.append((node.module, [alias.name for alias in node.names]))
        elif isinstance(node, ast.Import):
            found.extend((alias.name, []) for alias in node.names)
    return found


def closure(files: dict[str, str], start: str) -> list[str]:
    """`start` and the design files it imports, transitively (paths into `files`)."""
    seen: set[str] = set()
    pending = [start]
    while pending:
        path = pending.pop()
        if path in seen or path not in files:
            continue
        seen.add(path)
        for module, names in _imports(files[path]):
            base = module.replace(".", "/")
            pending += [f"{base}.py", f"{base}/__init__.py", *(f"{base}/{name}.py" for name in names)]
    return sorted(seen)


def topology_key(component: str, mode: str) -> str:
    """The cache entry holding a component's viewer topology for a tessellation mode ("preview" or "full"): kept
    apart from the component's own entry (its bodies), so adding it never rewrites that, much larger, entry."""
    return hashlib.sha256(f"steve-topology/1|{component}|{mode}".encode()).hexdigest()


# Calls a `Drawing(...)` statement's arguments may make and still be left out of the checks' key (`_without_drawings`).
PLAIN_CALLS = {"str", "int", "float", "round", "abs", "min", "max", "len", "dict", "list", "tuple", "range", "sorted"}


def _drawing_statement(node: ast.stmt, drawing: str, loaded: set[str], bound: dict[str, int]) -> bool:
    """A top-level `Drawing(...)` or `name = Drawing(...)` (`name` read nowhere) whose arguments call nothing but
    PLAIN_CALLS and assign nothing: a statement that only draws a sheet, and so can't change what a check sees."""
    if isinstance(node, ast.Expr):
        call = node.value
    elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id not in loaded:
        call = node.value
    else:
        return False
    if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == drawing):
        return False
    for inner in (part for arg in [*call.args, *(k.value for k in call.keywords)] for part in ast.walk(arg)):
        if isinstance(inner, (ast.NamedExpr, ast.Lambda, ast.Await, ast.Yield, ast.YieldFrom)):
            return False
        if isinstance(inner, ast.Call) and not (isinstance(inner.func, ast.Name) and inner.func.id in PLAIN_CALLS
                                                 and bound.get(inner.func.id, 0) == 0):
            return False
    return True


def _without_drawings(code: str) -> str:
    """Main's code without its sheet statements (`_drawing_statement`), on lines of their own, and trailing whitespace:
    what a design's motion and fit checks can depend on. Sheets are drawn from the design's result, after its checks
    ran, so an edit to them keeps the checks' entry (as web/src/drawing/code.ts withoutDrawings keeps the model).
    `Drawing` must be imported from steve, once, and never bound otherwise; a file that doesn't parse, or could reach
    its statements some other way (exec, globals …), keeps all of its text."""
    tree = _parse(code)
    if tree is None or "\r" in code or _keeps(tree) >= LOOKS:
        return code
    drawing, bound, loaded = None, {}, set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and not node.level and node.module and node.module.split(".")[0] == "steve":
            for alias in node.names:
                if alias.name == "Drawing":
                    drawing = alias.asname or alias.name
    if drawing is None:
        return code
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load):
                loaded.add(node.id)
            else:
                bound[node.id] = bound.get(node.id, 0) + 1
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                name = (alias.asname or alias.name).split(".")[0]
                bound[name] = bound.get(name, 0) + 1
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound[node.name] = bound.get(node.name, 0) + 1
        elif isinstance(node, ast.arg):
            bound[node.arg] = bound.get(node.arg, 0) + 1
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            for name in node.names:
                bound[name] = bound.get(name, 0) + 1
    if bound.get(drawing) != 1:
        return code
    lines, dropped, body = code.split("\n"), set(), tree.body
    for i, node in enumerate(body):
        if not _drawing_statement(node, drawing, loaded, bound):
            continue
        # Only a statement alone on its lines (no `a; b`) is left out, whole lines at a time.
        if (i and body[i - 1].end_lineno >= node.lineno) or (i + 1 < len(body) and body[i + 1].lineno <= node.end_lineno):
            continue
        dropped.update(range(node.lineno - 1, node.end_lineno))
    return "\n".join(line for n, line in enumerate(lines) if n not in dropped).rstrip() + "\n"


def checks_key(files: dict[str, str], code: str, runtime: str, mode: str, links=None, imports=None, materials=None) -> str:
    """The cache entry holding a design build's motion and fit check results (steve.design `_reuse`) for a build `mode`
    ("preview" or "full"): main's code (`code`) without its drawing sheets (`_without_drawings`) and every design file
    and table it reads, as a component's key sees them (so an appearance, material or decal edit keeps it, and so does
    a sheet's), and what the closure doesn't see: the linked documents' sources, the imported STEP files' contents and
    the person's own materials, as the build request carries them."""
    design = component_key({**files, "model.py": _without_drawings(code)}, "model.py", runtime)
    inputs = json.dumps([links or None, imports or None, materials or None], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"steve-checks/2|{design}|{mode}|".encode() + inputs.encode()).hexdigest()


def sheets_key(kind: str, files: dict[str, str] | None, code: str, runtime: str, links=None, imports=None, materials=None) -> str | None:
    """The model a document's drawing sheets are projected from: main's code without its sheet statements
    (`_without_drawings`), as a part's geometry key (`part_key`) or a design's checks key (`checks_key`) sees it, and its
    linked documents' sources. An edit to a sheet's annotations, layout or views keeps it; any edit to the model changes
    it. The dispatcher finds the person's earlier build of the same model by it (app/worker.py drawing_projections),
    whose record of projected views the runtime checks entry by entry (steve.drawing _projection_key). A part with no
    `Model` of its own (plain CadQuery) is keyed by all of that code and its inputs. None for code with no sheets."""
    if "Drawing" not in code:
        return None
    main = _without_drawings(code)
    if kind == "design":
        model = checks_key(files or {}, code, runtime, "drawing", links, imports, materials)
    elif kind == "part":
        inputs = json.dumps([files or None, imports or None, materials or None], sort_keys=True, separators=(",", ":"), default=str)
        model = part_key(main, files, imports, materials, runtime) or hashlib.sha256(
            f"steve-part-code/{VERSION}|{runtime}|".encode() + main.encode() + b"\0" + inputs.encode()).hexdigest()
    else:
        return None
    linked = json.dumps(links or None, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"steve-sheets/1|{kind}|{model}|".encode() + linked.encode()).hexdigest()


def component_key(files: dict[str, str], path: str, runtime: str) -> str:
    """Changes only when an edit can change the component's geometry: a literal appearance, material or decal
    statement is left out (`_geometry_text`), since a restored component runs those again (steve.design). Material
    statements stay in when the closure has sheet-metal features, which assign materials of their own."""
    digest = hashlib.sha256(f"steve-component/{VERSION}|{runtime}".encode())
    items = closure(files, path)
    trees = {item: _parse(files[item]) for item in items}
    keep = set().union(*(_keeps(tree) for tree in trees.values()))
    for item in items:
        digest.update(item.encode() + b"\0" + _geometry_text(files[item], trees[item], keep).encode() + b"\0")
    # The design's tables (.csv, read with steve.table from any file): editing one rebuilds its components.
    for item in sorted(p for p in files if p.endswith(".csv")):
        digest.update(item.encode() + b"\0" + files[item].encode() + b"\0")
    return digest.hexdigest()


def part_key(code: str, files: dict[str, str] | None, imports: dict | None, materials: dict | None, runtime: str) -> str | None:
    """A part document's geometry key: what `component_key` is to a component, for main.py's own `model = Model()`. It
    changes only when an edit can change the part's geometry (the same statements are left out, by the same rules), and
    with any of the part's files, the uploads it reads, the person's own materials it names and the runtime. None for a
    part that has no `Model` of its own to restore (plain CadQuery, or code that doesn't parse)."""
    tree = _parse(code)
    if tree is None or not _models(tree):
        return None
    digest = hashlib.sha256(f"steve-part/{VERSION}|{runtime}".encode())
    digest.update(_geometry_text(code, tree, _keeps(tree)).encode() + b"\0")
    for name, value in sorted((files or {}).items()):   # Tables and title-block images: any edit rebuilds.
        digest.update(name.encode() + b"\0" + str(value).encode() + b"\0")
    for label, value in (("imports", imports), ("materials", materials)):
        if value:
            digest.update(label.encode() + b"\0" + json.dumps(value, sort_keys=True, separators=(",", ":")).encode() + b"\0")
    return digest.hexdigest()
