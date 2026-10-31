"""Persistent names for B-rep faces, carried through operation history.

Every face gets a provenance name when a feature creates it (`extrude_1.end`,
`extrude_1.side(r1.left)`, `fillet_1.face(edge(a|b))`). Later operations update the
registry through OCCT's Modified/IsDeleted history, so a name keeps pointing at the
same face after booleans, fillets or parameter changes. Edges are named by their two
adjacent faces and vertices by three (docs/MODELING.md section 3).
"""
from __future__ import annotations

import cadquery as cq
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_VERTEX
from OCP.TopExp import TopExp
from OCP.collections import IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher

_STABLE = cq.Vector(1.0, 1e-3, 1e-6)  # Orders same-pair edges along a fixed, rarely degenerate axis.


def _faces(shapes) -> list[cq.Face]:
    return [cq.Face(s) for s in shapes if s.ShapeType() == TopAbs_FACE]


class Names:
    """name → current faces. Insertion order is creation order (the oldest name wins on export)."""

    def __init__(self):
        self.faces: dict[str, list[cq.Face]] = {}

    def add(self, name: str, faces) -> None:
        faces = [f if isinstance(f, cq.Face) else cq.Face(f) for f in faces]
        existing = self.faces.setdefault(name, [])
        for face in faces:
            if face not in existing:
                existing.append(face)

    def merge(self, other: "Names") -> None:
        for name, faces in other.faces.items():
            self.add(name, faces)

    def update(self, maker, result: cq.Shape, inputs) -> None:
        """Follows named faces of `inputs` through one operation (any BRepBuilderAPI_MakeShape).

        Faces of shapes the operation didn't take as input keep their names untouched.
        """
        touched = {face for shape in inputs for face in shape.Faces()}
        # Keep the result's own face objects: same shape, but oriented as they sit in the new solid.
        live = {face: face for face in result.Faces()}
        for name, faces in list(self.faces.items()):
            carried: list[cq.Face] = []
            for face in faces:
                if face in live:
                    carried.append(live[face])
                    continue
                if face not in touched:
                    carried.append(face)
                    continue
                try:
                    images = _faces(maker.Modified(face.wrapped))
                except Exception:  # Some makers raise for shapes they never saw.
                    images = []
                carried.extend(live[image] for image in images if image in live and live[image] not in carried)
            self.faces[name] = carried

    def prune(self, result: cq.Shape) -> None:
        live = set(result.Faces())
        for name, faces in self.faces.items():
            self.faces[name] = [face for face in faces if face in live]

    def transformed(self, maker) -> "Names":
        copy = Names()
        for name, faces in self.faces.items():
            images = []
            for face in faces:
                try:
                    images.extend(_faces(maker.Modified(face.wrapped)))
                except Exception:
                    pass
            copy.add(name, images)
        return copy

    # ───────── lookups ─────────

    def name_of(self, face: cq.Face) -> str | None:
        for name, faces in self.faces.items():
            if face in faces:
                return name
        return None

    def index(self) -> dict[cq.Face, str]:
        """face → its oldest name."""
        out: dict[cq.Face, str] = {}
        for name, faces in self.faces.items():
            for face in faces:
                out.setdefault(face, name)
        return out

    def pieces(self, name: str) -> list[cq.Face]:
        """The faces one name holds, in the order `<name>[i]` picks them: along a fixed axis, as edges' `[i]`."""
        return sorted(self.faces.get(name, []), key=_stable_key)

    def unique(self) -> dict[cq.Face, str]:
        """face → a name no other face has, for listing and picking one face: its oldest name, or
        `<name>[i]` (pieces) when a split left that name on several faces. The shared name itself still names them all."""
        index, order = self.index(), {}
        out: dict[cq.Face, str] = {}
        for face, name in index.items():
            if name not in order:
                pieces = self.pieces(name)
                order[name] = {piece: i for i, piece in enumerate(pieces)} if len(pieces) > 1 else None
            out[face] = name if order[name] is None else f"{name}[{order[name][face]}]"
        return out

    def matching(self, prefix: str) -> list[str]:
        return [name for name in self.faces if name.startswith(prefix)]


def _ancestors(shape: cq.Shape, kind, parent) -> IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher:
    table = IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapesAndAncestors_s(shape.wrapped, kind, parent, table)
    return table


def edge_faces(shape: cq.Shape) -> dict[cq.Edge, list[cq.Face]]:
    table = _ancestors(shape, TopAbs_EDGE, TopAbs_FACE)
    out: dict[cq.Edge, list[cq.Face]] = {}
    for i in range(1, table.Extent() + 1):
        edge = cq.Edge(table.FindKey(i))
        faces = []
        for face in table.FindFromIndex(i):
            f = cq.Face(face)
            if f not in faces:
                faces.append(f)
        out[edge] = faces
    return out


def vertex_faces(shape: cq.Shape) -> dict[cq.Vertex, list[cq.Face]]:
    table = _ancestors(shape, TopAbs_VERTEX, TopAbs_FACE)
    out: dict[cq.Vertex, list[cq.Face]] = {}
    for i in range(1, table.Extent() + 1):
        vertex = cq.Vertex(table.FindKey(i))
        faces = []
        for face in table.FindFromIndex(i):
            f = cq.Face(face)
            if f not in faces:
                faces.append(f)
        out[vertex] = faces
    return out


def _stable_key(shape: cq.Shape) -> float:
    return shape.Center().dot(_STABLE)


def edge_names(shape: cq.Shape, names: Names) -> dict[cq.Edge, str]:
    """Every edge of `shape` named `edge(a|b)` from its adjacent faces, `[i]` when a pair repeats."""
    face_name = names.index()
    groups: dict[str, list[cq.Edge]] = {}
    for edge, faces in edge_faces(shape).items():
        labels = sorted({face_name.get(face, "?") for face in faces})
        if len(labels) == 1:
            labels = labels * 2  # Seam or an edge between two faces with the same name.
        groups.setdefault(f"edge({'|'.join(labels[:2])})", []).append(edge)
    out: dict[cq.Edge, str] = {}
    for key, edges in groups.items():
        if len(edges) == 1:
            out[edges[0]] = key
        else:
            for i, edge in enumerate(sorted(edges, key=_stable_key)):
                out[edge] = f"{key}[{i}]"
    return out


def vertex_names(shape: cq.Shape, names: Names) -> dict[cq.Vertex, str]:
    face_name = names.index()
    groups: dict[str, list[cq.Vertex]] = {}
    for vertex, faces in vertex_faces(shape).items():
        labels = sorted({face_name.get(face, "?") for face in faces})
        groups.setdefault(f"vertex({'|'.join(labels[:3])})", []).append(vertex)
    out: dict[cq.Vertex, str] = {}
    for key, vertices in groups.items():
        if len(vertices) == 1:
            out[vertices[0]] = key
        else:
            for i, vertex in enumerate(sorted(vertices, key=_stable_key)):
                out[vertex] = f"{key}[{i}]"
    return out
