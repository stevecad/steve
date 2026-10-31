"""How two faces meet along an edge, measured on the exact B-rep (the Surface tab's continuity check, topology.json
`continuity` on an edge): the gap between them (G0), the angle between their tangent planes (G1) and the change of
their normal curvature across the edge (G2), each the largest over a few points spread along the edge.

Each face is evaluated where the edge's point projects onto it (ShapeAnalysis_Surface), so a gap is the real distance
from one face's boundary to the other face, also between separate bodies (a fill patch against the wall it closes).
Curvature is the normal curvature across the edge, k1 cos²θ + k2 sin²θ from the principal curvatures and directions
(BRepLProp_SLProps), signed as the web's analysis does: positive where the face bends away from its outward normal.

Only measured, never made: STEVE's tools give at most tangent (G1) blends; this says how close to G2 a junction is.
"""
from __future__ import annotations

import math

SAMPLES = 5          # points along the edge (its ends excluded, where faces can be degenerate)
FREE_EDGE_TOLERANCE = 0.01  # mm: a free edge lies on another face's boundary within this to be paired with it
MOST_FREE_EDGES = 400       # a mesh with more free edges than this isn't searched for partners (time)


def _side(face, surface, analysis, point, tangent):
    """(point on the face, outward unit normal, normal curvature across the edge) where `point` projects onto `face`."""
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.gp import gp_Dir, gp_Vec
    from OCP.TopAbs import TopAbs_REVERSED
    uv = analysis.ValueOfUV(point, 1e-6)
    props = BRepLProp_SLProps(surface, uv.X(), uv.Y(), 2, 1e-9)
    if not props.IsNormalDefined():
        return None
    normal = gp_Vec(props.Normal())
    reversed_ = face.Orientation() == TopAbs_REVERSED
    if reversed_:
        normal.Reverse()
    across = normal.Crossed(tangent)
    if across.Magnitude() < 1e-12:
        return None
    across.Normalize()
    curvature = None
    if props.IsCurvatureDefined():
        if props.IsUmbilic():
            k = props.MaxCurvature()
        else:
            d1, d2 = gp_Dir(), gp_Dir()
            props.CurvatureDirections(d1, d2)
            c = across.Dot(gp_Vec(d1))
            k = props.MaxCurvature() * c * c + props.MinCurvature() * (1 - c * c)
        # OCCT signs curvature against the surface's own normal (centre of curvature along it is positive); the web's
        # convention is against the outward normal, positive where the face bends away from it (a ball's outside).
        curvature = -k if not reversed_ else k
    return props.Value(), normal, curvature


