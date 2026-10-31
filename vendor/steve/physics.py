"""What the simulation model export (Motion tab → Export → Simulation model, web/src/motion/simulationModel.ts) needs
beyond the geometry and joints, declared in main.py (docs/MOTION.md):

- mass overrides: `design.fill` (printed infill scales a body's mass), `design.mass` (a datasheet mass for an
  envelope model), `design.measured_mass` (a weighed set of instances) and `design.lumped_mass` (a box or point mass
  for what isn't modelled: batteries, cable bundles, ballast);
- sites: named frames (`design.site`) on an instance, from a planar face (origin at its centre, Z its normal) or a point;
- contact filtering: `design.collision_filter` (contype/conaffinity bits, group, condim, friction per instance's
  collision geoms), `design.contact_pair` (explicit pairs) and `design.contact_exclude` (pairs of links that never
  collide).

The build only checks and resolves them to the design frame as modelled (every joint at 0, mm); the export applies them.
"""
from __future__ import annotations

import fnmatch
import math

import cadquery as cq

from .model import ID, FeatureError

CONDIMS = (1, 3, 4, 6)
BITS = 2 ** 31 - 1  # MuJoCo's contype/conaffinity are 32-bit ints


def _number(value) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def _names(value, label: str, example: str) -> list[str]:
    names = [value] if isinstance(value, str) else list(value) if isinstance(value, (list, tuple)) else None
    if not names or not all(isinstance(n, str) and n for n in names):
        raise FeatureError(f"{label}: name the instances (or patterns like \"servo_*\"), e.g. {example}.")
    return names


def _grams(value, label: str) -> float:
    if not _number(value) or value <= 0:
        raise FeatureError(f"{label}: grams must be a positive number, not {value!r}.")
    return float(value)


def _point3(value, label: str, what: str, nonzero: bool = False) -> list[float]:
    if not (isinstance(value, (list, tuple)) and len(value) == 3 and all(_number(v) for v in value)) or (nonzero and math.hypot(*value) < 1e-9):
        raise FeatureError(f"{label}: {what} must be {'a nonzero direction' if nonzero else 'a point'} (x, y, z), not {value!r}.")
    return [float(v) for v in value]


def _friction(value, label: str) -> list[float] | None:
    """Sliding, torsional and rolling friction (MuJoCo's geom friction); one number is the sliding friction."""
    if value is None:
        return None
    values = [value] if _number(value) else list(value) if isinstance(value, (list, tuple)) else None
    if not values or len(values) > 3 or not all(_number(v) and v >= 0 for v in values) or values[0] <= 0:
        raise FeatureError(f"{label}: friction is the sliding friction (e.g. 0.8), or (sliding, torsional, rolling), all zero or more.")
    return [float(v) for v in values]


def _condim(value, label: str) -> int | None:
    if value is not None and value not in CONDIMS:
        raise FeatureError(f"{label}: condim must be 1 (frictionless), 3 (sliding friction), 4 (and torsional) or 6 (and rolling), not {value!r}.")
    return value


def mass_override(kind: str, instances, grams=None, fraction=None, center=None) -> dict:
    """One `design.fill`, `design.mass` or `design.measured_mass`."""
    label = {"fill": "Fill", "mass": "Mass", "measured": "Measured mass"}[kind]
    names = _names(instances, label, {"fill": "design.fill(\"printed_*\", fraction=0.4)", "mass": "design.mass(\"servo_*\", grams=55)",
                                      "measured": "design.measured_mass([\"head_frame\", \"jaw\"], grams=500)"}[kind])
    entry = {"kind": kind, "instances": names}
    if kind == "fill":
        if not _number(fraction) or not 0 < fraction <= 1:
            raise FeatureError(f"{label} of {names!r}: fraction is the share of solid material, more than 0 and at most 1 (0.4 for 40 % infill).")
        entry["fraction"] = float(fraction)
    else:
        entry["grams"] = _grams(grams, f"{label} of {names!r}")
    if center is not None:
        entry["center"] = _point3(center, f"{label} of {names!r}", "center")
    return entry


