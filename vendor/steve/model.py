"""The feature list: human modeling operations as readable calls, with persistent names.

    model = Model()
    with model.sketch("sketch_1", on="XY") as s:
        s.rect("r1", (-40.0, -25.0), (40.0, 25.0))
    model.extrude("extrude_1", "sketch_1", distance=6)
    model.fillet("fillet_1", edges=["extrude_1.lateral_edges"], radius=4)
    result = model.result()

A failing feature is recorded and skipped, and later features still run, so the model
stays visible with the problem marked (docs/MODELING.md section 4).
"""
from __future__ import annotations

import base64
import dataclasses
import io
import json
import math
import os
import re
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

import cadquery as cq
from .reporting import surface_area
from cadquery.selectors import Selector
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer, BRepFilletAPI_MakeFillet
from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeThickSolid
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism, BRepPrimAPI_MakeRevol
from OCP.gp import gp_Ax1, gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Transform
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.collections import List_TopoDS_Shape
from OCP.TopAbs import TopAbs_REVERSED

from .naming import Names, _faces, _stable_key, edge_faces, edge_names, vertex_faces, vertex_names
from .sketch import POINT_KEYS, SolveReport, Sketch, SketchError
from .sheetmetal import SheetMetalMixin

CACHE_VERSION = 2  # Of a model's build-cache record (Model._record): a component's cache entry, a part's geometry record.
ID = re.compile(r"[a-z][a-z0-9_]*")
LABEL = re.compile(r"[A-Za-z0-9_]{1,32}")  # point_pattern's labels: pins[A2].pin.wall(0)
# CadQuery's six axis-pair planes (cq.Plane.named) and STEVE's view names. ZX, YX and ZY are not aliases of XZ, XY and
# YZ: their normals point the other way (ZX's is +Y, XZ's is -Y), so an extrude or a roll goes to the other side.
DATUM_PLANES = {"XY": "XY", "YZ": "YZ", "ZX": "ZX", "XZ": "XZ", "YX": "YX", "ZY": "ZY",
                "front": "XZ", "top": "XY", "right": "YZ"}
AXES = {"X": (0, 0, 0, 1, 0, 0), "Y": (0, 0, 0, 0, 1, 0), "Z": (0, 0, 0, 0, 0, 1)}
OPS = {"new", "join", "cut", "intersect"}


class FeatureError(Exception):
    """A feature that could not be built; the message is shown on that feature, and `detail` (names and sizes, never
    code) is merged into its detail."""

    def __init__(self, message: str, detail: dict | None = None):
        super().__init__(message)
        self.detail = detail


@dataclass
class Feature:
    id: str
    kind: str
    name: str
    status: str = "ok"
    error: str | None = None
    warning: str | None = None  # Advice on a feature that built (status stays "ok"): names the feature, never the person's values.
    ms: float = 0.0
    created: list[str] = field(default_factory=list)
    body: str | None = None
    detail: dict = field(default_factory=dict)

    def public(self) -> dict:
        out = {"id": self.id, "kind": self.kind, "name": self.name, "status": self.status, "ms": round(self.ms, 1)}
        if self.error:
            out["error"] = self.error
        if self.warning:
            out["warning"] = self.warning
        if self.body:
            out["body"] = self.body
        if self.detail:
            out["detail"] = self.detail
        return out


FIT_TRIALS = 6  # A failed fillet's bisection for the size that fits: trial fillets on its failing contours, at most.
LISTED = 8  # Names a fillet's error lists before "and N more".


def _make_fillet(before: cq.Shape, picked, size):
    """A fillet of (edge, name prefix, reversed) edges on `before`, built: (maker, done). `size` is a radius, or a
    variable fillet's (start, end) radii (swapped on a reversed edge)."""
    maker = BRepFilletAPI_MakeFillet(before.wrapped)
    for edge, _, backwards in picked:
        if isinstance(size, tuple):
            first, last = size
            maker.Add(float(last if backwards else first), float(first if backwards else last), edge.wrapped)
        else:
            maker.Add(float(size), edge.wrapped)
    try:
        maker.Build()
    except Exception:  # StdFail_NotDone, Standard_Failure: diagnosed like a build that returns not done.
        return maker, False
    return maker, maker.IsDone()


def _fillet_faults(maker) -> tuple[list[cq.Edge], list[cq.Vertex]]:
    """A failed fillet's faulty contours' edges (tangent ones the kernel followed included: they are the real blend) and
    faulty corners, in the kernel's order; nothing when it can't say."""
    try:
        edges: list[cq.Edge] = []
        for i in range(1, maker.NbFaultyContours() + 1):
            contour = maker.FaultyContour(i)
            for j in range(1, maker.NbEdges(contour) + 1):
                edge = cq.Edge(maker.Edge(contour, j))
                if edge not in edges:
                    edges.append(edge)
        corners = [cq.Vertex(maker.FaultyVertex(i)) for i in range(1, maker.NbFaultyVertices() + 1)]
    except Exception:
        return [], []
    return edges, corners


def _round_down(value: float) -> float:
    """`value` rounded down to two significant figures: 3.87 → 3.8."""
    step = 10 ** (math.floor(math.log10(value)) - 1)
    return round(math.floor(value / step) * step, 12)


def _mm(size) -> str:
    return f"{size:g} mm" if not isinstance(size, (list, tuple)) else f"{size[0]:g}–{size[1]:g} mm"


def _listed(names: list[str]) -> str:
    shown = ", ".join(names[:LISTED])
    return shown + (f" and {len(names) - LISTED} more" if len(names) > LISTED else "")


def _solid(shape: cq.Shape) -> cq.Shape:
    """Booleans return compounds; a single solid is easier to reason about downstream."""
    solids = shape.Solids()
    if len(solids) == 1:
        return solids[0]
    return shape


# Said wherever a surface body is left out (booleans, meshes, mass, simulation, CAM).
SURFACE_NOTE = "surface bodies aren't solids; thicken or solidify them first"


def is_surface(shape: cq.Shape) -> bool:
    """A surface body (model.fill, model.boundary_surface, model.add of faces): faces or an open shell, no solid."""
    return not shape.Solids() and bool(shape.Faces())


def _list(shapes) -> List_TopoDS_Shape:
    out = List_TopoDS_Shape()
    for shape in shapes:
        out.Append(shape.wrapped)
    return out


def _call_text(values) -> str | None:
    """A call's arguments as text, when they're all plain values (numbers, text, lists of them); else None."""
    def plain(value):
        if value is None or isinstance(value, (bool, int, float, str)):
            return True
        return isinstance(value, (list, tuple)) and all(plain(v) for v in value)
    return repr(values) if plain(values) else None


def _split_top(text: str, sep: str) -> list[str]:
    """Splits on `sep` outside parentheses."""
    parts, depth, current = [], 0, []
    for char in text:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == sep and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return parts


