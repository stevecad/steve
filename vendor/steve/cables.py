"""Cables and harnesses (`design.cable`, `design.harness`, docs/MOTION.md): a flexible element whose path points are
fastened to instances, so it moves with the mechanism. Each build redraws its centreline, a smooth spline through the
points recomputed at every pose (geometry, no physics), at the code's pose, each named pose, along every drive and
animation and at the poses of every collision study, and checks it:

- clearance and contact: the tube (centreline distance minus the radius) against every part;
- cable to cable: the gap between two tubes (at least the harness spacing within one harness, no overlap otherwise);
- connectors: a housing envelope at an end against every part but the one it mates with;
- bend radius: the smallest radius of curvature along the centreline;
- length: the path at each pose against the cable's length (the path as modelled, every joint at 0, plus `slack_mm`).

Each cable is a bill-of-materials line with its cut length (the longest path checked plus its slack, rounded up).
"""
from __future__ import annotations

import math
import time

import cadquery as cq

from .model import ID, FeatureError

CABLE_BUDGET = 25.0       # s for every cable check of one preview build (a full build's share of its time: design._budget)
CABLES_MAX = 50           # declared cables in one design
POINTS_MAX = 24           # path points of one cable, ends included
POSES_MAX = 2000          # poses the cable checks visit in one build
SAMPLES = 160             # points along a centreline for its length, bend radius and distances
CONTACT_TOLERANCE = 0.01  # mm a tube may touch a part before it's a contact
NEAR = 10.0               # mm beyond its clearance within which a cable's closest part is measured and reported
LISTED = 50               # failing poses a cable lists one by one
CHECKS = ("path", "contact", "clearance", "cable", "connector", "bend", "stretch", "slack")


