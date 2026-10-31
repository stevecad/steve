"""Linked designs (docs/MODELING.md §6, phase B): another design or part at a pinned revision,
used with parameter overrides, e.g. `design.add(bolt(length=30), at=…)`.

`from links import bolt` gives a `Link`. Calling it builds the linked document once per distinct
set of overrides, in its own folder and module namespace (its params.py and components/ never
mix with the host design's), and returns a `LinkedInstance` that `Design.add` places.

A shop (runtime/steve/shop.py) links other shops the same way: `from links import catalogue` then `catalogue.shop`
(the linked shop), `catalogue.vmc` or `catalogue.shop["vmc"]` (its items), to add to this shop or to use in its items.
"""
from __future__ import annotations

import ast
import json
import re
import runpy
import sys
from pathlib import Path

from . import images

_SOURCES: dict[str, dict] = {}   # alias → {document_id, revision, kind, name, code, files, links}
_BUILT: dict[tuple, "LinkedInstance"] = {}
DOCUMENTS: dict[int, str] = {}    # id(linked result) → its document id ("Open part document" in the viewer)
_ROOT = Path("links")
FOLDER_KINDS = ("design", "shop")   # Documents whose parameters are their params.py, beside main.py.


class LinkError(Exception):
    pass


def register(sources: dict, root: Path | None = None) -> None:
    """Called by the runtime before the design runs: the frozen sources of every link (nested ones under `links`)."""
    global _ROOT
    _SOURCES.clear()
    _SOURCES.update(sources or {})
    _BUILT.clear()
    DOCUMENTS.clear()
    if root is not None:
        _ROOT = root



def _save_scope():
    return dict(_SOURCES), _ROOT, dict(_BUILT), dict(DOCUMENTS)


def _restore_scope(saved):
    # A nested document has its own aliases and overrides, but must not discard
    # its parent's cached instances or leave subsequent jobs under its folder.
    sources, root, built, documents = saved
    nested_documents = dict(DOCUMENTS)
    register(sources, root)
    _BUILT.update(built)
    DOCUMENTS.update(documents)
    DOCUMENTS.update(nested_documents)


def parameters(source: dict) -> dict[str, float]:
    """A linked document's own parameters (its params.py for a design; top-level numbers for a part; none for a circuit)."""
    if source.get("kind") == "circuit":
        return {}
    code = (source.get("files") or {}).get("params.py") if source.get("kind") in FOLDER_KINDS else source.get("code", "")
    out = {}
    try:
        tree = ast.parse(code or "")
    except SyntaxError:
        return out
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            try:
                value = ast.literal_eval(node.value)
            except ValueError:
                continue
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                out[node.targets[0].id] = value
    return out


def _override(code: str, values: dict) -> str:
    """Rewrites top-level `name = <expr>` assignments with new values (the parameter interface)."""
    if not values:
        return code
    tree = ast.parse(code)
    lines = code.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    edits = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in values:
            value = node.value
            start = offsets[value.lineno - 1] + len(lines[value.lineno - 1].encode()[:value.col_offset].decode())
            end = offsets[value.end_lineno - 1] + len(lines[value.end_lineno - 1].encode()[:value.end_col_offset].decode())
            edits.append((start, end, repr(values[node.targets[0].id])))
    for start, end, text in sorted(edits, reverse=True):
        code = code[:start] + text + code[end:]
    return code