class Model(SheetMetalMixin):
    """A part: sketches, features and bodies built in order, each named by its id. End main.py with
    `result = model.result()`."""

    def __init__(self, name: str | None = None):
        self.name = name
        self.features: list[Feature] = []
        self.bodies: dict[str, cq.Shape] = {}
        self.active: str | None = None
        self.names = Names()
        self.sketches: dict[str, Sketch] = {}
        self.planes: dict[str, cq.Plane] = {}
        self.axes: dict[str, tuple] = {}
        self.points: dict[str, cq.Vector] = {}
        self._tools: dict[str, tuple] = {}
        self._edge_ops: dict[str, tuple] = {}  # Fillets and chamfers: (kind, [(edge, measured face's normal)], sizes, names).
        self._ids: set[str] = set()
        # A part's own model (main.py's `model = Model()`): restored from an earlier build of the same geometry when the
        # build was sent one (part_record).
        if type(self) is Model and sys._getframe(1).f_code.co_filename == MAIN_FILE:
            _MAIN_MODELS.append(self)
            if len(_MAIN_MODELS) == 1 and (record := part_record()) is not None:
                try:
                    self._restore(record)
                    self.cache = "hit"
                except Exception as error:  # A record that doesn't load means a normal build, never a failed one.
                    print(f"Warning: the part's earlier geometry was ignored: {type(error).__name__}", file=sys.stderr)
                    self.__dict__.clear()  # Nothing a half-restored record left behind survives.
                    Model.__init__(self, name)

    # ───────── feature plumbing ─────────

    def _begin(self, id: str, kind: str, name: str | None) -> Feature:
        if not isinstance(id, str) or not ID.fullmatch(id):
            raise FeatureError(f"Feature id {id!r} must be lowercase letters, digits and underscores, starting with a letter.")
        if id in self._ids:
            raise FeatureError(f"Feature id {id!r} is used twice.")
        self._ids.add(id)
        feature = Feature(id=id, kind=kind, name=name or id.replace("_", " ").capitalize())
        self.features.append(feature)
        if getattr(self, "_restored", False):  # A decal on a restored model: back in its place in the history.
            self._reinsert(feature)
        return feature

    @contextmanager
    def _feature(self, id, kind, name, suppressed=False):
        # A model restored from its build cache (a design component, or a part from an earlier build): nothing to
        # rebuild. Decals aren't geometry: they run again on the restored faces (their statements aren't in the cache
        # key, steve.cachekeys).
        if getattr(self, "_restored", False) and kind != "decal":
            yield None
            return
        feature = self._begin(id, kind, name)
        if suppressed:
            feature.status = "suppressed"
            yield None
            return
        started = time.perf_counter()
        try:
            yield feature
            if feature.status == "ok":
                self._name_unnamed(id)
        except (FeatureError, SketchError) as error:
            feature.status, feature.error = "error", str(error)
            if isinstance(getattr(error, 'sheet_diagnostic', None), dict):
                feature.detail['diagnostic'] = {'feature': id, **error.sheet_diagnostic}
            if isinstance(getattr(error, 'detail', None), dict):
                feature.detail.update(error.detail)
        except Exception as error:  # Kernel failures (StdFail_NotDone, …) become feature errors.
            feature.status = "error"
            feature.error = f"{type(error).__name__}: {error}" if str(error) else f"The geometry kernel rejected this {kind}."
        finally:
            feature.ms = (time.perf_counter() - started) * 1000

    def _name_unnamed(self, prefix: str) -> None:
        """Backstop for history gaps (booleans, face merges, repairs): a face no history named is named after the
        feature that left it and its named neighbours, `cut_1.face(a|b)` (`[i]` when that repeats)."""
        index = self.names.index()
        for body in self.bodies.values():
            orphans = [face for face in body.Faces() if face not in index]
            if not orphans:
                continue
            adjacent = edge_faces(body)
            groups: dict[str, list[cq.Face]] = {}
            for face in orphans:
                labels = sorted({index[other] for edge in face.Edges() for other in adjacent.get(edge, ()) if other in index})
                groups.setdefault(f"{prefix}.face({'|'.join(labels) or '?'})", []).append(face)
            for key, faces in groups.items():
                if len(faces) == 1 and key not in self.names.faces:
                    self.names.add(key, faces)
                    continue
                for i, face in enumerate(sorted(faces, key=_stable_key)):
                    self.names.add(f"{key}[{i}]", [face])

    def feature(self, id: str) -> Feature | None:
        """The feature with this id (its status, error and detail), or None."""
        return next((f for f in self.features if f.id == id), None)

    # ───────── datums and references ─────────

    def plane_of(self, ref) -> cq.Plane:
        """The plane a reference names: "XY", "YZ", "ZX", "XZ", "YX", "ZY" (as cq.Plane.named; ZX's normal is +Y, XZ's
        is -Y) or "top", "front", "right" (XY, XZ, YZ), a construction plane's id, one
        planar face ref, or a literal ((x, y, z) origin, (nx, ny, nz) normal, (dx, dy, dz) x direction)."""
        if isinstance(ref, cq.Plane):
            return ref
        if (other := _foreign(ref, self)):
            return other[0].plane_of(other[1])
        if isinstance(ref, (list, tuple)) and len(ref) == 3 and all(isinstance(v, (list, tuple)) and len(v) == 3 for v in ref):
            origin, normal, x_dir = ref  # A literal plane: (origin, normal, x direction).
            return cq.Plane(origin=tuple(float(v) for v in origin), xDir=tuple(float(v) for v in x_dir), normal=tuple(float(v) for v in normal))
        if isinstance(ref, str):
            if ref in DATUM_PLANES:
                return cq.Plane.named(DATUM_PLANES[ref])
            if ref in self.planes:
                return self.planes[ref]
            if ref not in self.names.faces and not any(c in ref for c in ".(["):  # A bare name, not a face reference.
                raise FeatureError(f"{ref!r} is not a plane or face here; named planes are {', '.join(DATUM_PLANES)}, "
                                   "or give a construction plane id or one planar face.")
            faces = self.faces(ref)
            if len(faces) != 1:
                raise FeatureError(f"{ref!r} is {len(faces)} faces; a sketch needs one planar face or plane.")
            return _face_plane(faces[0])
        raise FeatureError(f"Can't place a sketch on {ref!r}.")

    def axis_of(self, ref) -> gp_Ax1:
        """The axis a reference names, in every form revolve, circular_pattern and the joints take: "X", "Y" or "Z", a
        named axis (model.axis), a sketch line "<sketch>.<line>", a straight or circular edge ref, or a literal
        ((x, y, z), (dx, dy, dz))."""
        if (other := _foreign(ref, self)):
            return other[0].axis_of(other[1])
        if isinstance(ref, (list, tuple)) and len(ref) == 2 and all(isinstance(v, (list, tuple)) and len(v) == 3 for v in ref):
            (x, y, z), (dx, dy, dz) = ref  # A literal axis: (point, direction).
            return gp_Ax1(gp_Pnt(float(x), float(y), float(z)), gp_Dir(float(dx), float(dy), float(dz)))
        if isinstance(ref, str) and ref in AXES:
            x, y, z, dx, dy, dz = AXES[ref]
            return gp_Ax1(gp_Pnt(x, y, z), gp_Dir(dx, dy, dz))
        if isinstance(ref, str) and ref in self.axes:
            x, y, z, dx, dy, dz = self.axes[ref]
            return gp_Ax1(gp_Pnt(x, y, z), gp_Dir(dx, dy, dz))
        if isinstance(ref, str) and "." in ref and ref.split(".", 1)[0] in self.sketches:
            sketch_id, entity = ref.split(".", 1)
            sketch = self.sketches[sketch_id]
            line = sketch.entities.get(entity)
            if not line or line["type"] != "line":
                raise FeatureError(f"Axis {ref!r} must be a line in sketch {sketch_id}.")
            a, b = sketch.plane.toWorldCoords(tuple(line["start"])), sketch.plane.toWorldCoords(tuple(line["end"]))
            d = (b - a).normalized()
            return gp_Ax1(gp_Pnt(a.x, a.y, a.z), gp_Dir(d.x, d.y, d.z))
        edges = self.edges(ref)
        if len(edges) == 1 and edges[0].geomType() == "LINE":
            a, b = edges[0].startPoint(), edges[0].endPoint()
            d = (b - a).normalized()
            return gp_Ax1(gp_Pnt(a.x, a.y, a.z), gp_Dir(d.x, d.y, d.z))
        if len(edges) == 1 and edges[0].geomType() == "CIRCLE":
            c, n = edges[0].arcCenter(), edges[0].normal()
            return gp_Ax1(gp_Pnt(c.x, c.y, c.z), gp_Dir(n.x, n.y, n.z))
        raise FeatureError(f"Axis {ref!r} must be X, Y, Z, a sketch line, a straight edge, a circular edge or ((x, y, z), (dx, dy, dz)).")

    def sketch_edges(self, ref) -> list[cq.Edge] | None:
        """The curves "<sketch>.<entity>" names, construction included, in the model's frame: one entity ("cl.w.side0",
        "cl.arc1") or a group of them by its prefix ("cl.w": every side of polyline w). None when `ref` isn't a sketch
        reference. Sweep paths, drawing dimensions and axes use these, never the solid's faces."""
        if not isinstance(ref, str) or "." not in ref or ref.split(".", 1)[0] not in self.sketches:
            return None
        sketch_id, entity = ref.split(".", 1)
        curves = [edge for eid, edge in self.sketches[sketch_id].all_edges() if eid == entity or eid.startswith(entity + ".")]
        if not curves:
            raise FeatureError(f"Sketch {sketch_id} has no curve {entity!r} now.")
        return curves

    def _bodies_list(self) -> list[tuple[str, cq.Shape]]:
        return list(self.bodies.items())

    def faces(self, ref) -> list[cq.Face]:
        """The faces one reference (or a list of them) names: "extrude_1.end", "extrude_1.side_faces",
        "extrude_1.faces", select(faces, ">Z") or a CadQuery selector."""
        refs =ref if isinstance(ref, (list, tuple)) else [ref]
        # Resolve to the bodies' own face objects so normals follow the faces' current orientation.
        current = {face: face for _, body in self._bodies_list() for face in body.Faces()}
        out: list[cq.Face] = []
        for item in refs:
            for face in self._faces_one(item):
                face = current.get(face, face)
                if face not in out:
                    out.append(face)
        return out

    def _faces_one(self, ref: str) -> list[cq.Face]:
        if (other := _foreign(ref, self)):
            return other[0].faces(other[1])
        if isinstance(ref, Selector):
            return [s for s in self._select_with(ref, "faces") if isinstance(s, cq.Face)]
        if not isinstance(ref, str):
            raise FeatureError(f"Face reference {ref!r} must be a string or a CadQuery selector.")
        if ref.startswith("select("):
            return [s for s in self._select(ref) if isinstance(s, cq.Face)]
        index = None
        match = re.fullmatch(r"(.*)\[(\d+)\]", ref)
        if match and match.group(1) in self.names.faces:
            ref, index = match.group(1), int(match.group(2))
        if ref in self.names.faces:
            faces = self.names.faces[ref]
            if not faces:
                raise FeatureError(f"Reference {ref!r} no longer exists: an earlier change removed that face.")
            if index is not None:
                ordered = self.names.pieces(ref)
                if index >= len(ordered):
                    raise FeatureError(f"Reference {ref}[{index}] no longer exists.")
                return [ordered[index]]
            return list(faces)
        for suffix, prefix in ((".faces", "."), (".side_faces", ".side(")):
            if ref.endswith(suffix):
                base = ref[: -len(suffix)]
                found = [face for name in self.names.matching(base + prefix) for face in self.names.faces[name]]
                if not found:
                    raise FeatureError(f"Reference {ref!r} matches no faces.")
                return found
        raise FeatureError(f"Unknown face reference {ref!r}.{_numbered_hint(ref)}")

    def edges(self, ref) -> list[cq.Edge]:
        """The edges one reference (or a list of them) names: "edge(<face>|<face>)", "extrude_1.lateral_edges",
        "extrude_1.end_edges", select(edges, "%CIRCLE"), a CadQuery selector, or a face ref (all of its edges)."""
        refs =ref if isinstance(ref, (list, tuple)) else [ref]
        out: list[cq.Edge] = []
        for item in refs:
            for edge in self._edges_one(item):
                if edge not in out:
                    out.append(edge)
        return out

    def _edge_table(self) -> dict[str, cq.Edge]:
        bodies = self._bodies_list()
        # Rebuilt only when a feature changed the bodies or the names (fillets look up many edges at once).
        key = (tuple((name, hash(body)) for name, body in bodies), tuple((n, len(f)) for n, f in self.names.faces.items()))
        if getattr(self, "_edge_cache", (None,))[0] == key:
            return self._edge_cache[1]
        table: dict[str, cq.Edge] = {}
        for _, body in bodies:
            for edge, name in edge_names(body, self.names).items():
                table[name] = edge
        self._edge_cache = (key, table)
        return table

    def _edges_one(self, ref: str) -> list[cq.Edge]:
        if (other := _foreign(ref, self)):
            return other[0].edges(other[1])
        if isinstance(ref, Selector):
            return [s for s in self._select_with(ref, "edges") if isinstance(s, cq.Edge)]
        if not isinstance(ref, str):
            raise FeatureError(f"Edge reference {ref!r} must be a string or a CadQuery selector.")
        if ref.startswith("select("):
            return [s for s in self._select(ref) if isinstance(s, cq.Edge)]
        if (curves := self.sketch_edges(ref)) is not None:
            return curves
        if ref.startswith("edge("):
            table = self._edge_table()
            indexed = re.fullmatch(r"(.*\))\[(\d+)\]", ref)
            base = indexed.group(1) if indexed else ref
            pieces = [edge for name, edge in table.items() if name == base or name.startswith(base + "[")]
            if not pieces:
                # Faces can carry several names (e.g. coplanar faces merged by a boolean): match by the faces themselves.
                pieces = self._edges_joining(base)
            if not indexed:
                # "The edge between these two faces": if a later cut split it, all of its pieces.
                if pieces:
                    return pieces
                raise FeatureError(f"Edge {ref!r} no longer exists: the two faces it joined no longer meet.{_numbered_hint(ref)}")
            if ref in table and len(pieces) > 1:
                return [table[ref]]
            if len(pieces) == 1:
                return pieces  # Several edges merged into one.
            raise FeatureError(f"Edge {ref!r} is ambiguous now: those faces meet along {len(pieces)} edges. Pick the edge again.")
        if ref.endswith(".lateral_edges"):
            base = ref[: -len(".lateral_edges")]
            found = self._edges_between(base + ".side(", base + ".side(", same=True)
            if not found:
                raise FeatureError(f"Reference {ref!r} matches no edges (an earlier fillet or cut may have consumed them).")
            return found
        for suffix, cap in ((".end_edges", ".end"), (".start_edges", ".start")):
            if ref.endswith(suffix):
                return self._edges_one(ref[: -len(suffix)] + cap)  # The cap's whole boundary.
        # A face (or face group) stands for all of its edges.
        faces = self._faces_one(ref)
        out: list[cq.Edge] = []
        for face in faces:
            for edge in face.Edges():
                if edge not in out:
                    out.append(edge)
        return out

    def projection_source(self, ref) -> list:
        """What a sketch projection refers to, in 3D: edges (a face stands for its outline, seams left out),
        vertices, or curves of another sketch (`sketch_2` or `sketch_2.c1`). Resolved at the sketch's point
        in history, so projections follow upstream changes."""
        out: list = []
        for item in ref if isinstance(ref, list) or (isinstance(ref, tuple) and not _foreign(ref)) else [ref]:
            if (other := _foreign(item, self)):
                out.extend(other[0].projection_source(other[1]))
                continue
            if isinstance(item, Selector):
                out.extend(self.edges(item))
                continue
            if not isinstance(item, str):
                raise FeatureError(f"Projection reference {item!r} must be a string.")
            head, _, rest = item.partition(".")
            if head in self.sketches and not item.startswith(("edge(", "vertex(", "select(")):
                out.extend(self.sketches[head].world_edges(rest or None))
            elif item.startswith("vertex("):
                found = [v for _, body in self._bodies_list() for v, name in vertex_names(body, self.names).items()
                         if name == item or name.startswith(item + "[")]
                if not found:
                    raise FeatureError(f"Vertex {item!r} no longer exists.")
                out.extend(found)
            elif item.startswith(("edge(", "select(edges")) or item.endswith("_edges"):
                out.extend(self.edges(item))
            else:
                from OCP.BRep import BRep_Tool
                for face in self.faces(item):
                    out.extend(e for e in face.Edges() if not BRep_Tool.IsClosed_s(e.wrapped, face.wrapped))
        return out

    def _edges_joining(self, base: str) -> list[cq.Edge]:
        """Edges shared by the faces named in `edge(A|B)`, whatever names those faces are exported under."""
        inner = base[len("edge("):-1]
        parts = _split_top(inner, "|")
        if len(parts) != 2:
            return []
        try:
            faces_a, faces_b = set(self._faces_one(parts[0])), set(self._faces_one(parts[1]))
        except FeatureError:
            return []
        from .naming import edge_faces
        found = []
        for _, body in self._bodies_list():
            for edge, adjacent in edge_faces(body).items():
                if any(f in faces_a for f in adjacent) and any(f in faces_b for f in adjacent) and edge not in found:
                    found.append(edge)
        return sorted(found, key=lambda e: e.Center().dot(cq.Vector(1.0, 1e-3, 1e-6)))

    def _edges_between(self, prefix_a: str, prefix_b: str, same: bool) -> list[cq.Edge]:
        faces_a = {face for name in self.names.matching(prefix_a) for face in self.names.faces[name]}
        faces_b = {face for name in self.names.matching(prefix_b) for face in self.names.faces[name]}
        out: list[cq.Edge] = []
        for _, body in self._bodies_list():
            from .naming import edge_faces
            for edge, adjacent in edge_faces(body).items():
                in_a = [f for f in adjacent if f in faces_a]
                in_b = [f for f in adjacent if f in faces_b]
                if same:
                    ok = len(in_a) >= 2
                else:
                    ok = bool(in_a) and bool(in_b)
                if ok and edge not in out:
                    out.append(edge)
        return out

    def _select(self, ref: str):
        scoped = re.fullmatch(r"select\(\s*(faces|edges|vertices)\s*,\s*([\"'])(.+?)\2\s*,\s*on\s*=\s*([\"'])(.+?)\4\s*\)", ref)
        if scoped:
            kind, _, selector, _, on = scoped.groups()
            return self._select_with(selector, kind, on, ref)
        match = re.fullmatch(r"select\(\s*(faces|edges|vertices)\s*,\s*[\"']?(.+?)[\"']?\s*\)", ref)
        if not match:
            raise FeatureError(f"Selector reference {ref!r} must look like select(faces, \">Z\") or select(edges, \"%CIRCLE\", on=\"body_1\").")
        kind, selector = match.groups()
        return self._select_with(selector, kind, None, ref)

    def _select_with(self, selector, kind: str, on: str | None = None, label=None):
        """Runs a CadQuery selector (string or Selector object) over every body, or only over `on`
        (a body id, a feature id or a face reference). Resolved at each build, so it follows upstream changes."""
        if on is None:
            scopes = [body for _, body in self._bodies_list()]
        elif on in self.bodies:
            scopes = [self.bodies[on]]
        else:  # A feature id stands for the faces it made (e.g. a model.add joined into another body).
            scopes = [cq.Compound.makeCompound(self._faces_one(on + ".faces" if ID.fullmatch(on) else on))]
        label = label or (f"Selector {selector!r}" if isinstance(selector, str) else f"The {type(selector).__name__}")
        out = []
        for scope in scopes:
            try:
                out.extend(getattr(cq.Workplane(obj=scope), kind)(selector).vals())
            except (ValueError, AttributeError, IndexError) as exc:
                raise FeatureError(f"{label} couldn't be applied to {kind}: {exc}") from exc
        if not out:
            raise FeatureError(f"{label} selects nothing.")
        return out

    def body_of(self, shapes, op: str | None = None) -> str:
        """The id of the one body holding all of these faces or edges. With `op` (a feature that reshapes a solid: "fillet",
        "shell"…), a surface body is refused with the note why."""
        for body_id, body in self._bodies_list():
            faces = set(body.Faces())
            edges = set(body.Edges())
            if all((s in faces) if isinstance(s, cq.Face) else (s in edges) for s in shapes):
                if op is not None:
                    self._solid_only(body_id, op)
                return body_id
        raise FeatureError("The selected geometry spans several bodies; pick it from one body.")

    def _solid_only(self, body_id: str, op: str):
        """Refuses a feature that reshapes a solid (fillet, chamfer, shell, draft) on a surface body, saying why."""
        if body_id in self.bodies and is_surface(self.bodies[body_id]):
            raise FeatureError(f"A {op} works on a solid, and {body_id!r} is a surface body: {SURFACE_NOTE}.")

    # ───────── body bookkeeping ─────────

    def _solid_target(self) -> str:
        """The body a join, cut or intersect goes into when none is named: the active body, or the first solid one when
        the active body is a surface."""
        active = self.active or next(iter(self.bodies))
        if active not in self.bodies or not is_surface(self.bodies[active]):
            return active
        return next((body_id for body_id, shape in self.bodies.items() if not is_surface(shape)), active)

    def _apply(self, feature: Feature, tool: cq.Shape, tool_names: Names, op: str, body: str | None, label: str | None = None):
        """Combines a feature's tool body with the model and carries every name through. A surface tool only ever
        makes a body of its own."""
        surface = is_surface(tool)
        op = op or ("new" if surface or not any(not is_surface(b) for b in self.bodies.values()) else "join")
        if op not in OPS:
            raise FeatureError(f"Operation {op!r} must be one of new, join, cut, intersect.")
        if surface and op != "new":
            raise FeatureError(f"A surface can't {op} with a body: {SURFACE_NOTE}.")
        tool = _solid(tool)
        if op == "new" or not self.bodies:
            if op in {"cut", "intersect"}:
                raise FeatureError(f"There is no body to {op} yet.")
            body_id = body or feature.id
            if body_id in self.bodies:
                raise FeatureError(f"Body {body_id!r} already exists.")
            self.bodies[body_id] = tool
            self.names.merge(tool_names)
            if not surface or self.active not in self.bodies:  # Later features still go into the solid they were building.
                self.active = body_id
            feature.body = body_id
            feature.created = list(tool_names.faces)
            return
        target_id = body or self._solid_target()
        if target_id not in self.bodies:
            raise FeatureError(f"Body {target_id!r} doesn't exist.")
        target = self.bodies[target_id]
        if is_surface(target):
            raise FeatureError(f"Body {target_id!r} is a surface, so nothing can {op} with it: {SURFACE_NOTE}.")
        combined = self._boolean(op, target, [tool], tool_names, f"of {label} with {target_id}" if label else f"with {target_id}")
        if not combined.Solids():
            raise FeatureError(f"The {op} left no material in {target_id}.")
        self.bodies[target_id] = _solid(combined)
        self.active = target_id
        feature.body = target_id
        feature.created = [name for name in tool_names.faces if self.names.faces.get(name)]

    def _apply_many(self, feature: Feature, tools: list, tool_names: Names, op: str, body: str | None):
        """Like _apply for several tools at once (patterns): one boolean against the target body. New bodies (copies
        of a surface, say) are `<body or id>_<n>`."""
        if len(tools) == 1 or op == "new" or not self.bodies:
            for n, tool in enumerate(tools, start=1):
                self._apply(feature, tool, tool_names, op, f"{body or feature.id}_{n}" if op == "new" and len(tools) > 1 else body)
            return
        if any(is_surface(tool) for tool in tools):
            raise FeatureError(f"A surface can't {op} with a body: {SURFACE_NOTE}.")
        target_id = body or self._solid_target()
        if target_id not in self.bodies:
            raise FeatureError(f"Body {target_id!r} doesn't exist.")
        target = self.bodies[target_id]
        if is_surface(target):
            raise FeatureError(f"Body {target_id!r} is a surface, so nothing can {op} with it: {SURFACE_NOTE}.")
        combined = self._boolean(op, target, tools, tool_names, f"of {len(tools)} copies with {target_id}")
        if not combined.Solids():
            raise FeatureError(f"The {op} left no material in {target_id}.")
        self.bodies[target_id] = _solid(combined)
        self.active = target_id
        feature.body = target_id
        feature.created = [name for name in tool_names.faces if self.names.faces.get(name)]

    def _boolean(self, op: str, target: cq.Shape, tools: list, tool_names: Names, what: str) -> cq.Shape:
        """Runs one boolean of `tools` against `target` and carries every name through. A result BRepCheck rejects
        is repaired when it can be (without the face merge, then ShapeFix, then once more with a small fuzzy
        tolerance for near-coincident or approximated intersections); otherwise this feature fails by name and the
        bodies stay as they were, instead of every feature reading ok and the whole build failing at the end."""
        before = {name: list(faces) for name, faces in self.names.faces.items()}
        fuzzy = cq.Compound.makeCompound([target, *tools]).BoundingBox().DiagonalLength * 1e-6
        built, inputs_valid = False, None
        for tolerance in (0.0, fuzzy):
            self.names.faces = {name: list(faces) for name, faces in before.items()}
            maker = {"join": BRepAlgoAPI_Fuse, "cut": BRepAlgoAPI_Cut, "intersect": BRepAlgoAPI_Common}[op]()
            maker.SetArguments(_list([target]))
            maker.SetTools(_list(tools))
            if tolerance:
                maker.SetFuzzyValue(tolerance)
            maker.SetRunParallel(False)  # Serial, as every boolean in a build (run.keep_booleans_serial).
            maker.Build()
            if not maker.IsDone():
                continue
            built = True
            raw = cq.Shape.cast(maker.Shape())
            self.names.merge(tool_names)
            self.names.update(maker, raw, [target, *tools])
            carried = {name: list(faces) for name, faces in self.names.faces.items()}
            combined = self._clean(raw, [raw])
            if not combined.Solids() or combined.isValid():
                return combined
            if inputs_valid is None:
                inputs_valid = all(shape.isValid() for shape in (target, *tools))
            if not inputs_valid:
                return combined  # The inputs were already invalid: not something this boolean broke.
            self.names.faces = carried
            if raw.isValid():
                return raw  # The face merge broke it (e.g. on a torus's periodic faces): keep the unmerged faces.
            try:
                fixed = self._fix(raw)
            except Exception:  # noqa: BLE001 - a failed repair is reported below like an unrepaired one
                fixed = None
            if fixed is not None and fixed.Solids() and fixed.isValid():
                return fixed
        self.names.faces = before
        if not built:
            raise FeatureError(f"The {op} {what} failed in the geometry kernel.")
        raise FeatureError(f"The {op} {what} left invalid geometry (often tangent, coincident or self-intersecting faces), "
                           "so the bodies were left as they were.")

    def _fix(self, shape: cq.Shape) -> cq.Shape:
        """ShapeFix's general repair; names follow its history where the binding provides one."""
        from OCP.ShapeFix import ShapeFix_Shape
        fix = ShapeFix_Shape(shape.wrapped)
        fix.Perform()
        fixed = cq.Shape.cast(fix.Shape())
        try:
            self.names.update(fix.Context().History(), fixed, [shape])
        except Exception:  # noqa: BLE001 - without a history, faces the fix left alone keep their names
            self.names.update(None, fixed, [shape])  # Every lookup in the missing history finds nothing.
        return fixed

    def _clean(self, shape: cq.Shape, inputs, names: Names | None = None) -> cq.Shape:
        """Merges coplanar faces left by booleans; names (the model's, or `names`) follow the merge. It merges a copy:
        the merge changes the edges and faces it works on in place, and a boolean's result shares those with its
        inputs, so merging the result itself could break both (a torus joined to a cylinder: the tool and the unmerged
        result left invalid, and the boolean took them for inputs that were already broken)."""
        from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
        names = self.names if names is None else names
        copier = BRepBuilderAPI_Copy(shape.wrapped, False)  # The topology: surfaces stay shared, so faces on one still merge.
        copied = cq.Shape.cast(copier.Shape())
        names.update(copier, copied, inputs)
        unify = ShapeUpgrade_UnifySameDomain(copied.wrapped, True, True, True)
        unify.Build()
        cleaned = cq.Shape.cast(unify.Shape())
        names.update(unify.History(), cleaned, [copied])
        return cleaned

    def _replace(self, body_id: str, maker, before: cq.Shape) -> cq.Shape:
        after = cq.Shape.cast(maker.Shape())
        if not after.isValid() and before.isValid():  # Name the feature that broke the body, not the final check.
            raise FeatureError(f"This left {body_id} with invalid geometry (often tangent, coincident or self-intersecting "
                               "faces), so the body was left as it was.")
        self.names.update(maker, after, [before])
        after = _solid(after)
        self.bodies[body_id] = after
        return after

    # ───────── construction ─────────

    def plane(self, id, on="XY", offset=0.0, angle=0.0, axis=None, name=None, suppressed=False):
        """A construction plane: offset from a plane or planar face, optionally rotated about an axis."""
        with self._feature(id, "plane", name, suppressed) as feature:
            if feature is None:
                return None
            if id in DATUM_PLANES:  # `on=` resolves datum names first, so a plane with this id could never be used.
                raise FeatureError(f"{id!r} is the name of a built-in plane; give this plane another id, e.g. "
                                   f"{id}_plane (its display name can still be {id!r}).")
            base = self.plane_of(on)
            origin = base.origin + base.zDir * float(offset)
            plane = cq.Plane(origin=origin, xDir=base.xDir, normal=base.zDir)
            if angle:
                rotation_axis = axis or "x"
                plane = plane.rotated((float(angle), 0, 0) if rotation_axis == "x" else (0, float(angle), 0))
            self.planes[id] = plane
            return plane
        return None

    def axis(self, id, through=None, direction=(0, 0, 1), name=None, suppressed=False):
        """A construction axis named `id`, for revolve, patterns and joints: through a point (x, y, z) along
        `direction`, or along an existing axis or edge (`through="sketch_1.l1"`, an edge ref).

            model.axis("spin", through=(10, 0, 0), direction=(0, 0, 1))
        """
        with self._feature(id, "axis", name, suppressed) as feature:
            if feature is None:
                return None
            if isinstance(through, str):
                ax = self.axis_of(through)
                p, d = ax.Location(), ax.Direction()
                self.axes[id] = (p.X(), p.Y(), p.Z(), d.X(), d.Y(), d.Z())
            else:
                x, y, z = through or (0, 0, 0)
                dx, dy, dz = direction
                self.axes[id] = (float(x), float(y), float(z), float(dx), float(dy), float(dz))
        return None

    # ───────── sketches ─────────

    @contextmanager
    def sketch(self, id, on="XY", name=None, suppressed=False):
        """A 2D sketch on a plane or planar face (`on`: "XY", "YZ", "ZX", "XZ", "YX", "ZY", a construction plane or a face ref), used as
        a `with` block; it is solved when the block ends. Its curves (Sketch methods) close into regions that extrude,
        revolve, loft and sweep take as profiles.

            with model.sketch("sketch_1", on="XY") as s:
                s.circle("c1", (0, 0), 10)
        """
        if getattr(self, "_restored", False):  # Restored from the build cache: the statements run against a throwaway sketch.
            yield Sketch(id, cq.Plane.named("XY"), name or id)
            return
        feature = self._begin(id, "sketch", name)
        started = time.perf_counter()
        try:
            plane = self.plane_of(on)
        except FeatureError as error:
            feature.status, feature.error = "error", str(error)
            plane = cq.Plane.named("XY")
        sketch = Sketch(id, plane, feature.name)
        sketch.model = self
        try:
            yield sketch
        except SketchError as error:
            feature.status, feature.error = "error", str(error)
        if suppressed:
            feature.status = "suppressed"
            return
        if feature.status == "ok":
            try:
                report = sketch.solve()
                sketch.regions()
                feature.detail = {"solver": report.status, "dof": report.dof, "profiles": len(sketch.regions())}
            except SketchError as error:
                feature.status, feature.error = "error", str(error)
                feature.detail = {"conflicting": error.ids}
        self.sketches[id] = sketch
        feature.ms = (time.perf_counter() - started) * 1000

    def _profile_faces(self, profile) -> tuple[list[cq.Face], dict[cq.Edge, str], Sketch]:
        """Faces to sweep and each edge's sketch entity, from a sketch id or region refs."""
        refs = profile if isinstance(profile, (list, tuple)) else [profile]
        sketch_id = refs[0].split(".", 1)[0] if isinstance(refs[0], str) else None
        if sketch_id not in self.sketches:
            raise FeatureError(f"Profile {refs[0]!r} must name a sketch or one of its regions.")
        sketch = self.sketches[sketch_id]
        status = self.feature(sketch_id)
        if status and status.status == "error":
            raise FeatureError(f"Sketch {sketch_id} has an error: fix it first.")
        regions = sketch.profile(None if refs == [sketch_id] else refs)
        owner: dict[cq.Edge, str] = {}
        for eid, edge in sketch.edges():
            owner[edge] = eid
        faces = [region.face for region in regions]
        entity_of: dict[cq.Edge, str] = {}
        for face in faces:
            for edge in face.Edges():
                entity_of[edge] = owner.get(edge) or _nearest(edge, sketch.edges())
        return faces, entity_of, sketch

    # ───────── solid features ─────────

    def extrude(self, id, profile, distance=None, both=False, through_all=False, direction=None,
                op=None, body=None, name=None, suppressed=False):
        """Extrudes sketch profiles along the sketch normal: a distance (negative = reverse),
        symmetric with `both=True`, or through the whole model (`through_all=True`, usually with op="cut")."""
        with self._feature(id, "extrude", name, suppressed) as feature:
            if feature is None:
                return
            faces, entity_of, sketch = self._profile_faces(profile)
            normal = sketch.plane.zDir if direction is None else cq.Vector(*direction).normalized()
            if through_all:
                length = self._extent() * 2 + 10
                start_shift, depth = -length / 2, length
            else:
                if distance is None or float(distance) == 0:
                    raise FeatureError("Give the extrusion a non-zero distance.")
                d = float(distance)
                start_shift, depth = (-abs(d) / 2, abs(d)) if both else ((0.0, d) if d > 0 else (d, -d))
            tool_names = Names()
            solids = []
            for face in faces:
                moved = face.translate(normal * start_shift) if start_shift else face
                moved_owner = {e2: entity_of.get(e1) for e1, e2 in zip(face.Edges(), moved.Edges())}
                prism = BRepPrimAPI_MakePrism(moved.wrapped, gp_Vec(*(normal * depth).toTuple()))
                prism.Build()
                if not prism.IsDone():
                    raise FeatureError("The profile could not be extruded.")
                solid = cq.Shape.cast(prism.Shape())
                tool_names.add(f"{id}.start", [prism.FirstShape()])
                tool_names.add(f"{id}.end", [prism.LastShape()])
                for edge, entity in moved_owner.items():
                    if entity:
                        tool_names.add(f"{id}.side({entity})", [s for s in prism.Generated(edge.wrapped)])
                solids.append(solid)
            tool = solids[0] if len(solids) == 1 else _fuse_all(solids, tool_names)
            self._record_tool(feature, tool, tool_names, op, body)

    def revolve(self, id, profile, axis, angle=360.0, op=None, body=None, name=None, suppressed=False):
        """Turns sketch profiles (sketch ids or region refs, as extrude takes) about an axis into a solid.

        `axis`: "X", "Y" or "Z" (through the origin); a named axis (model.axis); a sketch line "<sketch>.<line>"; a
        straight edge ref (its line) or a circular edge ref (its centre and normal); or a literal
        ((x, y, z), (dx, dy, dz)), a point and a direction. `angle` in degrees (360 or more: a full turn; negative turns
        the other way). The profile must lie on one side of the axis (touching it is fine). `op` and `body` as for
        extrude: "join" (the default once there is a body), "cut", "intersect" or "new" (`body` names the new body or
        the one to change). Faces: "<id>.side(<entity>)" for each profile edge's surface, and "<id>.start" /
        "<id>.end" for a partial turn.

            model.revolve("revolve_1", "sketch_1", axis="Z")
            model.revolve("revolve_2", "sketch_2", axis=((0, 0, 0), (0, 1, 0)), angle=90)
        """
        with self._feature(id, "revolve", name, suppressed) as feature:
            if feature is None:
                return
            faces, entity_of, _ = self._profile_faces(profile)
            ax = self.axis_of(axis)
            full = abs(float(angle)) >= 360
            tool_names = Names()
            solids = []
            crossing = ("The profile crosses the revolve axis; it must lie entirely on one side (touching the axis is fine). "
                        "Trim it at the axis or pick a different axis.")
            for face in faces:
                if _crosses_axis(face, ax):
                    raise FeatureError(crossing)
                revol = BRepPrimAPI_MakeRevol(face.wrapped, ax, math.radians(360 if full else float(angle)))
                revol.Build()
                if not revol.IsDone() or revol.Shape().IsNull():
                    raise FeatureError("The profile could not be revolved (it may cross the axis).")
                for edge, entity in entity_of.items():
                    if entity and edge in face.Edges():
                        tool_names.add(f"{id}.side({entity})", [s for s in revol.Generated(edge.wrapped)])
                if not full:
                    tool_names.add(f"{id}.start", [revol.FirstShape()])
                    tool_names.add(f"{id}.end", [revol.LastShape()])
                solid = cq.Shape.cast(revol.Shape())
                # OCCT reports no history for edges perpendicular to the axis in a full turn:
                # name those faces by rotating an interior point back onto the profile.
                named = {f for faces_ in tool_names.faces.values() for f in faces_}
                for face_ in solid.Faces():
                    if face_ not in named:
                        entity = _revolved_source(face_, ax, face, entity_of)
                        if entity:
                            tool_names.add(f"{id}.side({entity})", [face_])
                solids.append(solid)
            tool = solids[0] if len(solids) == 1 else _fuse_all(solids, tool_names)
            self._record_tool(feature, tool, tool_names, op, body)

    def fillet(self, id, edges, radius, radius2=None, flip=False, name=None, suppressed=False):
        """Constant-radius fillet, or variable from `radius` at each edge's start to `radius2` at its end.
        `flip` swaps which end of the edge gets which radius."""
        with self._feature(id, "fillet", name, suppressed) as feature:
            if feature is None:
                return
            if radius2 is not None and not (float(radius) > 0 and float(radius2) > 0):
                raise FeatureError("Both fillet radii must be greater than 0.")
            picked = self.edges(edges)
            if not picked:
                raise FeatureError("Pick at least one edge to fillet.")
            start, end = (radius2, radius) if flip else (radius, radius2)
            feature.body, feature.created = self._fillet_edges([(edge, id, False) for edge in picked], radius, radius2, start, end)
            self._edge_ops[id] = ("fillet", [(edge, None) for edge in picked], (radius, radius2, start, end), list(feature.created))
            feature.detail = {"edges": len(picked)}

    def _fillet_edges(self, picked, radius, radius2, start, end) -> tuple[str, list[str]]:
        """Fillets (edge, name prefix, reversed) edges of one body in one go: the fillet itself, or a pattern's copies of
        one (a reversed edge runs the other way from the one it copies, so a variable fillet's radii swap on it)."""
        edges = [edge for edge, _, _ in picked]
        body_id = self.body_of(edges, "fillet")
        before = self.bodies[body_id]
        labels = edge_names(before, self.names)
        maker, done = _make_fillet(before, picked, radius if radius2 is None else (start, end))
        if not done:
            raise self._fillet_failure(maker, before, picked, labels, radius, radius2, start, end)
        if radius2 is not None:  # A constant fillet too big for its faces fails in the kernel; a variable one is clipped.
            self._fillet_stays_on_its_faces(maker, before, edges, labels, radius, radius2)
        new = Names()
        for edge, prefix, _ in picked:
            new.add(f"{prefix}.face({labels.get(edge, 'edge')})", [s for s in maker.Generated(edge.wrapped)])
        after = self._replace(body_id, maker, before)
        new.prune(after)
        self.names.merge(new)
        return body_id, list(new.faces)

    def _fillet_failure(self, maker, before, picked, labels, radius, radius2, start, end) -> FeatureError:
        """Why a fillet failed, by name: the edges of the contours the kernel couldn't blend (with the largest size
        that fits them, found only now that it failed) and the corners where filleted edges meet that it couldn't."""
        size = f"{radius} mm" if radius2 is None else f"{radius}–{radius2} mm variable"
        failed, corners = _fillet_faults(maker)
        if not failed and not corners:  # The kernel said nothing about where: the count, as before.
            if radius2 is not None:
                return FeatureError(f"A {size} fillet doesn't fit on {len(picked)} edge(s); try smaller or more similar radii.")
            return FeatureError(f"A {size} fillet doesn't fit on {len(picked)} edge(s); try a smaller radius.")
        detail, sentences = {}, []
        if failed:
            detail["failed_edges"] = [labels.get(edge, "an edge") for edge in failed]
            fit, built = self._fillet_fit(before, picked, set(failed), labels, radius, radius2, start, end)
            sentence = f"A {size} fillet doesn't fit on {_listed(detail['failed_edges'])}; "
            if fit is not None:
                detail["fits_up_to"] = fit
                sentence += f"it fits up to {_mm(fit)}."
            elif built:
                sentence += ("a smaller size fits there on its own but not together with the other picked edges: fillet "
                             "them in separate features.")
            else:
                sentence += ("even a much smaller one fails there, so the faces around it are the problem (a sliver, or "
                             "a face that ends too soon).")
            sentences.append(sentence)
        if corners:
            vertex_label = vertex_names(before, self.names)
            detail["failed_corners"] = [vertex_label.get(vertex, "a vertex") for vertex in corners]
            blend = "The corner blend also" if failed else f"A {size} fillet's corner blend"
            sentences.append(f"{blend} fails where three or more filleted edges meet, at {_listed(detail['failed_corners'])}: "
                             "fillet those edges in a different order or in separate features.")
        return FeatureError(" ".join(sentences), detail)

    def _fillet_fit(self, before, picked, failed, labels, radius, radius2, start, end):
        """The largest size that fits, scaled down from the person's: a bisection of at most FIT_TRIALS trial fillets on
        the failing contours' edges, then one of every picked edge at that size rounded down to two figures (a contour
        can fit alone yet fail beside its neighbours). (size, or None; whether any trial built.) A variable fillet's
        size is its (radius, radius2), both scaled together."""
        trial = [entry for entry in picked if entry[0] in failed] or picked

        def sized(scale):
            return float(radius) * scale if radius2 is None else (float(start) * scale, float(end) * scale)

        def fits(entries, value) -> bool:
            maker, done = _make_fillet(before, entries, value)
            if done and radius2 is not None:  # A variable fillet that runs past its faces is clipped, not that fillet.
                try:
                    self._fillet_stays_on_its_faces(maker, before, [edge for edge, _, _ in entries], labels, radius, radius2)
                except FeatureError:
                    return False
            return done

        low, high, best = 1 / 64, 1.0, None
        for _ in range(FIT_TRIALS):
            middle = (low + high) / 2
            if fits(trial, sized(middle)):
                best, low = middle, middle
            else:
                high = middle
        if best is None:
            return None, False
        value = sized(best)
        value = _round_down(value) if radius2 is None else (_round_down(value[0]), _round_down(value[1]))
        if not fits(picked, value):
            return None, True
        if radius2 is None:
            return value, True
        flipped = (float(start), float(end)) != (float(radius), float(radius2))
        return [value[1], value[0]] if flipped else list(value), True  # In the order the person wrote radius, radius2.

    def _fillet_stays_on_its_faces(self, maker, before: cq.Shape, picked, labels, radius, radius2) -> None:
        """A variable fillet rolls between the two faces beside its edge, ending on the faces at the edge's ends. One
        whose larger end is too big for them runs on across another face, and the kernel clips it there into a valid
        solid that isn't that fillet (a constant one that big fails in the kernel instead): refuse it by name."""
        after = cq.Shape.cast(maker.Shape())
        rounds = {cq.Face(face) for edge in picked for face in maker.Generated(edge.wrapped)}
        for vertex in {v for edge in picked for v in edge.Vertices()}:  # Corner blends where filleted edges meet.
            rounds |= {cq.Face(face) for face in maker.Generated(vertex.wrapped)}
        origin = {}  # A face of the result → the face of the body it came from.
        for face in before.Faces():
            images = [cq.Face(image) for image in maker.Modified(face.wrapped)]
            for image in images or ([face] if not maker.IsDeleted(face.wrapped) else []):
                origin.setdefault(image, face)
        touching = vertex_faces(before)
        beside = {edge: {face for vertex in edge.Vertices() for face in touching.get(vertex, [])} for edge in picked}
        neighbours = edge_faces(after)
        name = self.names.index()
        size = f"{radius}–{radius2} mm variable"
        for edge in picked:
            allowed = set().union(*(beside[other] for other in picked if other == edge or beside[other] & beside[edge]))
            for face in (cq.Face(f) for f in maker.Generated(edge.wrapped)):
                for border in face.Edges():
                    for other in neighbours.get(border, []):
                        source = origin.get(other)
                        if other in rounds or source is None or source in allowed:
                            continue
                        onto = name.get(source, "another face")
                        raise FeatureError(f"A {size} fillet on {labels.get(edge, 'the edge')} runs past the faces beside "
                                           f"it, onto {onto}; try a smaller radius.")

    def chamfer(self, id, edges, distance, distance2=None, angle=None, flip=False, along=None, name=None, suppressed=False):
        """Equal-distance, two-distance (`distance2`) or distance + `angle` (degrees) chamfer.
        Asymmetric chamfers measure `distance` along the `along` face(s) (each edge must touch exactly one of them);
        without it, along the edge's first face, and `flip` uses the other one. The detail reports each edge's
        measured legs."""
        with self._feature(id, "chamfer", name, suppressed) as feature:
            if feature is None:
                return
            if distance2 is not None and angle is not None:
                raise FeatureError("Give a second distance or an angle, not both.")
            if angle is not None and not 0 < float(angle) < 90:
                raise FeatureError("A chamfer angle must be between 0° and 90°.")
            uneven = distance2 is not None or angle is not None
            if along is not None and not uneven:
                raise FeatureError("`along` only applies to a chamfer with a second distance or an angle.")
            if along is not None and flip:
                raise FeatureError("Give `along` or `flip`, not both: `along` already says which face `distance` runs along.")
            picked = self.edges(edges)
            if not picked:
                raise FeatureError("Pick at least one edge to chamfer.")
            body_id = self.body_of(picked, "chamfer")
            before = self.bodies[body_id]
            labels = edge_names(before, self.names)
            face_name = self.names.index()
            along_faces = self.faces(along) if along is not None else None
            if along_faces is not None and not along_faces:
                raise FeatureError(f"`along` {along!r} names no faces.")
            adjacency = edge_faces(before)
            measured: list[tuple[cq.Edge, cq.Face, str]] = []
            for edge in picked:
                faces = adjacency[edge]
                if not uneven:
                    face = faces[0]
                elif along_faces is not None:
                    touching = [f for f in faces if f in along_faces]
                    if len(touching) != 1:
                        which = "none" if not touching else "both"
                        raise FeatureError(f"{labels.get(edge, 'An edge')} touches {which} of the `along` faces; "
                                           "each edge needs exactly one of them beside it.")
                    face = touching[0]
                else:
                    face = faces[1 if flip and len(faces) > 1 else 0]
                measured.append((edge, face, id))
            body_id, created, legs = self._chamfer_edges(measured, distance, distance2, angle)
            feature.body, feature.created = body_id, created
            self._edge_ops[id] = ("chamfer", [(edge, _normal_at(face, edge)) for edge, face, _ in measured],
                                  (distance, distance2, angle), list(created))
            feature.detail = {"edges": len(picked), "legs": legs}
            if len(picked) > len(legs):
                feature.detail["legs_not_listed"] = len(picked) - len(legs)

    def _chamfer_edges(self, measured, distance, distance2, angle) -> tuple[str, list[str], list]:
        """Chamfers (edge, face its `distance` runs along, name prefix) edges of one body in one go: the chamfer itself,
        or a pattern's copies of one."""
        uneven = distance2 is not None or angle is not None
        body_id = self.body_of([edge for edge, _, _ in measured], "chamfer")
        before = self.bodies[body_id]
        labels = edge_names(before, self.names)
        face_name = self.names.index()
        adjacency = edge_faces(before)
        maker = BRepFilletAPI_MakeChamfer(before.wrapped)
        for edge, face, _ in measured:
            if not uneven:
                maker.Add(float(distance), edge.wrapped)
            elif angle is None:
                maker.Add(float(distance), float(distance2), edge.wrapped, face.wrapped)
            else:
                maker.AddDA(float(distance), math.radians(float(angle)), edge.wrapped, face.wrapped)
        maker.Build()
        if not maker.IsDone():
            size = f"{distance} mm × {angle}°" if angle is not None else f"{distance} mm"
            raise FeatureError(f"A {size} chamfer doesn't fit on {len(measured)} edge(s); try a smaller distance"
                               + (" or a different angle." if angle is not None else "."))
        new = Names()
        legs = []
        for edge, face, prefix in measured:
            generated = [s for s in maker.Generated(edge.wrapped)]
            new.add(f"{prefix}.face({labels.get(edge, 'edge')})", generated)
            if len(legs) < CHAMFER_LEGS_LISTED:
                legs.append(_chamfer_legs(edge, adjacency[edge], face, generated, labels, face_name))
        after = self._replace(body_id, maker, before)
        new.prune(after)
        self.names.merge(new)
        return body_id, list(new.faces), legs

    def shell(self, id, remove, thickness, name=None, suppressed=False):
        """Hollows a body inward with wall `thickness`, opening the faces in `remove` (none: a closed hollow)."""
        with self._feature(id, "shell", name, suppressed) as feature:
            if feature is None:
                return
            opened = self.faces(remove) if remove else []
            if opened:
                body_id = self.body_of(opened, "shell")
            else:
                body_id = self.active
                if body_id is None:
                    raise FeatureError("There is no body to shell.")
                self._solid_only(body_id, "shell")
            before = self.bodies[body_id]
            index = self.names.index()
            maker = BRepOffsetAPI_MakeThickSolid()
            maker.MakeThickSolidByJoin(before.wrapped, _list(opened), -abs(float(thickness)), 1e-4)
            maker.Build()
            if not maker.IsDone():
                raise FeatureError(f"A {thickness} mm shell failed: walls may be thinner than the fillets or features inside.")
            new = Names()
            for face in before.Faces():
                label = index.get(face)
                generated = [s for s in maker.Generated(face.wrapped)]
                if not opened and not generated:
                    generated = [s for s in maker.Modified(face.wrapped)]
                if label and generated:
                    new.add(f"{id}.inner({label})", generated)
            result = cq.Shape.cast(maker.Shape())
            if not opened:
                # With nothing opened the maker only gives the inward offset; like CadQuery's `hollow`, close the
                # wall from the body's own outer shell and the offset shell (the void).
                outer, inner = before.Shells(), result.Shells()
                if len(outer) != 1 or not inner:
                    raise FeatureError(f"A {thickness} mm closed shell needs a single closed body; "
                                       f"open a face with `remove` instead.")
                result = cq.Shape.cast(BRepBuilderAPI_MakeSolid(outer[0].wrapped, inner[0].wrapped).Shape()).fix()
            if not 0 < result.Volume() < before.Volume() * (1 - 1e-9):  # Never report a shell that didn't hollow.
                raise FeatureError(f"A {thickness} mm shell didn't hollow the body; try a thinner wall"
                                   + (" or different open faces." if opened else " or open a face with `remove`."))
            self.names.update(maker, result, [before])
            after = _solid(result)
            self.bodies[body_id] = after
            new.prune(after)
            self.names.merge(new)
            feature.body, feature.created = body_id, list(new.faces)

    # ───────── primitives ─────────

    def box(self, id, length, width, height, at=(0, 0, 0), centered=True, op=None, body=None, name=None, suppressed=False):
        """A box `length` × `width` × `height` mm along X, Y and Z, centred on `at` (or with its lowest corner there
        when `centered=False`). Faces "<id>.top" (+Z), ".bottom" (-Z), ".front" (+X), ".back" (-X), ".left" (-Y) and
        ".right" (+Y): OCCT's names for a box's sides, which saved designs rely on; they aren't the drawing views'
        sides (a front view looks at ".left"). `op`/`body` as for extrude."""
        with self._feature(id, "box", name, suppressed) as feature:
            if feature is None:
                return
            x, y, z = (float(v) for v in at)
            l, w, h = float(length), float(width), float(height)
            corner = gp_Pnt(x - l / 2, y - w / 2, z - h / 2) if centered else gp_Pnt(x, y, z)
            maker = BRepPrimAPI_MakeBox(corner, l, w, h)
            maker.Build()
            names = Names()
            for side, face in (("bottom", maker.BottomFace()), ("top", maker.TopFace()), ("front", maker.FrontFace()),
                               ("back", maker.BackFace()), ("left", maker.LeftFace()), ("right", maker.RightFace())):
                names.add(f"{id}.{side}", [face])
            self._record_tool(feature, cq.Shape.cast(maker.Shape()), names, op, body)

    def cylinder(self, id, radius, height, at=(0, 0, 0), direction=(0, 0, 1), op=None, body=None, name=None, suppressed=False):
        """A cylinder of `radius` and `height` mm, its bottom centred on `at`, rising along `direction`. Faces
        "<id>.side", "<id>.top", "<id>.bottom"; `op`/`body` as for extrude."""
        with self._feature(id, "cylinder", name, suppressed) as feature:
            if feature is None:
                return
            x, y, z = (float(v) for v in at)
            dx, dy, dz = direction
            maker = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, z), gp_Dir(dx, dy, dz)), float(radius), float(height))
            maker.Build()
            shape = cq.Shape.cast(maker.Shape())
            names = Names()
            for face in shape.Faces():
                kind = face.geomType()
                if kind == "CYLINDER":
                    names.add(f"{id}.side", [face])
                else:
                    top = (face.Center() - cq.Vector(x, y, z)).dot(cq.Vector(dx, dy, dz)) > float(height) / 2
                    names.add(f"{id}.{'top' if top else 'bottom'}", [face])
            self._record_tool(feature, shape, names, op, body)

    # ───────── more solid features ─────────

    def _record_tool(self, feature: Feature, tool: cq.Shape, names: Names, op: str | None, body: str | None):
        """Keeps a feature's tool so patterns and mirrors can re-apply it."""
        self._tools[feature.id] = (tool, names, op, body)
        self._apply(feature, tool, names, op, body)

    def _hole_point(self, ref: str, plane: cq.Plane) -> tuple[float, float]:
        """A sketch point a hole is placed at, in `plane`'s coordinates: "<sketch>.<point>", a circle's or arc's id (its
        centre), or "<sketch>.<entity>.<point>" ("sk.l1.start"). Projected along the face normal, so the hole follows
        the sketch when its dimensions change."""
        sketch_id, _, entity = ref.partition(".")
        sketch = self.sketches.get(sketch_id)
        if sketch is None or not entity:
            raise FeatureError(f"Hole position {ref!r} must be a sketch point like \"sketch_1.p1\".")
        e, key = sketch.entities.get(entity), None
        if e is None and "." in entity:
            head, key = entity.rsplit(".", 1)
            e = sketch.entities.get(head)
        if e is None:
            raise FeatureError(f"Sketch {sketch_id} has no point {entity!r} now.")
        key = key or {"point": "at", "circle": "center", "arc": "center", "ellipse": "center", "elliptical_arc": "center"}.get(e["type"])
        at = e.get(key) if key in POINT_KEYS.get(e["type"], ()) else None
        if not isinstance(at, (list, tuple)) or len(at) != 2:
            raise FeatureError(f"Hole position {ref!r} isn't a point of sketch {sketch_id}.")
        local = plane.toLocalCoords(sketch.plane.toWorldCoords(tuple(at)))
        return (local.x, local.y)

    def hole(self, id, on, points, diameter, depth=None, kind="simple", cbore_diameter=None, cbore_depth=None,
             csk_diameter=None, csk_angle=90.0, thread=None, name=None, suppressed=False):
        """Holes normal to a planar face at 2D points in that face's sketch coordinates, at sketch points
        ("sketch_1.p1", a circle's id for its centre, "sketch_1.l1.start"; tuples and references can mix), or at all the
        points and circle centres of a sketch (`points="sketch_1"`). `depth=None` goes through. `thread` labels a tapped
        hole's thread ("M6x1") for drawings' hole tables; the hole is modelled at its `diameter` (the tap drill)."""
        with self._feature(id, "hole", name, suppressed) as feature:
            if feature is None:
                return
            if thread is not None and (not isinstance(thread, str) or not re.fullmatch(r"[^\x00-\x1f\x7f]{1,40}", thread.strip())):
                raise FeatureError("thread is a short label for the hole's thread, like \"M6x1\" or \"1/4-20 UNC\".")
            def whole(sketch):
                return ([tuple(e["at"]) for e in sketch.entities.values() if e["type"] == "point" and not e.get("construction")]
                        + [tuple(e["center"]) for e in sketch.entities.values() if e["type"] == "circle"])
            if isinstance(points, str) and points in self.sketches:
                plane = self.sketches[points].plane
                pts = whole(self.sketches[points])
            else:
                plane = self.plane_of(on)
                pts = []
                for p in ([points] if isinstance(points, str) else points):
                    if isinstance(p, str) and p in self.sketches:  # A whole sketch among other positions.
                        sketch = self.sketches[p]
                        pts += [(v.x, v.y) for v in (plane.toLocalCoords(sketch.plane.toWorldCoords(q)) for q in whole(sketch))]
                    else:
                        pts.append(self._hole_point(p, plane) if isinstance(p, str) else tuple(p))
            if not pts:
                raise FeatureError("Place at least one hole point.")
            through = depth is None
            length = self._extent() * 2 + 10 if through else float(depth)
            normal = plane.zDir
            names = Names()
            tools = []
            r = float(diameter) / 2
            for i, (u, v) in enumerate(pts):
                top = plane.toWorldCoords((u, v))
                parts = []
                cyl = _cylinder(top + normal * (1.0 if through else 0.0), -normal, r, length + (1.0 if through else 0.0))
                walls = [f for f in cyl.Faces() if f.geomType() == "CYLINDER"]
                names.add(f"{id}.wall({i})", walls)
                if not through:
                    bottom = [f for f in cyl.Faces() if f.geomType() == "PLANE" and (f.Center() - top).dot(normal) < -length / 2]
                    names.add(f"{id}.floor({i})", bottom)
                parts.append(cyl)
                if kind == "counterbore":
                    cr, cd = float(cbore_diameter or diameter * 1.8) / 2, float(cbore_depth or diameter * 0.6)
                    cb = _cylinder(top + normal * 1.0, -normal, cr, cd + 1.0)
                    names.add(f"{id}.cbore({i})", [f for f in cb.Faces() if f.geomType() == "CYLINDER"])
                    names.add(f"{id}.cbore_floor({i})", [f for f in cb.Faces() if f.geomType() == "PLANE" and (f.Center() - top).dot(normal) < 0])
                    parts.append(cb)
                elif kind == "countersink":
                    cr = float(csk_diameter or diameter * 2) / 2
                    half = math.radians(float(csk_angle)) / 2
                    height = max((cr - r) / math.tan(half), 1e-3)
                    cone = _cone(top + normal * 1.0, -normal, cr + 1.0 * math.tan(half), r, height + 1.0)
                    names.add(f"{id}.csk({i})", [f for f in cone.Faces() if f.geomType() == "CONE"])
                    parts.append(cone)
                tools.extend(parts)
            tool = tools[0] if len(tools) == 1 else _fuse_all(tools, names)
            self._record_tool(feature, tool, names, "cut", None)
            feature.detail = {"holes": len(pts), **({"thread": thread.strip()} if thread else {})}

    def loft(self, id, sections, ruled=False, op=None, body=None, name=None, suppressed=False, *, continuity=None,
             smoothing=False, max_degree=None):
        """A solid through two or more closed profiles (sketch ids or region refs), in order. A construction point's id
        may be the first or last section, closing the loft to an apex (a dome or a nose). For a smooth loft,
        `continuity` ("C1" or "C2") sets the surface's continuity across sections, `smoothing=True` fairs the surface
        so it bulges less between unevenly spaced sections, and `max_degree` (2-25) caps its degree; left out, the
        kernel's defaults apply (C2, no smoothing, degree 8); these three are keyword-only, so existing positional calls
        (`loft(id, sections, False, "cut")`) keep their meaning. Continuity holds inside the loft, between its own
        sections; it isn't carried across the start and end faces to neighbouring faces, and nothing here makes or
        checks G2 (curvature) continuity between separate faces or Class-A surface quality."""
        from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
        from OCP.GeomAbs import GeomAbs_C1, GeomAbs_C2
        with self._feature(id, "loft", name, suppressed) as feature:
            if feature is None:
                return
            if len(sections) < 2:
                raise FeatureError("A loft needs at least two sections.")
            if continuity is not None and continuity not in ("C1", "C2"):
                raise FeatureError(f"Loft continuity must be \"C1\" or \"C2\"; got {continuity!r}.")
            if not isinstance(smoothing, bool):
                raise FeatureError("Loft smoothing is True or False.")
            if max_degree is not None and (isinstance(max_degree, bool) or not isinstance(max_degree, int) or not 2 <= max_degree <= 25):
                raise FeatureError(f"Loft max_degree must be a whole number from 2 to 25; got {max_degree!r}.")
            if ruled and (continuity is not None or smoothing or max_degree is not None):
                raise FeatureError("continuity, smoothing and max_degree shape a smooth loft; leave them out with ruled=True.")
            is_point = [isinstance(s, str) and s in self.points for s in sections]
            if any(is_point[1:-1]):
                raise FeatureError("A point can only be the first or last section of a loft.")
            if all(is_point):
                raise FeatureError("A loft needs at least one profile section; two points don't make a solid.")
            maker = BRepOffsetAPI_ThruSections(True, bool(ruled))
            maker.CheckCompatibility(True)  # Matches sections with different edge counts (OCCT's default, kept explicit).
            if continuity is not None:
                maker.SetContinuity(GeomAbs_C1 if continuity == "C1" else GeomAbs_C2)
            if smoothing:
                maker.SetSmoothing(True)
            if max_degree is not None:
                maker.SetMaxDegree(max_degree)
            first_owner = None
            wires = []
            for section, point in zip(sections, is_point):
                if point:
                    p = self.points[section]
                    maker.AddVertex(BRepBuilderAPI_MakeVertex(gp_Pnt(p.x, p.y, p.z)).Vertex())
                    wires.append(cq.Vertex.makeVertex(p.x, p.y, p.z))
                    continue
                faces, entity_of, _ = self._profile_faces(section)
                if len(faces) != 1:
                    raise FeatureError(f"Loft section {section!r} must be one closed profile (it has {len(faces)}).")
                wire = faces[0].outerWire()
                maker.AddWire(wire.wrapped)
                wires.append(wire)
                if first_owner is None:
                    first_owner = {edge: entity_of.get(edge) for edge in wire.Edges()}
            maker.Build()
            if not maker.IsDone():
                raise FeatureError("The sections could not be lofted; check that they don't intersect and have compatible shapes.")
            names = Names()
            if not is_point[0]:
                names.add(f"{id}.start", [maker.FirstShape()])
            if not is_point[-1]:
                names.add(f"{id}.end", [maker.LastShape()])
            solid = cq.Shape.cast(maker.Shape())
            if is_point[0]:  # The first profile is shared by two spans; its sides are the faces reaching the apex.
                _name_by_touch(solid, names, f"{id}.side", first_owner, also=wires[0])
            else:
                for edge, entity in first_owner.items():
                    if entity:
                        face = maker.GeneratedFace(edge.wrapped)
                        if not face.IsNull():
                            names.add(f"{id}.side({entity})", [face])
                _name_by_touch(solid, names, f"{id}.side", first_owner)
            if ruled:
                _name_spans(solid, names, id, wires)
            elif (axis := _overshoot(_extent(solid), [_extent(w) for w in wires])):
                feature.warning = (f"The smooth loft {id!r} bulges well beyond its sections along {axis}; "
                                   + ("try ruled=True or more evenly spaced sections." if smoothing else
                                      "try smoothing=True, ruled=True or more evenly spaced sections."))
            self._record_tool(feature, solid, names, op, body)

    def _curve_edges(self, path, what: str) -> tuple[list[cq.Edge], list]:
        """A path or guide's edges, and each one's key: a sketch's curves (construction included) or edge refs."""
        if isinstance(path, str) and path in self.sketches:
            tagged = self.sketches[path].all_edges()
            edges = [edge for _, edge in tagged]
        else:
            edges = self.edges(path)
            tagged = [(str(i), edge) for i, edge in enumerate(edges)]
        if not edges:
            raise FeatureError(f"The sweep {what} has no curves.")
        return edges, tagged

    def sweep(self, id, profile, path, frenet=False, transition="right", op=None, body=None, name=None, suppressed=False,
              binormal=None, guide=None, sections=None, positions=None):
        """Sweeps a closed profile along a path: a sketch (its curves, construction included) or edge refs.

        How the profile turns along the path (one of these at most): the default corrected Frenet frame;
        `frenet=True`; `binormal=(dx, dy, dz)`, a fixed direction the profile keeps fixed angles to (no twist: the
        plane's normal for a U-shaped path in a plane); or `guide=` a second curve (a sketch or edge refs beside the
        path from end to end, drawn either way): the profile faces where the guide crosses the plane across the path,
        and when the guide starts on the profile's outline it also scales about the path to keep the guide on its side.
        `sections=` lists more closed profiles after `profile`, in order along the path, for a sweep whose section
        changes; `positions=` puts each section (the first included) at a fraction 0–1 of the path's length. With any
        of these the path runs from its end at the profile. Faces meet as the profile's curves and the path's segments
        do: no curvature (G2) continuity control, no Class-A surfacing."""
        from OCP.BRepOffsetAPI import BRepOffsetAPI_MakePipeShell
        from OCP.BRepBuilderAPI import BRepBuilderAPI_TransitionMode
        from OCP.BRepFill import BRepFill_TypeOfContact
        with self._feature(id, "sweep", name, suppressed) as feature:
            if feature is None:
                return
            modes = [key for key, value in (("frenet", frenet), ("binormal", binormal), ("guide", guide)) if value]
            if len(modes) > 1:
                raise FeatureError(f"Sweep {modes[0]}= and {modes[1]}= both set how the profile turns: give one of them.")
            orientation = modes[0] if modes else None
            if transition not in ("right", "round", "transformed"):
                raise FeatureError(f"transition= is {transition!r}: use \"right\", \"round\" or \"transformed\".")
            profiles = [profile, *(sections or [])]
            wires, first_owner = [], {}
            for index, section in enumerate(profiles):
                faces, entity_of, _ = self._profile_faces(section)
                if len(faces) != 1:
                    raise FeatureError("Sweep one closed profile at a time." if index == 0 else
                                       f"Sweep section {section!r} must be one closed profile (it has {len(faces)}).")
                wires.append(faces[0].outerWire())
                if index == 0:
                    profile_face = faces[0]
                    first_owner = {edge: entity_of.get(edge) for edge in wires[0].Edges()}
            edges, tagged = self._curve_edges(path, "path")
            spine = cq.Wire.assembleEdges(edges)
            if orientation or sections:
                # The path starts where the profile is (its edges were drawn in either direction): `.start` is the
                # profile's cap, positions= count from there and a guide runs the same way.
                spine = _starting_at(spine, profile_face)
            length = spine.Length()
            if positions is not None:
                if not sections:
                    raise FeatureError("positions= places sections= along the path: give the sections too.")
                try:
                    positions = [float(t) for t in positions]
                except (TypeError, ValueError):
                    raise FeatureError("positions= must be numbers from 0 to 1, one per section.") from None
                if len(positions) != len(profiles):
                    raise FeatureError(f"positions= has {len(positions)} values for {len(profiles)} sections "
                                       "(the profile and each of sections=): give one each.")
                if any(not 0 <= t <= 1 for t in positions):
                    raise FeatureError("positions= are fractions of the path's length: each from 0 to 1.")
                if any(b <= a for a, b in zip(positions, positions[1:])):
                    raise FeatureError("positions= must increase along the path, in the order of the sections.")
            maker = BRepOffsetAPI_MakePipeShell(spine.wrapped)
            if binormal:
                try:
                    direction = cq.Vector(*binormal)
                except TypeError:
                    raise FeatureError("binormal= must be a direction (dx, dy, dz).") from None
                if direction.Length < 1e-9:
                    raise FeatureError("binormal= is a zero direction: give (dx, dy, dz), like the path plane's normal.")
                direction = direction.normalized()
                if abs(direction.dot(spine.tangentAt(0))) > 0.999:
                    raise FeatureError("binormal= runs along the path's start: it must point across the path, like the "
                                       "normal of the plane the path lies in.")
                maker.SetMode(gp_Dir(direction.x, direction.y, direction.z))
            elif guide:
                guide_wire = cq.Wire.assembleEdges(self._curve_edges(guide, "guide curve")[0])
                reach = max(0.02 * length, 1e-3)
                def across(point, at):  # Distance from the path's normal plane at a fraction `at` along it.
                    return abs((point - spine.positionAt(at)).dot(spine.tangentAt(at)))
                g0, g1 = guide_wire.startPoint(), guide_wire.endPoint()
                if across(g1, 0) + across(g0, 1) < across(g0, 0) + across(g1, 1):
                    guide_wire = _reversed_wire(guide_wire)  # Drawn from the path's end: the same curve.
                    g0, g1 = g1, g0
                if across(g0, 0) > reach or across(g1, 1) > reach:
                    raise FeatureError("The guide curve doesn't span the path: it must run from beside the path's start to beside its end.")
                stations = _guide_stations(spine, guide_wire)
                touching = wires[0].distance(cq.Vertex.makeVertex(*stations[0][3].toTuple())) <= max(1e-3, 1e-5 * length)
                if touching and sections:
                    raise FeatureError("A guide curve that starts on the profile's outline scales the profile, so it can't also blend "
                                       "through sections=: start the guide beside the outline to only steer, or drop sections=.")
                # The guide sets the profile's turn: at each point of the path, the direction to where the guide crosses
                # the plane across the path there (OCCT's plane-intersection guide frame; its equal-length-ratio mode
                # strays off a parallel guide). When that direction keeps fixed angles to one direction across a path
                # of lines and arcs, it is that fixed binormal: OCCT then sweeps exact planes, cylinders and tori.
                fixed = _fixed_binormal(stations, spine, guide_wire)
                if fixed is not None:
                    maker.SetMode(gp_Dir(fixed.x, fixed.y, fixed.z))
                else:
                    maker.SetMode(guide_wire.wrapped, False, BRepFill_TypeOfContact.BRepFill_NoContact)
            else:
                maker.SetMode(bool(frenet))
            maker.SetTransitionMode({"right": BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner,
                                     "round": BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner,
                                     "transformed": BRepBuilderAPI_TransitionMode.BRepBuilderAPI_Transformed}[transition])
            if guide and touching:
                # On the profile's outline the guide also scales it about the path, to stay on the guide all along
                # (OCCT's ContactOnBorder, which only sweeps one-curve profiles, done as an evolution law instead).
                maker.SetLaw(wires[0].wrapped, _guide_scale_law(stations), False, False)
                wires = []
            for index, wire in enumerate(wires):
                if positions is None:
                    maker.Add(wire.wrapped, False, False)
                else:
                    at = spine.positionAt(positions[index])
                    maker.Add(wire.wrapped, cq.Vertex.makeVertex(at.x, at.y, at.z).wrapped, False, False)
            maker.Build()
            if not maker.IsDone() or not maker.MakeSolid():
                if guide:
                    raise FeatureError("The profile could not be swept with the guide curve; check that the guide stays "
                                       "beside the path and doesn't cross it.")
                if sections:
                    raise FeatureError("The profile could not be swept through the sections; check that each section "
                                       "crosses the path and that they have similar shapes.")
                if binormal:
                    raise FeatureError("The profile could not be swept with that binormal=; the path must never run along "
                                       "it (for a path in one plane, use that plane's normal).")
                raise FeatureError("The profile could not be swept along that path; check that the path starts on the profile's plane.")
            names = Names()
            names.add(f"{id}.start", [maker.FirstShape()])
            names.add(f"{id}.end", [maker.LastShape()])
            for edge, entity in first_owner.items():
                if entity:
                    names.add(f"{id}.side({entity})", [s for s in maker.Generated(edge.wrapped) if s.ShapeType().name == "TopAbs_FACE"])
            solid = cq.Shape.cast(maker.Shape())
            if sections:
                _name_by_touch(solid, names, f"{id}.side", first_owner)
            _name_along(solid, names, id, tagged)
            if orientation or sections:
                feature.detail = {"orientation": orientation or "default", "sections": len(profiles),
                                  **({"guide": "scales" if touching else "steers"} if guide else {})}
            self._record_tool(feature, solid, names, op, body)

    # ───────── surfaces ─────────

    def _curves(self, item) -> list[cq.Edge]:
        """The curves one item names: a sketch id (its curves, construction left out), a sketch curve
        ("sketch_1.s1"), edge refs, or plain CadQuery edges, wires or a Workplane of them; a list of any of these."""
        if _foreign(item):
            return self.edges(item)
        if isinstance(item, cq.Wire):
            return item.Edges()
        if isinstance(item, cq.Edge):
            return [item]
        if isinstance(item, cq.Workplane):
            return [edge for value in item.vals() if isinstance(value, cq.Shape) for edge in value.Edges()]
        if isinstance(item, str) and item in self.sketches:
            curves = [edge for edge in self.sketches[item].world_edges() if isinstance(edge, cq.Edge)]
            if not curves:
                raise FeatureError(f"Sketch {item} has no curves.")
            return curves
        if isinstance(item, (list, tuple)):
            return [edge for part in item for edge in self._curves(part)]
        return self.edges(item)

    def fill(self, id, boundary, constraints=None, continuity="G0", support=None, degree=3, points_per_curve=15,
             name=None, suppressed=False):
        """An N-sided surface patch (OCCT's BRepOffsetAPI_MakeFilling) closing a loop of `boundary` curves: edge refs,
        sketch curves or a sketch. `continuity` "G0" (through the edges) or "G1" (also tangent to the face each edge
        bounds), for every edge or per edge as {edge ref: "G0" | "G1"}; an edge between two faces needs `support=`, the
        face(s) the patch is tangent to. `constraints`: points (x, y, z) or point ids, and curves, the patch passes
        through. Makes a surface body `<id>` with face "<id>.face"; the detail reports how far it misses the boundary
        (`g0_error_mm`) and its tangency (`g1_error_deg`), measured on the exact faces along each tangent edge, as the
        continuity check does. A tangent fill missing 0.57° is rebuilt finer (at most twice) and the best kept;
        `g1_within_tolerance` says whether it met it and `points_per_curve` what it used."""
        from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeFilling
        from OCP.GeomAbs import GeomAbs_C0, GeomAbs_G1
        with self._feature(id, "fill", name, suppressed) as feature:
            if feature is None:
                return
            edges = self._curves(boundary if isinstance(boundary, (list, tuple)) else [boundary])
            if not edges:
                raise FeatureError("A fill needs boundary curves: edges, sketch curves or a sketch.")
            edges = _chain(edges)  # In order round the loop, as the kernel takes them.
            if edges is None:
                raise FeatureError("The fill's boundary curves don't form one closed loop; "
                                   "pick edges that meet end to end all the way round.")
            orders = {"G0": GeomAbs_C0, "G1": GeomAbs_G1}
            if isinstance(continuity, dict):
                per_edge = {}
                for ref, order in continuity.items():
                    if order not in orders:
                        raise FeatureError(f"continuity for {ref!r} must be \"G0\" or \"G1\"; got {order!r}.")
                    for edge in self._curves(ref):
                        per_edge[edge] = order
                order_of = lambda edge: per_edge.get(edge, "G0")  # noqa: E731
            elif continuity in orders:
                order_of = lambda edge: continuity  # noqa: E731
            else:
                raise FeatureError(f"continuity must be \"G0\", \"G1\" or {{edge: \"G0\" | \"G1\"}}; got {continuity!r}.")
            supports = set(self.faces(support)) if support is not None else None
            adjacent = {}
            if any(order_of(edge) == "G1" for edge in edges):
                for _, body in self._bodies_list():
                    adjacent.update(edge_faces(body))
            from .continuity import SAMPLES, measure
            tangent = []  # (edge, the support face it is tangent to)
            for i, edge in enumerate(edges):
                if order_of(edge) == "G0":
                    continue
                faces = [face for face in adjacent.get(edge, []) if supports is None or face in supports]
                if len(faces) != 1:
                    raise FeatureError(f"Boundary curve {i + 1} of the fill " + (
                        "is on no face it could be tangent to (G1 needs a model edge"
                        + (" of a support face)." if supports is not None else "); use \"G0\" for sketch curves.") if not faces else
                        "is between two faces: name the face the fill is tangent to with support=."))
                tangent.append((edge, faces[0]))
            support_of = {edge: face for edge, face in tangent}
            point = lambda v: (isinstance(v, (list, tuple)) and len(v) in (2, 3)  # noqa: E731
                               and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v))
            items = [] if constraints is None else list(constraints) if isinstance(constraints, (list, tuple)) and not point(constraints) else [constraints]
            extra = []  # the constraints, resolved once for every attempt
            for item in items:
                if isinstance(item, str) and item in self.points:
                    p = self.points[item]
                    extra.append(gp_Pnt(p.x, p.y, p.z))
                elif point(item):
                    extra.append(gp_Pnt(*(float(v) for v in item), *([0.0] if len(item) == 2 else [])))  # (x, y): Z is 0.
                else:
                    extra.extend(self._curves(item))

            def attempt(points, iterations, segments):
                maker = BRepOffsetAPI_MakeFilling(int(degree), int(points), iterations, False, 1e-5, 1e-4, 1e-2, 0.1, 8, segments)
                for edge in edges:
                    if edge in support_of:
                        maker.Add(edge.wrapped, support_of[edge].wrapped, GeomAbs_G1, True)
                    else:
                        maker.Add(edge.wrapped, GeomAbs_C0, True)
                for item in extra:
                    if isinstance(item, gp_Pnt):
                        maker.Add(item)
                    else:
                        maker.Add(item.wrapped, GeomAbs_C0, False)
                try:
                    maker.Build()
                except Exception:  # noqa: BLE001 - a refinement the kernel can't solve keeps the earlier result
                    return None
                return maker if maker.IsDone() else None

            def measured(maker):
                # The kernel's G1Error/G0Error are read at its constraint points only; between them the patch drifts
                # (most round arcs). Measure each tangent edge on the exact faces, densely (a superset of the
                # continuity check's own points), so the detail says what the Surface tab's analysis finds.
                patch = cq.Shape.cast(maker.Shape()).wrapped
                angle, gap = math.degrees(maker.G1Error()), maker.G0Error()
                for edge, support_face in tangent:
                    result = measure(edge.wrapped, support_face.wrapped, patch, samples=SAMPLES * 5)
                    if result is not None:
                        angle, gap = max(angle, result["angle"]), max(gap, result["gap"])
                return angle, gap

            # A tangent fill that misses the angular tolerance (TolAng, 1e-2 rad) is rebuilt with more points per curve,
            # more iterations and more segments, at most twice; the best (lowest measured angle) is kept.
            tolerance = math.degrees(1e-2)
            first = int(points_per_curve)
            tries = [(first, 2, 9)]
            if tangent:
                tries += [(max(first, min(60, first * 2)), 3, 16), (max(first, min(60, first * 4)), 3, 24)]
            best = None
            for points, iterations, segments in tries:
                maker = attempt(points, iterations, segments)
                if maker is None:
                    continue
                angle, gap = measured(maker) if tangent else (None, maker.G0Error())
                if best is None or angle < best[1]:
                    best = (maker, angle, gap, points)
                if not tangent or angle <= tolerance:
                    break
            if best is None:
                raise FeatureError("The fill failed in the geometry kernel; check that the boundary doesn't cross itself, "
                                   "and try G0 or fewer constraints.")
            maker, angle, gap, points = best
            face = cq.Shape.cast(maker.Shape())
            names = Names()
            names.add(f"{id}.face", face.Faces())
            self._record_tool(feature, face, names, "new", None)
            feature.detail = {"edges": len(edges), "g0_error_mm": round(gap, 6),
                              **({"g1_error_deg": round(angle, 4), "g1_within_tolerance": angle <= tolerance,
                                  "points_per_curve": points} if tangent else {})}

    def boundary_surface(self, id, curves_u, curves_v=None, ruled=False, name=None, suppressed=False):
        """A surface blended through two or more curve sets `curves_u`, in order (each a sketch, sketch curves, edge refs
        or a list of them; open or closed): a loft that stays a surface. With `curves_v` too, the first and last of each
        direction bound a four-sided patch and the inner ones guide it (met within tolerance, not exactly). Makes a
        surface body `<id>` with faces "<id>.face"."""
        from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeFilling, BRepOffsetAPI_ThruSections
        from OCP.GeomAbs import GeomAbs_C0
        with self._feature(id, "boundary_surface", name, suppressed) as feature:
            if feature is None:
                return
            if not isinstance(curves_u, (list, tuple)) or len(curves_u) < 2:
                raise FeatureError("A boundary surface needs at least two curve sets in curves_u.")
            sets_u = [self._curves(item) for item in curves_u]
            if curves_v is None:
                maker = BRepOffsetAPI_ThruSections(False, bool(ruled))
                for index, curves in enumerate(sets_u, start=1):
                    try:
                        wire = cq.Wire.assembleEdges(curves)
                    except Exception:  # noqa: BLE001 - the kernel's reason is no help here
                        raise FeatureError(f"Curve set {index} isn't one connected curve.") from None
                    maker.AddWire(wire.wrapped)
                maker.Build()
                if not maker.IsDone():
                    raise FeatureError("The curve sets could not be blended; check that they don't cross and run the same way.")
                shape = cq.Shape.cast(maker.Shape())
                detail = {"curves_u": len(sets_u)}
            else:
                if not isinstance(curves_v, (list, tuple)) or len(curves_v) < 2:
                    raise FeatureError("curves_v needs at least two curve sets, like curves_u.")
                sets_v = [self._curves(item) for item in curves_v]
                bounds = [*sets_u[0], *sets_u[-1], *sets_v[0], *sets_v[-1]]
                if _chain(bounds) is None:
                    raise FeatureError("The first and last curves of curves_u and curves_v must meet end to end and close "
                                       "a four-sided loop.")
                maker = BRepOffsetAPI_MakeFilling()
                for edge in bounds:
                    maker.Add(edge.wrapped, GeomAbs_C0, True)
                for curves in [*sets_u[1:-1], *sets_v[1:-1]]:
                    for edge in curves:
                        maker.Add(edge.wrapped, GeomAbs_C0, False)
                maker.Build()
                if not maker.IsDone():
                    raise FeatureError("The curve network could not be filled; check that the inner curves lie across "
                                       "the patch and meet its boundary.")
                shape = cq.Shape.cast(maker.Shape())
                detail = {"curves_u": len(sets_u), "curves_v": len(sets_v), "g0_error_mm": round(maker.G0Error(), 6)}
            if not shape.Faces():
                raise FeatureError("The boundary surface came out empty.")
            names = Names()
            names.add(f"{id}.face", shape.Faces())
            self._record_tool(feature, shape, names, "new", None)
            feature.detail = detail

    # ───────── thicken and solidify ─────────

    def _surface_source(self, source) -> tuple[list[cq.Face], list[str], str | None]:
        """What a thicken offsets: (faces, surface bodies named whole, the solid the faces belong to or None). `source` is
        a surface body id, face refs (of surface bodies, or of one solid), or a list of these."""
        items = list(source) if isinstance(source, (list, tuple)) else [source]
        faces, whole = [], []
        for item in items:
            if isinstance(item, str) and item in self.bodies:
                if not is_surface(self.bodies[item]):
                    raise FeatureError(f"Body {item!r} is a solid: thicken faces of it (\"{item}.<face>\"), or shell it.")
                whole.append(item)
                faces += [f for f in self.bodies[item].Faces() if f not in faces]
            else:
                faces += [f for f in self.faces(item) if f not in faces]
        if not faces:
            raise FeatureError("Pick a surface body or faces to thicken.")
        picked = set(faces)  # A surface body whose every face is picked is used whole too.
        whole += [b for b, s in self.bodies.items() if b not in whole and is_surface(s) and set(s.Faces()) <= picked]
        solids = {body_id for body_id, body in self.bodies.items() if not is_surface(body)
                  and any(f in set(body.Faces()) for f in faces)}
        if len(solids) > 1 or (solids and whole):
            raise FeatureError("Thicken faces of one solid, or surface bodies, not both at once.")
        return faces, whole, next(iter(solids), None)

    def _used_up(self, consumed: list[str], forget: str | None = None):
        """Removes surface bodies a feature turned into a solid; their names keep only faces still in a body. With
        `forget` (the feature's id), names other than the feature's own drop the used-up faces altogether (a thicken's
        wall is named by the thicken, whichever side the surface ends up on)."""
        if not consumed:
            return
        gone = {face for body_id in consumed if body_id in self.bodies for face in self.bodies[body_id].Faces()}
        for body_id in consumed:
            self.bodies.pop(body_id, None)
        live = {face for body in self.bodies.values() for face in body.Faces()}
        for name, faces in list(self.names.faces.items()):
            dropped = gone if forget is not None and not name.startswith(f"{forget}.") else set()
            kept = [face for face in faces if face in live and face not in dropped]
            if kept:
                self.names.faces[name] = kept
            else:
                del self.names.faces[name]
        if self.active not in self.bodies:
            self.active = next(iter(self.bodies), None)

    def thicken(self, id, source, thickness, side="out", op=None, body=None, name=None, suppressed=False):
        """Gives a surface a wall: offsets `source` (a surface body id, face refs of surface bodies or of one solid, or a
        list) by `thickness` mm into a solid, along the faces' normals (`side="out"`), against them (`"in"`) or half
        each way (`"both"`). Faces "<id>.outer" (the +normal side), "<id>.inner" and "<id>.side" (the rim). A surface
        body used whole becomes the solid (a new body `<id>` unless `op`/`body` say otherwise); faces of a solid join it
        by default. A face that curves tighter than the offset toward its centre is refused, named, with its radius."""
        from OCP.BRepOffset import BRepOffset_MakeOffset, BRepOffset_Skin
        from OCP.GeomAbs import GeomAbs_Intersection
        with self._feature(id, "thicken", name, suppressed) as feature:
            if feature is None:
                return
            if side not in ("out", "in", "both"):
                raise FeatureError(f"Thicken side must be \"out\", \"in\" or \"both\"; got {side!r}.")
            t = float(thickness)
            if not t > 0:
                raise FeatureError("A thicken needs a thickness greater than 0.")
            faces, whole, solid_id = self._surface_source(source)
            low, high = {"out": (0.0, t), "in": (-t, 0.0), "both": (-t / 2, t / 2)}[side]
            index = self.names.index()
            labels = [index.get(face) or f"face {i + 1} of the source" for i, face in enumerate(faces)]
            _check_offset_curvature(faces, labels, low, high, t)
            sheet = _sewn(faces)

            def offset(shape, distance, thick):
                maker = BRepOffset_MakeOffset()
                maker.Initialize(shape.wrapped, distance, 1e-6, BRepOffset_Skin, False, False, GeomAbs_Intersection, thick)
                maker.MakeOffsetShape()
                if not maker.IsDone():
                    raise FeatureError(f"A {thickness} mm thicken failed in the geometry kernel ({_offset_error(maker)}); "
                                       "try a thinner wall, or thicken fewer faces at once.")
                return cq.Shape.cast(maker.Shape())

            start = offset(sheet, low, False) if low else sheet  # "in"/"both": the face moved to the wall's low side first.
            result = offset(start, high - low, True)
            pieces = result.Solids()
            if len(pieces) != 1 or not pieces[0].isValid() or not pieces[0].Volume() > 0:
                raise FeatureError(f"A {thickness} mm thicken didn't make one valid solid; try a thinner wall or "
                                   "another side.")
            solid = pieces[0]
            names = Names()
            for face in solid.Faces():
                names.add(f"{id}.{_wall_part(face, faces, low, high, max(1e-4, t * 1e-3))}", [face])
            feature.detail = {"faces": len(faces), "side": side, "volume_mm3": round(solid.Volume(), 6)}
            if solid_id is not None:  # Faces of a solid: the wall grows from it and joins it, unless told otherwise.
                op = op or "join"
                self._record_tool(feature, solid, names, op, body or (None if op == "new" else solid_id))
            else:
                self._record_tool(feature, solid, names, op or "new", body)
                self._used_up(whole, forget=id)

    def solidify(self, id, surfaces, tolerance=0.01, op=None, body=None, name=None, suppressed=False):
        """Sews surface bodies (ids, or face refs of surface bodies) that close a volume into one solid (OCCT's
        BRepBuilderAPI_Sewing, gaps up to `tolerance` mm closed). Its faces keep the surfaces' names. Surface bodies used
        whole become the solid (a new body `<id>` unless `op`/`body` say otherwise). A set that doesn't close is refused,
        naming each open edge by the surface it bounds and its midpoint."""
        from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing
        from OCP.BRepLib import BRepLib
        from OCP.TopoDS import TopoDS
        with self._feature(id, "solidify", name, suppressed) as feature:
            if feature is None:
                return
            items = list(surfaces) if isinstance(surfaces, (list, tuple)) else [surfaces]
            faces, whole = [], []
            for item in items:
                if isinstance(item, str) and item in self.bodies:
                    if not is_surface(self.bodies[item]):
                        raise FeatureError(f"Body {item!r} is already a solid; solidify takes surface bodies.")
                    whole.append(item)
                    faces += [f for f in self.bodies[item].Faces() if f not in faces]
                else:
                    picked = self.faces(item)
                    owners = {b for b, s in self.bodies.items() if any(f in set(s.Faces()) for f in picked)}
                    if any(not is_surface(self.bodies[b]) for b in owners):
                        raise FeatureError(f"{item!r} names faces of a solid; solidify takes surface bodies.")
                    faces += [f for f in picked if f not in faces]
            if len(faces) < 2:
                raise FeatureError("Solidify needs surfaces that close a volume: at least two faces.")
            picked = set(faces)  # A surface body whose every face is picked is used whole too.
            whole += [b for b, s in self.bodies.items() if b not in whole and is_surface(s) and set(s.Faces()) <= picked]
            tol = float(tolerance)
            if not 0 < tol <= 1:
                raise FeatureError("Solidify tolerance is a gap in mm, greater than 0 and at most 1.")
            sewing = BRepBuilderAPI_Sewing(tol)
            for face in faces:
                sewing.Add(face.wrapped)
            sewing.Perform()
            index = self.names.index()
            owner = {face: index.get(face) or next((b for b, s in self.bodies.items() if face in set(s.Faces())), "a surface")
                     for face in faces}
            if sewing.NbFreeEdges():
                where = []
                for i in range(1, sewing.NbFreeEdges() + 1):
                    edge = cq.Edge(sewing.FreeEdge(i))
                    mid = edge.positionAt(0.5)
                    near = min(faces, key=lambda f: f.distance(cq.Vertex.makeVertex(*mid.toTuple())))
                    where.append(f"{owner[near]} at ({mid.x:.2f}, {mid.y:.2f}, {mid.z:.2f})")
                shown = "; ".join(where[:8]) + (f"; and {len(where) - 8} more" if len(where) > 8 else "")
                raise FeatureError(f"The surfaces don't close a volume: {len(where)} open edge(s), along {shown}. Close the "
                                   f"gap (a fill, say) or, for gaps under a few hundredths of a mm, raise tolerance.")
            if sewing.NbMultipleEdges():
                raise FeatureError(f"{sewing.NbMultipleEdges()} edge(s) are shared by more than two surfaces; a solid's "
                                   "edges join exactly two faces.")
            shells = cq.Shape.cast(sewing.SewedShape()).Shells()
            if len(shells) != 1:
                raise FeatureError(f"The surfaces sew into {len(shells)} separate shells; solidify one closed set at a time.")
            made = TopoDS.Solid(BRepBuilderAPI_MakeSolid(shells[0].wrapped).Solid())
            BRepLib.OrientClosedSolid_s(made)
            solid = cq.Solid(made)
            if not solid.isValid() or not solid.Volume() > 0:
                raise FeatureError("The sewn surfaces don't make a valid solid (they may cross each other).")
            live = {face: face for face in solid.Faces()}
            names = Names()
            for face in faces:
                image = sewing.Modified(face.wrapped) if sewing.IsModified(face.wrapped) else face.wrapped
                label = index.get(face)
                if label and cq.Face(image) in live:
                    names.add(label, [live[cq.Face(image)]])
            names.add(f"{id}.faces", list(solid.Faces()))
            feature.detail = {"faces": len(faces), "volume_mm3": round(solid.Volume(), 6)}
            self._record_tool(feature, solid, names, op or "new", body)
            self._used_up(whole)

    def _copies(self, id, feature, sources, transforms, bodies_mode, labels=None):
        """Re-applies feature tools (or copies bodies) under each transform, carrying names as `<id>[i].<name>`, or
        `<id>[<label>].<name>` with `labels` (one per transform)."""
        keys = labels or range(1, len(transforms) + 1)
        if bodies_mode:
            for body_id in sources:
                if body_id not in self.bodies:
                    raise FeatureError(f"Body {body_id!r} doesn't exist.")
            for n, (i, trsf) in enumerate(zip(keys, transforms), start=1):
                for body_id in sources:
                    maker = BRepBuilderAPI_Transform(self.bodies[body_id].wrapped, trsf, True)
                    shape = cq.Shape.cast(maker.Shape())
                    names = self.names.transformed(maker)
                    renamed = Names()
                    for name, faces in names.faces.items():
                        if faces:
                            renamed.add(f"{id}[{i}].{name}", faces)
                    self._apply(feature, shape, renamed, "new", f"{body_id}_{id}_{n}")  # Bodies keep numbered ids.
            return
        for source in sources:
            if source not in self._tools and source not in self._edge_ops:
                owner = self.feature(source)
                if owner is not None and owner.status == "error":
                    raise FeatureError(f"Feature {source!r} failed, so there is nothing of it to repeat: fix it first.")
                raise FeatureError(f"Feature {source!r} can't be patterned (patterns repeat extrudes, revolves, holes, lofts, "
                                   "sweeps, fillets and chamfers).")
        # All copies of a source go into the model in one boolean: patterning 24 blades is one fuse, not 24.
        for source in sources:
            if source in self._edge_ops:
                self._repeat_edge_op(id, feature, source, transforms, keys)
                continue
            tool, names, op, body = self._tools[source]
            copies, renamed = [], Names()
            for i, trsf in zip(keys, transforms):
                maker = BRepBuilderAPI_Transform(tool.wrapped, trsf, True)
                copies.append(cq.Shape.cast(maker.Shape()))
                for name, faces in names.transformed(maker).faces.items():
                    if faces:
                        renamed.add(f"{id}[{i}].{name}", faces)
            self._apply_many(feature, copies, renamed, op or "join", body)

    def _repeat_edge_op(self, id, feature, source, transforms, keys):
        """A pattern's copies of a fillet or chamfer: the same rounding on each copy's edges where the original's are,
        moved by the copy's transform, all in one go. Names: "<id>[i].<source>.face(...)"."""
        kind, recorded, sizes, _ = self._edge_ops[source]
        picked, seen = [], set()
        for i, trsf in zip(keys, transforms):
            for edge, normal in recorded:
                match, backwards = self._counterpart(edge, trsf)
                if match is None:
                    raise FeatureError(f"Copy {i} of {source!r} has no edge where the original {kind} is (the copy's "
                                       f"surroundings differ there); {kind} that copy's edges by name instead.")
                if match not in seen:
                    seen.add(match)
                    moved = gp_Vec(*normal).Transformed(trsf) if normal is not None else None
                    picked.append((match, f"{id}[{i}].{source}", backwards, moved))
        if not picked:
            return
        if kind == "fillet":
            body_id, created = self._fillet_edges([(edge, prefix, backwards) for edge, prefix, backwards, _ in picked], *sizes)
        else:
            adjacency = edge_faces(self.bodies[self.body_of([edge for edge, _, _, _ in picked], "chamfer")])
            measured = []
            for edge, prefix, _, normal in picked:
                faces = adjacency[edge]
                if normal is not None and len(faces) > 1:  # The face the original's distance ran along, turned with it.
                    faces = sorted(faces, key=lambda face: -gp_Vec(*_normal_at(face, edge)).Dot(normal))
                measured.append((edge, faces[0], prefix))
            body_id, created, _ = self._chamfer_edges(measured, *sizes)
        feature.body = body_id
        feature.created = list(feature.created or []) + created

    def _counterpart(self, edge: cq.Edge, trsf) -> tuple[cq.Edge | None, bool]:
        """The model's edge lying where `edge` moved by `trsf` lies (same length, same midpoint), and whether it runs
        the other way."""
        moved = cq.Edge(BRepBuilderAPI_Transform(edge.wrapped, trsf, True).Shape())
        middle, length, start = moved.positionAt(0.5), moved.Length(), _first_point(moved)
        tolerance = 1e-3
        best, best_gap = None, tolerance
        for _, body in self._bodies_list():
            for candidate in body.Edges():
                if abs(candidate.Length() - length) > tolerance:
                    continue
                gap = (candidate.positionAt(0.5) - middle).Length
                if gap <= best_gap:
                    best, best_gap = candidate, gap
        if best is None:
            return None, False
        return best, (_first_point(best) - start).Length > tolerance and (_last_point(best) - start).Length <= tolerance

    def linear_pattern(self, id, direction, count, spacing, features=None, bodies=None, direction2=None, count2=1, spacing2=0.0,
                       name=None, suppressed=False):
        """Repeats features (their ids) or whole bodies (`bodies=`) `count` times, `spacing` mm apart along
        `direction` (an axis ref or a vector (dx, dy, dz)); `direction2`/`count2`/`spacing2` make a grid. The original
        counts as the first. Copies' faces are named "<id>[<n>].<name>". A fillet or chamfer among `features` rounds each
        copy's edges where it rounds the original's (list it after the features it rounds)."""
        with self._feature(id, "linear_pattern", name, suppressed) as feature:
            if feature is None:
                return
            d1 = self._direction(direction)
            d2 = self._direction(direction2) if direction2 is not None else None
            transforms = []
            for a in range(int(count)):
                for b in range(int(count2) if d2 is not None else 1):
                    if a == 0 and b == 0:
                        continue
                    offset = d1 * (a * float(spacing)) + (d2 * (b * float(spacing2)) if d2 is not None else cq.Vector())
                    trsf = gp_Trsf()
                    trsf.SetTranslation(gp_Vec(*offset.toTuple()))
                    transforms.append(trsf)
            self._copies(id, feature, bodies or features or [], transforms, bodies is not None)
            feature.detail = {"instances": len(transforms) + 1}

    def circular_pattern(self, id, axis, count, angle=360.0, features=None, bodies=None, name=None, suppressed=False):
        """Repeats features (their ids) or whole bodies (`bodies=`) `count` times about `axis` (any form revolve
        takes): spread evenly over a full turn, or from the original to `angle` degrees for less. The original counts
        as the first. Copies' faces are named "<id>[<n>].<name>". A fillet or chamfer among `features` rounds each copy's
        edges where it rounds the original's (list it after the features it rounds).

            model.circular_pattern("holes", axis="Z", count=6, features=["hole_1"])
            model.circular_pattern("blades", axis="Z", count=9, features=["blade", "blade_roots"])  # with its fillet
        """
        with self._feature(id, "circular_pattern", name, suppressed) as feature:
            if feature is None:
                return
            ax = self.axis_of(axis)
            n = int(count)
            total = float(angle)
            step = total / n if abs(total) >= 360 else total / max(n - 1, 1)
            transforms = []
            for i in range(1, n):
                trsf = gp_Trsf()
                trsf.SetRotation(ax, math.radians(step * i))
                transforms.append(trsf)
            self._copies(id, feature, bodies or features or [], transforms, bodies is not None)
            feature.detail = {"instances": n}

    def point_pattern(self, id, points, features=None, bodies=None, polar=False, absolute=False, labels=None, name=None,
                      suppressed=False):
        """Repeats features at each of `points`, spaced however they are: offsets (x, y) or (x, y, z) in mm from where
        the features are, or with `polar=True` (r, θ degrees) or (r, θ, z), each copy turned by θ about Z through the
        origin and then moved to radius r at θ (as design.pattern's points). A point at no offset is the original.
        `absolute=True` reads them as positions instead: the first point is where the features are, and each other
        point gets a copy moved (and turned, polar) from the first to it. `points` may be a design's table, like
        table("pins.csv", columns=("x", "y")). `labels` (one per point: short names of letters, digits and _, or a
        one-column table) names the copies `<id>[<label>].<name>`, like pins[A2].pin.wall(0), instead of
        `<id>[2].<name>`; the original's faces get its label's names too."""
        from .tables import Table
        with self._feature(id, "point_pattern", name, suppressed) as feature:
            if feature is None:
                return
            tabled = isinstance(points, Table)
            try:
                rows = list(points)
            except TypeError:
                raise FeatureError("points must be a list of (x, y) or (x, y, z) points, or table(\"….csv\").") from None
            if not rows:
                raise FeatureError(f"{points.path} has no points to place copies at." if tabled else "A table pattern needs at least one point.")
            shape = "(r, θ) or (r, θ, z)" if polar else "(x, y) or (x, y, z)"
            placed = []
            for index, row in enumerate(rows):
                where = points.where(index) if tabled else f"points[{index}]"
                try:
                    values = list(row)
                except TypeError:
                    raise FeatureError(f"{where} must be a point {shape}.") from None
                if len(values) not in (2, 3):
                    raise FeatureError(f"{where} has {len(values)} values; a point is {shape}"
                                       + (" (pick its columns with table(…, columns=(…)))." if tabled else "."))
                for column, value in enumerate(values):
                    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                        raise FeatureError(f"{where} value {column + 1} isn't a number.")
                placed.append(tuple(map(float, values)) if len(values) == 3 else (*map(float, values), 0.0))
            tags = self._pattern_labels(labels, len(rows)) if labels is not None else None

            def placement(a, b, z):
                trsf = gp_Trsf()
                if not polar:
                    trsf.SetTranslation(gp_Vec(a, b, z))
                    return trsf
                trsf.SetTranslation(gp_Vec(a * math.cos(math.radians(b)), a * math.sin(math.radians(b)), z))
                if b:
                    rotation = gp_Trsf()
                    rotation.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.radians(b))
                    trsf.Multiply(rotation)  # Turned first, then moved.
                return trsf

            def same(p, q):
                if polar:  # r = 0 at any θ is still a turn about Z, so θ is compared even then.
                    return abs(p[0] - q[0]) < 1e-9 and abs(math.remainder(p[1] - q[1], 360.0)) < 1e-9 and abs(p[2] - q[2]) < 1e-9
                return all(abs(u - v) < 1e-9 for u, v in zip(p, q))

            origin = placed[0] if absolute else (0.0, 0.0, 0.0)
            back = placement(*origin).Inverted() if absolute else None
            transforms, keys, own = [], [], []
            for index, point in enumerate(placed):
                if same(point, origin):
                    own.append(index)  # The features themselves.
                    continue
                trsf = placement(*point)
                if back is not None:
                    trsf.Multiply(back)  # From the first point back to where it was made, then out to this one.
                transforms.append(trsf)
                keys.append(tags[index] if tags else None)
            self._copies(id, feature, bodies or features or [], transforms, bodies is not None, keys if tags else None)
            if tags and bodies is None:
                for source in features or []:
                    refs = self._tools[source][1].faces if source in self._tools else self._edge_ops[source][3]
                    for ref in refs:
                        faces = self.names.faces.get(ref)
                        for index in own if faces else ():
                            self.names.add(f"{id}[{tags[index]}].{ref}", faces)
            feature.detail = {"instances": len(transforms) + 1}

    @staticmethod
    def _pattern_labels(labels, count: int) -> list[str]:
        """point_pattern's `labels` as names: one per point, each unique, from a list or a one-column table. Errors say
        which label (a table's file and row), never its text."""
        from .tables import Table
        tabled = isinstance(labels, Table)
        usage = "labels takes one short name per point, like [\"A1\", \"A2\"], or a one-column table(\"….csv\", columns=(\"…\",))."
        if isinstance(labels, str):
            raise FeatureError(usage)
        try:
            items = list(labels)
        except TypeError:
            raise FeatureError(usage) from None
        if len(items) != count:
            raise FeatureError(f"labels has {len(items)} names for {count} points: give one per point.")
        tags, seen = [], set()
        for index, item in enumerate(items):
            where = labels.where(index) if tabled else f"labels[{index}]"
            if isinstance(item, tuple):
                if len(item) != 1:
                    raise FeatureError(f"{where} has {len(item)} values; a label is one"
                                       + (" (pick its column with table(…, columns=(\"…\",)))." if tabled else "."))
                item = item[0]
            if isinstance(item, float) and item.is_integer():
                item = int(item)  # A table reads a cell like 12 as a number.
            if isinstance(item, int) and not isinstance(item, bool):
                item = str(item)
            if not isinstance(item, str) or not LABEL.fullmatch(item):
                raise FeatureError(f"{where} isn't a label: use letters, digits and _ (up to 32), like A2.")
            if item in seen:
                raise FeatureError(f"{where} repeats an earlier label; each point needs its own.")
            seen.add(item)
            tags.append(item)
        return tags

    def mirror(self, id, plane, features=None, bodies=None, name=None, suppressed=False):
        """Mirrors features (their ids) or whole bodies (`bodies=`) across a plane ("XY", "YZ", "ZX" and the others plane_of names, a construction
        plane or a planar face), keeping the originals. The copy's faces are named "<id>[1].<name>". A fillet or chamfer
        among `features` rounds the copy's edges where it rounds the original's."""
        from OCP.gp import gp_Ax2 as Ax2
        with self._feature(id, "mirror", name, suppressed) as feature:
            if feature is None:
                return
            p = self.plane_of(plane)
            trsf = gp_Trsf()
            trsf.SetMirror(Ax2(gp_Pnt(*p.origin.toTuple()), gp_Dir(*p.zDir.toTuple()), gp_Dir(*p.xDir.toTuple())))
            self._copies(id, feature, bodies or features or [], [trsf], bodies is not None)

    def combine(self, id, target, tools, op="join", keep_tools=False, name=None, suppressed=False):
        """Joins, cuts or intersects (`op`) the bodies in `tools` (body ids) with body `target`; the tool bodies are
        removed unless `keep_tools=True`."""
        with self._feature(id, "combine", name, suppressed) as feature:
            if feature is None:
                return
            if target not in self.bodies:
                raise FeatureError(f"Body {target!r} doesn't exist.")
            for tool_id in tools:
                if tool_id not in self.bodies or tool_id == target:
                    raise FeatureError(f"Body {tool_id!r} doesn't exist." if tool_id != target else f"Body {target!r} can't combine with itself.")
                self._apply(feature, self.bodies[tool_id], Names(), op, target, label=tool_id)
                if not keep_tools:  # Only once combined: a tool whose boolean fails stays a body of its own.
                    del self.bodies[tool_id]
            feature.body = target

    def split(self, id, body, tool, name=None, suppressed=False):
        """Splits a body by a plane or a face; the pieces become bodies `<id>_1`, `<id>_2`, …"""
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Splitter
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
        from OCP.gp import gp_Pln
        with self._feature(id, "split", name, suppressed) as feature:
            if feature is None:
                return
            if body not in self.bodies:
                raise FeatureError(f"Body {body!r} doesn't exist.")
            if isinstance(tool, str) and (tool in DATUM_PLANES or tool in self.planes):
                p = self.plane_of(tool)
                size = self._extent() * 2
                splitter_face = cq.Face(BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(*p.origin.toTuple()), gp_Dir(*p.zDir.toTuple())), -size, size, -size, size).Face())
            else:
                faces = self.faces(tool)
                if len(faces) != 1:
                    raise FeatureError("Split with one plane or face.")
                splitter_face = faces[0]
            before = self.bodies[body]
            maker = BRepAlgoAPI_Splitter()
            maker.SetArguments(_list([before]))
            maker.SetTools(_list([splitter_face]))
            maker.Build()
            if not maker.IsDone():
                raise FeatureError("The split failed in the geometry kernel.")
            result = cq.Shape.cast(maker.Shape())
            self.names.update(maker, result, [before])
            pieces = result.Solids()
            if len(pieces) < 2:
                raise FeatureError("The tool doesn't cut the body into pieces.")
            del self.bodies[body]
            for i, piece in enumerate(pieces, start=1):
                self.bodies[f"{id}_{i}"] = piece
            self.active = f"{id}_1"
            feature.detail = {"pieces": len(pieces)}

    def boundary_fill(self, id, tools, planes=None, cells=None, op=None, body=None, tools_after="keep", name=None,
                      suppressed=False):
        """Fills or cuts the regions that bodies and planes enclose between them: a pocket closed off by a plane, the
        space under a bridge down to a plane, the slice of a body between two planes. `tools` are body ids (solids or
        surfaces); `planes` a plane ("XY", a construction plane's id, a planar face ref) or a list, each extended across
        the model. `cells` picks regions by a point (x, y, z) inside each; by default every enclosed region outside the
        tool bodies is used. The regions join, cut, intersect or make a new body (`op`/`body` as for extrude).
        `tools_after`: "keep" the tool bodies, "remove" them, or "include" them in the fill (joined into it); the body
        the fill goes into always stays. Faces "<id>.plane(<plane>)" and "<id>.face(<tool face's name>)". The detail
        lists every region (a point inside it, its volume, the tool body it lies in) and how many were used."""
        from OCP.BOPAlgo import BOPAlgo_MakerVolume
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
        from OCP.gp import gp_Ax3, gp_Pln
        with self._feature(id, "boundary_fill", name, suppressed) as feature:
            if feature is None:
                return
            if tools_after not in ("keep", "remove", "include"):
                raise FeatureError(f"tools_after must be \"keep\", \"remove\" or \"include\"; got {tools_after!r}.")
            if tools_after == "include" and op not in (None, "new", "join"):
                raise FeatureError("tools_after=\"include\" joins the tool bodies into the fill, so it works with op \"join\" or \"new\".")
            tool_ids = list(dict.fromkeys([tools] if isinstance(tools, str) else tools or []))
            for tool_id in tool_ids:
                if tool_id not in self.bodies:
                    raise FeatureError(f"Body {tool_id!r} doesn't exist (bodies: {', '.join(self.bodies) or 'none'}).")
            plane_refs = [planes] if isinstance(planes, str) or _literal_plane(planes) else list(planes or [])
            if not tool_ids and not plane_refs:
                raise FeatureError("Pick the bodies and planes that bound the regions to fill.")
            index = self.names.index()
            shapes, sources = [], []  # sources: (name, face) of every boundary face, to name the regions' faces after.
            for tool_id in tool_ids:
                shapes.append(self.bodies[tool_id])
                sources += [(f"{id}.face({index.get(face) or tool_id})", face) for face in self.bodies[tool_id].Faces()]
            if plane_refs:
                # Each plane as a square around the model, wide enough to cross all of it (as split's).
                centre = cq.Compound.makeCompound(list(self.bodies.values())).BoundingBox().center if self.bodies else cq.Vector(0, 0, 0)
                size = self._extent()
                for k, ref in enumerate(plane_refs):
                    p = self.plane_of(ref)
                    local = p.toLocalCoords(centre)
                    pln = gp_Pln(gp_Ax3(gp_Pnt(*p.origin.toTuple()), gp_Dir(*p.zDir.toTuple()), gp_Dir(*p.xDir.toTuple())))
                    face = cq.Face(BRepBuilderAPI_MakeFace(pln, local.x - size, local.x + size, local.y - size, local.y + size).Face())
                    shapes.append(face)
                    sources.append((f"{id}.plane({ref if isinstance(ref, str) else k})", face))
            # OCCT's volume maker: every closed region the boundaries make, as solids sharing their faces.
            fuzzy = cq.Compound.makeCompound(shapes).BoundingBox().DiagonalLength * 1e-6
            result = None
            for tolerance in (0.0, fuzzy):
                maker = BOPAlgo_MakerVolume()
                maker.SetArguments(_list(shapes))
                maker.SetRunParallel(False)  # Serial, as every boolean in a build.
                if tolerance:
                    maker.SetFuzzyValue(tolerance)
                maker.Perform()
                if not maker.HasErrors() and not maker.Shape().IsNull():
                    result = cq.Shape.cast(maker.Shape())
                    break
            if result is None:
                raise FeatureError("The boundary fill failed in the geometry kernel (often tangent or coincident boundaries); "
                                   "move a plane or body slightly.")
            live = {face: face for face in result.Faces()}
            names = Names()
            for label, source in sources:
                if source in live:
                    images = [live[source]]
                else:
                    try:
                        images = [live[face] for face in _faces(maker.Modified(source.wrapped)) if face in live]
                    except Exception:  # noqa: BLE001 - without a history the face is named by its neighbours
                        images = []
                names.add(label, images)
            solid_tools = [(tool_id, solid) for tool_id in tool_ids for solid in self.bodies[tool_id].Solids()]
            regions = []
            for region in result.Solids():
                point = _inside_point(region)
                owner = None if point is None else next((t for t, solid in solid_tools if _classify(solid, point) == "in"), None)
                regions.append((region, region.Center() if point is None else point, owner))
            regions.sort(key=lambda r: (round(r[1].z, 6), round(r[1].y, 6), round(r[1].x, 6)))
            feature.detail = {"cells": [{"point": [round(v, 3) for v in point.toTuple()], "volume_mm3": round(region.Volume(), 3),
                                         **({"inside": owner} if owner else {})} for region, point, owner in regions]}
            if not regions:
                raise FeatureError("These bodies and planes don't enclose any region; add a plane or body that closes one "
                                   "off (to grow a body to a plane, an extrude or a split may be what's wanted).")
            if cells is None:
                chosen = [k for k, (_, _, owner) in enumerate(regions) if owner is None]
                if not chosen and tools_after != "include":
                    raise FeatureError("Every region these bound lies inside a tool body: pick regions with cells=[(x, y, z), …] "
                                       "(the detail lists a point inside each), or add a plane that closes off an empty one.")
            else:
                chosen = []
                for i, point in enumerate(_cell_points(cells)):
                    states = [_classify(region, point) for region, _, _ in regions]
                    if "in" not in states:
                        raise FeatureError(f"cells[{i}] lies on a boundary between regions; move it inside one." if "on" in states
                                           else f"cells[{i}] isn't inside any enclosed region; the detail lists a point inside each.")
                    if states.index("in") not in chosen:
                        chosen.append(states.index("in"))
            if tools_after == "include":
                chosen += [k for k, (_, _, owner) in enumerate(regions) if owner is not None and k not in chosen]
            if not chosen:
                raise FeatureError("Pick at least one region: cells=[(x, y, z), …], a point inside each.")
            feature.detail["used"] = len(chosen)
            picked = [regions[k][0] for k in sorted(chosen)]
            raw = picked[0]
            if len(picked) > 1:
                fuse = BRepAlgoAPI_Fuse()
                fuse.SetArguments(_list(picked[:1]))
                fuse.SetTools(_list(picked[1:]))
                fuse.SetRunParallel(False)
                fuse.Build()
                if not fuse.IsDone():
                    raise FeatureError("Joining the chosen regions failed in the geometry kernel.")
                raw = cq.Shape.cast(fuse.Shape())
                names.update(fuse, raw, picked)
            # A copy, merged: the regions share faces with the tool bodies, which must stay as they are.
            tool = _solid(self._clean(raw, [raw], names))
            names.prune(tool)
            names.faces = {label: faces for label, faces in names.faces.items() if faces}
            self._record_tool(feature, tool, names, op, body)
            if tools_after != "keep":
                self._used_up([tool_id for tool_id in tool_ids if tool_id != feature.body])

    def move(self, id, bodies, translate=(0, 0, 0), rotate=None, copy=False, name=None, suppressed=False):
        """Rotates bodies about an axis (`rotate=(axis, degrees)`), then translates them. Moved bodies keep
        their ids and face names, and a sheet-metal body stays sheet metal with the same flat; `copy=True` keeps the
        originals and adds bodies `<body>_<id>` named `<id>.<name>` (a copy of a sheet-metal body is a plain solid)."""
        with self._feature(id, "move", name, suppressed) as feature:
            if feature is None:
                return
            ids = list(dict.fromkeys([bodies] if isinstance(bodies, str) else bodies or []))
            if not ids:
                raise FeatureError("Pick at least one body to move.")
            for body_id in ids:
                if body_id not in self.bodies:
                    raise FeatureError(f"Body {body_id!r} doesn't exist (bodies: {', '.join(self.bodies) or 'none'}).")
            if not isinstance(translate, (list, tuple)) or len(translate) != 3:
                raise FeatureError("translate must be (x, y, z) in mm.")
            offset = [float(v) for v in translate]
            trsf, axis, angle = gp_Trsf(), None, 0.0
            if rotate is not None:
                if not isinstance(rotate, (list, tuple)) or len(rotate) != 2:
                    raise FeatureError("rotate must be (axis, angle in degrees).")
                axis, angle = self.axis_of(rotate[0]), float(rotate[1])
                trsf.SetRotation(axis, math.radians(angle))
            shift = gp_Trsf()
            shift.SetTranslation(gp_Vec(*offset))
            trsf = shift.Multiplied(trsf)  # Rotation first, then the translation.
            copies, plain = [], []
            sheets = self.__dict__.get("_sheet_metal", {})
            for body_id in ids:
                before = self.bodies[body_id]
                sheet = sheets.get(body_id)
                sheet = sheet if sheet is not None and sheet.owner_shape is not None and before.isSame(sheet.owner_shape) else None
                maker = BRepBuilderAPI_Transform(before.wrapped, trsf, True)
                if not copy:
                    after = self._replace(body_id, maker, before)
                    if sheet is not None:
                        # A rigid move keeps a sheet-metal body sheet metal: its folded geometry moves, its flat doesn't.
                        sheets[body_id] = sheet.transformed(trsf)
                        sheets[body_id].owner_shape = after
                    continue
                if sheet is not None:
                    plain.append(f"{body_id}_{id}")
                renamed = Names()
                for label, faces in self.names.transformed(maker).faces.items():
                    if faces:
                        renamed.add(f"{id}.{label}", faces)
                active = self.active
                self._apply(feature, cq.Shape.cast(maker.Shape()), renamed, "new", f"{body_id}_{id}")
                self.active = active
                copies.append(f"{body_id}_{id}")
            if not copy:
                # Features built into a moved body pattern and mirror from where the body is now.
                for fid, (tool, names, op, body) in list(self._tools.items()):
                    owner = self.feature(fid)
                    if owner and owner.body in ids:
                        maker = BRepBuilderAPI_Transform(tool.wrapped, trsf, True)
                        self._tools[fid] = (cq.Shape.cast(maker.Shape()), names.transformed(maker), op, body)
                for fid, (kind, recorded, sizes, created) in list(self._edge_ops.items()):
                    owner = self.feature(fid)
                    if owner and owner.body in ids:
                        moved = [(cq.Edge(BRepBuilderAPI_Transform(edge.wrapped, trsf, True).Shape()),
                                  None if normal is None else _vec(gp_Vec(*normal).Transformed(trsf))) for edge, normal in recorded]
                        self._edge_ops[fid] = (kind, moved, sizes, created)
            feature.body = (copies or ids)[0]
            feature.created = [n for n in self.names.faces if n.startswith(f"{id}.")] if copy else []
            located = None
            if axis is not None:
                p, d = axis.Location(), axis.Direction()
                located = [round(v, 6) + 0.0 for v in (p.X(), p.Y(), p.Z(), d.X(), d.Y(), d.Z())]
            # The resolved transform, so the viewport's move handles start from what the build shows.
            feature.detail = {"bodies": ids, "translate": [round(v, 6) + 0.0 for v in offset], "axis": located, "angle": angle,
                              **({"copies": copies} if copy else {}),
                              # Copies of sheet-metal bodies are plain solids; the originals keep their flats.
                              **({"plain_solid_copies": plain} if plain else {})}

    def draft(self, id, faces, neutral, angle, pull=None, name=None, suppressed=False):
        """Tilts `faces` by `angle` degrees about where they meet the `neutral` plane (a plane or planar face), for
        moulding: the pull direction is the neutral plane's normal, or `pull=(dx, dy, dz)`."""
        from OCP.BRepOffsetAPI import BRepOffsetAPI_DraftAngle
        from OCP.gp import gp_Pln
        with self._feature(id, "draft", name, suppressed) as feature:
            if feature is None:
                return
            picked = self.faces(faces)
            body_id = self.body_of(picked, "draft")
            before = self.bodies[body_id]
            p = self.plane_of(neutral)
            direction = gp_Dir(*(cq.Vector(*pull) if pull else p.zDir).toTuple())
            maker = BRepOffsetAPI_DraftAngle(before.wrapped)
            for face in picked:
                maker.Add(face.wrapped, direction, math.radians(float(angle)), gp_Pln(gp_Pnt(*p.origin.toTuple()), gp_Dir(*p.zDir.toTuple())))
                if not maker.AddDone():
                    raise FeatureError("One of the faces can't take that draft (it may be parallel to the pull direction).")
            maker.Build()
            if not maker.IsDone():
                raise FeatureError("The draft failed in the geometry kernel.")
            self._replace(body_id, maker, before)
            feature.body = body_id

    def sphere(self, id, radius, at=(0, 0, 0), op=None, body=None, name=None, suppressed=False):
        """A sphere of `radius` mm centred on `at`. Face "<id>.side"; `op`/`body` as for extrude."""
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeSphere
        with self._feature(id, "sphere", name, suppressed) as feature:
            if feature is None:
                return
            shape = cq.Shape.cast(BRepPrimAPI_MakeSphere(gp_Pnt(*(float(v) for v in at)), float(radius)).Shape())
            names = Names()
            names.add(f"{id}.side", shape.Faces())
            self._record_tool(feature, shape, names, op, body)

    def cone(self, id, radius1, radius2, height, at=(0, 0, 0), direction=(0, 0, 1), op=None, body=None, name=None, suppressed=False):
        """A cone (or frustum) of `height` mm along `direction`: `radius1` at its bottom, centred on `at`, `radius2` at
        its top (0 for a point). Faces "<id>.side", "<id>.top", "<id>.bottom"; `op`/`body` as for extrude."""
        with self._feature(id, "cone", name, suppressed) as feature:
            if feature is None:
                return
            shape = _cone(cq.Vector(*at), cq.Vector(*direction), float(radius1), float(radius2), float(height))
            names = Names()
            for face in shape.Faces():
                if face.geomType() == "CONE":
                    names.add(f"{id}.side", [face])
                else:
                    top = (face.Center() - cq.Vector(*at)).dot(cq.Vector(*direction).normalized()) > float(height) / 2
                    names.add(f"{id}.{'top' if top else 'bottom'}", [face])
            self._record_tool(feature, shape, names, op, body)

    def torus(self, id, major_radius, minor_radius, at=(0, 0, 0), direction=(0, 0, 1), op=None, body=None, name=None, suppressed=False):
        """A torus centred on `at` about `direction`: `major_radius` to the tube's centre, `minor_radius` the tube's.
        Face "<id>.side"; `op`/`body` as for extrude."""
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeTorus
        with self._feature(id, "torus", name, suppressed) as feature:
            if feature is None:
                return
            ax = gp_Ax2(gp_Pnt(*(float(v) for v in at)), gp_Dir(*(float(v) for v in direction)))
            shape = cq.Shape.cast(BRepPrimAPI_MakeTorus(ax, float(major_radius), float(minor_radius)).Shape())
            names = Names()
            names.add(f"{id}.side", shape.Faces())
            self._record_tool(feature, shape, names, op, body)

    def wedge(self, id, dx, dy, dz, xmin, zmin, xmax, zmax, at=(0, 0, 0), op=None, body=None, name=None, suppressed=False):
        """A wedge (OpenCASCADE's): a `dx` × `dy` × `dz` mm block with its lowest corner at `at`, narrowing along Y to a top face spanning
        `xmin`..`xmax` in X and `zmin`..`zmax` in Z. Faces are numbered "<id>.face(<n>)"; `op`/`body` as for
        extrude."""
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeWedge
        with self._feature(id, "wedge", name, suppressed) as feature:
            if feature is None:
                return
            maker = BRepPrimAPI_MakeWedge(float(dx), float(dy), float(dz), float(xmin), float(zmin), float(xmax), float(zmax))
            shape = cq.Shape.cast(maker.Shape()).translate(cq.Vector(*at))
            names = Names()
            for i, face in enumerate(shape.Faces()):
                names.add(f"{id}.face({i})", [face])
            self._record_tool(feature, shape, names, op, body)

    def text(self, id, text, on="XY", size=10.0, depth=1.0, at=(0, 0), font="DejaVu Sans", halign="center", valign="center",
             op="join", body=None, name=None, suppressed=False):
        """Raised (op="join") or engraved (op="cut", negative depth) text on a plane or planar face."""
        with self._feature(id, "text", name, suppressed) as feature:
            if feature is None:
                return
            plane = self.plane_of(on)
            origin = plane.toWorldCoords(tuple(at))
            placed = cq.Plane(origin=origin, xDir=plane.xDir, normal=plane.zDir)
            height = -abs(float(depth)) if op == "cut" else float(depth)  # Engraving goes into the face.
            shape = cq.Compound.makeText(str(text), float(size), height, font=font, halign=halign, valign=valign, position=placed)
            names = Names()
            names.add(f"{id}.glyphs", shape.Faces())
            self._record_tool(feature, shape, names, op, body)

    def add(self, id, shape, op=None, body=None, name=None, suppressed=False):
        """Brings geometry made by plain CadQuery code into the model as a body (faces named by position). A linked part
        (`from links import standoff`) works too: `model.add("boss_1", standoff(height=8))`, or its moved result
        `standoff(height=8).result.translate((x, y, z))`; the feature's detail names the linked document and revision."""
        from .links import Link, LinkedInstance
        with self._feature(id, "add", name, suppressed) as feature:
            if feature is None:
                return
            if isinstance(shape, Link):
                shape = shape()
            if isinstance(shape, LinkedInstance):
                if shape.result is None:
                    raise FeatureError(f"{shape.name} has no geometry to add.")
                feature.detail = {"link": shape.alias, **{key: shape.source[key] for key in ("document_id", "revision") if shape.source.get(key) is not None},
                                  **({"overrides": dict(shape.overrides)} if shape.overrides else {})}
                shape = shape.result
            if isinstance(shape, cq.Workplane):
                shapes = [v for v in shape.vals() if isinstance(v, cq.Shape)]
            elif isinstance(shape, cq.Assembly):
                shapes = [shape.toCompound()]
            elif isinstance(shape, cq.Shape):
                shapes = [shape]
            else:
                raise FeatureError("model.add expects a CadQuery Workplane, Shape or Assembly.")
            solids = [s for v in shapes for s in v.Solids()]
            if not solids:
                # Only faces (Face.makeNSidedSurface, interpPlate, an open shell): a surface body of its own. Code
                # that has solids too keeps only the solids, as before.
                solids = [s for v in shapes for s in (v.Shells() or v.Faces())]
                if not solids:
                    raise FeatureError("The code produced no solid or surface to add.")
                if op not in (None, "new"):
                    raise FeatureError(f"A surface can't {op} with a body: {SURFACE_NOTE}.")
                op = "new"
            combined = solids[0] if len(solids) == 1 else cq.Compound.makeCompound(solids)
            names = Names()
            for i, face in enumerate(sorted(combined.Faces(), key=lambda f: (round(f.Center().z, 6), round(f.Center().y, 6), round(f.Center().x, 6)))):
                names.add(f"{id}.face({i})", [face])
            self._record_tool(feature, combined, names, op, body)

    def import_step(self, id, source, name=None, op="new", body=None, solids=None, suppressed=False):
        """A STEP or Autodesk Fusion (.f3d) file uploaded to STEVE (POST /v1/imports), by sha256 or import id. `op="new"`
        adds a body per solid (`<id>`, or `<id>_<k>` when the file has several); join/cut/intersect combine them with a
        body. Faces are named in file order: `<id>.face(<i>)`, or `<id>.solid(<k>).face(<i>)`. `solids=[k, …]` picks
        some. A Fusion file comes in as its exact solids (its timeline isn't rebuilt); its parameters and features are
        reported in the feature's detail as data."""
        from . import imports
        with self._feature(id, "import_step", name, suppressed) as feature:
            if feature is None:
                return
            try:
                found = imports.solids(source)
            except (imports.StepImportError, FileNotFoundError) as error:
                raise FeatureError(str(error)) from None
            several = len(found) > 1
            picked = list(range(1, len(found) + 1)) if solids is None else [int(k) for k in ([solids] if isinstance(solids, (int, float)) else solids)]
            if not picked or any(not 1 <= k <= len(found) for k in picked):
                raise FeatureError(f"The file has {len(found)} solid{'s' if several else ''}; pick solids 1 to {len(found)}.")
            tools, named = [], []
            for k in picked:
                tool = found[k - 1][0]
                # Local fix: a repeated import must be a distinct body even
                # before the Move tool separates it from the first instance.
                # Reusing the same cached TShape collapses coincident solids
                # during glTF/topology export. Copy only this reused body.
                if (op or "new") == "new" and any(tool.isSame(existing) for existing in self.bodies.values()):
                    tool = tool.copy()
                names = Names()
                for i, face in enumerate(tool.Faces()):
                    names.add(f"{id}.solid({k}).face({i})" if several else f"{id}.face({i})", [face])
                tools.append(tool)
                named.append(names)
            everything = Names()
            for names in named:
                everything.merge(names)
            bodies = []
            if (op or "new") == "new":
                for k, tool, names in zip(picked, tools, named):
                    self._apply(feature, tool, names, "new", f"{body or id}_{k}" if several else body)
                    bodies.append(feature.body)
                    if found[k - 1][1]:   # the file's name for it, shown until the person names the body (body_name wins)
                        self.__dict__.setdefault("file_body_names", {})[feature.body] = found[k - 1][1]
            else:
                self._apply_many(feature, tools, everything, op, body)
                bodies.append(feature.body)
            self._tools[id] = (tools[0] if len(tools) == 1 else cq.Compound.makeCompound(tools), everything, op, body)
            feature.body, feature.created = bodies[0], [n for n in everything.faces if self.names.faces.get(n)]
            feature.detail = {"solids": len(found), "imported": picked if solids is not None else len(picked), "bodies": bodies,
                              "faces": sum(len(names.faces) for names in named), "file": imports.sha256(source)[:12],
                              "names": _within([found[k - 1][1] for k in picked], NAMES_CHARS)}
            extras = imports.extras(source)
            if extras is not None:
                feature.detail.update({"format": "f3d", "fusion": extras})
                if extras.get("skipped_surfaces"):  # Surface bodies in the Fusion file: left out, and said so.
                    feature.warning = extras["note"]

    def point(self, id, at, name=None, suppressed=False):
        """A construction point named `id` at (x, y, z) mm."""
        with self._feature(id, "point", name, suppressed) as feature:
            if feature is None:
                return
            self.points[id] = cq.Vector(*(float(v) for v in at))

    def body_name(self, body, name):
        """A body's display name (`summary()["bodies"][id]["name"]`); its id, references and geometry stay as they are."""
        if not isinstance(body, str) or not isinstance(name, str) or not name.strip():
            raise FeatureError("model.body_name takes a body id and a non-empty name.")
        self.__dict__.setdefault("body_names", {})[body] = name.strip()

    def material(self, material, bodies=None, finish=None, color=None):
        """The part's physical material, or some bodies' (`bodies=`): a material library id (steve/materials.py).
        The summary reports each body's material and mass; `finish` and `color` are appearance only. Not a feature."""
        from .materials import Assignments
        self._around_material(False)
        try:
            self.__dict__.setdefault("materials", Assignments()).add(material, bodies, finish, color)
        except ValueError as error:
            raise FeatureError(str(error)) from None
        self._around_material(True)

    def _around_material(self, done: bool) -> None:
        """Sheet-metal features assign materials themselves, between the file's own `material` statements. A build
        notes each assignment with how many statements came before it, and a restored model (whose features don't
        run) makes it again at that point, so it reports the same materials and mass as the build it came from."""
        restored = getattr(self, "_restored", False)
        if not done:
            if not restored:
                self._note_materials()  # What features assigned since the last statement.
            return
        self._material_calls = self.__dict__.get("_material_calls", 0) + 1
        if restored:
            self._replay_materials()
        else:
            assigned = self.__dict__.get("materials")
            self._materials_seen = dict(assigned.bodies) if assigned else {}

    def _note_materials(self) -> None:
        assigned = self.__dict__.get("materials")
        seen = self.__dict__.get("_materials_seen", {})
        made = {body: entry for body, entry in (assigned.bodies.items() if assigned else ()) if seen.get(body) != entry}
        if made:
            self.__dict__.setdefault("_feature_materials", []).append([self.__dict__.get("_material_calls", 0), made])
            self._materials_seen = dict(assigned.bodies)

    def _replay_materials(self) -> None:
        from .materials import Assignments
        pending, calls = self.__dict__.get("_pending_materials", []), self.__dict__.get("_material_calls", 0)
        for at, made in [item for item in pending if item[0] <= calls]:
            self.__dict__.setdefault("materials", Assignments()).bodies.update(made)
        self._pending_materials = [item for item in pending if item[0] > calls]

    def _reinsert(self, feature) -> None:
        """Puts a restored model's decal back where the cached history had it (a new one goes last)."""
        order = self.__dict__.get("_order", {})
        if feature.id not in order:
            return
        self.features.remove(feature)
        at = order[feature.id]
        self.features.insert(sum(1 for f in self.features if order.get(f.id, math.inf) < at), feature)

    def _reuse_decal(self, id, call) -> bool:
        """On a restored model, a decal whose call is unchanged since the cached build takes its cached feature."""
        cached = self.__dict__.get("_cached_decals", {}).pop(id, None)
        if cached is None or call is None or cached[1] != call or id in self._ids:
            return False
        feature = Feature(**cached[0])
        self._ids.add(id)
        self.features.append(feature)
        self._reinsert(feature)
        return True

    # ───────── build cache ─────────
    # A design component's cache entry (steve.design), and a part's geometry from an earlier build (part_record): the
    # model's bodies as BREP, its names, history, sketches and construction geometry. A restored model runs no feature;
    # its decals and material statements run again (they're left out of the keys, steve.cachekeys).

    def _record(self) -> dict:
        self._place_decals()  # Projected decals' faces on the finished bodies: a restored model can't resolve them.
        self._note_materials()  # Sheet-metal features' assignments after the file's last material statement.
        where, first = {}, {}
        for body_id, body in self.bodies.items():
            for index, face in enumerate(body.Faces()):
                where[face] = (body_id, index)
                first.setdefault(face, body_id)
        bodies = {}
        for body_id, body in self.bodies.items():
            buffer = io.BytesIO()
            body.exportBrep(buffer)
            bodies[body_id] = base64.b64encode(buffer.getvalue()).decode()
        plane = lambda p: [list(p.origin.toTuple()), list(p.xDir.toTuple()), list(p.zDir.toTuple())]  # noqa: E731
        return {
            "version": CACHE_VERSION, "id": getattr(self, "id", None), "name": self.name, "active": self.active, "bodies": bodies,
            "names": {name: [where[f] for f in faces if f in where] for name, faces in self.names.faces.items()},
            # A face shared by bodies (two extrudes of one sketch) is restored on the last; a decal on it belongs to the
            # first, as in a build.
            "shared_faces": [[*where[face], body_id] for face, body_id in first.items() if where[face][0] != body_id],
            "features": [dataclasses.asdict(f) for f in self.features],
            "sketches": {sid: {"name": sk.name, "plane": plane(sk.plane), "entities": sk.entities, "constraints": sk.constraints,
                               "report": dataclasses.asdict(sk.report), "projections": sk.projections} for sid, sk in self.sketches.items()},
            "planes": {pid: plane(p) for pid, p in self.planes.items()},
            "axes": {k: list(v) for k, v in self.axes.items()},
            "points": {k: list(v.toTuple()) for k, v in self.points.items()},
            "sheet_metal": {key: {**sheet.record(), "valid": sheet.owner_shape is not None and
                             key in self.bodies and self.bodies[key].isSame(sheet.owner_shape)}
                            for key, sheet in self.__dict__.get("_sheet_metal", {}).items()},
            # Run again on a restore rather than restored: decals (unless their call is unchanged) and the file's
            # material statements, between which the features' own material assignments are made again.
            "decals": self.__dict__.get("_decal_calls", {}),
            "feature_materials": self.__dict__.get("_feature_materials", []),
            "file_body_names": self.__dict__.get("file_body_names", {}),
        }

    def _restore(self, record: dict) -> None:
        to_plane = lambda r: cq.Plane(origin=tuple(r[0]), xDir=tuple(r[1]), normal=tuple(r[2]))  # noqa: E731
        self.bodies = {bid: cq.Shape.importBrep(io.BytesIO(base64.b64decode(data))) for bid, data in record["bodies"].items()}
        faces = {bid: body.Faces() for bid, body in self.bodies.items()}
        self.names = Names()
        for name, places in record["names"].items():
            self.names.add(name, [faces[bid][i] for bid, i in places])
        self._decal_bodies = {faces[bid][i]: owner for bid, i, owner in record.get("shared_faces", [])}
        features = [Feature(**f) for f in record["features"]]
        # Decals aren't geometry, and their statements are left out of the cache key (steve.cachekeys): each runs
        # again, landing on the restored faces, and takes back its place in the history (an unchanged one, its cached
        # feature). A decal whose statement is gone is gone from the history.
        self._order = {f.id: i for i, f in enumerate(features)}
        calls = record.get("decals", {})
        self._cached_decals = {f.id: (dataclasses.asdict(f), calls.get(f.id)) for f in features if f.kind == "decal"}
        self.features = [f for f in features if f.kind != "decal"]
        self._ids = {f.id for f in self.features}
        if record.get("file_body_names"):
            self.file_body_names = dict(record["file_body_names"])
        self._pending_materials = [list(item) for item in record.get("feature_materials", [])]
        self._material_calls = 0
        self.active = record["active"]
        self.sketches = {}
        for sid, item in record["sketches"].items():
            sketch = Sketch(sid, to_plane(item["plane"]), item["name"])
            sketch.entities, sketch.constraints = item["entities"], item["constraints"]
            sketch.report, sketch.projections = SolveReport(**item["report"]), item["projections"]
            self.sketches[sid] = sketch
        self.planes = {pid: to_plane(r) for pid, r in record["planes"].items()}
        self.axes = {k: tuple(v) for k, v in record["axes"].items()}
        self.points = {k: cq.Vector(*v) for k, v in record["points"].items()}
        if record.get("sheet_metal"):
            from .sheetmetal.geometry import Sheet
            self._sheet_metal = {key: Sheet.restore(item, self.bodies[key]) for key, item in record["sheet_metal"].items()}
        self._restored = True
        self._replay_materials()  # Those made before the file's first material statement.

    def appearance(self, color=None, finish=None, opacity=None, roughness=None, metalness=None, bodies=None, faces=None):
        """How the part, some bodies (`bodies=`) or some faces (`faces=`: face references as `faces()` takes them,
        "extrude_1.end", "door.side_faces", select(...), resolved on the finished model at every build) look, without a
        physical material: paint, glazing, bands, presentation of proxy geometry. `color` hex; `finish` a finish id
        ("painted", "matte" …); `opacity`, `roughness`, `metalness` 0–1. Wins over a material's look (a face's over its
        body's); never sets a density or changes geometry, so mass, simulation and solids follow `model.material` only."""
        from .materials import Appearances
        try:
            self.__dict__.setdefault("appearances", Appearances()).add(color, finish, opacity, roughness, metalness, bodies, faces)
        except ValueError as error:
            raise FeatureError(str(error)) from None

    def decal(self, id, image, on, width, height=None, at=None, rotation=0.0, direction=None, depth=None, wrap=False, name=None, suppressed=False):
        """An image shown on a part's faces: a label, a screen, a logo, markings on a curved skin. Appearance only: the
        geometry, mass and exports (STEP, STL) don't change. `image` is an uploaded image's id ("img_" + 12 hex digits);
        `on` one face reference or several (a list, select(...), "loft_1.side_faces"), of any surface type, all on one
        body; `width` in mm (`height` too, else the image's aspect ratio); `rotation` in degrees, counter-clockwise seen
        from outside.
        On one flat face the image lies on it: `at` is its centre in the face's sketch coordinates (default: the face's
        centre). On curved or several faces (or with `direction=`/`depth=`) it is projected, like a slide projector:
        `at` is a point (x, y, z) on or near the faces, snapped onto them (default: the middle of the first face);
        `direction=(x, y, z)` the side it is seen from (default: the surface normal there); `depth` in mm (default: half
        the image's larger side) how far in front of and behind that point it reaches, so it never prints through to the
        far side. Only faces turned toward the projector show it. The faces are resolved again on the finished model at
        every build (as model.appearance(faces=...)), so the decal stays on them through later features.
        Projection suits markings seen from one side. `wrap=True` instead lays the image along the surface like a vinyl
        sticker, keeping its lengths on the skin: for stripes, bands and text running round a body (a 300 mm stripe
        round a fuselage covers 300 mm of skin). `at`, `rotation` and `direction` (which way is up) mean the same;
        `depth` doesn't apply. A large wrap on a doubly curved patch (a sphere, a nose cone's tip) must stretch: the
        feature's warning says so."""
        call = _call_text([image, on, width, height, at, rotation, direction, depth, wrap, name, suppressed])
        if self._reuse_decal(id, call):
            return
        self.__dict__.setdefault("_decal_calls", {})[id] = call
        with self._feature(id, "decal", name, suppressed) as feature:
            if feature is None:
                return
            if not isinstance(image, str) or not re.fullmatch(r"img_[0-9a-f]{12}", image):
                raise FeatureError(f"image= takes an uploaded image's id such as \"img_3fa2b9c41d07\"; got {image!r}.")
            for label, value in (("width", width), ("height", height), ("depth", depth)):
                if value is not None and (not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 < value < 1e6):
                    raise FeatureError(f"{label}= is a size in mm, more than 0; got {value!r}.")
            if not isinstance(rotation, (int, float)) or isinstance(rotation, bool):
                raise FeatureError(f"rotation= is an angle in degrees; got {rotation!r}.")
            if direction is not None and not (isinstance(direction, (list, tuple)) and len(direction) == 3 and _numbers(direction)
                                              and cq.Vector(*(float(v) for v in direction)).Length > 1e-9):
                raise FeatureError(f"direction= is a direction (x, y, z), not zero; got {direction!r}.")
            if not isinstance(wrap, bool):
                raise FeatureError(f"wrap= is True or False; got {wrap!r}.")
            if wrap and depth is not None:
                raise FeatureError("depth= is for projected decals; a wrapped decal follows the surface, so leave depth out.")
            refs = list(on) if isinstance(on, (list, tuple)) else [on]
            if not refs:
                raise FeatureError("on= takes a face reference or several, e.g. on=[\"loft_1.side_faces\"].")
            faces: list[cq.Face] = []
            for ref in refs:
                if isinstance(ref, cq.Plane) or _foreign(ref):
                    raise FeatureError(f"A decal goes on this part's own faces; {_ref_label(ref)!r} isn't one.")
                found = self.faces(ref)
                if not found:
                    raise FeatureError(f"Decal face reference {_ref_label(ref)!r} names no face.")
                faces += [face for face in found if face not in faces]
            vector = lambda v: [round(v.x, 6) + 0.0, round(v.y, 6) + 0.0, round(v.z, 6) + 0.0]
            if wrap or len(faces) != 1 or faces[0].geomType() != "PLANE" or direction is not None or depth is not None:
                self._projected_decal(feature, image, refs, faces, width, height, at, rotation, direction, depth, vector)
                if wrap and feature.detail:
                    feature.detail["wrap"] = True
                    feature.warning = _wrap_stretch(faces, cq.Vector(*feature.detail["origin"]), float(width), height)
                return
            face = faces[0]
            plane = _face_plane(face)
            if at is None:
                origin = face.Center()
            else:
                if not isinstance(at, (list, tuple)) or len(at) != 2 or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in at):
                    raise FeatureError(f"at= is a point (x, y) in the face's sketch coordinates; got {at!r}.")
                origin = plane.toWorldCoords((float(at[0]), float(at[1])))
            normal = face.normalAt(face.Center()).normalized()  # Outward: the side the image shows on.
            angle = math.radians(float(rotation))
            x_dir = plane.xDir * math.cos(angle) + normal.cross(plane.xDir) * math.sin(angle)
            # A restored component's shared faces name the body a build gives them (Component._restore).
            body = self.__dict__.get("_decal_bodies", {}).get(face) or next(
                (body_id for body_id, shape in self.bodies.items() if any(face.isSame(f) for f in shape.Faces())), None)
            feature.detail = {"image": image, "face": on, "origin": vector(origin), "normal": vector(normal), "x_dir": vector(x_dir.normalized()),
                              "width": float(width), "height": float(height) if height is not None else None, **({"body": body} if body else {})}

    def _projected_decal(self, feature, image, refs, faces, width, height, at, rotation, direction, depth, vector):
        """model.decal on curved or several faces: the projector's frame and the faces it lands on (see `decal`)."""
        index = {face: (body_id, i) for body_id, shape in self.bodies.items() for i, face in enumerate(shape.Faces())}
        bodies = list(dict.fromkeys(index[face][0] for face in faces if face in index))
        if len(bodies) != 1:
            raise FeatureError(f"A decal goes on faces of one body; {', '.join(repr(_ref_label(r)) for r in refs)} "
                               + (f"are on {len(bodies)} bodies." if bodies else "aren't on a body."))
        if at is None:
            owner, origin = faces[0], _face_middle(faces[0])
        else:
            if not isinstance(at, (list, tuple)) or len(at) != 3 or not _numbers(at):
                raise FeatureError(f"at= is a point (x, y, z) on or near the decal's faces (in the part's coordinates); got {at!r}.")
            owner, origin = _nearest_face(faces, cq.Vector(*(float(v) for v in at)))
        normal = owner.normalAt(origin).normalized()  # Outward: the side the image shows on.
        view = normal if direction is None else cq.Vector(*(float(v) for v in direction)).normalized()
        base = cq.Vector(1, 0, 0) if abs(view.x) <= 0.99 else cq.Vector(0, 1, 0)  # As _face_plane: global X, projected.
        base = (base - view * base.dot(view)).normalized()
        angle = math.radians(float(rotation))
        x_dir = base * math.cos(angle) + view.cross(base) * math.sin(angle)
        feature.detail = {"image": image, "on": [_ref_label(ref) for ref in refs], "origin": vector(origin), "direction": vector(view),
                          "x_dir": vector(x_dir.normalized()), "width": float(width), "height": float(height) if height is not None else None,
                          # None: half the image's larger side, known once its proportions are (the viewer).
                          "depth": float(depth) if depth is not None else None,
                          "body": bodies[0], "faces": sorted(index[face][1] for face in faces if index.get(face, ("",))[0] == bodies[0])}
        self.__dict__.setdefault("_decal_refs", {})[feature.id] = refs

    def _place_decals(self) -> None:
        """Projected decals' faces on the finished model, as model.appearance(faces=...) resolves them: the body and its
        face indices in export order, so a decal stays on its faces through later features. A reference that names no
        face of the part's bodies now fails its decal, by the reference's name."""
        placed = self.__dict__.get("_decal_refs")
        if not placed:
            return
        index = {face: (body_id, i) for body_id, body in self.bodies.items() for i, face in enumerate(body.Faces())}
        for feature in self.features:
            refs = placed.get(feature.id)
            if refs is None or feature.status != "ok":
                continue
            hits: list[tuple[str, int]] = []
            for ref in refs:
                try:
                    found = [index[face] for face in self.faces(ref) if face in index]
                except Exception as error:  # FeatureError, a selector that fails on this geometry
                    feature.status, feature.error = "error", f"Decal face reference {_ref_label(ref)!r}: {error}"
                    break
                if not found:
                    feature.status, feature.error = "error", f"Decal face reference {_ref_label(ref)!r} names no face of the part's bodies now."
                    break
                hits += found
            else:
                body = hits[0][0]
                feature.detail["body"], feature.detail["faces"] = body, sorted({i for body_id, i in hits if body_id == body})

    def _direction(self, ref) -> cq.Vector:
        if isinstance(ref, (list, tuple)):
            return cq.Vector(*ref).normalized()
        ax = self.axis_of(ref)
        d = ax.Direction()
        return cq.Vector(d.X(), d.Y(), d.Z())

    # ───────── output ─────────

    def _extent(self) -> float:
        if not self.bodies:
            return 100.0
        box = cq.Compound.makeCompound(list(self.bodies.values())).BoundingBox()
        return max(box.DiagonalLength, 1.0)

    def result(self):
        """The model's geometry for the runtime: one solid, or a compound of bodies."""
        shapes = list(self.bodies.values())
        if not shapes:
            errors = [f"{f.name}: {f.error}" for f in self.features if f.status == "error"]
            if errors:
                raise FeatureError("The model has no bodies yet. " + " ".join(errors))
            # Nothing modelled yet, or only sketches and construction geometry: an empty part, not a build error.
            empty = cq.Compound.makeCompound([])
            empty._steve_model, empty._steve_empty = self, True
            _ACTIVE.append(self)
            return empty
        if all(is_surface(s) for s in shapes):  # Builds, but has nothing to mesh, weigh, simulate or machine yet.
            last = next((f for f in reversed(self.features) if f.status == "ok" and f.body in self.bodies), None)
            if last is not None and not last.warning:
                last.warning = (f"The part has only surface bodies, so it has no volume or mass and is left out of mesh "
                                f"exports, simulation and machining: {SURFACE_NOTE}.")
        shape = shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes)
        shape._steve_model = self  # The runtime exports names for picking from here.
        _ACTIVE.append(self)
        return shape

    def summary(self) -> dict:
        """The build's report: each feature's status, each body's kind, faces, volume (a surface's area instead), extent
        and material, each sketch's solver state and regions."""
        self._place_decals()
        assigned = self.__dict__.get("materials")
        looks = self.__dict__.get("appearances")  # model.appearance: the look only, never mass.
        faced, face_problems = looks.face_looks(self) if looks else ({}, [])
        warnings =[{"feature": f.id, "message": f.warning} for f in self.features if f.warning and f.status == "ok"]
        surfaces = {body_id for body_id, body in self.bodies.items() if is_surface(body)}
        solids = {body_id: body.Volume() for body_id, body in self.bodies.items() if body_id not in surfaces}

        def measured(body_id, body):
            if body_id in surfaces:  # No volume, mass or material mass: a surface's area, and the note why.
                return {"kind": "surface", "area_mm2": round(surface_area(body), 4), "note": SURFACE_NOTE}
            return {"kind": "solid", "volume": round(solids[body_id], 4)}

        return {"version": 1, "features": [f.public() for f in self.features],
                **({"warnings": warnings} if warnings else {}),
                # A part restored from an earlier build of the same geometry (only its looks changed): no feature ran.
                **({"cache": "hit"} if type(self) is Model and self.__dict__.get("cache") == "hit" else {}),
                # `index`: export order (stores such as Postgres jsonb don't keep key order).
                # `extent_mm`: exact [xmin, ymin, zmin, xmax, ymax, zmax], computed like the manufacturing geometry
                # check (steve.simulation.bounds), so a print can be placed exactly on its bed.
                "bodies": {body_id: {"faces": len(body.Faces()), **measured(body_id, body), "index": i,
                                     "extent_mm": _extent(body),
                                     "name": self.__dict__.get("body_names", {}).get(body_id) or self.__dict__.get("file_body_names", {}).get(body_id),
                                     **(assigned.body(body_id, solids[body_id]) if assigned and body_id in solids else {}),
                                     **({"appearance": looks.of(body_id)} if looks and looks.of(body_id) else {}),
                                     # model.appearance(faces=...): face indices in the body's export order.
                                     **({"face_appearances": looks.grouped(faced[body_id])} if body_id in faced else {})}
                           for i, (body_id, body) in enumerate(self.bodies.items())},
                # Each sketch's plane as the build placed it ([origin, x, normal]): where to show it when the face it was
                # drawn on is gone from the finished model (a later feature used it up).
                "sketches": {sid: {"solver": s.report.status, "dof": s.report.dof,
                                   "plane": [[round(v, 9) for v in vector.toTuple()] for vector in (s.plane.origin, s.plane.xDir, s.plane.zDir)],
                                   "regions": [{"name": r.name, "area": round(surface_area(r.face), 4), "depth": r.depth} for r in _safe_regions(s)],
                                   **({"projections": s.projections} if s.projections else {})}
                             for sid, s in self.sketches.items()},
                **({"materials": assigned.report(solids, surfaces)} if assigned else {}),
                **({"appearances": {"default": looks.default, "problems": looks.problems(self.bodies) + face_problems}} if looks else {}),
                **({"sheet_metal": self.sheet_metal_summary()} if self.__dict__.get("_sheet_metal") else {})}

    def refs(self, shape: cq.Shape) -> dict:
        """Persistent names for every face, edge and vertex of a (sub)shape, for pick → reference. Each face's is its
        own (Names.unique: the pieces of a split face are `<name>[i]`); edges and vertices are named from the faces'
        shared names."""
        faces = self.names.unique()
        return {"faces": {face: faces.get(face) for face in shape.Faces()},
                "edges": edge_names(shape, self.names), "vertices": vertex_names(shape, self.names)}


