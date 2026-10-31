"""Outline of a design (docs/MODELING.md §6): every file parsed like a part, plus how they fit together.

Shared parameters come from params.py; each component file is parsed with the parameters it
imports; main.py lists the placed instances. Diagnostics keep the codebase shape that makes a
design readable: one component per file, components defined in components/, not in main.py.
"""
from __future__ import annotations

import ast
import re

from .parse import parse

PARAMS = "params.py"
NAME = re.compile(r"[a-z][a-z0-9_]*")  # Component ids and joint, coupling, … names (runtime/steve/model.py ID).


def _suggested(name: str) -> str:
    """A name the build accepts, close to `name`: lowercase, other characters as underscores."""
    name = re.sub(r"_+", "_", re.sub(r"[^a-z0-9_]", "_", name.lower())).strip("_")
    return name if NAME.fullmatch(name) else f"n_{name}".rstrip("_")


def _imports(tree: ast.Module) -> dict[str, list[str]]:
    """module → names imported from it (`*` for star imports)."""
    out: dict[str, list[str]] = {}
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module:
            out.setdefault(node.module, []).extend(alias.name for alias in node.names)
    return out


def _module_path(module: str) -> str:
    return module.replace(".", "/") + ".py"


def _instances(tree: ast.Module) -> list[dict]:
    """`design.add(blade, at=..., name=...)` calls in main.py."""
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "add" and node.args:
            target = node.args[0]
            if isinstance(target, ast.Name):
                name = next((k.value.value for k in node.keywords if k.arg == "name" and isinstance(k.value, ast.Constant)), None)
                out.append({"variable": target.id, "name": name, "line": node.lineno})
    return out


JOINTS = ("rigid", "revolute", "slider", "cylindrical")


def _joints(tree: ast.Module, main: str) -> list[dict]:
    """`design.revolute("hinge", "frame", "arm", axis=…)` calls (and rigid/slider/cylindrical) in main.py."""
    def text(node):
        if node is None:
            return None
        return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else ast.get_source_segment(main, node)
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in JOINTS and node.args \
                and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            keywords = {k.arg: k.value for k in node.keywords}
            args = node.args + [None] * 4
            out.append({"name": node.args[0].value, "type": node.func.attr, "parent": text(args[1] or keywords.get("parent")),
                        "child": text(args[2] or keywords.get("child")), "axis": text(args[3] or keywords.get("axis")),
                        "limits": text(keywords.get("limits")), "follow": _literal(keywords.get("follow")) is True,
                        "line": node.lineno, "end_line": node.end_lineno})
    return sorted(out, key=lambda joint: joint["line"])


def _couplings(tree: ast.Module, main: str) -> list[dict]:
    """`design.couple("train", {"sun": 1, "carrier": 0.25}, limits=…, value=…)` calls in main.py. `gears` is the
    joint → ratio mapping when written as a literal dict (else None, with its source in `gears_source`)."""
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "couple" and node.args \
                and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            keywords = {k.arg: k.value for k in node.keywords}
            source = node.args[1] if len(node.args) > 1 else keywords.get("gears")
            try:
                gears = ast.literal_eval(source) if source is not None else None
                gears = {str(k): float(v) for k, v in gears.items()} if isinstance(gears, dict) else None
            except (ValueError, TypeError, SyntaxError):
                gears = None
            text = lambda item: ast.get_source_segment(main, item) if item is not None else None  # noqa: E731
            out.append({"name": node.args[0].value, "gears": gears, "gears_source": text(source), "limits": text(keywords.get("limits")),
                        "value": text(keywords.get("value")), "line": node.lineno, "end_line": node.end_lineno})
    return sorted(out, key=lambda coupling: coupling["line"])


def _calls(tree: ast.Module, attribute: str):
    """`design.<attribute>("name", …)` calls whose first argument is a string literal, in source order."""
    found = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == attribute
             and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str)]
    return sorted(found, key=lambda node: node.lineno)


def _literal(node):
    try:
        return ast.literal_eval(node) if node is not None else None
    except (ValueError, TypeError, SyntaxError):
        return None


def _poses(tree: ast.Module) -> list[dict]:
    """`design.pose("open", hinge=80, track=20)`: each named pose's values (None where one isn't a literal number), and
    its `mode=` when it names one."""
    out = []
    for node in _calls(tree, "pose"):
        values = {k.arg: _literal(k.value) for k in node.keywords if k.arg}
        mode = values.pop("mode") if isinstance(values.get("mode"), str) else None
        out.append({"name": node.args[0].value, "values": values, **({"mode": mode} if mode else {}), "line": node.lineno})
    return out


def _modes(tree: ast.Module) -> list[dict]:
    """`design.mode("limited", limits={"flap": (-10, 10)}, travel_limits=…)` calls: each mode's limits (joint or coupling →
    [min, max]) where written as a literal dict (else None)."""
    out = []
    for node in _calls(tree, "mode"):
        keywords = {k.arg: k.value for k in node.keywords}
        entry = {"name": node.args[0].value}
        for index, option in enumerate(("limits", "travel_limits"), start=1):
            given = _literal(node.args[index] if len(node.args) > index else keywords.get(option))
            entry[option] = {str(k): list(v) for k, v in given.items() if isinstance(v, (list, tuple))} if isinstance(given, dict) else None
        out.append({**entry, "line": node.lineno, "end_line": node.end_lineno})
    return out