class LinkedInstance:
    """A linked document built with one set of overrides: its geometry and what it reports.

    Its persistent names work like a component's: `plate.face("body.end")`, `plate.edge("edge(body.end|body.side(r.top))")`,
    resolved in the linked document's own namespace (a linked design's need its component: `rotor.face("disk:body.end")`).
    Joints, fasteners, fits and cables follow where the instance is placed. Sketches, projections and other modelling
    in a host component take `at=`, the same placement as `design.add(..., at=...)`, else the linked document's own frame.
    """
    _steve_linked = True

    def __init__(self, alias: str, source: dict, overrides: dict, result, summary: dict | None, namespace: dict | None = None,
                 model=None, design=None):
        self.alias, self.source, self.overrides, self.result, self.summary = alias, source, overrides, result, summary
        self.namespace = namespace or {}
        self.id = alias
        self._model, self._design = model, design
        self._modelled_at: list = []  # (at, location) of every at= used in modelling, checked against the placements

    @property
    def name(self) -> str:
        design = self.__dict__.get("_design")
        if self.source.get("component") and design is not None and design.instances:
            # One component of a design: "Standoff (from Enclosure)".
            return f"{design.instances[0]['component'].name} (from {self.source.get('name') or self.alias})"
        return self.source.get("name") or self.alias

    def face(self, ref: str, at=None):
        """A face of the linked document by persistent name, e.g. `plate.face("extrude_1.end")`; `at=` (as in
        `design.add`) when a host component models on it where the instance is placed."""
        return self.ref(ref, at)

    def edge(self, ref: str, at=None):
        """An edge of the linked document by persistent name, e.g. `plate.edge("edge(extrude_1.end|extrude_1.side(r1.top))")`;
        `at=` as for `face`."""
        return self.ref(ref, at)

    def vertex(self, ref: str, at=None):
        return self.ref(ref, at)

    def ref(self, ref: str, at=None):
        """Any reference into the linked document: a face, edge, vertex, plane, axis or sketch (entity). In a linked
        design, prefix the component (instance) name: `"housing:extrude_1.end"`."""
        from .design import Ref, _location
        if at is None:
            return Ref(self, ref)
        placed = _Placed(self, _location(at))
        self._modelled_at.append((at, placed.location))
        return Ref(self, ref, target=placed)

    # What host modelling calls on a reference's component, in the linked document's own frame.
    def faces(self, ref):
        return self._geometry("faces", ref)

    def edges(self, ref):
        return self._geometry("edges", ref)

    def plane_of(self, ref):
        return self._geometry("plane_of", ref)

    def axis_of(self, ref):
        return self._geometry("axis_of", ref)

    def projection_source(self, ref):
        return self._geometry("projection_source", ref)

    def _resolve(self, ref) -> tuple:
        """(model, name, location in this document's frame or None) for a reference into this linked document."""
        from .model import FeatureError
        if self.source.get("kind") == "circuit":
            raise FeatureError(f"{self.name} is a circuit board: it has no named faces or edges. Place it by instance, "
                               f"or reference a point as (instance, (x, y, z)).")
        design = self.__dict__.get("_design")
        if design is not None:
            match = re.fullmatch(r"([a-z][a-z0-9_]*):(.+)", ref) if isinstance(ref, str) else None
            if not match and isinstance(ref, str) and self.source.get("component") and design.instances:
                match = re.fullmatch(r"([a-z][a-z0-9_]*):(.+)", f"{design.instances[0]['name']}:{ref}", re.S)  # Its one component.
            names = ", ".join(i["name"] for i in design.instances) or "none"
            if not match:
                raise FeatureError(f"{self.name} is a linked design: name the component too, like "
                                   f"{self.alias}.face(\"<instance>:extrude_1.end\") (its instances: {names}).")
            instance, name = match.groups()
            found = [i for i in design.instances if i["name"] == instance] or \
                [i for i in design.instances if getattr(i["component"], "id", None) == instance]
            if not found:
                raise FeatureError(f"{self.name} has no instance {instance!r} (its instances: {names}).")
            if len(found) > 1:
                raise FeatureError(f"{instance} is placed {len(found)} times in {self.name}; name the instance "
                                   f"({', '.join(i['name'] for i in found)}).")
            item = found[0]
            if isinstance(item["component"], LinkedInstance):  # A link of the linked design: one level further down.
                model, name, inner = item["component"]._resolve(name)
                return model, name, item["location"] * inner if inner is not None else item["location"]
            return item["component"], name, item["location"]
        model = self.__dict__.get("_model")
        if model is None:
            raise FeatureError(f"{self.name} has no named faces or edges: it isn't built with steve's Model, so reference it by position.")
        return model, ref, None

    def _geometry(self, method: str, ref, at=None):
        from .model import FeatureError
        model, name, location = self._resolve(ref)
        try:
            found = getattr(model, method)(name)
        except FeatureError as error:
            revision = self.source.get("revision")
            pinned = f" (linked at revision {revision})" if revision is not None else ""
            faces = sorted(model.names.faces)
            listed = ", ".join(faces[:30]) + (f" … ({len(faces)} in all)" if len(faces) > 30 else "")
            where = f"{self.name}{pinned}" + (f", component {getattr(model, 'id', '')}" if self.__dict__.get("_design") is not None else "")
            raise FeatureError(f"{where}: {error} Its named faces: {listed or 'none'}. If you updated the link, "
                               f"its names may have changed.") from None
        for move in (location, at):
            if move is not None:
                found = _moved(found, move)
        return found

    def __getattr__(self, name):
        # Plain CadQuery code uses a linked document like a module: `bolt.result`, `bolt.head_d`; a linked shop's items
        # by their names in its main.py, or by key.
        namespace = self.__dict__.get("namespace") or {}
        if not name.startswith("_") and name in namespace:
            return namespace[name]
        shop = namespace.get("shop")
        if not name.startswith("_") and self.__dict__.get("source", {}).get("kind") == "shop" and shop is not None:
            try:
                return shop[name]
            except KeyError:
                pass
        raise AttributeError(f"{self.__dict__.get('alias', 'link')} has no {name!r}")