_ACTIVE: list[Model] = []

# A part's own model: made by main.py's code itself (the name the runtime runs it under, run.MAIN). Each run's
# (run.build clears the list), so a part making several models is never recorded or restored as one.
MAIN_FILE = "/work/model.py"
_MAIN_MODELS: list[Model] = []


def part_record() -> dict | None:
    """The geometry record of an earlier build of this part's geometry (Model._record), when the dispatcher sent one:
    the one file in STEVE_PART_CACHE (runtime/kernel.py puts it there; app/worker.py part_geometry chose it from the
    person's own builds by steve.cachekeys part_key). None otherwise, or when it isn't one."""
    folder = os.environ.get("STEVE_PART_CACHE")
    entries = sorted(Path(folder).glob("*.json")) if folder and Path(folder).is_dir() else []
    if len(entries) != 1:
        return None
    try:
        record = json.loads(entries[0].read_text())
    except (OSError, ValueError, RecursionError):
        return None
    return record if isinstance(record, dict) and record.get("version") == CACHE_VERSION else None


def part_restored(model) -> bool:
    """Whether `model` is a part's own model restored from an earlier build (part_record)."""
    return type(model) is Model and model.__dict__.get("cache") == "hit"


def recordable_part(model) -> bool:
    """Whether a full build's geometry record of `model` can serve a later build of the same part: the part's one own
    model, built here (not restored), with nothing from a linked document (its key can't see those)."""
    return (type(model) is Model and len(_MAIN_MODELS) == 1 and _MAIN_MODELS[0] is model and not part_restored(model)
            and model.__dict__.get("_cacheable", True) is not False)


