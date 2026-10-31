"""Runtime witnesses for the recognized feature plan, inside the CAD sandbox only."""
import inspect
import math

from .model import FeatureError, TOLERANCE

plan = None
events = []
objects = {}
final_shape = None
final_result = None


def reset(value):
    global plan, events, objects, final_shape, final_result
    plan, events, objects, final_shape = value, [], {}, None
    final_result = None


def take_result(result):
    import cadquery as cq
    global final_shape, final_result
    final_result = result
    final_shape = result.findSolid() if isinstance(result, cq.Workplane) else result


def valid(shape):
    """The shape's validity, judged on a copy without its triangulation. GLB export meshes the shape, and the kernel's
    check also inspects that mesh: on a part with about a thousand faces it took 105 s meshed against 2 s bare."""
    import cadquery as cq
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    return cq.Shape.cast(BRepBuilderAPI_Copy(shape.wrapped, True, False).Shape()).isValid()


def metrics(shape):
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    bounds = Bnd_Box()
    # GLB export adds triangulations; measurements must use the CAD surfaces.
    BRepBndLib.AddOptimal_s(shape.wrapped, bounds, False, False)
    low, high = bounds.CornerMin(), bounds.CornerMax()
    (xmin, ymin, zmin), (xmax, ymax, zmax) = low.Coord(), high.Coord()
    return {"bounds_mm": [xmax - xmin, ymax - ymin, zmax - zmin],
            "min_mm": [xmin, ymin, zmin],
            "volume_mm3": shape.Volume(), "solids": len(shape.Solids()),
            "faces": len(shape.Faces()), "valid": valid(shape)}


def close(actual, expected):
    return math.isclose(actual, expected, rel_tol=1e-8, abs_tol=TOLERANCE)


def capture(feature_id, function, *args, **kwargs):
    index = len(events)
    expected = plan.calls[index]
    feature = plan.features[index]
    if expected["id"] != feature_id:
        raise FeatureError("trace_mismatch", "Executed feature order differs from the analyzed plan.")
    parents = feature["depends_on"]
    if parents and getattr(function, "__self__", None) is not objects[parents[0]]:
        raise FeatureError("trace_mismatch", "A feature's executed input differs from its recorded dependency.")
    bound = inspect.signature(function).bind(*args, **kwargs)
    bound.apply_defaults()
    result = function(*args, **kwargs)
    observed = {}
    parameter_names = {"width": "xLen", "height": "yLen", "thickness": "until", "diameter": "diameter"}
    for name, parameter in feature["parameters"].items():
        value = bound.arguments[parameter_names[name]]
        if not close(value, parameter["value"]):
            raise FeatureError("trace_mismatch", "An executed dimension differs from its source binding.")
        observed[name] = value
    witness = {"selected_objects": len(result.vals()), "parameter_values": observed}
    if feature["operation"] == "face":
        faces = result.vals()
        if len(faces) != 1 or not close(faces[0].normalAt().z, 1) or not close(faces[0].Center().z, plan.thickness):
            raise FeatureError("unresolved_reference", "The top-face reference did not resolve to the expected single planar face.")
        witness["resolved_reference"] = {"count": 1, "normal": [0, 0, 1], "z_mm": faces[0].Center().z}
    if feature["operation"] in {"extrusion", "holes"}:
        shape = result.findSolid()
        measurement = metrics(shape)
        volume = plan.width * plan.height * plan.thickness
        if feature["operation"] == "holes":
            volume -= len(plan.points) * math.pi * (plan.diameter / 2) ** 2 * plan.thickness
        if not measurement["valid"] or measurement["solids"] != 1 or not close(measurement["volume_mm3"], volume):
            raise FeatureError("geometry_mismatch", "The generated solid does not match the supported feature dimensions.")
        if not all(close(a, b) for a, b in zip(measurement["bounds_mm"], [plan.width, plan.height, plan.thickness])):
            raise FeatureError("geometry_mismatch", "Unexpected generated bounds.")
        expected_faces = 6 + (len(plan.points) if feature["operation"] == "holes" else 0)
        if measurement["faces"] != expected_faces:
            raise FeatureError("topology_change", "Generated face count differs from the supported plate topology.")
        if feature["operation"] == "holes":
            from OCP.BRepAdaptor import BRepAdaptor_Surface
            cylinders = [face for face in shape.Faces() if face.geomType() == "CYLINDER"]
            if len(cylinders) != len(plan.points):
                raise FeatureError("geometry_mismatch", "The generated solid is missing an expected circular hole.")
            remaining = list(plan.points)
            holes = []
            for face in cylinders:
                cylinder = BRepAdaptor_Surface(face.wrapped).Cylinder()
                center, direction = cylinder.Axis().Location(), cylinder.Axis().Direction()
                match = next((point for point in remaining if close(point[0], center.X()) and close(point[1], center.Y())), None)
                dimensions = metrics(face)
                if match is None or not close(cylinder.Radius(), plan.diameter / 2) or not close(abs(direction.Z()), 1) or not close(dimensions["min_mm"][2], 0) or not close(dimensions["bounds_mm"][2], plan.thickness):
                    raise FeatureError("geometry_mismatch", "A generated hole differs from its recorded center, diameter, axis, or through-depth.")
                remaining.remove(match)
                holes.append({"center_xy_mm": match, "diameter_mm": 2 * cylinder.Radius(), "depth_mm": dimensions["bounds_mm"][2]})
            witness["holes"] = sorted(holes, key=lambda hole: hole["center_xy_mm"])
        witness["geometry"] = measurement
    events.append({"feature_id": feature_id, **witness})
    objects[feature_id] = result
    return result