class _Placed:
    """A linked instance's geometry where the host places it (`plate.face(..., at=(50, 0, 0))`), for modelling."""
    _steve_linked = True

    def __init__(self, instance: LinkedInstance, location):
        self.instance, self.location, self.id = instance, location, instance.id

    def faces(self, ref):
        return self.instance._geometry("faces", ref, self.location)

    def edges(self, ref):
        return self.instance._geometry("edges", ref, self.location)

    def plane_of(self, ref):
        return self.instance._geometry("plane_of", ref, self.location)

    def axis_of(self, ref):
        return self.instance._geometry("axis_of", ref, self.location)

    def projection_source(self, ref):
        return self.instance._geometry("projection_source", ref, self.location)


def _moved(value, location):
    """Faces, edges, vertices, a plane or an axis moved by a placement (names are resolved before moving)."""
    import cadquery as cq
    from OCP.gp import gp_Ax1
    from .design import _move, _turn
    if isinstance(value, list):
        return [_moved(v, location) for v in value]
    if isinstance(value, cq.Plane):
        return cq.Plane(origin=_move(location, value.origin), xDir=_turn(location, value.xDir), normal=_turn(location, value.zDir))
    if isinstance(value, gp_Ax1):
        return value.Transformed(location.wrapped.Transformation())
    return value.moved(location)


def placement_problems(design) -> list[str]:
    """Modelling on a linked instance with `at=` that matches none of its placements in the design."""
    problems, seen = [], set()
    for item in design.instances:
        instance = item["component"]
        if not isinstance(instance, LinkedInstance) or id(instance) in seen:
            continue
        seen.add(id(instance))
        placements = [i for i in design.instances if i["component"] is instance]
        for at, location in instance._modelled_at:
            if not any(_same_place(location, i["location"]) for i in placements):
                listed = ", ".join(f"{i['name']} at {i['at']!r}" for i in placements)
                problems.append(f"{instance.alias}.face/edge(..., at={at!r}) is modelled where no {instance.alias} is placed "
                                f"({listed}); use the at= of the instance it means.")
    return list(dict.fromkeys(problems))


def _same_place(a, b) -> bool:
    from .design import _move
    import cadquery as cq
    points = [cq.Vector(0, 0, 0), cq.Vector(100, 0, 0), cq.Vector(0, 100, 0), cq.Vector(0, 0, 100)]
    return all((_move(a, p) - _move(b, p)).Length < 1e-6 for p in points)