def _foreign(ref, model=None):
    """A reference into another component or a linked part (`disk.face(...)`, see design.py) as (what resolves it, name).
    A model resolving one into a linked part isn't cached: its cache key can't see the link's revision."""
    if not getattr(ref, "_steve_ref", False):
        return None
    if model is not None and getattr(ref.target, "_steve_linked", False):
        model._cacheable = False
    return ref.target, ref.ref


def _numbered_hint(ref: str) -> str:
    """Numbered faces (model.add, import_step, wedge) renumber when that geometry changes: say what holds up."""
    if not re.search(r"\.face\(\d+\)", ref):
        return ""
    return (" Numbered faces (.face(<n>)) from model.add or import_step renumber when that geometry changes;"
            " reference it by geometry instead, e.g. select(edges, \"%CIRCLE\", on=\"<body>\") or a CadQuery selector"
            " object such as cq.selectors.BoxSelector((x0, y0, z0), (x1, y1, z1)).")


def active_model() -> Model | None:
    return _ACTIVE[-1] if _ACTIVE else None


# An import's file names in its detail: every one, in file order, within this many characters together (each name is at
# most 120), so a file of thousands of bodies keeps its names well inside result.json's size.
NAMES_CHARS = 200_000


def _within(names: list, budget: int) -> list:
    out = []
    for name in names:
        budget -= len(name or "") + 4
        if budget < 0:
            break
        out.append(name)
    return out


