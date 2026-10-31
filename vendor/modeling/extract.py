"""Extracting a design's component into its own part (link_design(extract_component=...)).

`components/<id>.py` becomes a part: its `Component(...)` a `Model(...)`, the shared parameters it uses (and those they
depend on) inlined as the part's own top-level parameters, and `result = <id>.result()` last. The host design's main.py
then imports the part as a link under the same name, called with the host's parameters as overrides, so it builds to
the same geometry and stays driven by its own params.py: `from links import standoff` and
`standoff = standoff(height=params.height)` where `from components.standoff import standoff` was.

Pure source rewriting: nothing here reads or saves documents. Problems are ExtractError, naming files and lines,
never their code.
"""
import ast
import json
import re

ID = re.compile(r"[a-z][a-z0-9_]{0,63}")


class ExtractError(ValueError):
    pass


def _offsets(code: str) -> tuple[list[str], list[int]]:
    lines = code.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    return lines, offsets


def _char(lines: list[str], offsets: list[int], line: int, column: int) -> int:
    """A (line, UTF-8 byte column) position from ast as a character offset."""
    return offsets[line - 1] + len(lines[line - 1].encode()[:column].decode())


def _replace(code: str, edits: list[tuple[int, int, str]]) -> str:
    for start, end, text in sorted(edits, reverse=True):
        code = code[:start] + text + code[end:]
    return code


def _whole_lines(offsets: list[int], node: ast.AST) -> tuple[int, int]:
    return offsets[node.lineno - 1], offsets[node.end_lineno]


def _parse(path: str, code: str) -> ast.Module:
    try:
        return ast.parse(code)
    except SyntaxError as error:
        raise ExtractError(f"{path} has a syntax error at line {error.lineno}: fix it before extracting. Nothing was saved.") from None


def _bound(stmt: ast.stmt) -> set[str]:
    """The names a top-level statement of params.py binds."""
    if isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return {(a.asname or a.name).split(".")[0] for a in stmt.names if a.name != "*"}
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return {stmt.name}
    targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target] if isinstance(stmt, (ast.AnnAssign, ast.AugAssign)) else []
    return {n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)}


def _used(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _literal_number(value: ast.expr) -> bool:
    """A part parameter a link can override (runtime/steve/links.py parameters): a literal int or float."""
    try:
        number = ast.literal_eval(value)
    except (ValueError, SyntaxError, TypeError):
        return False
    return isinstance(number, (int, float)) and not isinstance(number, bool)


def _local_modules(files: dict) -> set[str]:
    return {path.split("/")[0].removesuffix(".py") for path in files} | {"params", "components", "links"}


def _inline_params(params: str, wanted: set[str], local: set[str]) -> tuple[str, list[str]]:
    """The statements of params.py that define `wanted` (and what those use), in order, as source lines; and the
    names among them that are plain numbers (what the host passes as overrides)."""
    tree = _parse("params.py", params)
    binders: dict[str, list[int]] = {}
    for index, stmt in enumerate(tree.body):
        for name in _bound(stmt):
            binders.setdefault(name, []).append(index)
    chosen, queue = set(), [n for n in wanted if n in binders]
    while queue:
        for index in binders.get(queue.pop(), []):
            if index not in chosen:
                chosen.add(index)
                queue += [n for n in _used(tree.body[index]) if n in binders]
    lines, _ = _offsets(params)
    numbers, out, taken = [], [], set()
    for index in sorted(chosen):
        stmt = tree.body[index]
        if isinstance(stmt, (ast.Import, ast.ImportFrom)):
            module = (stmt.module or "") if isinstance(stmt, ast.ImportFrom) else stmt.names[0].name
            if getattr(stmt, "level", 0) or module.split(".")[0] in local:
                raise ExtractError(f"params.py line {stmt.lineno} imports {module or 'a relative module'}, another file of this design, for a "
                                   "parameter the component uses: a part is one file. Define that value in params.py itself first. Nothing was saved.")
        for number in range(stmt.lineno, stmt.end_lineno + 1):
            if number not in taken:
                taken.add(number)
                out.append(lines[number - 1])
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name) and _literal_number(stmt.value):
            numbers.append(stmt.targets[0].id)
    text = "".join(out)
    return (text if text.endswith("\n") or not text else text + "\n"), list(dict.fromkeys(numbers))