class Link:
    """`from links import bolt`: call it, with parameter overrides, to get an instance to place."""

    def __init__(self, alias: str):
        self.alias = alias

    @property
    def source(self) -> dict:
        if self.alias not in _SOURCES:
            raise LinkError(f"Link {self.alias!r} isn't part of this design (add it to the design's links).")
        return _SOURCES[self.alias]

    def parameters(self) -> dict[str, float]:
        """The linked document's parameters and their values at its pinned revision (what calling it can override)."""
        return parameters(self.source)

    def __call__(self, **overrides) -> LinkedInstance:
        """`from links import plate`, then `plate(width=50)`: the linked document (pinned at its revision) built with
        those parameter overrides, a LinkedInstance to place with `design.add(plate(width=50), at=(x, y, z))`. Each
        distinct set of overrides is built once per build; `plate` alone is `plate()`. Its faces and edges:
        `plate.face("extrude_1.end")` (see LinkedInstance.face)."""
        source = self.source
        known = parameters(source)
        unknown = sorted(set(overrides) - set(known))
        if unknown and source.get("kind") == "circuit":
            raise LinkError(f"{source.get('name') or self.alias} is a circuit board: it has no parameters to override.")
        if unknown:
            raise LinkError(f"{source.get('name') or self.alias} has no parameter {', '.join(unknown)}; its parameters are "
                            f"{', '.join(sorted(known)) or 'none'}.")
        for key, value in overrides.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise LinkError(f"Override {key}={value!r} must be a number.")
        key = (self.alias, json.dumps(overrides, sort_keys=True))
        if key not in _BUILT:
            # What the person waiting sees: which linked document builds now, and how many of the links are
            # built, instead of main.py's bare stage; back in main.py's code afterwards.
            from . import progress
            progress.stage("links", source.get("name") or self.alias, of=len(_SOURCES))
            progress.step(len({alias for alias, _ in _BUILT}))
            try:
                _BUILT[key] = _build(self.alias, source, overrides, len(_BUILT))
            finally:
                progress.stage("main")
        return _BUILT[key]

    def __getattr__(self, name):
        # `from links import plate` then `plate.result`: the linked document as built without overrides.
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self(), name)

    def __repr__(self):
        return f"Link({self.alias!r})"


def component_main(source: dict) -> str:
    """The main.py a link to one component of a design runs instead of the design's own: that component alone, placed
    where the design models it (its params.py, the components it references and the design's links still resolve)."""
    component = source["component"]
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", component) or source.get("kind") != "design":
        raise LinkError(f"Link to component {component!r}: only a design's components can be linked one at a time.")
    if f"components/{component}.py" not in (source.get("files") or {}):
        raise LinkError(f"{source.get('name') or 'The linked design'} has no components/{component}.py at revision {source.get('revision')}.")
    return (f"from steve import Design\nfrom components.{component} import {component}\n\n"
            f"design = Design({json.dumps(source.get('name') or component)})\ndesign.add({component})\nresult = design.result()\n")