def declaration(name, diameter, start, end, via, min_bend_radius, clearance, slack_mm, max_slack_mm, connector_start, connector_end,
                conductors, ignore) -> dict:
    """One `design.cable(...)`, checked as far as it can be without geometry."""
    if not isinstance(name, str) or not ID.fullmatch(name):
        raise FeatureError(f"Cable name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
    label = f"Cable {name!r}"
    if not _number(diameter) or diameter <= 0:
        raise FeatureError(f"{label}: diameter is the cable's (or bundle's) outer diameter in mm, more than 0.")
    for key, value in (("min_bend_radius", min_bend_radius), ("max_slack_mm", max_slack_mm)):
        if value is not None and (not _number(value) or value <= 0):
            raise FeatureError(f"{label}: {key} must be a positive number of mm, or None.")
    for key, value in (("clearance", clearance), ("slack_mm", slack_mm)):
        if not _number(value) or value < 0:
            raise FeatureError(f"{label}: {key} must be zero or more mm, not {value!r}.")
    if via is not None and not isinstance(via, (list, tuple)):
        raise FeatureError(f"{label}: via lists the path points between the ends, e.g. via=[(\"link_2\", (12, 4, 30))].")
    points = [_point(start, label, "start"), *[_point(p, label, f"via point {i}") for i, p in enumerate(via or [], start=1)], _point(end, label, "end")]
    if len(points) > POINTS_MAX:
        raise FeatureError(f"{label}: {len(points)} path points; a cable takes at most {POINTS_MAX}, ends included.")
    if conductors is not None and (isinstance(conductors, bool) or not isinstance(conductors, int) or conductors < 1):
        raise FeatureError(f"{label}: conductors must be a whole number of wires (1 or more), or None.")
    names = [ignore] if isinstance(ignore, str) else list(ignore) if isinstance(ignore, (list, tuple)) else [] if ignore is None else None
    if names is None or not all(isinstance(n, str) and n for n in names):
        raise FeatureError(f"{label}: ignore lists instance names the cable may touch (clips, grommets), e.g. ignore=[\"cable_clip\"].")
    return {"name": name, "diameter": float(diameter), "points": points, "min_bend_radius": float(min_bend_radius) if min_bend_radius else None,
            "clearance": float(clearance), "slack": float(slack_mm), "max_slack": float(max_slack_mm) if max_slack_mm else None,
            "connectors": [_connector(connector_start, label, "connector_start"), _connector(connector_end, label, "connector_end")],
            "conductors": conductors, "ignore": names}


def harness(name, cables, spacing) -> dict:
    """One `design.harness(...)`: cables routed together, at least `spacing` mm apart."""
    if not isinstance(name, str) or not ID.fullmatch(name):
        raise FeatureError(f"Harness name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
    label = f"Harness {name!r}"
    names = list(cables) if isinstance(cables, (list, tuple)) else None
    if not names or not all(isinstance(n, str) and n for n in names) or len(set(names)) != len(names):
        raise FeatureError(f"{label}: cables lists cable names once each, e.g. [\"servo_lead\", \"power_pair\"].")
    if not _number(spacing) or spacing < 0:
        raise FeatureError(f"{label}: spacing must be zero or more mm between the cables' surfaces.")
    return {"name": name, "cables": names, "spacing": float(spacing)}


def _point(value, label: str, role: str) -> dict:
    """A path point: (instance, (x, y, z)), (instance, reference), a reference alone, or (x, y, z) fixed in the design."""
    from .design import Ref
    if isinstance(value, Ref):
        return {"instance": None, "at": value, "role": role}
    if isinstance(value, (list, tuple)) and len(value) == 3 and all(_number(v) for v in value):
        return {"instance": None, "at": tuple(float(v) for v in value), "role": role}
    if isinstance(value, (list, tuple)) and len(value) == 2 and isinstance(value[0], str) and value[0]:
        at = value[1]
        if isinstance(at, Ref):
            return {"instance": value[0], "at": at, "role": role}
        if isinstance(at, (list, tuple)) and len(at) == 3 and all(_number(v) for v in at):
            return {"instance": value[0], "at": tuple(float(v) for v in at), "role": role}
    raise FeatureError(f"{label}: the {role} must be (instance, (x, y, z)), (instance, part.face(\"…\")) or a face reference, e.g. "
                       "(\"link_2\", (12, 4, 30)). Points are where they are in the design as modelled (every joint at 0).")


def _connector(value, label: str, role: str) -> dict | None:
    """A connector: a name (listed in the BOM), a housing size (length along the cable, width, height in mm), or both."""
    if value is None:
        return None
    usage = (f"{label}: {role} is a housing size (length along the cable, width, height in mm), a name for the BOM, or "
             "{\"name\": \"Molex 5264 3p\", \"size\": (6.0, 7.9, 4.6)}.")
    if isinstance(value, str):
        name, size = value.strip(), None
    elif isinstance(value, dict):
        if set(value) - {"name", "size"}:
            raise FeatureError(usage)
        name, size = value.get("name"), value.get("size")
        name = name.strip() if isinstance(name, str) else name
    else:
        name, size = None, value
    if name is not None and (not isinstance(name, str) or not name):
        raise FeatureError(usage)
    if size is not None:
        if not (isinstance(size, (list, tuple)) and len(size) == 3 and all(_number(v) and v > 0 for v in size)):
            raise FeatureError(usage)
        size = tuple(float(v) for v in size)
    if name is None and size is None:
        raise FeatureError(usage)
    return {"name": name, "size": size}


# ───────── the checks at the build ─────────


def evaluate(design, joints: list[dict], couplings: list[dict], frames: list[tuple[dict, dict]], budget: float = CABLE_BUDGET) -> dict:
    """Every declared cable redrawn and checked at each of `frames` ((when, joint and coupling values), in order)."""
    from .design import CLASH_TOLERANCE, _animation_frame, _box, _closest, _common, _effective, _instance_motions, _instance_shape, budget_words
    started = time.monotonic()
    by_name = {item["name"]: item for item in design.instances}
    ignored = design._not_hardware()  # Component(..., hardware=False): a fluid volume or envelope, nothing a cable can touch.
    shapes = {name: shape for name, item in by_name.items() if name not in ignored and (shape := _instance_shape(item)) is not None}
    declared = {c["name"] for c in design.cables}
    harness_of: dict[str, dict] = {}
    for group in design.harnesses:
        for name in group["cables"]:
            if name not in declared:
                design.errors.append(f"Harness {group['name']!r}: {name!r} isn't a cable of this design" + (f" (cables: {', '.join(sorted(declared))})." if declared else "."))
            elif name in harness_of:
                design.errors.append(f"Harness {group['name']!r}: cable {name!r} is already in harness {harness_of[name]['name']!r}; a cable is in one harness.")
            else:
                harness_of[name] = group

    cables, results = [], {}
    for cable in design.cables:
        base = {"name": cable["name"], "diameter_mm": cable["diameter"], "clearance_mm": cable["clearance"], "min_bend_radius_mm": cable["min_bend_radius"],
                "slack_mm": cable["slack"], "max_slack_mm": cable["max_slack"], "conductors": cable["conductors"],
                "connectors": {end: c for end, c in zip(("start", "end"), (_jsonable_connector(c) for c in cable["connectors"]))},
                **({"harness": harness_of[cable["name"]]["name"], "spacing_mm": harness_of[cable["name"]]["spacing"]} if cable["name"] in harness_of else {})}
        try:
            resolved = _resolve(design, cable, by_name, shapes)
        except FeatureError as error:
            design.errors.append(str(error))
            results[cable["name"]] = {**base, "status": "fail", "findings": [{"check": "declaration", "status": "fail", "message": str(error)}]}
            continue
        resolved.update(base=base, harness=harness_of.get(cable["name"]), worst={}, failing=[], failing_count=0, studies={}, lengths=[],
                        gap=None, bend=None, poses=0)
        cables.append(resolved)

    notes, checked, kernel = [], 0, set()
    for when, values in frames[:POSES_MAX] if cables else []:
        if time.monotonic() - started > budget:
            notes.append(f"Stopped after {checked} of {min(len(frames), POSES_MAX)} poses ({budget_words(budget)}); the results cover the poses checked.")
            break
        motions = _instance_motions(joints, _effective(joints, couplings, *_animation_frame(joints, values))) if joints else {}
        placed: dict[str, cq.Shape] = {}
        boxes: dict = {}

        def solid(name: str) -> cq.Shape:
            if name not in placed:
                placed[name] = shapes[name].moved(cq.Location(motions[name])) if name in motions else shapes[name]
                boxes[name] = _box(placed[name])
            return placed[name]

        paths, failed = {}, {}
        for cable in cables:
            label = cable["name"]
            failed[label] = set()

            def flag(check: str, key, severity: float, finding: dict, cable=cable) -> None:
                failed[cable["name"]].add(check)
                worst = cable["worst"].get((check, key))
                if worst is None or severity > worst[0]:
                    cable["worst"][(check, key)] = (severity, {"check": check, "status": "fail", **finding, "when": when})

            try:
                path = _path(cable, motions)
            except FeatureError as error:
                flag("path", None, 1.0, {"message": str(error)})
                continue
            except Exception as error:  # noqa: BLE001  A kernel failure on one pose leaves it unchecked there, never the build failed.
                kernel.add(f"{label}: {type(error).__name__}: {error}"[:200])
                continue
            paths[label] = path
            decl, radius = cable["declared"], cable["declared"]["diameter"] / 2
            try:
                length = path["length"]
                cable["lengths"].append((length, when))
                spare = cable["length"] - length
                if spare < -CONTACT_TOLERANCE:
                    flag("stretch", None, -spare, {"measured": round(length, 2), "limit": round(cable["length"], 2),
                                                   "message": f"Needs {length:.1f} mm of cable at this pose, {-spare:.1f} mm more than its "
                                                              f"{cable['length']:.1f} mm (the path as modelled plus slack_mm): it pulls tight."})
                elif decl["max_slack"] is not None and spare > decl["max_slack"] + CONTACT_TOLERANCE:
                    flag("slack", None, spare, {"measured": round(spare, 2), "limit": decl["max_slack"],
                                                "message": f"{spare:.1f} mm of spare cable at this pose, more than max_slack_mm {decl['max_slack']:g}: it may snag."})
                bend, at = path["min_radius"], path["min_radius_at"]
                if cable["bend"] is None or bend < cable["bend"][0]:
                    cable["bend"] = (bend, at, when)
                if decl["min_bend_radius"] is not None and bend < decl["min_bend_radius"] - 1e-6:
                    flag("bend", None, decl["min_bend_radius"] - bend, {"measured": round(bend, 2), "limit": decl["min_bend_radius"], "at_mm": round(at, 1),
                                                                        "point": path["min_radius_point"],
                                                                        "message": f"Bends to a {bend:.1f} mm radius {at:.0f} mm along the cable; "
                                                                                   f"it allows {decl['min_bend_radius']:g} mm."})
                reach = radius + decl["clearance"] + NEAR
                for name in shapes:
                    if name in decl["ignore"]:
                        continue
                    wire = _segment(cable, path, name)
                    if wire is None:
                        continue
                    shape = solid(name)
                    if _box(wire, reach + 1e-6).IsOut(boxes[name]):
                        continue
                    distance, points = _closest(wire, shape)
                    gap = distance - radius
                    at = _along(path, points[0]) if points else None
                    if cable["gap"] is None or gap < cable["gap"][0]:
                        cable["gap"] = (gap, name, at, points[0] if points else None, when)
                    if gap < -CONTACT_TOLERANCE:
                        flag("contact", name, -gap, {"part": name, "measured": round(-gap, 3), "at_mm": at, "point": points[0] if points else None,
                                                     "message": f"Runs {-gap:.2f} mm into {name}" + (f", {at:.0f} mm along the cable." if at is not None else ".")
                                                     + (" Its centreline passes through the part." if distance <= 1e-9 else "")})
                    elif gap < decl["clearance"] - 1e-9:
                        flag("clearance", name, decl["clearance"] - gap, {"part": name, "measured": round(gap, 3), "limit": decl["clearance"], "at_mm": at,
                                                                          "point": points[0] if points else None,
                                                                          "message": f"{max(gap, 0.0):.2f} mm from {name}, needs {decl['clearance']:g} mm"
                                                                                     + (f", {at:.0f} mm along the cable." if at is not None else ".")})
                for end, housing in zip(("start", "end"), cable["housings"]):
                    if housing is None:
                        continue
                    owner, solid0 = housing
                    moved = solid0.moved(cq.Location(motions[owner])) if owner in motions else solid0
                    box = _box(moved)
                    for name in shapes:
                        if name == owner or name in decl["ignore"]:
                            continue
                        solid(name)
                        if box.IsOut(boxes[name]):
                            continue
                        common = _common(moved, placed[name])
                        if common is None:
                            kernel.add(f"{label}: the {end} connector against {name}")
                        elif common[0] > CLASH_TOLERANCE:
                            flag("connector", (end, name), common[0], {"part": name, "end": end, "measured": round(common[0], 3), "point": common[1],
                                                                      "message": f"The {end} connector housing overlaps {name} by {common[0]:.2f} mm³."})
            except Exception as error:  # noqa: BLE001
                kernel.add(f"{label}: {type(error).__name__}: {error}"[:200])

        for i, first in enumerate(cables):
            for second in cables[i + 1:]:
                a, b = paths.get(first["name"]), paths.get(second["name"])
                if a is None or b is None:
                    continue
                together = first["harness"] is not None and first["harness"] is second["harness"]
                required = first["harness"]["spacing"] if together else 0.0
                try:
                    wire_a, wire_b = _segment(first, a, None), _segment(second, b, None)
                    if wire_a is None or wire_b is None:
                        continue
                    radii = (first["declared"]["diameter"] + second["declared"]["diameter"]) / 2
                    if _box(wire_a, radii + required + 1e-6).IsOut(_box(wire_b)):
                        continue
                    distance, points = _closest(wire_a, wire_b)
                except Exception as error:  # noqa: BLE001
                    kernel.add(f"{first['name']} against {second['name']}: {type(error).__name__}"[:200])
                    continue
                gap = distance - radii
                limit = required if together else -CONTACT_TOLERANCE
                if gap < limit - 1e-9:
                    for cable, other, path, point in ((first, second, a, points[0] if points else None), (second, first, b, points[1] if points else None)):
                        at = _along(path, point) if point else None
                        failed[cable["name"]].add("cable")
                        key, severity = ("cable", other["name"]), limit - gap
                        worst = cable["worst"].get(key)
                        if worst is None or severity > worst[0]:
                            message = (f"{max(gap, 0.0):.2f} mm from cable {other['name']} in harness {first['harness']['name']}, needs {required:g} mm."
                                       if together else f"Runs {-gap:.2f} mm into cable {other['name']}.")
                            cable["worst"][key] = (severity, {"check": "cable", "status": "fail", "other": other["name"], "measured": round(gap, 3),
                                                              "limit": required if together else 0.0, "at_mm": at, "points": points, "when": when, "message": message})

        for cable in cables:
            if cable["name"] not in paths and not failed[cable["name"]]:
                continue
            cable["poses"] += 1
            bad = failed[cable["name"]]
            study = when.get("study")
            if study is not None:
                counts = cable["studies"].setdefault(study, [0, 0])
                counts[0] += 1
                counts[1] += bool(bad)
            if bad:
                cable["failing_count"] += 1
                if len(cable["failing"]) < LISTED:
                    cable["failing"].append({"when": when, "checks": sorted(bad, key=CHECKS.index)})
        checked += 1

    if len(frames) > POSES_MAX and cables:
        notes.append(f"Checked the first {POSES_MAX} of {len(frames)} poses.")
    if kernel:
        notes.append("The geometry kernel couldn't check some poses: " + "; ".join(sorted(kernel)[:5]) + ".")

    for cable in cables:
        base, slack = cable["base"], cable["declared"]["slack"]
        findings = [item for _, item in sorted(cable["worst"].values(), key=lambda entry: (CHECKS.index(entry[1]["check"]), -entry[0]))]
        longest = max([cable["zero_length"], *(length for length, _ in cable["lengths"])])
        report = {**base, "status": "fail" if findings else "pass" if cable["poses"] else "unchecked", "poses": cable["poses"],
                  "instances": sorted({name for name, _ in cable["points"] if name}),
                  "points": [{"instance": name, "at": _round(point)} for name, point in cable["points"]],
                  "tangents": {"start": _round(cable["tangents"][0]) if cable["tangents"][0] is not None else None,
                               "end": _round(cable["tangents"][1]) if cable["tangents"][1] is not None else None},
                  "path_length_mm": round(cable["zero_length"], 2), "length_mm": round(cable["length"], 2),
                  "cut_length_mm": math.ceil(longest + slack - 1e-9), "findings": findings}
        if cable["lengths"]:
            shortest = min(cable["lengths"], key=lambda item: item[0])
            longest_at = max(cable["lengths"], key=lambda item: item[0])
            report["lengths"] = {"min_mm": round(shortest[0], 2), "min_when": shortest[1], "max_mm": round(longest_at[0], 2), "max_when": longest_at[1],
                                 "stretch_mm": round(max(longest_at[0] - cable["length"], 0.0), 2), "spare_mm": round(cable["length"] - shortest[0], 2)}
        if cable["bend"] is not None:
            bend, at, when = cable["bend"]
            report["bend"] = {"min_radius_mm": round(bend, 2) if math.isfinite(bend) else None, "at_mm": round(at, 1), "when": when}
        if cable["gap"] is not None:
            gap, part, at, point, when = cable["gap"]
            report["closest"] = {"part": part, "gap_mm": round(gap, 3), "at_mm": at, "point": point, "when": when}
        if cable["studies"]:
            report["studies"] = [{"name": name, "poses": n, "failing": bad, "fraction": round(bad / n, 6) if n else 0.0}
                                 for name, (n, bad) in cable["studies"].items()]
        report["failing_poses"] = cable["failing_count"]
        report["failing"] = cable["failing"]
        results[cable["name"]] = report

    ordered = [results[c["name"]] for c in design.cables if c["name"] in results]
    out = {"version": 1, "pass": all(r["status"] == "pass" for r in ordered), "cables": ordered, "poses": checked,
           "of": min(len(frames), POSES_MAX) if cables else 0,
           **({"harnesses": [{"name": h["name"], "cables": h["cables"], "spacing_mm": h["spacing"]} for h in design.harnesses]} if design.harnesses else {})}
    if notes:
        out["note"] = " ".join(notes)
    return out


def bom_rows(design) -> list[dict]:
    """A bill-of-materials line per cable: its diameter, cut length (when the build measured it) and connectors."""
    measured = {c["name"]: c for c in (design.cable_report or {}).get("cables", [])}
    harness_of = {name: h["name"] for h in design.harnesses for name in h["cables"]}
    rows = []
    for cable in design.cables:
        cut = measured.get(cable["name"], {}).get("cut_length_mm")
        connectors = {end: (c["name"] or "housing") if c else None for end, c in zip(("start", "end"), cable["connectors"])}
        rows.append({"item": cable["name"], "name": f"Cable {cable['name']} Ø{cable['diameter']:g} mm" + (f" × {cut} mm" if cut is not None else ""),
                     "kind": "cable", "link": False, "hardware": True, "quantity": 1, "diameter_mm": cable["diameter"], "cut_length_mm": cut,
                     "connectors": connectors, **({"conductors": cable["conductors"]} if cable["conductors"] else {}),
                     **({"harness": harness_of[cable["name"]]} if cable["name"] in harness_of else {})})
    return rows


def _resolve(design, cable: dict, by_name: dict, shapes: dict) -> dict:
    """The cable's points (instance, design-frame point at every joint 0), end directions, path as modelled and housings."""
    label = f"Cable {cable['name']!r}"
    points, normals = [], []
    for point in cable["points"]:
        name, at, normal = _place(design, label, point, by_name)
        points.append((name, at))
        normals.append(normal)
    for name in cable["ignore"]:
        if name not in by_name:
            raise FeatureError(f"{label}: ignore names {name!r}, which isn't an instance of this design (instances: {', '.join(by_name)}).")
    vectors = [p for _, p in points]
    for (_, a), (_, b), role in zip(points, points[1:], [p["role"] for p in cable["points"][1:]]):
        if (b - a).Length < 1e-6:
            raise FeatureError(f"{label}: the {role} is at the same place as the point before it; give each point its own place.")
    # A planar face sets the direction the cable leaves (or enters) it; otherwise the spline chooses.
    start = normals[0]
    end = normals[-1] * -1.0 if normals[-1] is not None else None
    tangents = (start, end)
    try:
        edge = _spline(vectors, tangents)
    except Exception as error:  # noqa: BLE001
        raise FeatureError(f"{label}: no smooth path through its points ({type(error).__name__}); move points that double back on themselves.") from None
    zero = _sample(edge)
    resolved = {"name": cable["name"], "declared": cable, "points": points, "tangents": tangents, "zero_length": zero["length"],
                "length": zero["length"] + cable["slack"]}
    # Each end's own part: it touches the cable there, so the cable's first diameter (or its housing) isn't checked against it.
    ends = (points[0][0], points[-1][0])
    trims = []
    for connector in cable["connectors"]:
        trims.append(connector["size"][0] if connector and connector["size"] else cable["diameter"])
    housings = []
    for index, (connector, owner) in enumerate(zip(cable["connectors"], ends)):
        if not connector or not connector["size"]:
            housings.append(None)
            continue
        origin = vectors[0] if index == 0 else vectors[-1]
        direction = (zero["start_tangent"] if index == 0 else zero["end_tangent"] * -1.0).normalized()
        housings.append((owner, _housing(origin, direction, connector["size"])))
    resolved.update(ends=ends, trims=trims, housings=housings)
    return resolved


def _place(design, label: str, point: dict, by_name: dict) -> tuple[str | None, cq.Vector, cq.Vector | None]:
    """A path point's instance, its place in the design frame as modelled, and a planar face's outward normal."""
    from .design import Ref, _move, _turn
    at, name, role = point["at"], point["instance"], point["role"]
    if name is not None and name not in by_name:
        raise FeatureError(f"{label}: the {role} is fastened to {name!r}, which isn't an instance of this design (instances: {', '.join(by_name)}).")
    if not isinstance(at, Ref):
        return name, cq.Vector(*at), None
    component = at.component
    if name is None:
        found = [item for item in design.instances if item["component"] is component]
        if len(found) != 1:
            where = "isn't placed in this design" if not found else f"is placed {len(found)} times; write (instance, {at!r})"
            raise FeatureError(f"{label}: the {role} is on {component.id}, which {where}.")
        owner = found[0]
    else:
        owner = by_name[name]
        if owner["component"] is not component:
            raise FeatureError(f"{label}: the {role} {at!r} is on {component.id}, but it's fastened to {name}, which isn't {component.id}; "
                               f"fasten it to an instance of {component.id}.")
    centre, normal = _ref_point(component, at.ref, label, role)
    return owner["name"], _move(owner["location"], centre), _turn(owner["location"], normal) if normal is not None else None


def _ref_point(component, ref: str, label: str, role: str) -> tuple[cq.Vector, cq.Vector | None]:
    """A face's centre (and a planar face's outward normal), an edge's centre (a circle's centre) or a named point."""
    try:
        faces = component.faces(ref)
    except FeatureError:
        faces = []
    if len(faces) > 1:
        raise FeatureError(f"{label}: the {role} {component.id}.face({ref!r}) names {len(faces)} faces; name one face, an edge or a point.")
    if faces:
        face = faces[0]
        centre = face.Center()
        return centre, face.normalAt(centre).normalized() if face.geomType() == "PLANE" else None
    try:
        edges = component.edges(ref)
    except FeatureError:
        edges = []
    if len(edges) == 1:
        edge = edges[0]
        return (edge.arcCenter() if edge.geomType() == "CIRCLE" else edge.Center()), None
    if ref in getattr(component, "points", {}):
        return cq.Vector(component.points[ref]), None
    raise FeatureError(f"{label}: the {role} {component.id}.ref({ref!r}) isn't a face, edge or point of {component.id}; use one face like "
                       f"{component.id}.face(\"extrude_1.end\"), or (instance, (x, y, z)).")


def _spline(points: list[cq.Vector], tangents: tuple) -> cq.Edge:
    """A smooth curve through the points, leaving and entering along the given end directions (or the chord's)."""
    start, end = tangents
    if start is None and end is None:
        return cq.Edge.makeLine(points[0], points[1]) if len(points) == 2 else cq.Edge.makeSpline(points)
    start = start if start is not None else (points[1] - points[0]).normalized()
    end = end if end is not None else (points[-1] - points[-2]).normalized()
    return cq.Edge.makeSpline(points, tangents=[start, end], scale=True)


def _sample(edge: cq.Edge) -> dict:
    """Points along a centreline, their distance along it, its length and its tightest bend (radius, where)."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.gp import gp_Pnt, gp_Vec
    curve = BRepAdaptor_Curve(edge.wrapped)
    first, last = curve.FirstParameter(), curve.LastParameter()
    points, arc, tightest, where, directions = [], [], math.inf, 0, []
    for i in range(SAMPLES + 1):
        p, d1, d2 = gp_Pnt(), gp_Vec(), gp_Vec()
        curve.D2(first + (last - first) * i / SAMPLES, p, d1, d2)
        point = cq.Vector(p.X(), p.Y(), p.Z())
        arc.append(arc[-1] + (point - points[-1]).Length if points else 0.0)
        points.append(point)
        speed = d1.Magnitude()
        curvature = d1.Crossed(d2).Magnitude() / speed ** 3 if speed > 1e-12 else 0.0
        radius = 1.0 / curvature if curvature > 1e-12 else math.inf
        if radius < tightest:
            tightest, where = radius, i
        directions.append(cq.Vector(d1.X(), d1.Y(), d1.Z()))
    return {"points": points, "arc": arc, "length": edge.Length(), "min_radius": tightest, "min_radius_at": arc[where],
            "min_radius_point": _round(points[where]), "start_tangent": directions[0], "end_tangent": directions[-1]}


def _path(cable: dict, motions: dict) -> dict:
    """The cable at a pose: its points moved with their instances, the spline through them, sampled."""
    moved, tangents = [], []
    for name, point in cable["points"]:
        trsf = motions.get(name) if name else None
        moved.append(point if trsf is None else _apply(point, trsf))
    for name, direction in zip(cable["ends"], cable["tangents"]):
        trsf = motions.get(name) if name else None
        tangents.append(None if direction is None else direction if trsf is None else _apply(direction, trsf, direction=True))
    for a, b in zip(moved, moved[1:]):
        if (b - a).Length < 1e-6:
            raise FeatureError("Two of its points meet at this pose, so it has no path; move them apart.")
    try:
        edge = _spline(moved, tuple(tangents))
    except Exception as error:  # noqa: BLE001
        raise FeatureError(f"No smooth path through its points at this pose ({type(error).__name__}).") from None
    path = _sample(edge)
    path["wires"] = {}
    return path


def _segment(cable: dict, path: dict, part: str | None):
    """The centreline as a polyline, less each end's trim (its housing, or one diameter); against an end's own part,
    also less the clearance and another diameter, where the cable leaves the part it's fastened to."""
    extra = cable["declared"]["clearance"] + cable["declared"]["diameter"]
    cuts = tuple(trim + (extra if part is not None and part == end else 0.0) for trim, end in zip(cable["trims"], cable["ends"]))
    if cuts not in path["wires"]:
        arc = path["arc"]
        low, high = cuts[0], arc[-1] - cuts[1]
        chosen = [p for p, s in zip(path["points"], arc) if low <= s <= high]
        path["wires"][cuts] = cq.Wire.makePolygon(chosen) if len(chosen) >= 2 else None
    return path["wires"][cuts]


def _along(path: dict, point) -> float | None:
    """How far along the cable (mm from its start) a point on it is: the nearest sample."""
    if point is None:
        return None
    target = cq.Vector(*point)
    index = min(range(len(path["points"])), key=lambda i: (path["points"][i] - target).Length)
    return round(path["arc"][index], 1)


def _housing(origin: cq.Vector, direction: cq.Vector, size: tuple) -> cq.Shape:
    """A connector housing: a box from the cable's end along the cable, `length` long, `width` across it kept level
    (in the design's XY plane where it can be) and `height` across that."""
    length, width, height = size
    across = direction.cross(cq.Vector(0, 0, 1))
    across = across.normalized() if across.Length > 1e-6 else cq.Vector(1, 0, 0)
    plane = cq.Plane(origin=origin, xDir=across, normal=direction)
    return cq.Workplane(plane).rect(width, height).extrude(length).val()


def _apply(vector: cq.Vector, trsf, direction: bool = False) -> cq.Vector:
    moved = vector.toDir().Transformed(trsf) if direction else vector.toPnt().Transformed(trsf)
    return cq.Vector(moved.X(), moved.Y(), moved.Z())


def _round(vector) -> list[float]:
    values = vector.toTuple() if isinstance(vector, cq.Vector) else vector
    return [round(v, 4) + 0.0 for v in values]


def _jsonable_connector(connector: dict | None) -> dict | None:
    return None if connector is None else {"name": connector["name"], "size": list(connector["size"]) if connector["size"] else None}


def _number(value) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