def lumped_mass(name, on, grams, at, box) -> dict:
    """One `design.lumped_mass`."""
    from .cables import _point
    if not isinstance(name, str) or not ID.fullmatch(name):
        raise FeatureError(f"Lumped mass name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
    label = f"Lumped mass {name!r}"
    if not isinstance(on, str) or not on:
        raise FeatureError(f"{label}: on names the instance it's fastened to, e.g. design.lumped_mass(\"battery\", \"base\", grams=133, at=(0, 0, 40)).")
    if box is not None and not (isinstance(box, (list, tuple)) and len(box) == 3 and all(_number(v) and v > 0 for v in box)):
        raise FeatureError(f"{label}: box is its size (x, y, z), three positive lengths in mm, or None for a point mass.")
    return {"name": name, "grams": _grams(grams, label), "point": _point((on, at), label, "place"),
            "box": [float(v) for v in box] if box is not None else None}


def site(name, at, x_dir) -> dict:
    """One `design.site`."""
    from .cables import _point
    if not isinstance(name, str) or not ID.fullmatch(name):
        raise FeatureError(f"Site name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
    label = f"Site {name!r}"
    point = _point(at, label, "place")
    if point["instance"] is None and not hasattr(point["at"], "_steve_ref"):
        raise FeatureError(f"{label}: a site belongs to an instance: write (instance, (x, y, z)) or (instance, part.face(\"…\")).")
    return {"name": name, "point": point, "x_dir": _point3(x_dir, label, "x_dir", nonzero=True) if x_dir is not None else None}


def collision_filter(instances, contype, conaffinity, group, condim, friction) -> dict:
    """One `design.collision_filter`."""
    names = _names(instances, "Collision filter", "design.collision_filter(\"sole_*\", contype=1, conaffinity=1)")
    label = f"Collision filter of {names!r}"
    for key, value in (("contype", contype), ("conaffinity", conaffinity)):
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= BITS:
            raise FeatureError(f"{label}: {key} is a bit mask, a whole number from 0 to {BITS} (e.g. 1 | 4), not {value!r}.")
    if group is not None and (isinstance(group, bool) or group not in range(6)):
        raise FeatureError(f"{label}: group must be a whole number from 0 to 5, not {group!r}.")
    entry = {"instances": names, "contype": contype, "conaffinity": conaffinity}
    if group is not None:
        entry["group"] = group
    if (dim := _condim(condim, label)) is not None:
        entry["condim"] = dim
    if (slide := _friction(friction, label)) is not None:
        entry["friction"] = slide
    return entry


def contact_rule(kind: str, a, b, condim=None, friction=None) -> dict:
    """One `design.contact_pair` or `design.contact_exclude`."""
    label = f"Contact {'pair' if kind == 'pair' else 'exclude'} {a!r}/{b!r}"
    if not all(isinstance(n, str) and n for n in (a, b)) or a == b:
        raise FeatureError(f"{label}: name two different instances, e.g. design.contact_{kind}(\"arm_left\", \"base_shell\").")
    entry = {"a": a, "b": b}
    if (dim := _condim(condim, label)) is not None:
        entry["condim"] = dim
    if (slide := _friction(friction, label)) is not None:
        entry["friction"] = slide
    return entry


def resolve(design) -> dict:
    """Every declaration checked against the design's instances, places and frames in the design frame (mm) as
    modelled: `kinematics.simulation`. Problems go to the design's errors; what they name is left out."""
    from .design import _move
    by_name = {i["name"]: i for i in design.instances}
    everyone = list(by_name)

    def matching(patterns: list[str], label: str) -> list[str]:
        found = []
        for pattern in patterns:
            hits = [n for n in everyone if fnmatch.fnmatchcase(n, pattern)]
            if not hits:
                raise FeatureError(f"{label}: {pattern!r} matches no instance of this design (instances: {', '.join(everyone)}).")
            found += [n for n in hits if n not in found]
        return found

    def known(name: str, label: str) -> str:
        if name not in by_name:
            raise FeatureError(f"{label}: {name!r} isn't an instance of this design (instances: {', '.join(everyone)}).")
        return name

    out = {"masses": [], "lumped": [], "sites": [], "filters": [], "pairs": [], "excludes": []}
    for entry in design.mass_overrides:
        label = {"fill": "Fill", "mass": "Mass", "measured": "Measured mass"}[entry["kind"]] + f" of {entry['instances']!r}"
        try:
            names = matching(entry["instances"], label)
            if entry["kind"] == "mass" and "center" in entry:  # The centre is in each instance's own frame.
                for name in names:
                    out["masses"].append({**entry, "instances": [name], "center": _round(_move(by_name[name]["location"], cq.Vector(*entry["center"])))})
            else:
                out["masses"].append({**entry, "instances": names})
        except FeatureError as error:
            design.errors.append(str(error))
    for kind, items in (("lumped", design.lumped_masses), ("sites", design.sites)):
        for item in items:
            label = f"{'Lumped mass' if kind == 'lumped' else 'Site'} {item['name']!r}"
            try:
                instance, origin, axes = _frame(design, label, item["point"], by_name, item.get("x_dir"))
                entry = {"name": item["name"], "instance": instance, "at": _round(origin), "axes": [_round(axis, 9) for axis in axes]}
                if kind == "lumped":
                    entry.update(grams=item["grams"], box=item["box"])
                out[kind].append(entry)
            except FeatureError as error:
                design.errors.append(str(error))
    for item in design.collision_filters:
        try:
            out["filters"].append({**item, "instances": matching(item["instances"], f"Collision filter of {item['instances']!r}")})
        except FeatureError as error:
            design.errors.append(str(error))
    for kind in ("pairs", "excludes"):
        for item in getattr(design, f"contact_{kind}"):
            label = f"Contact {'pair' if kind == 'pairs' else 'exclude'} {item['a']!r}/{item['b']!r}"
            try:
                for name in (item["a"], item["b"]):
                    known(name, label)
                out[kind].append(item)
            except FeatureError as error:
                design.errors.append(str(error))
    return {key: value for key, value in out.items() if value}


def _round(vector: cq.Vector, digits: int = 6) -> list[float]:
    return [round(v, digits) + 0.0 for v in vector.toTuple()]


def _frame(design, label: str, point: dict, by_name: dict, x_dir) -> tuple[str, cq.Vector, list[cq.Vector]]:
    """A frame on an instance, as modelled: a planar face's centre with Z its outward normal and X along `x_dir` (in
    the instance's frame) or the face's first straight edge; a point (or another reference's centre) with the
    instance's own axes, X along `x_dir` when given."""
    from .cables import _place as place_point
    from .design import Ref, _move, _turn
    instance, origin, normal = place_point(design, label, point, by_name)
    if instance is None:
        raise FeatureError(f"{label}: name the instance it's on, e.g. (\"base\", (0, 0, 40)).")
    location = by_name[instance]["location"]
    if not isinstance(point["at"], Ref):  # A point in the instance's own frame, like design.collision_shape.
        origin = _move(location, origin)
    z = normal if normal is not None else _turn(location, cq.Vector(0, 0, 1))
    x = _turn(location, cq.Vector(*x_dir)) if x_dir is not None else None
    if x is None and normal is not None and isinstance(point["at"], Ref):
        face = point["at"].component.faces(point["at"].ref)[0]
        edge = next((e for e in face.outerWire().Edges() if e.geomType() == "LINE"), None)
        if edge is not None:
            x = _turn(location, edge.endPoint() - edge.startPoint())
    if x is None:
        x = _turn(location, cq.Vector(1, 0, 0))
    x = x - z * x.dot(z)
    if x.Length < 1e-9:
        if x_dir is not None:
            raise FeatureError(f"{label}: x_dir {tuple(x_dir)} is along the frame's Z (the face normal); give a direction across it.")
        x = _turn(location, cq.Vector(0, 1, 0))
        x = x - z * x.dot(z)
    x = x.normalized()
    return instance, origin, [x, z.cross(x).normalized(), z.normalized()]