def _build(alias: str, source: dict, overrides: dict, index: int) -> LinkedInstance:
    """Runs the linked document in its own folder with its own `params`, `components` and `links` modules. A circuit isn't
    run: its board is built from the frozen board data and STEP the build service attached (steve/circuit_board.py)."""
    if source.get("kind") == "circuit":
        from . import circuit_board, imports
        step = imports.path(source["step"]) if source.get("step") else None
        result = circuit_board.assembly(source, step)
        if source.get("document_id"):
            DOCUMENTS[id(result)] = source["document_id"]
        # The board's own look (solder mask, plastic, metal leads, LED colours), node by node, for the viewer.
        return LinkedInstance(alias, source, overrides, result, {"kind": "circuit", "appearance": circuit_board.appearance(result)})
    folder = (_ROOT / alias / f"v{index}").resolve()
    folder.mkdir(parents=True, exist_ok=True)
    files = dict(source.get("files") or {})
    main = source.get("code", "")
    if source.get("component"):  # One component of a design: it alone, not the design's main.py.
        main = component_main(source)
    if source.get("kind") in FOLDER_KINDS:
        if "params.py" in files:
            files["params.py"] = _override(files["params.py"], overrides)
    else:
        main = _override(main, overrides)
    for path, text in files.items():
        target = folder / path
        if images.NAME.fullmatch(path):   # A logo image, as its bytes (steve/images.py).
            images.write(target, text)
            continue
        for parent in reversed(target.relative_to(folder).parents[:-1]):
            (folder / parent).mkdir(exist_ok=True)
            (folder / parent / "__init__.py").touch()
        target.write_text(text)
    (folder / "main.py").write_text(main)
    if source.get("kind") == "shop":
        return _build_shop(alias, source, overrides, folder, files)
    names = {"params", "components", "links"}
    saved = {name: module for name, module in sys.modules.items() if name.split(".")[0] in names}
    for name in saved:
        del sys.modules[name]
    nested = _save_scope()
    sys.path.insert(0, str(folder))
    from . import design as design_module, drawing as drawing_module, model as model_module
    designs, models, sheets = len(design_module._DESIGNS), len(model_module._ACTIVE), len(drawing_module.SHEETS)
    try:
        if source.get("links"):  # A linked design's own links, one level down.
            register(source["links"], folder / ".linked")
            _write_links_module(folder, source["links"])
        namespace = runpy.run_path(str(folder / "main.py"), run_name="__linked__")
    finally:
        sys.path.remove(str(folder))
        for name in [n for n in sys.modules if n.split(".")[0] in names]:
            del sys.modules[name]
        sys.modules.update(saved)
        if source.get("links"):
            _restore_scope(nested)
    result = namespace.get("result")
    if result is None:
        raise LinkError(f"Linked {source.get('name') or alias} has no `result`.")
    linked_design = design_module._DESIGNS[designs] if len(design_module._DESIGNS) > designs else None
    linked_model = model_module._ACTIVE[models] if len(model_module._ACTIVE) > models else None
    # Linked builds don't make the host's own report.
    del design_module._DESIGNS[designs:]
    del model_module._ACTIVE[models:]
    del drawing_module.SHEETS[sheets:]  # Its drawings are its own builds' sheets.
    summary = linked_design.summary() if linked_design else linked_model.summary() if linked_model else None
    if linked_design and summary:
        # Its motion (animations, sweeps, cable checks) is reported in its own builds; the host places it fixed.
        summary.pop("kinematics", None)
    if source.get("document_id"):
        DOCUMENTS[id(result)] = source["document_id"]
    return LinkedInstance(alias, source, overrides, result, summary, namespace, model=linked_model, design=linked_design)


def _build_shop(alias: str, source: dict, overrides: dict, folder: Path, files: dict) -> LinkedInstance:
    """Runs a linked shop's main.py (written to `folder`) in its own module namespace: its folders (machines/, tools/, …)
    may be named like the host shop's, so the host's modules of those names step aside while it runs. Its `shop` and
    every name its main.py defines come back as the instance's namespace; nothing is placed."""
    from .shop import Shop
    names = {"params", "links"} | {path.split("/")[0].removesuffix(".py") for path in files}
    saved = {name: module for name, module in sys.modules.items() if name.split(".")[0] in names}
    for name in saved:
        del sys.modules[name]
    nested = _save_scope()
    sys.path.insert(0, str(folder))
    try:
        if source.get("links"):  # A linked shop's own links, one level down.
            register(source["links"], folder / ".linked")
            _write_links_module(folder, source["links"])
        namespace = runpy.run_path(str(folder / "main.py"), run_name="__linked__")
    finally:
        sys.path.remove(str(folder))
        for name in [n for n in sys.modules if n.split(".")[0] in names]:
            del sys.modules[name]
        sys.modules.update(saved)
        if source.get("links"):
            _restore_scope(nested)
    if not isinstance(namespace.get("shop"), Shop):
        raise LinkError(f"Linked {source.get('name') or alias} is a shop without `shop = Shop()` in its main.py.")
    return LinkedInstance(alias, source, overrides, None, {"kind": "shop"}, namespace)


def _write_links_module(folder: Path, sources: dict) -> None:
    package = folder / "links"
    package.mkdir(exist_ok=True)
    (package / "__init__.py").write_text("from steve.links import Link\n" + "".join(f"{alias} = Link({alias!r})\n" for alias in sources))


def install(sources: dict) -> None:
    """The `links` module for the design being built: one Link per alias (linked builds go in .linked/)."""
    register(sources, (Path.cwd() / ".linked").resolve())
    if sources:
        _write_links_module(Path.cwd(), sources)