def extract(code: str, files: dict[str, str], links: dict, component: str, alias: str) -> dict:
    """Splits `components/<component>.py` out of a design (main.py `code`, its other `files`, its stored `links`).

    Returns {"part": {"name", "code", "links", "overrides"}, "host": {"code", "files"}, "notes": [...]}: the new part
    (`overrides`: its parameters the host passes from its params.py), and the host once the part is linked as `alias`
    (its links entry is the caller's to add, at the part's first revision)."""
    if not ID.fullmatch(component or ""):
        raise ExtractError("extract_component is a component id: lowercase letters, digits and underscores, starting with a letter.")
    path = f"components/{component}.py"
    if path not in files:
        listed = ", ".join(sorted(p.removeprefix("components/").removesuffix(".py") for p in files if p.startswith("components/"))) or "none"
        raise ExtractError(f"This design has no {path} (its components: {listed}). Nothing was saved.")
    source = files[path]
    tree = _parse(path, source)
    local = _local_modules(files)
    host_tree = _parse("main.py", code)

    # The name main.py imports it as (`from components.standoff import standoff`): the component's variable.
    imports = []
    for node in ast.walk(host_tree):
        if isinstance(node, ast.ImportFrom) and node.module == f"components.{component}" and not node.level:
            imports.append(node)
        elif isinstance(node, ast.Import) and any(a.name == f"components.{component}" or a.name.startswith(f"components.{component}.") for a in node.names):
            raise ExtractError(f"main.py line {node.lineno} imports components.{component} as a module; import it as "
                               f"`from components.{component} import {component}` first. Nothing was saved.")
    if len(imports) > 1 or any(node not in host_tree.body for node in imports) or \
            any(len(node.names) != 1 or node.names[0].name == "*" for node in imports):
        line = imports[0].lineno if imports else 1
        raise ExtractError(f"main.py line {line} imports {path} in a way extracting can't rewrite: import it once, at the top, as "
                           f"`from components.{component} import <name>`. Nothing was saved.")
    variable = imports[0].names[0].name if imports else component
    placed_as = (imports[0].names[0].asname or variable) if imports else None

    # Every other file that uses it: a component imported elsewhere can't come from a part.
    for other, text in sorted(files.items()):
        if other == path or not other.endswith(".py"):   # Tables (.csv) are data, not modules.
            continue
        for node in ast.walk(_parse(other, text)):
            module = node.module if isinstance(node, ast.ImportFrom) else None
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else []
            if module == f"components.{component}" or f"components.{component}" in names or \
                    (module == "components" and any(a.name == component for a in node.names)):
                raise ExtractError(f"{other} line {node.lineno} uses {path}: another file of the design models with it, and a "
                                   f"part can't be imported into a design's files. Make that file stop importing it (reference "
                                   f"it from main.py instead), or keep {component} a component. Nothing was saved.")

    tables = [name for name in sorted(files) if name.endswith(".csv") and name in source]
    if tables:
        raise ExtractError(f"{path} reads the design's table {tables[0]}: a part is one file and can't hold a table. Read the "
                           "table in main.py and place it from there, or keep this a component. Nothing was saved.")

    # The component's own imports: steve, cadquery and other libraries stay; params are inlined; links come along.
    edits: list[tuple[int, int, str]] = []
    lines, offsets = _offsets(source)
    params_import, wanted, renamed, part_links = None, set(), [], {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        module = (node.module or "") if isinstance(node, ast.ImportFrom) else ""
        tops = {module.split(".")[0]} if isinstance(node, ast.ImportFrom) else {a.name.split(".")[0] for a in node.names}
        if getattr(node, "level", 0):
            raise ExtractError(f"{path} line {node.lineno} has a relative import: a part is one file. Nothing was saved.")
        if "components" in tops:
            raise ExtractError(f"{path} line {node.lineno} imports another component ({module or 'components'}): a part is one file "
                               "and can't use a design's components. Extract that one first and link it, or keep this a "
                               "component. Nothing was saved.")
        if "params" in tops:
            if isinstance(node, ast.Import) or node not in tree.body or params_import is not None:
                raise ExtractError(f"{path} line {node.lineno}: import the shared parameters once, at the top, as `from params import "
                                   "...` (or `*`) before extracting. Nothing was saved.")
            params_import = node
            continue
        if "links" in tops:
            if not isinstance(node, ast.ImportFrom) or module != "links":
                raise ExtractError(f"{path} line {node.lineno}: import links as `from links import <alias>`. Nothing was saved.")
            for item in node.names:
                if item.name == "*" or item.name not in links:
                    raise ExtractError(f"{path} line {node.lineno} imports link {item.name!r}, which this design doesn't link. Nothing was saved.")
                part_links[item.name] = dict(links[item.name])
            continue
        if tops & local:
            raise ExtractError(f"{path} line {node.lineno} imports {', '.join(sorted(tops & local))}, another file of this design: a part "
                               "is one file. Move what it uses into the component first. Nothing was saved.")

    # Its one Component, assigned to the name main.py imports, becomes a Model of the same name.
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and
             ((isinstance(n.func, ast.Name) and n.func.id == "Component") or (isinstance(n.func, ast.Attribute) and n.func.attr == "Component"))]
    statement = next((s for s in tree.body if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name)
                      and s.targets[0].id == variable and s.value in calls), None)
    if statement is None or len(calls) != 1:
        raise ExtractError(f"{path} must define exactly one `{variable} = Component(...)` at the top level to extract it. Nothing was saved.")
    call = statement.value
    label = call.args[1] if len(call.args) > 1 else next((k.value for k in call.keywords if k.arg == "name"), None)
    name = label.value if isinstance(label, ast.Constant) and isinstance(label.value, str) and label.value.strip() else \
        component.replace("_", " ").capitalize()
    model_call = "Model" if isinstance(call.func, ast.Name) else ast.get_source_segment(source, call.func.value) + ".Model"
    arguments = ast.get_source_segment(source, label) if label is not None else json.dumps(name)
    edits.append((_char(lines, offsets, call.lineno, call.col_offset), _char(lines, offsets, call.end_lineno, call.end_col_offset),
                  f"{model_call}({arguments})"))
    if isinstance(call.func, ast.Name):
        steve = next((s for s in tree.body if isinstance(s, ast.ImportFrom) and s.module == "steve" and not s.level
                      and any(a.name == "Component" and not a.asname for a in s.names)), None)
        if steve is not None:
            names = []
            for item in steve.names:
                text = "Model" if item.name == "Component" else item.name + (f" as {item.asname}" if item.asname else "")
                if text not in names:
                    names.append(text)
            edits.append((*_whole_lines(offsets, steve), f"from steve import {', '.join(names)}\n"))
        elif not any(isinstance(s, ast.ImportFrom) and s.module == "steve" and any(a.name in ("Model", "*") for a in s.names) for s in tree.body):
            raise ExtractError(f"{path} must import Component as `from steve import Component` to extract it. Nothing was saved.")
    if any(isinstance(s, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "result" for t in s.targets) for s in tree.body):
        raise ExtractError(f"{path} already sets `result`; rename that variable before extracting. Nothing was saved.")

    # Shared parameters it uses become the part's own, where it imported them.
    overrides: list[str] = []
    if params_import is not None:
        if "params.py" not in files:
            raise ExtractError(f"{path} line {params_import.lineno} imports params, but the design has no params.py. Nothing was saved.")
        own = {n for stmt in tree.body for n in _bound(stmt) if not isinstance(stmt, (ast.Import, ast.ImportFrom))}
        star = any(a.name == "*" for a in params_import.names)
        wanted = _used(tree) if star else {a.name for a in params_import.names}
        renamed = [] if star else [(a.asname, a.name) for a in params_import.names if a.asname and a.asname != a.name]
        block, numbers = _inline_params(files["params.py"], wanted, local)
        block += "".join(f"{new} = {old}\n" for new, old in renamed)
        header = "# Parameters (from the design's params.py when this was extracted)\n" if block else ""
        edits.append((*_whole_lines(offsets, params_import), header + block))
        # The host keeps driving them: plain numbers the component doesn't set again itself.
        overrides = [n for n in numbers if n not in own and n not in {new for new, _ in renamed}]

    part_code = _replace(source, edits).rstrip("\n") + f"\n\nresult = {variable}.result()\n"
    try:
        ast.parse(part_code)
    except SyntaxError as error:  # Never expected: the rewrite is of whole statements.
        raise ExtractError(f"Extracting {path} didn't produce valid code (line {error.lineno}); it was left unchanged. Nothing was saved.") from None

    # The host: its import becomes the link, called with its own parameters, under the name the rest of main.py uses.
    host_code, notes = code, []
    bound = {n.id for n in ast.walk(host_tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)} | \
        {(a.asname or a.name).split(".")[0] for n in ast.walk(host_tree) if isinstance(n, (ast.Import, ast.ImportFrom)) for a in n.names}
    if alias in bound and alias != placed_as:
        raise ExtractError(f"main.py already uses the name {alias!r}: link the part under another alias (the component id "
                           f"{component!r} keeps instance names). Nothing was saved.")
    if imports:
        _, host_offsets = _offsets(code)
        has_params = any(isinstance(s, ast.Import) and any(a.name == "params" and not a.asname for a in s.names) and s.lineno < imports[0].lineno
                         for s in host_tree.body)
        module = "params" if has_params or "params" not in bound else "_params"
        block = ""
        if overrides and not has_params:
            block += "import params\n" if module == "params" else "import params as _params\n"
        block += f"from links import {alias}\n{placed_as} = {alias}({', '.join(f'{n}={module}.{n}' for n in overrides)})\n"
        host_code = _replace(code, [(*_whole_lines(host_offsets, imports[0]), block)])
        uses = sorted({n.lineno for n in ast.walk(host_tree) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name)
                       and n.value.id == placed_as})
        if uses:
            notes.append(f"main.py uses {placed_as}'s faces or edges (line{'s' if len(uses) > 1 else ''} {', '.join(map(str, uses))}): "
                         "they now resolve through the link, in the same place. Run generate_model to check them.")
    else:
        _, host_offsets = _offsets(code)
        last = [s for s in host_tree.body if isinstance(s, (ast.Import, ast.ImportFrom))]
        at = host_offsets[last[-1].end_lineno] if last else 0
        host_code = code[:at] + ("" if not at or code[:at].endswith("\n") else "\n") + f"from links import {alias}\n" + code[at:]
        notes.append(f"main.py didn't place {component}; the part is linked as {alias} for you to place.")
    if alias != component:
        notes.append(f"Its instances are now named after the link ({alias}), not {component}: joints, studies and comments that "
                     f"named {component} need the new name.")
    notes.append("Simulation studies, CAM setups, drawings and comments that pointed into this component now see a linked part; "
                 "check them after generate_model.")
    host_files = {p: t for p, t in files.items() if p != path}
    return {"part": {"name": name[:100], "code": part_code, "links": part_links, "overrides": overrides},
            "host": {"code": host_code, "files": host_files}, "notes": notes}