def _safe_regions(sketch: Sketch):
    try:
        return sketch.regions()
    except SketchError:
        return []


def _nearest(edge: cq.Edge, tagged) -> str | None:
    mid = edge.positionAt(0.5)
    best, best_d = None, float("inf")
    for eid, candidate in tagged:
        d = candidate.distance(cq.Vertex.makeVertex(mid.x, mid.y, mid.z))
        if d < best_d:
            best, best_d = eid, d
    return best if best_d < 1e-6 else None


CHAMFER_LEGS_LISTED = 50  # A chamfer's detail lists the measured legs of its first edges, and counts the rest.


def _normal_at(face: cq.Face, edge: cq.Edge) -> tuple[float, float, float]:
    """A face's normal where an edge on it has its middle: which of an edge's two faces a pattern's copy measures on."""
    normal = face.normalAt(edge.positionAt(0.5))
    return (normal.x, normal.y, normal.z)


def _first_point(edge: cq.Edge) -> cq.Vector:
    """Where an edge starts as it runs in its body (its orientation), where a variable fillet's first radius goes;
    cq's startPoint is its curve's start, whichever way the edge runs."""
    return edge.endPoint() if edge.wrapped.Orientation() == TopAbs_REVERSED else edge.startPoint()


def _last_point(edge: cq.Edge) -> cq.Vector:
    return edge.startPoint() if edge.wrapped.Orientation() == TopAbs_REVERSED else edge.endPoint()