# Above this many faces, the two replays are compared face by face instead of with solid differences: a boolean
# between two coincident solids is OCCT's worst case (every face overlaps one of the other), and on parts with a few
# hundred faces it takes minutes and gigabytes, enough to crash the build (signal 11) at the job's memory limit.
DIFFERENCE_FACES = 200


def face_signatures(shape):
    """(surface type, area, centroid) of every face, in a stable order."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    signatures = []
    for face in shape.Faces():
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face.wrapped, props)
        centre = props.CentreOfMass()
        signatures.append((face.geomType(), props.Mass(), centre.X(), centre.Y(), centre.Z()))
    return sorted(signatures, key=lambda s: (s[0], *(round(v, 4) for v in s[2:]), round(s[1], 4)))


def solid_differences(original, instrumented):
    """[original - instrumented, instrumented - original] volumes, or None when the kernel can't form either one."""
    volumes = []
    for a, b in ((original, instrumented), (instrumented, original)):
        try:
            cut = a.cut(b)
            if cut.wrapped is None or cut.wrapped.IsNull():
                return None
            volumes.append(cut.Volume())
        except Exception:
            return None
    return volumes


def compare(original, instrumented):
    before, after = metrics(original), metrics(instrumented)
    if not before["valid"] or not after["valid"] or before["solids"] != after["solids"] or before["faces"] != after["faces"]:
        raise FeatureError("geometry_mismatch", "Instrumentation changed geometry validity or topology counts.")
    for key in ("bounds_mm", "min_mm"):
        if not all(close(a, b) for a, b in zip(before[key], after[key])):
            raise FeatureError("geometry_mismatch", "Instrumentation changed geometry bounds or placement.")
    tolerance = max(TOLERANCE, before["volume_mm3"] * 1e-8)
    if not close(before["volume_mm3"], after["volume_mm3"]):
        raise FeatureError("geometry_mismatch", "Instrumentation changed the solid's occupied volume.")
    common = {"passed": True, "volume_tolerance_mm3": tolerance, "linear_absolute_tolerance_mm": TOLERANCE,
              "relative_tolerance": 1e-8, "original": before, "instrumented": after}
    if before["faces"] > DIFFERENCE_FACES:
        for a, b in zip(face_signatures(original), face_signatures(instrumented)):
            if a[0] != b[0] or not all(math.isclose(x, y, rel_tol=1e-8, abs_tol=TOLERANCE) for x, y in zip(a[1:], b[1:])):
                raise FeatureError("geometry_mismatch", "Instrumentation changed a face's type, area, or position.")
        return {**common, "method": f"validity, solid/face counts, bounds, placement, volume, and each face's type, area and "
                                    f"centroid (solid differences are skipped above {DIFFERENCE_FACES} faces)"}
    difference = solid_differences(original, instrumented)
    if difference is None:
        # The kernel could not form the differences (a null or invalid boolean result, seen after a smooth loft and a
        # failed shell): the other checks still ran, so skip this one rather than crash the person's build.
        return {**common, "method": "validity, solid/face counts, bounds, placement and volume (the kernel could not form "
                                    "solid differences, so they were skipped)"}
    if max(abs(v) for v in difference) > tolerance:
        raise FeatureError("geometry_mismatch", "Instrumentation changed the solid's occupied volume.")
    return {**common, "method": "validity, solid/face counts, bounds, placement, volume, and bidirectional solid differences",
            "difference_volume_mm3": difference}
