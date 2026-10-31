"""Constrained 2D sketches: declarations in code, solved geometry, profile regions.

A sketch is a list of entities and constraints in the shared solver JSON (docs/MODELING.md
section 2). Code states coordinates at full precision (the last solved state) and the
solver re-solves from there, so a sketch reproduces what the user saw and follows
parameter changes. Angles are degrees in code and radians in the JSON.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field

try:  # The shared planegcs core (solver/); absent until the runtime image bundles it.
    import steve_sketch as _solver
except ImportError:  # pragma: no cover - exercised only in images without the solver
    _solver = None

def _load():
    """OpenCASCADE is only needed to build geometry; declarations work without it (the API parser)."""
    if "BOPAlgo_Builder" in globals():
        return
    import cadquery as cq
    from OCP.BOPAlgo import BOPAlgo_Builder, BOPAlgo_BuilderFace
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakeWire
    from OCP.GC import GC_MakeArcOfCircle, GC_MakeArcOfEllipse
    from OCP.Geom import Geom_BezierCurve, Geom_BSplineCurve
    from OCP.gp import gp_Ax2, gp_Circ, gp_Dir, gp_Elips, gp_Pln, gp_Pnt
    from OCP.TopAbs import TopAbs_FORWARD
    from OCP.collections import Array1_double, Array1_gp_Pnt, Array1_int, List_TopoDS_Shape
    globals().update(locals())


POINT_KEYS = {"line": ("start", "end"), "arc": ("center", "start", "end"), "circle": ("center",),
              "ellipse": ("center",), "elliptical_arc": ("center", "start", "end"), "point": ("at",)}
FIXED = {"origin", "x_axis", "y_axis"}


class SketchError(Exception):
    """A sketch that cannot be solved or turned into geometry; `ids` names the culprits."""

    def __init__(self, message, ids=()):
        super().__init__(message)
        self.ids = list(ids)


@dataclass
class Region:
    name: str
    face: cq.Face
    boundary: list[str]
    depth: int = 0


@dataclass
class SolveReport:
    status: str = "unsolved"
    dof: int | None = None
    conflicting: list[str] = field(default_factory=list)
    redundant: list[str] = field(default_factory=list)
    free: dict = field(default_factory=dict)


def _xy(value):
    x, y = value
    return [float(x), float(y)]


class Sketch:
    """Collects sketch declarations; `solve()` settles them and builds edges and regions."""

    def __init__(self, id: str, plane: cq.Plane, name: str | None = None):
        self.id = id
        self.plane = plane
        self.name = name or id
        self.entities: dict[str, dict] = {}
        self.constraints: list[dict] = []
        self.report = SolveReport()
        self._counter = 0
        self._edges: list[tuple[str, cq.Edge]] | None = None
        self._regions: list[Region] | None = None
        self.model = None  # Set by Model.sketch; projections read model edges through it.
        self.projections: dict[str, list[dict]] = {}  # projection id → the fixed entities it resolved to

    # ───────── bookkeeping ─────────

    def _add(self, entity: dict) -> str:
        eid = entity["id"]
        if not isinstance(eid, str) or not eid or eid in self.entities or eid in FIXED:
            raise SketchError(f"Sketch {self.id}: entity id {eid!r} is missing or already used.", [eid])
        self.entities[eid] = entity
        self._edges = self._regions = None
        return eid

    def _constrain(self, kind: str, refs: list, value=None, id=None, driving=True, **extra) -> str:
        self._counter += 1
        cid = id or f"k{self._counter}"
        item = {"id": cid, "type": kind, "refs": list(refs), **extra}
        if value is not None:
            item["value"] = float(value)
            item["driving"] = bool(driving)
        self.constraints.append(item)
        return cid

    def _flags(self, construction, external=False):
        return {"construction": bool(construction), **({"external": True} if external else {})}

    # ───────── geometry ─────────

    def point(self, id, at, construction=False):
        """A point at (x, y) in sketch coordinates (mm). Constraints refer to entities by id and to their points as
        "<id>.<point>" (`l1.start`, `c1.center`), alongside the built-in "origin", "x_axis" and "y_axis"."""
        return self._add({"id": id, "type": "point", "at": _xy(at), **self._flags(construction)})

    def line(self, id, start, end, construction=False):
        """A line from (x, y) `start` to `end` ("<id>.start", "<id>.end"). As for every entity, `construction=True`
        geometry guides constraints, sweep paths and axes but never bounds a profile."""
        return self._add({"id": id, "type": "line", "start": _xy(start), "end": _xy(end), **self._flags(construction)})

    def circle(self, id, center, radius, construction=False):
        """A circle of `radius` mm about (x, y) `center` ("<id>.center")."""
        return self._add({"id": id, "type": "circle", "center": _xy(center), "radius": float(radius), **self._flags(construction)})

    def arc(self, id, center, radius, start_angle, end_angle, construction=False):
        """Counter-clockwise from start_angle to end_angle (degrees)."""
        return self._add({"id": id, "type": "arc", "center": _xy(center), "radius": float(radius),
                          "start_angle": math.radians(start_angle), "end_angle": math.radians(end_angle), **self._flags(construction)})

    def ellipse(self, id, center, major_radius, minor_radius, rotation=0.0, construction=False):
        """An ellipse about (x, y) `center`, its major axis turned `rotation` degrees from the sketch's x axis."""
        return self._add({"id": id, "type": "ellipse", "center": _xy(center), "major_radius": float(major_radius),
                          "minor_radius": float(minor_radius), "rotation": math.radians(rotation), **self._flags(construction)})

    def elliptical_arc(self, id, center, major_radius, minor_radius, rotation, start_angle, end_angle, construction=False):
        """Part of an ellipse (as `ellipse`), counter-clockwise from `start_angle` to `end_angle` (degrees)."""
        return self._add({"id": id, "type": "elliptical_arc", "center": _xy(center), "major_radius": float(major_radius),
                          "minor_radius": float(minor_radius), "rotation": math.radians(rotation),
                          "start_angle": math.radians(start_angle), "end_angle": math.radians(end_angle), **self._flags(construction)})

    def spline(self, id, poles, degree=3, periodic=False, construction=False):
        """A B-spline through control points `poles` [(x, y), …] (at least two) of `degree` (at most one less than the
        number of poles); `periodic=True` closes it."""
        poles = [_xy(p) for p in poles]
        if len(poles) < 2:
            raise SketchError(f"Sketch {self.id}: spline {id!r} needs at least two control points.", [id])
        return self._add({"id": id, "type": "bspline", "poles": poles, "degree": int(min(degree, len(poles) - 1)),
                          "periodic": bool(periodic), **self._flags(construction)})

    def bezier(self, id, poles, construction=False):
        """A Bézier curve on control points `poles` [(x, y), …]; its degree is one less than their number."""
        poles = [_xy(p) for p in poles]
        return self._add({"id": id, "type": "bspline", "poles": poles, "degree": len(poles) - 1, "periodic": False,
                          "bezier": True, **self._flags(construction)})

    # ───────── composites (CadQuery face shapes, as constrained curves) ─────────

    def rect(self, id, corner1, corner2, construction=False):
        """A rectangle between opposite corners (x, y): lines "<id>.bottom", ".right", ".top" and ".left", joined and
        kept horizontal and vertical."""
        (x1, y1), (x2, y2) = _xy(corner1), _xy(corner2)
        sides = {"bottom": ((x1, y1), (x2, y1)), "right": ((x2, y1), (x2, y2)),
                 "top": ((x2, y2), (x1, y2)), "left": ((x1, y2), (x1, y1))}
        for side, (a, b) in sides.items():
            self.line(f"{id}.{side}", a, b, construction)
        order = ["bottom", "right", "top", "left"]
        for a, b in zip(order, order[1:] + order[:1]):
            self._constrain("coincident", [f"{id}.{a}.end", f"{id}.{b}.start"], id=f"{id}.c_{a}_{b}")
        self._constrain("horizontal", [f"{id}.bottom"], id=f"{id}.h_bottom")
        self._constrain("horizontal", [f"{id}.top"], id=f"{id}.h_top")
        self._constrain("vertical", [f"{id}.left"], id=f"{id}.v_left")
        self._constrain("vertical", [f"{id}.right"], id=f"{id}.v_right")
        return id

    def center_rect(self, id, center, width, height, construction=False):
        """A rectangle `width` × `height` centred on (x, y) `center` (a construction point "<id>.center"), with the
        sides `rect` names."""
        cx, cy = _xy(center)
        w, h = float(width) / 2, float(height) / 2
        self.rect(id, (cx - w, cy - h), (cx + w, cy + h), construction)
        self.point(f"{id}.center", (cx, cy), construction=True)
        self._constrain("symmetric", [f"{id}.bottom.start", f"{id}.top.start", f"{id}.center"], id=f"{id}.s_center")
        return id

    def slot(self, id, start, end, radius, construction=False):
        """A slot with round ends of `radius` centred on (x, y) `start` and `end`: arcs "<id>.start_arc" and
        "<id>.end_arc", lines "<id>.upper" and "<id>.lower", and the construction line "<id>.axis" between centres."""
        (x1, y1), (x2, y2) = _xy(start), _xy(end)
        angle = math.atan2(y2 - y1, x2 - x1)
        nx, ny = -math.sin(angle) * radius, math.cos(angle) * radius
        deg = math.degrees(angle)
        self.arc(f"{id}.end_arc", (x2, y2), radius, deg - 90, deg + 90, construction)
        self.line(f"{id}.upper", (x2 + nx, y2 + ny), (x1 + nx, y1 + ny), construction)
        self.arc(f"{id}.start_arc", (x1, y1), radius, deg + 90, deg + 270, construction)
        self.line(f"{id}.lower", (x1 - nx, y1 - ny), (x2 - nx, y2 - ny), construction)
        self.line(f"{id}.axis", (x1, y1), (x2, y2), construction=True)
        self._constrain("coincident", [f"{id}.end_arc.end", f"{id}.upper.start"], id=f"{id}.c1")
        self._constrain("coincident", [f"{id}.upper.end", f"{id}.start_arc.start"], id=f"{id}.c2")
        self._constrain("coincident", [f"{id}.start_arc.end", f"{id}.lower.start"], id=f"{id}.c3")
        self._constrain("coincident", [f"{id}.lower.end", f"{id}.end_arc.start"], id=f"{id}.c4")
        self._constrain("tangent", [f"{id}.upper", f"{id}.end_arc"], at=f"{id}.upper.start", id=f"{id}.t1")
        self._constrain("tangent", [f"{id}.upper", f"{id}.start_arc"], at=f"{id}.upper.end", id=f"{id}.t2")
        self._constrain("tangent", [f"{id}.lower", f"{id}.start_arc"], at=f"{id}.lower.start", id=f"{id}.t3")
        self._constrain("tangent", [f"{id}.lower", f"{id}.end_arc"], at=f"{id}.lower.end", id=f"{id}.t4")
        self._constrain("equal", [f"{id}.start_arc", f"{id}.end_arc"], id=f"{id}.eq")
        self._constrain("coincident", [f"{id}.axis.start", f"{id}.start_arc.center"], id=f"{id}.a1")
        self._constrain("coincident", [f"{id}.axis.end", f"{id}.end_arc.center"], id=f"{id}.a2")
        return id

    def polygon(self, id, center, radius, sides, inscribed=True, rotation=0.0, construction=False):
        """A regular polygon of `sides` (3 or more) about (x, y) `center`: its corners on a circle of `radius`
        (`inscribed=True`), or its sides touching it; the first corner `rotation` degrees from the x axis. Sides
        "<id>.side0", "<id>.side1", …, and the construction circle "<id>.circle". For an arbitrary outline through
        given points, use `polyline`."""
        cx, cy = _xy(center)
        n = int(sides)
        if n < 3:
            raise SketchError(f"Sketch {self.id}: polygon {id!r} needs at least 3 sides.", [id])
        r = float(radius) if inscribed else float(radius) / math.cos(math.pi / n)
        start = math.radians(rotation)
        pts = [(cx + r * math.cos(start + 2 * math.pi * i / n), cy + r * math.sin(start + 2 * math.pi * i / n)) for i in range(n)]
        self.circle(f"{id}.circle", (cx, cy), radius, construction=True)
        for i in range(n):
            self.line(f"{id}.side{i}", pts[i], pts[(i + 1) % n], construction)
        for i in range(n):
            self._constrain("coincident", [f"{id}.side{i}.end", f"{id}.side{(i + 1) % n}.start"], id=f"{id}.c{i}")
            if inscribed:
                self._constrain("point_on", [f"{id}.side{i}.start", f"{id}.circle"], id=f"{id}.on{i}")
            else:
                self._constrain("tangent", [f"{id}.side{i}", f"{id}.circle"], id=f"{id}.tan{i}")
            if i:
                self._constrain("equal", [f"{id}.side0", f"{id}.side{i}"], id=f"{id}.eq{i}")
        return id

    def polyline(self, id, points, closed=True, construction=False):
        """Lines through (x, y) `points` [(x, y), …] in order, joined at each corner: "<id>.side0" from the first point
        to the second, "<id>.side1", …; `closed=True` (at least 3 points) adds the side from the last point back to the
        first, so the outline bounds a profile. `closed=False` (at least 2 points) leaves an open chain. Corners are
        only joined, not kept at any angle or length."""
        pts = [_xy(p) for p in points]
        if closed and len(pts) > 1 and pts[-1] == pts[0]:
            pts.pop()  # The first point repeated at the end: the closing side already goes there.
        n = len(pts)
        if n < (3 if closed else 2):
            raise SketchError(f"Sketch {self.id}: polyline {id!r} needs at least {3 if closed else 2} points.", [id])
        sides = n if closed else n - 1
        for i in range(sides):
            if pts[i] == pts[(i + 1) % n]:
                raise SketchError(f"Sketch {self.id}: polyline {id!r} repeats point {i + 1}, which leaves side{i} with no length.", [id])
        for i in range(sides):
            self.line(f"{id}.side{i}", pts[i], pts[(i + 1) % n], construction)
        for i in range(sides if closed else sides - 1):
            self._constrain("coincident", [f"{id}.side{i}.end", f"{id}.side{(i + 1) % sides}.start"], id=f"{id}.c{i}")
        return id

    def trapezoid(self, id, center, width, height, angle1, angle2=None, construction=False):
        """CadQuery's trapezoid: bottom `width`, `height`, interior base angles in degrees."""
        cx, cy = _xy(center)
        a1 = math.radians(angle1)
        a2 = math.radians(angle1 if angle2 is None else angle2)
        h = float(height)
        x0, x1 = cx - width / 2, cx + width / 2
        y0, y1 = cy - h / 2, cy + h / 2
        tl = (x0 + h / math.tan(a1), y1)
        tr = (x1 - h / math.tan(a2), y1)
        self.line(f"{id}.bottom", (x0, y0), (x1, y0), construction)
        self.line(f"{id}.right", (x1, y0), tr, construction)
        self.line(f"{id}.top", tr, tl, construction)
        self.line(f"{id}.left", tl, (x0, y0), construction)
        order = ["bottom", "right", "top", "left"]
        for a, b in zip(order, order[1:] + order[:1]):
            self._constrain("coincident", [f"{id}.{a}.end", f"{id}.{b}.start"], id=f"{id}.c_{a}_{b}")
        self._constrain("horizontal", [f"{id}.bottom"], id=f"{id}.h_bottom")
        self._constrain("horizontal", [f"{id}.top"], id=f"{id}.h_top")
        return id

    # ───────── constraints ─────────

    def coincident(self, a, b, id=None):
        """Points `a` and `b` ("l1.end", "origin") are the same point. Every constraint returns its id (`id`, or
        "k<n>")."""
        return self._constrain("coincident", [a, b], id=id)

    def point_on(self, point, curve, id=None):
        """`point` lies on `curve` (a line, arc, circle, … or "x_axis"/"y_axis")."""
        return self._constrain("point_on", [point, curve], id=id)

    def horizontal(self, a, b=None, id=None):
        """Line `a` is horizontal, or points `a` and `b` are level."""
        return self._constrain("horizontal", [a] if b is None else [a, b], id=id)

    def vertical(self, a, b=None, id=None):
        """Line `a` is vertical, or points `a` and `b` are one above the other."""
        return self._constrain("vertical", [a] if b is None else [a, b], id=id)

    def parallel(self, a, b, id=None):
        """Lines `a` and `b` are parallel."""
        return self._constrain("parallel", [a, b], id=id)

    def perpendicular(self, a, b, id=None):
        """Lines `a` and `b` are at right angles."""
        return self._constrain("perpendicular", [a, b], id=id)

    def collinear(self, a, b, id=None):
        """Lines `a` and `b` lie on one line."""
        return self._constrain("collinear", [a, b], id=id)

    def tangent(self, a, b, at=None, id=None):
        """Curves `a` and `b` are tangent; `at` names the point where they meet ("l1.end") when they share one."""
        return self._constrain("tangent", [a, b], id=id, **({"at": at} if at else {}))

    def equal(self, a, b, id=None):
        """Lines `a` and `b` are as long, or arcs and circles (or two ellipses) `a` and `b` are the same size."""
        return self._constrain("equal", [a, b], id=id)

    def symmetric(self, p, q, about, id=None):
        """Points `p` and `q` mirror each other about a line or a point `about`."""
        return self._constrain("symmetric", [p, q, about], id=id)

    def midpoint(self, point, line, id=None):
        """`point` is at the middle of `line`."""
        return self._constrain("midpoint", [point, line], id=id)

    def concentric(self, a, b, id=None):
        """Arcs or circles `a` and `b` share their centre."""
        return self._constrain("concentric", [a, b], id=id)

    def fix(self, ref, at=None, id=None):
        """Locks a point or entity where it is, or point `ref` at (x, y) `at`."""
        return self._constrain("fix", [ref], id=id, **({"at": _xy(at)} if at is not None else {}))

    # ───────── dimensions ─────────

    def distance(self, a, b, value, driving=True, id=None, label=None):
        """`value` mm between `a` and `b` (points, or a point and a line). As for every dimension, `driving=False`
        only measures, and `label=(x, y)` places its value (see `angle`)."""
        return self._constrain("distance", [a, b], value, id, driving)

    def length(self, curve, value, driving=True, id=None, label=None):
        """`curve` (a line or an arc) is `value` mm long."""
        return self._constrain("length", [curve], value, id, driving)

    def horizontal_distance(self, p, q, value, driving=True, id=None, label=None):
        """`value` mm from point `p` to point `q` along the sketch's x axis (signed: q.x − p.x)."""
        return self._constrain("horizontal_distance", [p, q], value, id, driving)

    def vertical_distance(self, p, q, value, driving=True, id=None, label=None):
        """`value` mm from point `p` to point `q` along the sketch's y axis (signed: q.y − p.y)."""
        return self._constrain("vertical_distance", [p, q], value, id, driving)

    def angle(self, a, b=None, value=None, driving=True, id=None, label=None):
        """Degrees, counter-clockwise from `a` to `b` (or from the x axis when `b` is omitted).

        Every dimension takes `label=(x, y)`: where its value is drawn, in sketch coordinates. It
        never affects the geometry.
        """
        if b is not None and not isinstance(b, str):
            b, value = None, b
        refs = [a] if b is None else [a, b]
        return self._constrain("angle", refs, math.radians(value), id, driving)

    def radius(self, curve, value, driving=True, id=None, label=None):
        """Arc or circle `curve` has radius `value` mm."""
        return self._constrain("radius", [curve], value, id, driving)

    def diameter(self, curve, value, driving=True, id=None, label=None):
        """Arc or circle `curve` has diameter `value` mm."""
        return self._constrain("diameter", [curve], value, id, driving)

    # ───────── external geometry ─────────

    def external_line(self, id, start, end):
        """Fixed geometry, e.g. a model edge projected by the modeling layer."""
        return self._add({"id": id, "type": "line", "start": _xy(start), "end": _xy(end), "construction": True, "external": True})

    def project(self, id, ref, construction=False):
        """Model or sketch geometry projected onto this sketch's plane as fixed (external) entities.

        `ref`: an edge, a face (its outline), a vertex, another sketch or one of its entities
        (`sketch_2`, `sketch_2.c1`), or a list of these. Recomputed on every rebuild, so it follows
        upstream changes. Projected curves form profiles unless `construction=True`. One item is
        `id`; several are `id.0`, `id.1`, …
        """
        if self.model is None:  # Parsing without a model: remember the projection, geometry comes from the build.
            return self._add({"id": id, "type": "projection", "ref": ref, "construction": bool(construction), "external": True})
        try:
            shapes = self.model.projection_source(ref)
        except Exception as error:  # A reference the model can't resolve fails this sketch, clearly.
            raise SketchError(f"Sketch {self.name!r}: can't project {ref!r}: {error}", [id]) from None
        entities = [e for shape in shapes for e in _project(shape, self.plane)]
        if not entities:
            raise SketchError(f"Sketch {self.name!r}: {ref!r} has nothing to project.", [id])
        added = []
        for i, entity in enumerate(entities):
            entity.update({"id": id if len(entities) == 1 else f"{id}.{i}", "construction": bool(construction) or entity["type"] == "point", "external": True})
            self._add(entity)
            added.append(entity)
        self.projections[id] = added
        return id

    def world_edges(self, entity: str | None = None) -> list:
        """This sketch's curves in 3D (all of them, or one entity), for other sketches to project."""
        _load()
        if entity is not None:
            e = self.entities.get(entity)
            if e is None:
                raise SketchError(f"Sketch {self.name!r} has no entity {entity!r}.", [entity])
            if e["type"] == "point":
                return [cq.Vertex.makeVertex(*self.plane.toWorldCoords(tuple(e["at"])).toTuple())]
            edge = self._edge(e)
            return [edge] if edge is not None else []
        return [edge for _, edge in self.edges()]

    # ───────── solving ─────────

    def document(self) -> dict:
        """The sketch as the shared solver JSON: its entities (unresolved projections left out) and
        constraints."""
        return {"entities": [e for e in self.entities.values() if e["type"] != "projection"], "constraints": self.constraints}

    def solve(self) -> SolveReport:
        """Re-solves from the declared geometry. Without the solver module, the declared geometry stands."""
        self._check_refs()
        if _solver is None or not self.constraints:
            self.report = SolveReport(status="unsolved" if _solver is None else "ok", dof=None)
            return self.report
        raw = json.loads(_solver.solve(json.dumps(self.document()), json.dumps({})))
        self.report = SolveReport(status=raw.get("status", "failed"), dof=raw.get("dof"), conflicting=raw.get("conflicting", []),
                                  redundant=raw.get("redundant", []), free=raw.get("free", {}))
        if self.report.status != "ok":
            culprits = self.report.conflicting or self.report.redundant
            detail = f" Conflicting constraints: {', '.join(culprits)}." if culprits else ""
            raise SketchError(f"Sketch {self.name!r} could not be solved.{detail}", culprits)
        for entity in raw.get("entities", []):
            if entity.get("id") in self.entities:
                self.entities[entity["id"]].update({k: v for k, v in entity.items() if k not in {"id", "type"}})
        self._edges = self._regions = None
        return self.report

    def _check_refs(self):
        known = set(FIXED) | set(self.entities)
        for entity in self.entities.values():
            for key in POINT_KEYS.get(entity["type"], ()):
                known.add(f"{entity['id']}.{key}")
            if entity["type"] == "bspline":
                known.update(f"{entity['id']}.pole{i}" for i in range(len(entity["poles"])))
                known.update({f"{entity['id']}.start", f"{entity['id']}.end"})
        for constraint in self.constraints:
            for ref in constraint["refs"] + ([constraint["at"]] if isinstance(constraint.get("at"), str) else []):
                if ref not in known:
                    raise SketchError(f"Sketch {self.name!r}: constraint {constraint['id']} refers to unknown {ref!r}.", [constraint["id"]])

    # ───────── 3D geometry ─────────

    def _p(self, xy) -> gp_Pnt:
        _load()
        v = self.plane.toWorldCoords((xy[0], xy[1]))
        return gp_Pnt(v.x, v.y, v.z)

    def _ax2(self, center, rotation=0.0) -> gp_Ax2:
        _load()
        n, x = self.plane.zDir, self.plane.xDir
        y = self.plane.yDir
        dx = x * math.cos(rotation) + y * math.sin(rotation)
        return gp_Ax2(self._p(center), gp_Dir(n.x, n.y, n.z), gp_Dir(dx.x, dx.y, dx.z))

    def _edge(self, e: dict) -> cq.Edge | None:
        _load()
        kind = e["type"]
        if kind == "line":
            if math.dist(e["start"], e["end"]) < 1e-9:
                return None
            return cq.Edge(BRepBuilderAPI_MakeEdge(self._p(e["start"]), self._p(e["end"])).Edge())
        if kind == "circle":
            return cq.Edge(BRepBuilderAPI_MakeEdge(gp_Circ(self._ax2(e["center"]), e["radius"])).Edge())
        if kind == "arc":
            circ = gp_Circ(self._ax2(e["center"]), e["radius"])
            a0, a1 = e["start_angle"], e["end_angle"]
            while a1 <= a0:
                a1 += 2 * math.pi
            return cq.Edge(BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(circ, a0, a1, True).Value()).Edge())
        if kind in {"ellipse", "elliptical_arc"}:
            major, minor = e["major_radius"], e["minor_radius"]
            rotation = e.get("rotation", 0.0)
            if minor > major:
                major, minor, rotation = minor, major, rotation + math.pi / 2
            elips = gp_Elips(self._ax2(e["center"], rotation), major, minor)
            if kind == "ellipse":
                return cq.Edge(BRepBuilderAPI_MakeEdge(elips).Edge())
            a0, a1 = e["start_angle"], e["end_angle"]
            while a1 <= a0:
                a1 += 2 * math.pi
            return cq.Edge(BRepBuilderAPI_MakeEdge(GC_MakeArcOfEllipse(elips, a0, a1, True).Value()).Edge())
        if kind == "bspline":
            poles = Array1_gp_Pnt(1, len(e["poles"]))
            for i, p in enumerate(e["poles"], start=1):
                poles.SetValue(i, self._p(p))
            if e.get("bezier"):
                return cq.Edge(BRepBuilderAPI_MakeEdge(Geom_BezierCurve(poles)).Edge())
            return cq.Edge(BRepBuilderAPI_MakeEdge(_bspline(poles, e["degree"], e.get("periodic", False))).Edge())
        return None

    def edges(self) -> list[tuple[str, cq.Edge]]:
        """Profile-forming edges (construction excluded), tagged with their entity id."""
        if self._edges is None:
            self._edges = []
            for entity in self.entities.values():
                if entity.get("construction") or entity["type"] in {"point", "projection"}:
                    continue
                edge = self._edge(entity)
                if edge is not None:
                    self._edges.append((entity["id"], edge))
        return self._edges

    def all_edges(self) -> list[tuple[str, cq.Edge]]:
        """Every curve including construction geometry (sweep paths, axes, drawing dimensions' path lines)."""
        _load()
        result = []
        for entity in self.entities.values():
            edge = self._edge(entity) if entity["type"] not in {"point", "projection"} else None
            if edge is not None:
                result.append((entity["id"], edge))
        return result

    def regions(self) -> list[Region]:
        """Closed areas of the planar arrangement, named by their outer boundary entities."""
        _load()
        if self._regions is not None:
            return self._regions
        tagged = self.edges()
        self._regions = []
        if not tagged:
            return self._regions
        n = self.plane.zDir
        separate = self._separate_closed(tagged)
        if separate is not None:
            self._regions = separate
            return self._regions
        owner: dict[cq.Edge, str] = {}
        if len(tagged) == 1:  # Nothing to intersect (a lone circle, ellipse or closed spline).
            owner[tagged[0][1]] = tagged[0][0]
            split = [tagged[0][1]]
        else:
            builder = BOPAlgo_Builder()
            for _, edge in tagged:
                builder.AddArgument(edge.wrapped)
            builder.Perform()
            if builder.HasErrors():
                raise SketchError(f"Sketch {self.name!r}: the curves could not be intersected into regions.")
            for eid, edge in tagged:
                images = builder.Modified(edge.wrapped)
                pieces = [cq.Edge(piece) for piece in images] if images.Size() else [edge]
                for piece in pieces:
                    owner[piece] = eid
            split = cq.Shape.cast(builder.Shape()).Edges()
        base = BRepBuilderAPI_MakeFace(gp_Pln(self._p((0, 0)), gp_Dir(n.x, n.y, n.z))).Face()
        shapes = List_TopoDS_Shape()
        for edge in split:
            shapes.Append(edge.wrapped.Oriented(TopAbs_FORWARD))
            shapes.Append(edge.wrapped.Reversed())
        faces = BOPAlgo_BuilderFace()
        faces.SetFace(base)
        faces.SetShapes(shapes)
        faces.Perform()
        if faces.HasErrors():
            raise SketchError(f"Sketch {self.name!r}: closed profiles could not be built.")
        found = []
        for area in faces.Areas():
            face = cq.Face(area)
            if face.Area() <= 1e-9:
                continue  # The unbounded outside of the arrangement.
            outer = face.outerWire().Edges()
            boundary = sorted({owner.get(edge, _nearest_owner(edge, owner)) for edge in outer})
            found.append((face, boundary, [set(w.Edges()) for w in face.innerWires()], set(outer)))
        # Even-odd nesting: a region whose outer loop is another region's hole is one level deeper.
        by_outer: dict[frozenset, list[int]] = {}
        for i, (_, _, _, outer) in enumerate(found):
            by_outer.setdefault(frozenset(outer), []).append(i)
        inside = [(i, j) for j, (_, _, holes, _) in enumerate(found) for hole in holes
                  for i in by_outer.get(frozenset(hole), ()) if i != j]
        depth = {i: 0 for i in range(len(found))}
        changed = True
        while changed:
            changed = False
            for i, j in inside:
                if depth[i] != depth[j] + 1:
                    depth[i] = depth[j] + 1
                    changed = True
        names: dict[str, int] = {}
        for i, (face, boundary, _, _) in enumerate(found):
            name = f"{self.id}.region({','.join(boundary)})"
            if name in names:  # Same boundary entities, e.g. a line splitting a circle: disambiguate.
                names[name] += 1
                name = f"{name}[{names[name] - 1}]"
            else:
                names[name] = 1
            self._regions.append(Region(name=name, face=face, boundary=boundary, depth=depth[i]))
        return self._regions

    def _separate_closed(self, tagged) -> list[Region] | None:
        """Regions of circles and ellipses that neither touch nor contain each other, built straight from each curve
        with the names and depths the planar arrangement gives them. The arrangement intersects every curve with
        every other, which took seconds for hundreds of holes. None when any curve may meet or nest in another."""
        if any(self.entities[eid]["type"] not in {"circle", "ellipse"} for eid, _ in tagged):
            return None
        gap = 1e-6
        active: list = []
        for box in sorted((edge.BoundingBox() for _, edge in tagged), key=lambda b: b.xmin):
            active = [other for other in active if other.xmax >= box.xmin - gap]  # Sweep: these overlap it in x.
            if any(other.ymin <= box.ymax + gap and box.ymin <= other.ymax + gap
                   and other.zmin <= box.zmax + gap and box.zmin <= other.zmax + gap for other in active):
                return None
            active.append(box)
        n = self.plane.zDir
        plane = gp_Pln(self._p((0, 0)), gp_Dir(n.x, n.y, n.z))
        regions = []
        for eid, edge in tagged:
            wire = BRepBuilderAPI_MakeWire(edge.wrapped).Wire()
            face = cq.Face(BRepBuilderAPI_MakeFace(plane, wire, True).Face())  # True: the finite side of the curve.
            if face.Area() > 1e-9:
                regions.append(Region(name=f"{self.id}.region({eid})", face=face, boundary=[eid]))
        return regions

    def profile(self, selection=None) -> list[Region]:
        """Regions to extrude: named ones, or all regions at even nesting depth (holes stay holes)."""
        regions = self.regions()
        if not regions:
            raise SketchError(f"Sketch {self.name!r} has no closed profile. Close the outline or turn off construction.")
        if not selection:
            return [region for region in regions if region.depth % 2 == 0]
        wanted = [selection] if isinstance(selection, str) else list(selection)
        picked = []
        for ref in wanted:
            match = [region for region in regions if region.name == ref]
            if not match:
                raise SketchError(f"Profile {ref!r} no longer exists in sketch {self.name!r}.", [ref])
            picked.extend(match)
        return picked