def _drives(tree: ast.Module, main: str) -> list[dict]:
    """`design.drive("hinge", speed=45, range=(0, 90), check=True)` calls."""
    out = []
    for node in _calls(tree, "drive"):
        keywords = {k.arg: k.value for k in node.keywords}
        out.append({"joint": node.args[0].value, "speed": _literal(keywords.get("speed")),
                    "range": ast.get_source_segment(main, keywords["range"]) if "range" in keywords else None,
                    "check": _literal(keywords.get("check")) is True, "line": node.lineno})
    return out


def _animations(tree: ast.Module, main: str) -> list[dict]:
    """`design.animation("cycle", [("closed", 0), ("open", 2)], loop=True, easing="ease", check=True)` calls. `keys` is
    [(pose name or values, seconds)] when written literally (else None, with its source in `keys_source`)."""
    out = []
    for node in _calls(tree, "animation"):
        keywords = {k.arg: k.value for k in node.keywords}
        source = node.args[1] if len(node.args) > 1 else keywords.get("keys")
        keys = _literal(source)
        keys = [list(key) for key in keys] if isinstance(keys, (list, tuple)) and all(isinstance(k, (list, tuple)) and len(k) == 2 for k in keys) else None
        out.append({"name": node.args[0].value, "keys": keys, "keys_source": ast.get_source_segment(main, source) if source is not None else None,
                    "loop": _literal(keywords.get("loop")) is True, "easing": _literal(keywords.get("easing")) or "ease",
                    "check": _literal(keywords.get("check")) is True, "line": node.lineno, "end_line": node.end_lineno})
    return out


def _explodes(tree: ast.Module) -> list[dict]:
    """`design.explode("teardown", [...])` and `design.explode("teardown", auto=True)` calls: whether it's automatic and how
    many steps it lists (None where not a literal list)."""
    out = []
    for node in _calls(tree, "explode"):
        keywords = {k.arg: k.value for k in node.keywords}
        source = node.args[1] if len(node.args) > 1 else keywords.get("steps")
        steps = source.elts if isinstance(source, (ast.List, ast.Tuple)) else None
        out.append({"name": node.args[0].value, "auto": _literal(keywords.get("auto")) is True, "steps": len(steps) if steps is not None else None,
                    "line": node.lineno, "end_line": node.end_lineno})
    return out


def _studies(tree: ast.Module) -> list[dict]:
    """`design.collision_study("reach", joints=["shoulder", "elbow"], sampling="grid", steps=5)` calls: the joints that vary
    (None where not a literal) and the sampling; for sampling="animation", the animation it follows and `at`."""
    out = []
    for node in _calls(tree, "collision_study"):
        keywords = {k.arg: k.value for k in node.keywords}
        joints = _literal(node.args[1] if len(node.args) > 1 else keywords.get("joints"))
        sampling = _literal(keywords.get("sampling")) or "random"
        followed = {"animation": _literal(keywords.get("animation")), "at": _literal(keywords.get("at"))} if sampling == "animation" else {}
        out.append({"name": node.args[0].value, "joints": list(joints) if isinstance(joints, (list, tuple)) else None,
                    "sampling": sampling, **followed, "line": node.lineno, "end_line": node.end_lineno})
    return out


def _cables(tree: ast.Module) -> tuple[list[dict], list[dict]]:
    """`design.cable("servo_lead", diameter=1.9, start=…, end=…)` and `design.harness("neck", ["servo_lead", …])` calls:
    each cable's diameter (None where not a literal), and each harness's cables."""
    cables = [{"name": node.args[0].value, "diameter": _literal(node.args[1] if len(node.args) > 1 else {k.arg: k.value for k in node.keywords}.get("diameter")),
               "line": node.lineno, "end_line": node.end_lineno} for node in _calls(tree, "cable")]
    harnesses = []
    for node in _calls(tree, "harness"):
        listed = _literal(node.args[1] if len(node.args) > 1 else {k.arg: k.value for k in node.keywords}.get("cables"))
        harnesses.append({"name": node.args[0].value, "cables": list(listed) if isinstance(listed, (list, tuple)) else None, "line": node.lineno})
    return cables, harnesses


def _fits(tree: ast.Module) -> tuple[list[dict], list[dict]]:
    """`design.fit_check("fit", instances=[…])` and `design.contact("servo", "bracket", kind="seated")` calls."""
    calls = sorted((node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr in ("fit_check", "contact")), key=lambda node: node.lineno)
    fits, contacts = [], []
    for node in calls:
        keywords = {k.arg: k.value for k in node.keywords}
        if node.func.attr == "fit_check":
            name = _literal(node.args[0]) if node.args else _literal(keywords["name"]) if "name" in keywords else "fit"
            fits.append({"name": name if isinstance(name, str) else None,
                         "instances": _literal(keywords.get("instances")), "line": node.lineno})
        elif len(node.args) >= 2:
            contacts.append({"a": _literal(node.args[0]), "b": _literal(node.args[1]), "kind": _literal(keywords.get("kind")) or "seated", "line": node.lineno})
    return fits, contacts