def _literal_plane(ref) -> bool:
    """A plane written out as ((x, y, z) origin, (nx, ny, nz) normal, (dx, dy, dz) x direction), not a list of planes."""
    return (isinstance(ref, (list, tuple)) and len(ref) == 3
            and all(isinstance(v, (list, tuple)) and len(v) == 3 and all(isinstance(x, (int, float)) for x in v) for v in ref))


def _classify(solid: cq.Shape, point: cq.Vector) -> str:
    """Where a point lies against a solid: "in", "on" (its boundary) or "out"."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_IN, TopAbs_ON
    tolerance = max(solid.BoundingBox().DiagonalLength * 1e-7, 1e-7)
    state = BRepClass3d_SolidClassifier(solid.wrapped, gp_Pnt(point.x, point.y, point.z), tolerance).State()
    return "in" if state == TopAbs_IN else "on" if state == TopAbs_ON else "out"


def _inside_point(solid: cq.Shape) -> cq.Vector | None:
    """A point inside a solid: its centre of mass when that is inside, else the inside point of a grid over its box
    nearest to it (an L-shaped or ring-shaped region's centre can lie outside it). None when no grid point is."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_IN
    box = solid.BoundingBox()
    tolerance = max(box.DiagonalLength * 1e-7, 1e-7)
    classifier = BRepClass3d_SolidClassifier(solid.wrapped)

    def inside(p: cq.Vector) -> bool:
        classifier.Perform(gp_Pnt(p.x, p.y, p.z), tolerance)
        return classifier.State() == TopAbs_IN

    centre = solid.Center()
    if inside(centre):
        return centre
    for n in (4, 8, 16):
        steps = [(i + 0.5) / n for i in range(n)]
        hits = [p for p in (cq.Vector(box.xmin + box.xlen * a, box.ymin + box.ylen * b, box.zmin + box.zlen * c)
                            for a in steps for b in steps for c in steps) if inside(p)]
        if hits:
            return min(hits, key=lambda p: (p - centre).Length)
    return None


def _cell_points(cells) -> list[cq.Vector]:
    """boundary_fill's `cells`: one point (x, y, z) or a list of them. Errors name no values."""
    usage = "cells takes a point inside each region to use, like [(0, 0, 5)]."
    if isinstance(cells, cq.Vector) or (isinstance(cells, (list, tuple)) and len(cells) == 3
                                        and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in cells)):
        cells = [cells]
    if isinstance(cells, str):
        raise FeatureError(usage)
    try:
        items = list(cells)
    except TypeError:
        raise FeatureError(usage) from None
    out = []
    for item in items:
        if isinstance(item, cq.Vector):
            item = item.toTuple()
        if not isinstance(item, (list, tuple)) or len(item) != 3:
            raise FeatureError(usage)
        try:
            out.append(cq.Vector(*(float(v) for v in item)))
        except (TypeError, ValueError):
            raise FeatureError(usage) from None
    return out


