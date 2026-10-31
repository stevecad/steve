"""A Blender document's measurements (blender/blender_run.py), from its triangle meshes: plain numpy, no bpy, so they are
tested without Blender (tests/service/test_blender.py). World millimetres throughout."""
import numpy as np

MAX_OPEN_NAMED = 20  # Open meshes a warning names one by one.


class NoGeometry(ValueError):
    """Nothing renderable to measure."""


def closed(vertices, triangles):
    """Whether a triangle mesh is watertight: with vertices at the same place welded (a text's or curve's caps and sides
    are separate pieces), every edge of its non-degenerate triangles is shared by exactly two of them."""
    if not len(triangles):
        return False
    tolerance = max(float(np.ptp(vertices, axis=0).max()) * 1e-7, 1e-9)
    _, weld = np.unique(np.round(vertices / tolerance), axis=0, return_inverse=True)
    welded = weld.reshape(-1)[triangles]
    welded = welded[(welded[:, 0] != welded[:, 1]) & (welded[:, 1] != welded[:, 2]) & (welded[:, 2] != welded[:, 0])]
    if not len(welded):
        return False
    edges = np.sort(np.concatenate([welded[:, [0, 1]], welded[:, [1, 2]], welded[:, [2, 0]]]), axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return bool(np.all(counts == 2))


def measure_instance(vertices, triangles, matrix):
    """Extent, surface area, and signed volume with its centroid moment, of one placed mesh (world millimetres)."""
    world = vertices @ matrix[:3, :3].T + matrix[:3, 3]
    a, b, c = world[triangles[:, 0]], world[triangles[:, 1]], world[triangles[:, 2]]
    cross = np.cross(b - a, c - a)
    area = 0.5 * float(np.linalg.norm(cross, axis=1).sum())
    signed = np.einsum("ij,ij->i", a, np.cross(b, c)) / 6.0  # Tetrahedra from the origin to each triangle.
    volume = float(signed.sum())
    moment = (signed[:, None] * (a + b + c) / 4.0).sum(axis=0)
    return world.min(axis=0), world.max(axis=0), area, volume, moment


def overlapping(boxes, most=2000):
    """Whether any two closed objects' extents overlap (so their volumes may), checked for up to `most` of them."""
    if len(boxes) < 2:
        return False
    if len(boxes) > most:
        return True
    low, high = np.array([box[0] for box in boxes]), np.array([box[1] for box in boxes])
    tolerance = 1e-6 * max(float((high.max(axis=0) - low.min(axis=0)).max()), 1.0)
    apart = ((low[:, None, :] >= high[None, :, :] - tolerance) | (low[None, :, :] >= high[:, None, :] - tolerance)).any(axis=2)
    np.fill_diagonal(apart, True)
    return not bool(apart.all())


def rounded(value):
    if isinstance(value, np.ndarray):
        return [round(float(v), 6) + 0.0 for v in value]
    return round(float(value), 6) + 0.0


def summarize(placed, listed_max=200):
    """The scene's measurements from its placed meshes [(name, type, vertices, triangles, watertight, matrix)]:
    (metadata, (low, high)). Volume and centre of mass count the closed meshes only; each object's own figures are listed
    (up to `listed_max`), and warnings say what the totals leave out."""
    listed, warnings, open_names, solids = [], [], [], []
    low, high = np.full(3, np.inf), np.full(3, -np.inf)
    area_total, volume_total, moment_total, triangles_total, closed_count = 0.0, 0.0, np.zeros(3), 0, 0
    for name, kind, vertices, triangles, watertight, matrix in placed:
        lo, hi, area, volume, moment = measure_instance(vertices, triangles, matrix)
        triangles_total += len(triangles)
        low, high = np.minimum(low, lo), np.maximum(high, hi)
        area_total += area
        if watertight:
            sign = 1.0 if volume >= 0 else -1.0  # Inward normals or a mirroring transform: the same solid.
            volume_total += sign * volume
            moment_total += sign * moment
            closed_count += 1
            solids.append((lo, hi))
        elif len(open_names) < MAX_OPEN_NAMED:
            open_names.append(name)
        if len(listed) < listed_max:
            listed.append({"name": str(name)[:128], "type": kind, "triangles": len(triangles), "closed": bool(watertight),
                           "extent_mm": [*rounded(lo), *rounded(hi)], "surface_area_mm2": rounded(area),
                           **({"volume_mm3": rounded(abs(volume))} if watertight else {})})
    count = len(placed)
    if not count:
        raise NoGeometry("The scene has no renderable geometry.")
    if open_names:
        more = ", …" if count - closed_count > len(open_names) else ""
        warnings.append("Open (not watertight) meshes have no volume, so volume_mm3 and center_of_mass_mm count only the "
                        f"closed ones: {', '.join(open_names)}{more}.")
    if overlapping(solids):
        warnings.append("volume_mm3 adds up each closed object's volume, and some of their extents overlap: where the "
                        "objects themselves overlap, that volume counts more than once.")
    solid = closed_count > 0 and volume_total > 0
    return {
        "units": "mm",
        "objects": count,
        "closed_objects": closed_count,
        "triangles": triangles_total,
        "bounds_mm": rounded(high - low),
        "extent_mm": [*rounded(low), *rounded(high)],
        "surface_area_mm2": rounded(area_total),
        "volume_mm3": rounded(volume_total) if solid else None,
        "center_of_mass_mm": rounded(moment_total / volume_total) if solid else None,
        "scene_objects": listed,
        **({"scene_objects_more": count - len(listed)} if count > len(listed) else {}),
        **({"warnings": warnings} if warnings else {}),
    }, (low.tolist(), high.tolist())