def parse_design(main: str, files: dict[str, str]) -> dict:
    diagnostics: list[dict] = []
    params = parse(files[PARAMS]) if PARAMS in files else None
    shared = {p["name"]: p["value"] for p in (params or {}).get("parameters", [])}
    outlines: dict[str, dict] = {}
    if params is not None:
        outlines[PARAMS] = params
    components: list[dict] = []
    variables: dict[str, str] = {}  # module variable → component id
    for path, text in sorted(files.items()):
        if path == PARAMS or not path.endswith(".py"):   # Tables (.csv) are data, not modules.
            continue
        try:
            tree = ast.parse(text)
        except SyntaxError as error:
            outlines[path] = parse(text)
            diagnostics.append({"severity": "error", "file": path, "line": error.lineno or 1, "message": f"Syntax error: {error.msg}"})
            continue
        imported = _imports(tree)
        names = imported.get("params", [])
        values = shared if "*" in names else {k: v for k, v in shared.items() if k in names}
        outline = parse(text, values)
        outlines[path] = outline
        defined = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "id", getattr(n.func, "attr", None)) == "Component"]
        if len(defined) > 1:
            diagnostics.append({"severity": "warning", "file": path, "line": defined[1].lineno,
                                "message": "One component per file: move this component into its own file under components/."})
        component = (outline.get("model") or {}).get("component")
        if component:
            if not path.startswith("components/"):
                diagnostics.append({"severity": "warning", "file": path, "line": outline["model"]["line"],
                                    "message": "Components live in components/<name>.py so the design reads like a codebase."})
            components.append({**component, "file": path, "variable": outline["model"]["variable"], "line": outline["model"]["line"],
                               "imports": [_module_path(m) for m in imported if _module_path(m) in files and m != "params"]})
            variables[outline["model"]["variable"]] = component["id"]
    try:
        main_tree = ast.parse(main)
    except SyntaxError as error:
        main_tree = None
        diagnostics.append({"severity": "error", "file": "main.py", "line": error.lineno or 1, "message": f"Syntax error: {error.msg}"})
    instances, joints, couplings, poses, drives, animations, studies, fits, contacts, cables, harnesses = [], [], [], [], [], [], [], [], [], [], []
    explodes: list[dict] = []
    modes: list[dict] = []
    if main_tree is not None:
        joints = _joints(main_tree, main)
        couplings = _couplings(main_tree, main)
        modes = _modes(main_tree)
        poses, drives, animations, studies = _poses(main_tree), _drives(main_tree, main), _animations(main_tree, main), _studies(main_tree)
        explodes = _explodes(main_tree)
        fits, contacts = _fits(main_tree)
        cables, harnesses = _cables(main_tree)
        for node in ast.walk(main_tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", getattr(node.func, "attr", None)) == "Component":
                diagnostics.append({"severity": "warning", "file": "main.py", "line": node.lineno,
                                    "message": "main.py places components; define this one in components/<name>.py and import it."})
        for item in _instances(main_tree):
            item["component"] = variables.get(item["variable"])
            instances.append(item)
    # Names a build refuses (runtime/steve/model.py ID), found before it spends minutes building every component first.
    # Only names written as literals: computed ones are checked by the build.
    named = [("Component id", c["file"], c) for c in components] + [
        (label, "main.py", item) for label, items in (("Joint name", joints), ("Coupling name", couplings), ("Mode name", modes),
                                                      ("Animation name", animations), ("Explode name", explodes),
                                                      ("Collision study name", studies), ("Fit check name", fits)) for item in items]
    for label, path, item in named:
        name = item.get("id") if label == "Component id" else item.get("name")
        if isinstance(name, str) and not NAME.fullmatch(name):
            diagnostics.append({"severity": "error", "file": path, "line": item.get("line") or 1,
                                "message": f"{label} {name!r} must be lowercase letters, digits and underscores, starting with a letter "
                                           f"(like {_suggested(name)!r}); the build stops there. Rename it everywhere it's used."})
    ids = [c["id"] for c in components if c.get("id")]
    for duplicate in sorted({i for i in ids if ids.count(i) > 1}):
        diagnostics.append({"severity": "error", "file": next(c["file"] for c in components if c["id"] == duplicate), "line": 1,
                            "message": f"Two components are named {duplicate!r}; component ids must be unique in a design."})
    return {"version": 1, "parameters": (params or {}).get("parameters", []), "files": outlines, "components": components,
            "instances": instances, "joints": joints, "couplings": couplings, "modes": modes, "poses": poses, "drives": drives, "animations": animations,
            "explodes": explodes, "studies": studies, "fits": fits, "contacts": contacts, "cables": cables, "harnesses": harnesses, "diagnostics": diagnostics}