def measure(edge, face_a, face_b, samples: int = SAMPLES) -> dict | None:
    """The continuity of `face_a` and `face_b` along `edge` (an edge of face_a; face_b may be another body's face):
    {"gap": mm, "angle": degrees, "curvature": [k_a, k_b] at the worst point (1/mm), "change": largest |k_a − k_b|,
    "relative": that as a share of the larger |k|, "at": the worst point}."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.gp import gp_Pnt, gp_Vec
    from OCP.ShapeAnalysis import ShapeAnalysis_Surface
    curve = BRepAdaptor_Curve(edge)
    first, last = curve.FirstParameter(), curve.LastParameter()
    if not (math.isfinite(first) and math.isfinite(last)) or last - first <= 1e-12:
        return None
    sides = []
    for face in (face_a, face_b):
        surface = BRepAdaptor_Surface(face)
        sides.append((face, surface, ShapeAnalysis_Surface(BRep_Tool.Surface_s(face))))
    gap = angle = change = relative = 0.0
    worst, at, found = None, None, 0
    for i in range(samples):
        t = first + (last - first) * (i + 0.5) / samples
        point, tangent = gp_Pnt(), gp_Vec()
        curve.D1(t, point, tangent)
        if tangent.Magnitude() < 1e-12:
            continue
        a = _side(*sides[0], point, tangent)
        b = _side(*sides[1], point, tangent)
        if a is None or b is None:
            continue
        found += 1
        between = math.degrees(math.acos(max(-1.0, min(1.0, abs(a[1].Dot(b[1]))))))
        # A face of another body may be oriented either way: its curvature is read against the normal that agrees.
        kb = b[2] if b[2] is None or a[1].Dot(b[1]) >= 0 else -b[2]
        gap = max(gap, a[0].Distance(b[0]))
        if a[2] is not None and kb is not None:
            difference = abs(a[2] - kb)
            scale = max(abs(a[2]), abs(kb))
            change = max(change, difference)
            relative = max(relative, difference / scale if scale > 1e-4 else 0.0)
        if worst is None or between >= worst:
            worst, at = between, (a[0], a[2], kb)
        angle = max(angle, between)
    if not found:
        return None
    return {"gap": round(gap, 6), "angle": round(angle, 5), "change": round(change, 7), "relative": round(relative, 5),
            "curvature": [None if at[1] is None else round(at[1], 7), None if at[2] is None else round(at[2], 7)],
            "at": [round(at[0].X(), 5), round(at[0].Y(), 5), round(at[0].Z(), 5)], "samples": found}


def _points(edge, count=3):
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    curve = BRepAdaptor_Curve(edge)
    first, last = curve.FirstParameter(), curve.LastParameter()
    return [curve.Value(first + (last - first) * (i + 0.5) / count) for i in range(count)]


def _into(face, point, tangent) -> object | None:
    """The unit direction across the edge, in the face's tangent plane, pointing into the face at `point`."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.gp import gp_Pnt
    from OCP.ShapeAnalysis import ShapeAnalysis_Surface
    from OCP.TopAbs import TopAbs_IN
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    side = _side(face, BRepAdaptor_Surface(face), ShapeAnalysis_Surface(BRep_Tool.Surface_s(face)), point, tangent)
    if side is None:
        return None
    across = side[1].Crossed(tangent)
    across.Normalize()
    for sign in (1, -1):
        step = 1e-3
        probe = gp_Pnt(point.X() + sign * step * across.X(), point.Y() + sign * step * across.Y(), point.Z() + sign * step * across.Z())
        if BRepClass_FaceClassifier(face, probe, 1e-4).State() == TopAbs_IN:
            return across.Multiplied(sign)
    return None


def free_edge_partners(edges, faces_of, owner_of) -> dict:
    """For free edges (one face; a surface body's boundary), the faces of other bodies meeting them: {edge index:
    (own face, partner face, partner's edge)}. `edges`: {index: TopoDS_Edge}; `faces_of`: {edge index: [(face index,
    TopoDS_Face)]}; `owner_of`: {face index: body id}. Each free edge's entry is (its face, the partner face, the edge
    the partner lies on). A partner lies on an edge within FREE_EDGE_TOLERANCE all along
    and continues the free face across it (their directions into the faces are opposite)."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.gp import gp_Vec
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    free = [i for i, adjacent in faces_of.items() if len(adjacent) == 1]
    if not free or len(free) > MOST_FREE_EDGES:
        return {}
    boxes = {}
    for j, other in edges.items():
        box = Bnd_Box()
        BRepBndLib.Add_s(other, box)
        box.Enlarge(FREE_EDGE_TOLERANCE)
        boxes[j] = box
    out = {}
    for i in free:
        own_index, own_face = faces_of[i][0]
        samples = _points(edges[i])
        curve = BRepAdaptor_Curve(edges[i])
        middle_t = (curve.FirstParameter() + curve.LastParameter()) / 2
        middle, tangent = samples[1], gp_Vec()
        curve.D1(middle_t, middle, tangent)
        if tangent.Magnitude() < 1e-12:
            continue
        own_into = _into(own_face, middle, tangent)
        if own_into is None:
            continue
        best = None
        for j, other in edges.items():
            if j == i:
                continue
            candidates = [(k, f) for k, f in faces_of.get(j, []) if owner_of.get(k) != owner_of.get(own_index)]
            if not candidates or any(boxes[j].IsOut(p) for p in samples):
                continue
            if any(BRepExtrema_DistShapeShape(BRepBuilderAPI_MakeVertex(p).Vertex(), other).Value() > FREE_EDGE_TOLERANCE for p in samples):
                continue
            for k, face in candidates:
                into = _into(face, middle, tangent)
                if into is None:
                    continue
                facing = into.Dot(own_into)
                if facing < 0 and (best is None or facing < best[0]):
                    best = (facing, k, j)
        if best is not None:
            out[i] = (own_index, best[1], best[2])
    return out