def _sewn(faces: list) -> cq.Shape:
    """One face as it is, or several sewn into one shell (shared edges made one) for an offset."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing
    if len(faces) == 1:
        return faces[0]
    sewing = BRepBuilderAPI_Sewing(1e-6)
    for face in faces:
        sewing.Add(face.wrapped)
    sewing.Perform()
    shells = cq.Shape.cast(sewing.SewedShape()).Shells()
    if len(shells) != 1:
        raise FeatureError("The faces to thicken don't join edge to edge into one sheet; thicken each connected set on its own.")
    return shells[0]


def _face_samples(face: cq.Face, samples: int = 5) -> list[cq.Vector]:
    """Points inside a face: a UV grid, kept where it lies on the trimmed face (its centre of area, projected onto it,
    when none does)."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.BRepTools import BRepTools
    from OCP.gp import gp_Pnt2d
    from OCP.TopAbs import TopAbs_IN
    adaptor = BRepAdaptor_Surface(face.wrapped)
    u0, u1, v0, v1 = BRepTools.UVBounds_s(face.wrapped)
    points = []
    for i in range(samples):
        for j in range(samples):
            u, v = u0 + (u1 - u0) * (i + 0.5) / samples, v0 + (v1 - v0) * (j + 0.5) / samples
            if BRepClass_FaceClassifier(face.wrapped, gp_Pnt2d(u, v), 1e-7).State() == TopAbs_IN:
                points.append(cq.Vector(adaptor.Value(u, v)))
    if not points:
        centre = face.Center()
        tool = BRepExtrema_DistShapeShape(BRepBuilderAPI_MakeVertex(gp_Pnt(*centre.toTuple())).Vertex(), face.wrapped)
        points.append(cq.Vector(tool.PointOnShape2(1)) if tool.IsDone() and tool.NbSolution() else centre)
    return points


def _signed_offset(point: cq.Vector, source: list) -> float:
    """How far a point lies from the source surface, + along the source's normal."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    vertex = BRepBuilderAPI_MakeVertex(gp_Pnt(*point.toTuple())).Vertex()
    best = None
    for src in source:
        tool = BRepExtrema_DistShapeShape(vertex, src.wrapped)
        if tool.IsDone() and tool.NbSolution() and (best is None or tool.Value() < best[0]):
            best = (tool.Value(), src, cq.Vector(tool.PointOnShape2(1)))
    if best is None:
        return math.nan
    distance, src, foot = best
    if distance < 1e-9:
        return 0.0
    return math.copysign(distance, (point - foot).dot(src.normalAt(foot)))


def _wall_part(face: cq.Face, source: list, low: float, high: float, tol: float) -> str:
    """"outer" for a wall face lying wholly at the +normal offset, "inner" at the other, else "side" (the rim)."""
    offsets = [_signed_offset(p, source) for p in _face_samples(face)]
    if all(abs(d - high) < tol for d in offsets):
        return "outer"
    if all(abs(d - low) < tol for d in offsets):
        return "inner"
    return "side"


def _check_offset_curvature(faces: list, labels: list, low: float, high: float, thickness: float, samples: int = 9):
    """Refuses a thicken whose wall would reach past a face's centre of curvature (the offset folds over itself there):
    named, with the tightest radius, before the kernel is asked. Curvature is sampled on a grid inside each face."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.BRepTools import BRepTools
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.gp import gp_Pnt2d
    from OCP.TopAbs import TopAbs_IN, TopAbs_ON
    for face, label in zip(faces, labels):
        adaptor = BRepAdaptor_Surface(face.wrapped)
        if adaptor.GetType() == 0:  # GeomAbs_Plane: no curvature.
            continue
        u0, u1, v0, v1 = BRepTools.UVBounds_s(face.wrapped)
        flip = -1.0 if face.wrapped.Orientation() == TopAbs_REVERSED else 1.0
        tightest = None
        for i in range(samples):
            for j in range(samples):
                u = u0 + (u1 - u0) * (i + 0.5) / samples
                v = v0 + (v1 - v0) * (j + 0.5) / samples
                if BRepClass_FaceClassifier(face.wrapped, gp_Pnt2d(u, v), 1e-7).State() not in (TopAbs_IN, TopAbs_ON):
                    continue
                props = BRepLProp_SLProps(adaptor, u, v, 2, 1e-7)
                if not props.IsCurvatureDefined():
                    continue
                for k in (props.MaxCurvature(), props.MinCurvature()):
                    k *= flip  # + when the face bends toward its own (outward) normal: its centre lies on that side.
                    for d in (low, high):
                        if d * k >= 1 - 1e-9 and (tightest is None or abs(1 / k) < tightest[0]):
                            tightest = (abs(1 / k), d)
        if tightest is not None:
            radius, d = tightest
            raise FeatureError(f"A {thickness:g} mm thicken can't be made: {label} curves tighter (radius ≈ {radius:.3g} mm) "
                               f"than the {abs(d):g} mm the wall reaches toward its centre. Thicken it the other way, "
                               "thinner, or with side=\"both\".")


