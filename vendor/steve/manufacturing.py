"""Manufacturing facts measured on the exact B-rep of a full build (manufacturing.json).

Facts only: no thresholds or verdicts. The API applies process rules to them
(app/manufacturing_checks.py; STEVE asks through inspect_model(checks=[...])). Per body:

- face samples: point, outward unit normal and area share, so overhang and draft can be evaluated
  for any build or pull direction;
- wall thickness at each sample: a ray from the surface along the inward normal to the next surface;
- visibility at each sample along ±X, ±Y and ±Z (a ray from just outside the surface that leaves the
  part without hitting it), for undercuts and 3-axis tool access;
- cylinders: holes (concave, full turn) with diameter, axis and depth; bosses and pins (convex, full
  turn); concave partial cylinders (internal fillets) with radius and axis;
- sharp concave edges (no fillet) with their dihedral angle, direction and length;
- sealed internal voids (inner shells) and the bounding box.

Everything carries persistent face/edge names where the model has them. Sampling is capped and the
whole analysis has a time budget; a cut-short analysis says so (`partial`).
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path
from .reporting import surface_area

DIRECTIONS = {"+X": (1, 0, 0), "-X": (-1, 0, 0), "+Y": (0, 1, 0), "-Y": (0, -1, 0), "+Z": (0, 0, 1), "-Z": (0, 0, -1)}
MAX_SAMPLES = 2400            # per body
MAX_PER_FACE = 36
BUDGET_S = 20.0               # all bodies together


def _r(value, digits=4):
    return round(float(value), digits) + 0.0


class _Budget:
    def __init__(self, seconds):
        self.end = time.monotonic() + seconds
        self.partial = False

    def spent(self):
        if time.monotonic() > self.end:
            self.partial = True
        return self.partial


def _bodies(result, skipped=None):
    """[(body name, cq.Shape (Solid), steve model or None, instances)] in the frame it is made in. Surface bodies and
    components that aren't hardware (`Component(..., hardware=False)`) are left out (nothing to machine, mould or print)
    and, given a `skipped` list, named there with the note why."""
    import cadquery as cq
    found = []
    design = getattr(result, "_steve_design", None)
    if isinstance(result, cq.Assembly) or design is not None:
        seen = {}
        assembly = result if isinstance(result, cq.Assembly) else None
        for element in (assembly.traverse() if assembly is not None else []):
            _, node = element
            obj = node.obj
            if obj is None:
                continue
            model = getattr(obj, "_steve_model", None)
            shape = obj.val() if isinstance(obj, cq.Workplane) and len(obj.vals()) == 1 else obj
            if isinstance(shape, cq.Workplane):
                shape = cq.Compound.makeCompound([v for v in shape.vals() if isinstance(v, cq.Shape)])
            key = id(model) if model is not None else id(shape)
            if key in seen:
                seen[key][3].append(node.name)
                continue
            if model is not None and getattr(model, "hardware", True) is False:  # A fluid volume or envelope: nothing to make.
                if skipped is not None:
                    from .design import NOT_HARDWARE_NOTE
                    entry = next((e for e in skipped if e["body"] == model.id and e["note"] == NOT_HARDWARE_NOTE), None)
                    if entry is None:
                        skipped.append({"body": model.id, "instances": [node.name], "note": NOT_HARDWARE_NOTE})
                    else:
                        entry["instances"].append(node.name)
                continue
            if model is not None and model.bodies:
                from .model import SURFACE_NOTE, is_surface
                for identity, body in model.bodies.items():
                    if is_surface(body):  # Only solids are made (see below).
                        if skipped is not None:
                            skipped.append({"body": f"{getattr(model, 'id', node.name)}.{identity}", "instances": [node.name], "note": SURFACE_NOTE})
                        continue
                    entry = [f"{getattr(model, 'id', node.name)}.{identity}" if len(model.bodies) > 1 else getattr(model, "id", node.name), body, model, [node.name]]
                    found.append(entry)
                    seen[key] = entry
            else:
                for index, solid in enumerate(shape.Solids()):
                    found.append([f"{node.name}.{index + 1}" if len(shape.Solids()) > 1 else node.name, solid, None, [node.name]])
                seen[key] = found[-1]
        return [tuple(entry) for entry in found]
    model = getattr(result, "_steve_model", None)
    if isinstance(result, cq.Workplane):
        values = [v for v in result.vals() if isinstance(v, cq.Shape)]
        result = values[0] if len(values) == 1 else cq.Compound.makeCompound(values)
    if model is not None and model.bodies:
        from .model import SURFACE_NOTE, is_surface
        # Surface bodies have no wall, volume or tool access to check: only solids are made.
        if skipped is not None:
            skipped.extend({"body": identity, "note": SURFACE_NOTE} for identity, body in model.bodies.items() if is_surface(body))
        return [(identity, body, model, []) for identity, body in model.bodies.items() if not is_surface(body)]
    return [(f"body_{i + 1}" if len(result.Solids()) > 1 else "body", solid, None, []) for i, solid in enumerate(result.Solids())]


def _names(model, body):
    if model is None:
        return {}, {}
    try:
        refs = model.refs(body)
        return refs.get("faces", {}), refs.get("edges", {})
    except Exception:
        return {}, {}


def analyze_body(name, body, model, budget):
    import cadquery as cq
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.BRepGProp import BRepGProp_Face
    from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane, GeomAbs_Cone, GeomAbs_Sphere, GeomAbs_Torus
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
    from OCP.IntTools import IntTools_FClass2d
    from OCP.TopAbs import TopAbs_IN, TopAbs_ON
    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt, gp_Pnt2d, gp_Vec

    face_names, edge_names = _names(model, body)
    faces = body.Faces()
    bbox = body.BoundingBox()
    size = max(bbox.xlen, bbox.ylen, bbox.zlen, 1e-6)
    eps = max(1e-4, size * 1e-6)
    tol = max(1e-5, size * 1e-7)
    caster = IntCurvesFace_ShapeIntersector()
    caster.Load(body.wrapped, tol)
    classifier = BRepClass3d_SolidClassifier(body.wrapped)
    kinds = {GeomAbs_Plane: "plane", GeomAbs_Cylinder: "cylinder", GeomAbs_Cone: "cone", GeomAbs_Sphere: "sphere", GeomAbs_Torus: "torus"}

    def first_hit(origin, direction, skip=0.0):
        caster.Perform(gp_Lin(origin, gp_Dir(*direction)), skip, 1e100)
        if not caster.IsDone() or caster.NbPnt() == 0:
            return None
        return min(caster.WParameter(i) for i in range(1, caster.NbPnt() + 1))

    def inside(point):
        classifier.Perform(gp_Pnt(*point), tol * 10)
        return classifier.State() == TopAbs_IN

    reported_areas = [surface_area(face) for face in faces]
    total_area = sum(reported_areas) or 1.0
    face_index = {face: i for i, face in enumerate(faces)}
    samples, exact, face_rows = [], [], []
    for index, face in enumerate(faces):
        if budget.spent():
            break
        ref = face_names.get(face)
        area = reported_areas[index]
        adaptor = BRepAdaptor_Surface(face.wrapped)
        kind = kinds.get(adaptor.GetType(), "other")
        u0, u1, v0, v1 = adaptor.FirstUParameter(), adaptor.LastUParameter(), adaptor.FirstVParameter(), adaptor.LastVParameter()
        count = max(1, min(MAX_PER_FACE, round(MAX_SAMPLES * area / total_area)))
        side = max(1, math.ceil(math.sqrt(count)))
        classify = IntTools_FClass2d(face.wrapped, 1e-7)
        props = BRepGProp_Face(face.wrapped)
        points = []
        for i in range(side):
            for j in range(side):
                u = u0 + (u1 - u0) * (i + 0.5) / side
                v = v0 + (v1 - v0) * (j + 0.5) / side
                if classify.Perform(gp_Pnt2d(u, v)) not in (TopAbs_IN, TopAbs_ON):
                    continue
                p, n = gp_Pnt(), gp_Vec()
                props.Normal(u, v, p, n)
                if n.Magnitude() < 1e-12:
                    continue
                n.Normalize()
                points.append(((p.X(), p.Y(), p.Z()), (n.X(), n.Y(), n.Z())))
        if not points:  # A thin or oddly parameterised face: its centre.
            c = face.Center()
            nn = face.normalAt(c)
            points = [((c.x, c.y, c.z), (nn.x, nn.y, nn.z))]
        share = area / len(points)
        row = {"index": index, "ref": ref, "type": kind, "area_mm2": _r(area, 3)}
        if kind == "plane":
            row["normal"] = [_r(c) for c in points[0][1]]
        if kind in ("cylinder", "cone"):
            axis = adaptor.Cylinder().Axis() if kind == "cylinder" else adaptor.Cone().Axis()
            origin, direction = axis.Location(), axis.Direction()
            row["axis"] = [_r(direction.X()), _r(direction.Y()), _r(direction.Z())]
            if kind == "cylinder":
                radius = adaptor.Cylinder().Radius()
                row["radius_mm"] = _r(radius)
                # Concave (material outside the cylinder: a hole or an internal fillet) when the outward normal points to the axis.
                p, n = points[0]
                to_axis = gp_Vec(gp_Pnt(*p), origin)
                d = gp_Vec(direction)
                to_axis = to_axis - d * to_axis.Dot(d)
                row["concave"] = to_axis.Dot(gp_Vec(*n)) > 0
                row["full_turn"] = abs((u1 - u0) - 2 * math.pi) < 1e-3
                heights = [gp_Vec(origin, gp_Pnt(*q)).Dot(d) for q, _ in points]
                vmin, vmax = adaptor.FirstVParameter(), adaptor.LastVParameter()
                row["length_mm"] = _r(abs(vmax - vmin) if math.isfinite(vmax - vmin) else max(heights) - min(heights))
            else:
                row["half_angle_deg"] = _r(math.degrees(adaptor.Cone().SemiAngle()), 3)
        face_rows.append(row)
        for point, normal in points:
            samples.append({"face": index, "p": [_r(c, 3) for c in point], "n": [_r(c) for c in normal], "a": _r(share, 4)})
            exact.append((point, normal))

    # The rays start from the exact surface points: rounding a point on a curved face moves it
    # several eps off the surface (into the air or the material), which corrupts both measurements.
    # Wall thickness: along the inward normal to the next surface.
    for sample, (p, n) in zip(samples, exact):
        if budget.spent():
            break
        start = gp_Pnt(p[0] - n[0] * eps, p[1] - n[1] * eps, p[2] - n[2] * eps)
        hit = first_hit(start, (-n[0], -n[1], -n[2]), eps * 0.1)
        sample["t"] = _r(hit + eps, 4) if hit is not None else None
    # Visibility: rays leaving the surface along each principal direction.
    for sample, (p, n) in zip(samples, exact):
        if budget.spent():
            break
        start = gp_Pnt(p[0] + n[0] * eps * 2, p[1] + n[1] * eps * 2, p[2] + n[2] * eps * 2)
        if inside((start.X(), start.Y(), start.Z())):
            sample["v"] = ""  # The surface point's outside is inside the part (a seam); unknown.
            continue
        sample["v"] = "".join(key for key, d in DIRECTIONS.items() if first_hit(start, d, eps * 0.1) is None)

    # Sharp concave edges: two faces meeting at an inside corner without a fillet.
    edges = []
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.collections import IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher
    from OCP.TopoDS import TopoDS
    edge_faces = IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapesAndAncestors_s(body.wrapped, TopAbs_EDGE, TopAbs_FACE, edge_faces)
    for i in range(1, edge_faces.Extent() + 1):
        if budget.spent():
            break
        edge = cq.Edge(TopoDS.Edge(edge_faces.FindKey(i)))
        adjacent = [cq.Face(TopoDS.Face(f)) for f in edge_faces.FindFromIndex(i)]
        if len(adjacent) != 2 or BRep_Tool.Degenerated_s(edge.wrapped) or edge.Length() < eps * 10:
            continue
        mid = edge.positionAt(0.5)
        normals = []
        for face in adjacent:
            try:
                normals.append(face.normalAt(mid))
            except Exception:
                normals = []
                break
        if len(normals) != 2:
            continue
        angle = math.degrees(normals[0].getAngle(normals[1]))
        if angle < 20:  # Tangent or nearly so: a smooth transition, not a corner.
            continue
        # Locally a convex edge's solid is the intersection of the two faces' inner half-spaces, a
        # concave (re-entrant) edge's their union: m + (n1 - n2)·δ lies outside the first and inside
        # the second, so it is inside the solid only at a concave edge.
        offset = normals[0] - normals[1]
        if offset.Length < 1e-9:
            continue
        probe = mid + offset.normalized() * max(eps * 20, min(0.05, size * 1e-3))
        if not inside((probe.x, probe.y, probe.z)):
            continue  # Convex.
        tangent = edge.tangentAt(0.5)
        edges.append({"ref": edge_names.get(edge), "dihedral_deg": _r(180 - angle, 2), "length_mm": _r(edge.Length(), 3),
                      "type": edge.geomType().lower(), "direction": [_r(tangent.x), _r(tangent.y), _r(tangent.z)],
                      "midpoint": [_r(mid.x, 3), _r(mid.y, 3), _r(mid.z, 3)],
                      "faces": [face_names.get(face) for face in adjacent],
                      "face_indices": [face_index.get(face) for face in adjacent]})

    shells = body.Shells()
    voids = []
    if len(shells) > 1:
        outer = max(shells, key=lambda s: s.BoundingBox().DiagonalLength)
        for shell in shells:
            if not shell.isSame(outer):
                voids.append({"volume_mm3": _r(abs(cq.Solid.makeSolid(shell).Volume()), 3)})
    return {
        "name": name,
        "bounds_mm": [_r(bbox.xmin, 3), _r(bbox.ymin, 3), _r(bbox.zmin, 3), _r(bbox.xmax, 3), _r(bbox.ymax, 3), _r(bbox.zmax, 3)],
        "volume_mm3": _r(body.Volume(), 3), "area_mm2": _r(total_area, 3),
        "faces": face_rows, "samples": samples, "concave_edges": edges, "voids": voids,
    }


def facts(result, budget_s=BUDGET_S):
    budget = _Budget(budget_s)
    started = time.monotonic()
    bodies, skipped = [], []
    for name, body, model, instances in _bodies(result, skipped):
        if budget.spent():
            break
        row = analyze_body(name, body, model, budget)
        if instances:
            row["instances"] = instances
        bodies.append(row)
    return {"version": 1, "units": "mm", "frame": "each body in the coordinates it is modelled in",
            "directions": list(DIRECTIONS), "partial": budget.partial, "seconds": _r(time.monotonic() - started, 2),
            "bodies": bodies, **({"skipped": skipped} if skipped else {})}


def write(result, path="manufacturing.json", budget_s=BUDGET_S):
    from .model import SURFACE_NOTE
    data = facts(result, budget_s)
    Path(path).write_text(json.dumps(data, separators=(",", ":"), allow_nan=False))
    from .design import NOT_HARDWARE_NOTE
    skipped = data.get("skipped") or []
    surfaces = sum(1 for item in skipped if item["note"] == SURFACE_NOTE)
    others = len(skipped) - surfaces
    notes = [*([f"{surfaces} surface {'body' if surfaces == 1 else 'bodies'} left out: {SURFACE_NOTE}."] if surfaces else []),
             *([f"{others} {'component' if others == 1 else 'components'} left out: {NOT_HARDWARE_NOTE}."] if others else [])]
    return {"bodies": len(data["bodies"]), "partial": data["partial"], "seconds": data["seconds"],
            **({"skipped": len(skipped), "note": " ".join(notes)} if skipped else {})}