def _nearest_owner(edge: cq.Edge, owner: dict) -> str:
    """Split pieces sometimes come back as new shapes: match them by geometry."""
    _load()
    mid = edge.positionAt(0.5)
    best, best_d = "?", float("inf")
    for candidate, eid in owner.items():
        d = candidate.distance(cq.Vertex.makeVertex(mid.x, mid.y, mid.z))
        if d < best_d:
            best, best_d = eid, d
    return best


def _project(shape, plane: cq.Plane) -> list[dict]:
    """Orthographic projection of a 3D edge or vertex onto `plane`, in its 2D coordinates: exact for
    lines, circles and arcs (tilted ones become ellipses), a dense polyline for other curves."""
    _load()
    local = lambda v: plane.toLocalCoords(v)  # noqa: E731
    if isinstance(shape, cq.Vertex):
        p = local(cq.Vector(shape.toTuple()))
        return [{"type": "point", "at": [p.x, p.y]}]
    edge: cq.Edge = shape
    kind = edge.geomType()
    a, b = local(edge.startPoint()), local(edge.endPoint())
    if kind == "LINE":
        if math.hypot(b.x - a.x, b.y - a.y) < 1e-9:
            return [{"type": "point", "at": [a.x, a.y]}]  # Seen end-on.
        return [{"type": "line", "start": [a.x, a.y], "end": [b.x, b.y]}]
    if kind == "CIRCLE":
        n = edge.normal()
        c3, r = edge.arcCenter(), edge.radius()
        c = local(c3)
        cos = n.dot(plane.zDir)
        closed = edge.IsClosed()
        if abs(abs(cos) - 1) < 1e-9:
            if closed:
                return [{"type": "circle", "center": [c.x, c.y], "radius": r}]
            a0, a1 = math.atan2(a.y - c.y, a.x - c.x), math.atan2(b.y - c.y, b.x - c.x)
            # Sketch arcs run counter-clockwise from start to end: keep the side the edge's midpoint is on. The edge's
            # start and end follow its orientation in the face (a reversed edge starts at its curve's end) while the
            # circle's normal doesn't, so the normal's sign can't say which way the arc runs.
            mid = local(edge.positionAt(0.5))
            am = math.atan2(mid.y - c.y, mid.x - c.x)
            if (am - a0) % (2 * math.pi) > (a1 - a0) % (2 * math.pi):
                a0, a1 = a1, a0
            return [{"type": "arc", "center": [c.x, c.y], "radius": r, "start_angle": a0, "end_angle": a1}]
        if abs(cos) > 1e-9:
            # A tilted circle is an ellipse: the major axis is the circle's diameter lying parallel to the plane.
            major3 = n.cross(plane.zDir).normalized()
            major = local(c3 + major3)
            rotation = math.atan2(major.y - c.y, major.x - c.x)
            minor = r * abs(cos)
            if closed:
                return [{"type": "ellipse", "center": [c.x, c.y], "major_radius": r, "minor_radius": minor, "rotation": rotation}]
            param = lambda p: math.atan2(  # noqa: E731
                ((p.x - c.x) * -math.sin(rotation) + (p.y - c.y) * math.cos(rotation)) / minor,
                ((p.x - c.x) * math.cos(rotation) + (p.y - c.y) * math.sin(rotation)) / r)
            mid = local(edge.positionAt(0.5))
            t0, t1, tm = param(a), param(b), param(mid)
            norm = lambda x: x % (2 * math.pi)  # noqa: E731
            if norm(tm - t0) > norm(t1 - t0):
                t0, t1 = t1, t0  # Keep it counter-clockwise, through the midpoint.
            return [{"type": "elliptical_arc", "center": [c.x, c.y], "major_radius": r, "minor_radius": minor,
                     "rotation": rotation, "start_angle": t0, "end_angle": t1}]
        # Seen edge-on: a line segment.
        points = [local(edge.positionAt(t / 64)) for t in range(65)]
    else:
        points = [local(edge.positionAt(t / 64)) for t in range(65)]
    xs = [(p.x, p.y) for p in points]
    span = max(math.dist(p, q) for p in xs for q in xs[:: 16])
    if span < 1e-9:
        return [{"type": "point", "at": [a.x, a.y]}]
    return [{"type": "bspline", "poles": [list(p) for p in xs], "degree": 1, "periodic": False}]


def _bspline(poles: Array1_gp_Pnt, degree: int, periodic: bool):
    _load()
    n = poles.Length()
    degree = max(1, min(degree, n - 1))
    if periodic:
        knots = Array1_double(1, n + 1)
        mults = Array1_int(1, n + 1)
        for i in range(1, n + 2):
            knots.SetValue(i, float(i - 1))
            mults.SetValue(i, 1)
        return Geom_BSplineCurve(poles, knots, mults, degree, True)
    inner = n - degree - 1
    knots = Array1_double(1, inner + 2)
    mults = Array1_int(1, inner + 2)
    for i in range(inner + 2):
        knots.SetValue(i + 1, i / (inner + 1))
        mults.SetValue(i + 1, degree + 1 if i in (0, inner + 1) else 1)
    return Geom_BSplineCurve(poles, knots, mults, degree)