def _offset_error(maker) -> str:
    """BRepOffset_MakeOffset's error, in words."""
    words = {"BRepOffset_BadNormalsOnGeometry": "a face's normal is undefined somewhere",
             "BRepOffset_C0Geometry": "a face isn't smooth (C0) inside",
             "BRepOffset_NullOffset": "the thickness is zero",
             "BRepOffset_NotConnectedShell": "the faces don't form one connected sheet",
             "BRepOffset_CannotTrimEdges": "the wall's rim couldn't be trimmed",
             "BRepOffset_CannotFuseVertices": "the wall's corners couldn't be joined",
             "BRepOffset_CannotExtentEdge": "an edge couldn't be extended",
             "BRepOffset_UnorientableShape": "the faces' sides can't be oriented consistently",
             "BRepOffset_MixedConnectivity": "faces meet in a mix of smooth and sharp edges the offset can't join"}
    try:
        error = maker.Error()
    except Exception:  # noqa: BLE001 - only the wording depends on it
        return "no reason given"
    return words.get(getattr(error, "name", str(error)), "no reason given")


def _chain(edges: list, tolerance: float = 1e-3) -> list | None:
    """`edges` in order round one closed loop, each meeting the next end to end; None when they don't close one."""
    left, out = list(dict.fromkeys(edges)), []
    if not left:
        return None
    out.append(left.pop(0))
    start, end = out[0].startPoint(), out[0].endPoint()
    while left:
        for i, edge in enumerate(left):
            a, b = edge.startPoint(), edge.endPoint()
            if (a - end).Length < tolerance or (b - end).Length < tolerance:
                end = b if (a - end).Length < tolerance else a
                out.append(left.pop(i))
                break
        else:
            return None
    return out if (end - start).Length < tolerance else None


def _vec(vector: gp_Vec) -> tuple[float, float, float]:
    return (vector.X(), vector.Y(), vector.Z())


def _chamfer_legs(edge: cq.Edge, faces, measured_on: cq.Face, generated, labels, face_name) -> dict:
    """An edge's chamfer legs measured on the built chamfer face: how far its boundary on each original face lies from
    the edge. `along` is the face `distance` was measured on."""
    sides = [cq.Shape.cast(s) for s in generated]
    others = [f for f in faces if f != measured_on]

    def leg(face):
        found = []
        for side in (e for s in sides for e in s.Edges()):
            mid = side.positionAt(0.5)
            point = cq.Vertex.makeVertex(mid.x, mid.y, mid.z)
            if face.distance(point) < 1e-5:
                found.append(edge.distance(point))
        return round(max(found), 6) if found else None

    row = {"edge": labels.get(edge, "edge"), "along": face_name.get(measured_on, "face"), "distance": leg(measured_on)}
    if others:
        row.update(other=face_name.get(others[0], "face"), distance2=leg(others[0]))
    return row


def _fuse_all(solids, names: Names) -> cq.Shape:
    """One general fuse of every solid (they may overlap each other), not one fuse per solid: fusing a growing result
    one solid at a time made 592 holes cost hundreds of full booleans and name updates."""
    maker = BRepAlgoAPI_Fuse()
    maker.SetArguments(_list(solids[:1]))
    maker.SetTools(_list(solids[1:]))
    maker.SetRunParallel(False)  # Serial, as every boolean in a build (run.keep_booleans_serial).
    maker.Build()
    if not maker.IsDone():
        raise FeatureError(f"Combining {len(solids)} profiles failed in the geometry kernel.")
    fused = cq.Shape.cast(maker.Shape())
    names.update(maker, fused, solids)
    return fused


def _face_plane(face: cq.Face) -> cq.Plane:
    """Sketch plane on a planar face: model origin projected onto it, global X projected as x."""
    if face.geomType() != "PLANE":
        raise FeatureError("Sketches need a planar face or a construction plane.")
    normal = face.normalAt()
    origin = face.Center()
    projected = cq.Vector(0, 0, 0) - normal * (cq.Vector(0, 0, 0) - origin).dot(normal)
    x = cq.Vector(1, 0, 0)
    if abs(x.dot(normal)) > 0.99:
        x = cq.Vector(0, 1, 0)
    x = (x - normal * x.dot(normal)).normalized()
    return cq.Plane(origin=projected, xDir=x, normal=normal)


def _interior_point(face: cq.Face) -> cq.Vector:
    """A point strictly inside a face (its UV centre can fall in a hole)."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.IntTools import IntTools_FClass2d
    from OCP.gp import gp_Pnt2d
    from OCP.TopAbs import TopAbs_IN
    u0, u1, v0, v1 = face._uvBounds()
    classifier = IntTools_FClass2d(face.wrapped, 1e-7)
    for i in range(1, 8):
        for j in range(1, 8):
            u, v = u0 + (u1 - u0) * i / 8, v0 + (v1 - v0) * j / 8
            if classifier.Perform(gp_Pnt2d(u, v)) == TopAbs_IN:
                p = BRepAdaptor_Surface(face.wrapped).Value(u, v)
                return cq.Vector(p.X(), p.Y(), p.Z())
    return face.Center()


def _ref_label(ref) -> str:
    """A face reference as messages name it: its text, or a selector's kind (never values)."""
    return ref if isinstance(ref, str) else type(ref).__name__


def _numbers(values) -> bool:
    return all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in values)


def _face_middle(face: cq.Face) -> cq.Vector:
    """A point on a face near its middle: its UV centre when that lies on the face (a cylinder's side, a loft's skin),
    else a point inside it. Not the centre of mass, which lies off a curved face (on a cylinder's axis)."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.BRepTools import BRepTools
    from OCP.gp import gp_Pnt2d
    from OCP.TopAbs import TopAbs_IN
    u0, u1, v0, v1 = BRepTools.UVBounds_s(face.wrapped)
    u, v = (u0 + u1) / 2, (v0 + v1) / 2
    if BRepClass_FaceClassifier(face.wrapped, gp_Pnt2d(u, v), 1e-7).State() == TopAbs_IN:
        return cq.Vector(BRepAdaptor_Surface(face.wrapped).Value(u, v))
    return _interior_point(face)


def _wrap_stretch(faces: list, origin: cq.Vector, width: float, height, samples: int = 7) -> str | None:
    """A wrapped decal's note when its patch is too doubly curved to carry it without stretching, else None. A surface
    with Gaussian curvature K can't be flattened: a geodesic disc of radius r drifts from 2πr round by about K·r²/6, so
    past |K|·r² ≈ 0.05 (r half the decal's larger side) the stretch shows, about 1 % round its rim and more toward its corners. Cylinders, cones and planes (K = 0) never warn. Curvature is
    sampled on a grid inside each face, where it lies within the decal's reach of its centre."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.BRep import BRep_Tool
    from OCP.BRepTools import BRepTools
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.ShapeAnalysis import ShapeAnalysis_Surface
    from OCP.gp import gp_Pnt2d
    from OCP.TopAbs import TopAbs_IN, TopAbs_ON
    half = max(width, height or width) / 2
    reach = math.hypot(width, height or width) / 2
    worst = 0.0
    for face in faces:
        adaptor = BRepAdaptor_Surface(face.wrapped)
        if adaptor.GetType() in (0, 1, 2):  # GeomAbs_Plane, _Cylinder, _Cone: developable.
            continue
        u0, u1, v0, v1 = BRepTools.UVBounds_s(face.wrapped)
        at = ShapeAnalysis_Surface(BRep_Tool.Surface_s(face.wrapped)).ValueOfUV(gp_Pnt(*origin.toTuple()), 1e-6)
        grid = [(u0 + (u1 - u0) * (i + 0.5) / samples, v0 + (v1 - v0) * (j + 0.5) / samples) for i in range(samples) for j in range(samples)]
        for u, v in [(at.X(), at.Y())] + grid:  # The decal's centre too: a small decal can fall between grid points.
            if (cq.Vector(adaptor.Value(u, v)) - origin).Length > reach:
                continue
            if BRepClass_FaceClassifier(face.wrapped, gp_Pnt2d(u, v), 1e-7).State() not in (TopAbs_IN, TopAbs_ON):
                continue
            props = BRepLProp_SLProps(adaptor, u, v, 2, 1e-7)
            if props.IsCurvatureDefined():
                worst = max(worst, abs(props.GaussianCurvature()))
    if worst * half * half <= 0.05:
        return None
    return ("This wrapped decal is larger than this curved patch can carry without stretching, so it stretches toward "
            "its edges; a smaller decal, or one on a less rounded part of the surface, keeps its shape.")


def _nearest_face(faces: list, point: cq.Vector) -> tuple:
    """The face nearest a point, and the point snapped onto it."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    vertex = BRepBuilderAPI_MakeVertex(gp_Pnt(*point.toTuple())).Vertex()
    best = None
    for face in faces:
        tool = BRepExtrema_DistShapeShape(vertex, face.wrapped)
        if tool.IsDone() and tool.NbSolution() and (best is None or tool.Value() < best[0]):
            best = (tool.Value(), face, cq.Vector(tool.PointOnShape2(1)))
    if best is None:
        raise FeatureError("at= couldn't be placed on the decal's faces; leave it out to use the middle of the first face.")
    return best[1], best[2]


def _crosses_axis(face: cq.Face, axis: gp_Ax1) -> bool:
    """True when a planar profile lies on both sides of the axis (revolving it would self-intersect)."""
    loc, d = axis.Location(), axis.Direction()
    origin, direction = cq.Vector(loc.X(), loc.Y(), loc.Z()), cq.Vector(d.X(), d.Y(), d.Z())
    side = face.normalAt().cross(direction)
    if side.Length < 1e-9:  # Axis along the profile normal: no sides to compare.
        return False
    side = side.normalized()
    tol = 1e-6 * max(1.0, face.BoundingBox().DiagonalLength)
    below = above = False
    for edge in face.Edges():
        for i in range(17):
            offset = (edge.positionAt(i / 16) - origin).dot(side)
            below, above = below or offset < -tol, above or offset > tol
            if below and above:
                return True
    return False


def _revolved_source(face: cq.Face, axis: gp_Ax1, profile: cq.Face, entity_of: dict) -> str | None:
    loc, d = axis.Location(), axis.Direction()
    origin, direction = cq.Vector(loc.X(), loc.Y(), loc.Z()), cq.Vector(d.X(), d.Y(), d.Z())
    point = _interior_point(face)
    rel = point - origin
    h = rel.dot(direction)
    r = (rel - direction * h).Length
    # The profile's half-plane: a point of the profile off the axis gives the in-plane radial direction.
    sample = _interior_point(profile) - origin
    radial = sample - direction * sample.dot(direction)
    if radial.Length < 1e-9:
        return None
    back = origin + direction * h + radial.normalized() * r
    vertex = cq.Vertex.makeVertex(back.x, back.y, back.z)
    best, best_d = None, float("inf")
    for edge, entity in entity_of.items():
        if not entity or edge not in profile.Edges():
            continue
        dist = edge.distance(vertex)
        if dist < best_d:
            best, best_d = entity, dist
    return best if best_d < 1e-5 else None


def _cylinder(base: cq.Vector, direction: cq.Vector, radius: float, height: float) -> cq.Shape:
    d = direction.normalized()
    return cq.Shape.cast(BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(base.x, base.y, base.z), gp_Dir(d.x, d.y, d.z)), radius, height).Shape())


def _cone(base: cq.Vector, direction: cq.Vector, r1: float, r2: float, height: float) -> cq.Shape:
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCone
    d = direction.normalized()
    return cq.Shape.cast(BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(base.x, base.y, base.z), gp_Dir(d.x, d.y, d.z)), r1, r2, height).Shape())


def _name_by_touch(solid: cq.Shape, names: Names, prefix: str, owner: dict, also: cq.Shape | None = None):
    """Names still-unnamed faces after the profile edge they touch (history gaps in lofts and sweeps); with `also`, only
    faces that touch that shape too (a loft's apex point)."""
    named = {f for faces in names.faces.values() for f in faces}
    for face in solid.Faces():
        if face in named or (also is not None and face.distance(also) > 1e-5):
            continue
        for edge, entity in owner.items():
            if not entity:
                continue
            mid = edge.positionAt(0.5)
            if face.distance(cq.Vertex.makeVertex(mid.x, mid.y, mid.z)) < 1e-5:
                names.add(f"{prefix}({entity})", [face])
                break


_GUIDE_STATIONS = 32  # Points per path edge where a guide is crossed.


def _reversed_wire(wire: cq.Wire) -> cq.Wire:
    """The same curves run the other way."""
    return cq.Wire.assembleEdges([cq.Edge(edge.wrapped.Reversed()) for edge in reversed(_wire_edges(wire))])


def _wire_edges(wire: cq.Wire) -> list[cq.Edge]:
    """A wire's edges end to end, in its direction (each edge's orientation says which way it runs)."""
    from OCP.BRepTools import BRepTools_WireExplorer
    out, explorer = [], BRepTools_WireExplorer(wire.wrapped)
    while explorer.More():
        out.append(cq.Edge(explorer.Current()))
        explorer.Next()
    return out


def _starting_at(spine: cq.Wire, profile: cq.Face) -> cq.Wire:
    """The path run from its end nearer the profile."""
    start, end = spine.startPoint(), spine.endPoint()
    if (start - end).Length < 1e-9:
        return spine
    near = lambda p: profile.distance(cq.Vertex.makeVertex(p.x, p.y, p.z))
    return _reversed_wire(spine) if near(end) < near(start) else spine


def _guide_stations(spine: cq.Wire, guide: cq.Wire, per_edge: int = _GUIDE_STATIONS) -> list:
    """(u, point, tangent, guide point) along the path: u is the sweep's law parameter (edges laid end to end by
    their share of the path's length, each run through its own parameter evenly, as BRepFill_LocationLaw does), the
    guide point is where the guide crosses the plane across the path there, the crossing nearest the last one."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GCPnts import GCPnts_AbscissaPoint
    from OCP.Geom import Geom_Plane
    from OCP.GeomAPI import GeomAPI_IntCS
    curves = []
    for edge in guide.Edges():
        adaptor = BRepAdaptor_Curve(edge.wrapped)
        curves.append((BRep_Tool.Curve_s(edge.wrapped, 0.0, 0.0), adaptor.FirstParameter(), adaptor.LastParameter()))
    edges = [e for e in _wire_edges(spine) if e.Length() > 1e-9]
    lengths = [GCPnts_AbscissaPoint.Length_s(BRepAdaptor_Curve(e.wrapped)) for e in edges]
    total, done, previous, stations = sum(lengths), 0.0, guide.startPoint(), []
    for index, (edge, length) in enumerate(zip(edges, lengths)):
        adaptor = BRepAdaptor_Curve(edge.wrapped)
        a, b = adaptor.FirstParameter(), adaptor.LastParameter()
        backwards = edge.wrapped.Orientation() == TopAbs_REVERSED
        for k in range(0 if index == 0 else 1, per_edge + 1):
            f = k / per_edge
            p, d = gp_Pnt(), gp_Vec()
            adaptor.D1(b - f * (b - a) if backwards else a + f * (b - a), p, d)
            point, tangent = cq.Vector(p.X(), p.Y(), p.Z()), cq.Vector(d.X(), d.Y(), d.Z()).normalized() * (-1 if backwards else 1)
            plane = Geom_Plane(p, gp_Dir(tangent.x, tangent.y, tangent.z))
            best = None
            for curve, c0, c1 in curves:
                hits = GeomAPI_IntCS(curve, plane)
                if not hits.IsDone():
                    continue
                slack = 1e-7 * (c1 - c0)
                for i in range(1, hits.NbPoints() + 1):
                    if c0 - slack <= hits.Parameters(i)[2] <= c1 + slack:
                        q = hits.Point(i)
                        q = cq.Vector(q.X(), q.Y(), q.Z())
                        if best is None or (q - previous).Length < (best - previous).Length:
                            best = q
            at = round(100 * (done + f * length) / total)
            if best is None:
                raise FeatureError(f"The guide curve doesn't span the path: the plane across the path {at}% along it "
                                   "doesn't cross the guide. The guide must run beside the path from its start to its end.")
            if (best - point).Length < 1e-6:
                raise FeatureError(f"The guide curve meets the path {at}% along it: keep the guide beside the path.")
            stations.append(((done + f * length) / total, point, tangent, best))
            previous = best
        done += length
    return stations


def _fixed_binormal(stations: list, spine: cq.Wire, guide: cq.Wire):
    """The fixed direction a guide's frame amounts to, or None: one across the whole path (perpendicular to every
    tangent) that the direction to the guide keeps the same angles to. Only for paths and guides of lines and arcs,
    where agreeing at every station means agreeing everywhere."""
    if any(edge.geomType() not in ("LINE", "CIRCLE") for edge in spine.Edges() + guide.Edges()):
        return None
    tangents = [t for _, _, t, _ in stations]
    toward = [((q - p) - t * (q - p).dot(t)).normalized() for _, p, t, q in stations]
    direction = next((tangents[0].cross(t).normalized() for t in tangents if tangents[0].cross(t).Length > 1e-6), toward[0])
    if any(abs(direction.dot(t)) > 1e-9 for t in tangents):
        return None  # The path leaves a plane: no direction stays across it.
    angles = [(direction.dot(n), direction.cross(t).dot(n)) for n, t in zip(toward, tangents)]
    if any(abs(c - angles[0][0]) > 1e-9 or abs(s - angles[0][1]) > 1e-9 for c, s in angles):
        return None
    return direction


def _guide_scale_law(stations: list, per_edge: int = _GUIDE_STATIONS):
    """The profile's scale along the path (1 at its start) that keeps a guide starting on its outline on it: the
    guide's distance from the path over its distance at the start. Linear when the guide widens evenly (an exact
    frustum); else a cubic through every station of each path edge, the pieces joined at the edges' ends, where the
    path's curvature, and so the scale's slope, may jump."""
    from OCP.Law import Law_BSpFunc, Law_BSpline, Law_Interpol, Law_Linear
    from OCP.collections import Array1_double, Array1_gp_Pnt2d, Array1_int
    from OCP.gp import gp_Pnt2d
    start = (stations[0][3] - stations[0][1]).Length
    scale = [(u, (q - p).Length / start) for u, p, _, q in stations]
    last = scale[-1][1]
    if all(abs(k - (1 + (last - 1) * u)) < 1e-9 for u, k in scale):
        law = Law_Linear()
        law.Set(0.0, 1.0, 1.0, last)
        return law
    poles, knots, mults, degree = [], [], [], None
    for first in range(0, len(scale) - 1, per_edge):
        piece = scale[first:first + per_edge + 1]
        points = Array1_gp_Pnt2d(1, len(piece))
        for i, (u, k) in enumerate(piece):
            points.SetValue(i + 1, gp_Pnt2d(u, k))
        interpolated = Law_Interpol()
        interpolated.Set(points, False)
        curve = interpolated.Curve()
        degree = curve.Degree()
        if poles:  # Shares the last piece's end: one pole, its knot kept to C0.
            mults[-1] = degree
        skip = 1 if poles else 0
        poles += [curve.Pole(i) for i in range(1 + skip, curve.NbPoles() + 1)]
        knots += [curve.Knot(i) for i in range(1 + skip, curve.NbKnots() + 1)]
        mults += [curve.Multiplicity(i) for i in range(1 + skip, curve.NbKnots() + 1)]
    arrays = []
    for values, kind in ((poles, Array1_double), (knots, Array1_double), (mults, Array1_int)):
        array = kind(1, len(values))
        for i, value in enumerate(values):
            array.SetValue(i + 1, value)
        arrays.append(array)
    law = Law_BSpFunc()
    law.SetCurve(Law_BSpline(*arrays, degree))
    return law


def _name_along(solid: cq.Shape, names: Names, id: str, spine: list) -> None:
    """Names a sweep's side faces after the path segment each runs along: `<id>.along(<entity>)` for a sketch path,
    `<id>.along(<i>)` (path order) for edge refs. A face goes with the spine edge nearest its middle: every side face
    touches its neighbours' segments at their shared ends, but its middle is a profile's reach from its own."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    caps = {face for cap in (f"{id}.start", f"{id}.end") for face in names.faces.get(cap, ())}
    reach = max(solid.BoundingBox().DiagonalLength, 1.0) * 1e-7
    for face in solid.Faces():
        if face in caps:
            continue
        u0, u1, v0, v1 = face._uvBounds()
        p = BRepAdaptor_Surface(face.wrapped).Value((u0 + u1) / 2, (v0 + v1) / 2)
        middle = cq.Vertex.makeVertex(p.X(), p.Y(), p.Z())
        distances = [(edge.distance(middle), key) for key, edge in spine]
        nearest, key = min(distances, key=lambda item: item[0])
        if nearest > reach:  # On the path itself: a cap, never a side.
            names.add(f"{id}.along({key})", [face])


def _name_spans(solid: cq.Shape, names: Names, id: str, wires: list) -> None:
    """A ruled loft makes one face per profile edge per span. The first span keeps `<id>.side(<entity>)`; span k (between
    sections k and k+1, counted from 1) is `<id>.side(<entity>, k-(k+1))`, found by crossing each section's edges from
    the previous span's face (not by edge index: OCCT may reorder or split later sections' edges to match)."""
    prefix = f"{id}.side("
    span = {face: name[len(prefix):-1] for name, faces in names.faces.items()
            if name.startswith(prefix) and name.endswith(")") for face in faces}
    adjacent = edge_faces(solid)
    named = set(names.index())
    for k in range(1, len(wires) - 1):  # wires[k] is section k+1, between spans k and k+1.
        found: dict[cq.Face, str] = {}
        for face, entity in span.items():
            for edge in face.Edges():
                mid = edge.positionAt(0.5)
                if wires[k].distance(cq.Vertex.makeVertex(mid.x, mid.y, mid.z)) > 1e-4:
                    continue
                for other in adjacent.get(edge, ()):
                    if other != face and other not in named and other not in found:
                        found[other] = entity
        for face, entity in found.items():
            names.add(f"{id}.side({entity}, {k + 1}-{k + 2})", [face])
        named |= set(found)
        span = found


def _overshoot(solid: list[float] | None, sections: list) -> str | None:
    """The axis ("X", "Y" or "Z") along which a loft's bounds pass its sections' combined bounds by more than a quarter of
    that envelope's size, or None. Bounds are `_extent`'s [xmin, ymin, zmin, xmax, ymax, zmax]."""
    if not solid or not sections or not all(sections):
        return None
    low = [min(b[i] for b in sections) for i in range(3)]
    high = [max(b[i + 3] for b in sections) for i in range(3)]
    largest = max(h - l for l, h in zip(low, high))
    worst, axis = 0.0, None
    for i, name in enumerate("XYZ"):
        size = max(high[i] - low[i], largest * 0.05, 1e-6)  # A thin envelope axis doesn't turn rounding into a bulge.
        excess = max(low[i] - solid[i], solid[i + 3] - high[i]) / size
        if excess > 0.25 and excess > worst:
            worst, axis = excess, name
    return axis


def _extent(shape: cq.Shape) -> list[float] | None:
    """Exact bounds [xmin, ymin, zmin, xmax, ymax, zmax] (None when OCCT can't bound the shape)."""
    from .simulation import bounds
    try:
        values = bounds(shape)
    except Exception:  # noqa: BLE001 - a summary never fails a build
        return None
    return values if all(math.isfinite(v) for v in values) else None
