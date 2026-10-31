"""Declared fasteners (`design.fasten`, docs/FASTENERS.md): a screw joint named once (the screw, its axis, the parts it
clamps and what it threads into), then checked at every build against the geometry as built, never the declaration:
hole sizes, the head's seat, thread engagement, bottoming, breakthrough, the wall around each hole, the screw against
other parts and other screws, and (with `design.assembly_steps` or `driver=`) whether a driver reaches the head and the
screw can go in. Each declared screw, washer, nut and insert is a bill-of-materials line.

Measuring: lines parallel to the screw axis at a few radii (the thread envelope, the ring the head bears on) and rays
out from the axis at a few depths, cast in each part's own frame so the faces they hit keep their persistent names;
plain solids (head and shank, no thread) for clashes and the tool envelopes. Every rule is a generic default,
overridable per design (`design.fastener_rules`) or per fastener (`rules=`): review evidence, not certification.
"""
from __future__ import annotations

import fnmatch
import math
import re
import time

import cadquery as cq

from .model import ID, FeatureError

SOURCE = ("ISO 273 clearance holes; ISO 4762, 7380, 10642, 4017 and 7045 heads; ISO 4032 nuts; ISO 7089 washers; common "
          "heat-set insert bores; generic engagement, pilot, wall and gap rules. Your screw, insert or printer data overrides them.")
NOT_CHECKED = ["preload, torque and joint strength", "thread stripping beyond the engagement rule", "captive nuts in a slot",
               "tilted (ball-end) drivers"]
THREADS = ("tapped", "thread_forming", "insert", "nut")
FITS = ("close", "normal", "loose")
FASTENER_BUDGET = 25.0   # s for every fastener check of one preview build (a full build's share of its time: design._budget)
FASTENERS_MAX = 1000     # declared fasteners in one design
GAP = 0.2                # mm between parts that still count as one clamped stack
LENGTHS = (3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 90, 100, 110, 120)

# Metric coarse threads: nominal diameter, pitch, tap drill, ISO 273 clearance holes (fine/close, medium/normal, coarse/loose).
SIZES = {
    "M2": (2.0, 0.4, 1.6, (2.2, 2.4, 2.6)),
    "M2.5": (2.5, 0.45, 2.05, (2.7, 2.9, 3.1)),
    "M3": (3.0, 0.5, 2.5, (3.2, 3.4, 3.6)),
    "M4": (4.0, 0.7, 3.3, (4.3, 4.5, 4.8)),
    "M5": (5.0, 0.8, 4.2, (5.3, 5.5, 5.8)),
    "M6": (6.0, 1.0, 5.0, (6.4, 6.6, 7.0)),
    "M8": (8.0, 1.25, 6.8, (8.4, 9.0, 10.0)),
    "M10": (10.0, 1.5, 8.5, (10.5, 11.0, 12.0)),
    "M12": (12.0, 1.75, 10.2, (13.0, 13.5, 14.5)),
}
# Heads per size: (head diameter, or across flats for a hex head; head height; hex key across flats, or the cross-recess size).
HEADS = {
    "ISO 4762": {"label": "Socket head cap screw", "head": "socket", "sizes": {
        "M2": (3.8, 2.0, 1.5), "M2.5": (4.5, 2.5, 2.0), "M3": (5.5, 3.0, 2.5), "M4": (7.0, 4.0, 3.0), "M5": (8.5, 5.0, 4.0),
        "M6": (10.0, 6.0, 5.0), "M8": (13.0, 8.0, 6.0), "M10": (16.0, 10.0, 8.0), "M12": (18.0, 12.0, 10.0)}},
    "ISO 7380": {"label": "Button head screw", "head": "button", "sizes": {
        "M3": (5.7, 1.65, 2.0), "M4": (7.6, 2.2, 2.5), "M5": (9.5, 2.75, 3.0), "M6": (10.5, 3.3, 4.0), "M8": (14.0, 4.4, 5.0),
        "M10": (17.5, 5.5, 6.0), "M12": (21.0, 6.6, 8.0)}},
    "ISO 10642": {"label": "Countersunk socket screw", "head": "countersunk", "sizes": {
        "M3": (6.72, 1.86, 2.0), "M4": (8.96, 2.48, 2.5), "M5": (11.2, 3.1, 3.0), "M6": (13.44, 3.72, 4.0), "M8": (17.92, 4.96, 5.0),
        "M10": (22.4, 6.2, 6.0), "M12": (26.88, 7.44, 8.0)}},
    "ISO 4017": {"label": "Hex head screw", "head": "hex", "sizes": {
        "M3": (5.5, 2.0, 5.5), "M4": (7.0, 2.8, 7.0), "M5": (8.0, 3.5, 8.0), "M6": (10.0, 4.0, 10.0), "M8": (13.0, 5.3, 13.0),
        "M10": (16.0, 6.4, 16.0), "M12": (18.0, 7.5, 18.0)}},
    "ISO 7045": {"label": "Pan head screw", "head": "pan", "sizes": {
        "M2": (4.0, 1.6, 1), "M2.5": (5.0, 2.0, 1), "M3": (5.6, 2.4, 1), "M4": (8.0, 3.1, 2), "M5": (9.5, 3.8, 2), "M6": (12.0, 4.6, 3),
        "M8": (16.0, 6.0, 4)}},
}
STANDARDS = {"DIN 912": "ISO 4762", "DIN 7991": "ISO 10642", "DIN 933": "ISO 4017", "DIN 931": "ISO 4017", "ISO 4014": "ISO 4017",
             "DIN 7985": "ISO 7045"}
NUTS = {"M2": (4.0, 1.6), "M2.5": (5.0, 2.0), "M3": (5.5, 2.4), "M4": (7.0, 3.2), "M5": (8.0, 4.7), "M6": (10.0, 5.2),
        "M8": (13.0, 6.8), "M10": (16.0, 8.4), "M12": (18.0, 10.8)}                       # ISO 4032: across flats, height
WASHERS = {"M2": (2.2, 5.0, 0.3), "M2.5": (2.7, 6.0, 0.5), "M3": (3.2, 7.0, 0.5), "M4": (4.3, 9.0, 0.8), "M5": (5.3, 10.0, 1.0),
           "M6": (6.4, 12.0, 1.6), "M8": (8.4, 16.0, 1.6), "M10": (10.5, 20.0, 2.0), "M12": (13.0, 24.0, 2.5)}  # ISO 7089: d1, d2, h
INSERTS = {"M2": (3.2, 4.0), "M2.5": (3.6, 5.7), "M3": (4.0, 5.7), "M4": (5.6, 8.1), "M5": (6.4, 9.5), "M6": (8.0, 12.7),
           "M8": (9.7, 12.7)}                                                               # heat-set inserts: bore, length
ENGAGEMENT = {"tapped": 1.5, "thread_forming": 2.0}  # × nominal diameter
WALLS = {"fdm": 1.6, "sla": 1.0, "sls": 1.2, "mjf": 1.0}  # mm around a screw hole, by print process
WALL_DEFAULT = 1.0
RULES = {"min_engagement_d": None, "pilot_ratio": (0.8, 0.9), "min_wall_mm": None, "bottom_gap_mm": 0.5, "screw_gap_mm": 0.5,
         "head_proud_mm": 0.0, "hole_tolerance_mm": 0.1}
SCREWDRIVERS = {1: 4.5, 2: 6.0, 3: 8.0, 4: 10.0}  # cross-recess size → shaft diameter (mm)


def screw(spec) -> dict:
    """"ISO 4762 M3x8" → the screw's standard, size, length and the dimensions the checks use."""
    usage = ("A screw is a standard, a metric size and a length, e.g. \"ISO 4762 M3x8\" (standards: "
             + ", ".join([*HEADS, *STANDARDS]) + ").")
    if not isinstance(spec, str):
        raise FeatureError(usage)
    match = re.fullmatch(r"\s*((?:ISO|DIN)\s*\d+)\s+(M\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*", spec, re.IGNORECASE)
    if not match:
        raise FeatureError(f"Screw {spec!r}: {usage}")
    standard = re.sub(r"^(ISO|DIN)\s*", r"\1 ", match.group(1).upper())
    standard = STANDARDS.get(standard, standard)
    size, length = match.group(2).upper(), float(match.group(3))
    if standard not in HEADS:
        raise FeatureError(f"Screw {spec!r}: {match.group(1)} isn't a standard STEVE knows; {usage}")
    head = HEADS[standard]
    if size not in head["sizes"] or size not in SIZES:
        raise FeatureError(f"Screw {spec!r}: {standard} comes in {', '.join(head['sizes'])}.")
    if length <= 0:
        raise FeatureError(f"Screw {spec!r}: the length must be more than 0 mm.")
    d, pitch, tap, clearance = SIZES[size]
    dk, k, key = head["sizes"][size]
    hexagon = head["head"] == "hex"
    return {"spec": f"{standard} {size}x{length:g}", "standard": standard, "label": head["label"], "size": size, "d": d, "pitch": pitch,
            "tap": tap, "clearance": dict(zip(FITS, clearance)), "length": length, "head": head["head"], "k": k, "key": key,
            # A hex head clashes with its corners and bears on its flats.
            "head_r": dk / math.sqrt(3) if hexagon else dk / 2, "bearing_r": dk / 2, "dk": dk}


def rules(values, label: str) -> dict:
    """Checked rule overrides (`design.fastener_rules(...)`, `rules=` on a fastener)."""
    if values is None:
        return {}
    if not isinstance(values, dict):
        raise FeatureError(f"{label}: rules must be a dict like {{\"min_wall_mm\": 2.0}}.")
    unknown = sorted(set(values) - set(RULES))
    if unknown:
        raise FeatureError(f"{label}: unknown rule {', '.join(map(repr, unknown))}; rules are {', '.join(RULES)}.")
    out = {}
    for key, value in values.items():
        if key == "pilot_ratio":
            pair = (value - 0.05, value + 0.05) if _number(value) else tuple(value) if isinstance(value, (list, tuple)) and len(value) == 2 else None
            if not pair or not all(_number(v) and v > 0 for v in pair) or not pair[0] < pair[1]:
                raise FeatureError(f"{label}: pilot_ratio is a fraction of the screw diameter, e.g. 0.85, or a range (0.8, 0.9).")
            out[key] = (float(pair[0]), float(pair[1]))
        elif value is None and key in ("min_engagement_d", "min_wall_mm"):
            out[key] = None
        elif not _number(value) or value < 0 or (key == "min_engagement_d" and value == 0):
            raise FeatureError(f"{label}: {key} must be a positive number, not {value!r}.")
        else:
            out[key] = float(value)
    return out


def tool(name: str, shaft_d, min_free_mm, handle_d, handle_from_mm) -> dict:
    """A driver profile (`design.tool`): a shaft that must be clear for `min_free_mm` above the head, then a handle."""
    label = f"Tool {name!r}"
    if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_.]*", name):
        raise FeatureError(f"{label}: name a tool with lowercase letters, digits, dots and underscores, e.g. \"hex_2.5_long\".")
    for key, value in (("shaft_d", shaft_d), ("min_free_mm", min_free_mm)):
        if not _number(value) or value <= 0:
            raise FeatureError(f"{label}: {key} must be a positive number of mm.")
    if handle_d is not None and (not _number(handle_d) or handle_d <= 0):
        raise FeatureError(f"{label}: handle_d must be a positive number of mm, or None.")
    if handle_from_mm is not None and (not _number(handle_from_mm) or handle_from_mm < 0):
        raise FeatureError(f"{label}: handle_from_mm must be zero or more mm.")
    return {"name": name, "shaft_d": float(shaft_d), "min_free_mm": float(min_free_mm), "handle_d": float(handle_d) if handle_d else None,
            "handle_from_mm": float(handle_from_mm) if handle_from_mm is not None else float(min_free_mm)}


def builtin_tool(name: str) -> dict | None:
    """hex_<s> (an L-key: its short leg needs 20 mm), ph1…ph4 (screwdrivers) and socket_<s> (nut drivers)."""
    if match := re.fullmatch(r"hex_(\d+(?:\.\d+)?)", name):
        size = float(match.group(1))
        return tool(name, size / math.cos(math.pi / 6), 20.0, None, None)
    if match := re.fullmatch(r"ph([1-4])", name):
        return tool(name, SCREWDRIVERS[int(match.group(1))], 45.0, 28.0, None)
    if match := re.fullmatch(r"socket_(\d+(?:\.\d+)?)", name):
        size = float(match.group(1))
        return tool(name, size / math.cos(math.pi / 6) + 3.0, 45.0, 28.0, None)
    return None


def default_tool(screw_: dict) -> str:
    if screw_["head"] == "hex":
        return f"socket_{screw_['key']:g}"
    if screw_["head"] == "pan":
        return f"ph{screw_['key']}"
    return f"hex_{screw_['key']:g}"


def declaration(name, screw_spec, axis, head_on, clamps, into, thread, washer, fit, through, step, driver, instance, insert, overrides) -> dict:
    """One `design.fasten(...)`, checked as far as it can be without geometry."""
    from .design import Ref
    if not isinstance(name, str) or not ID.fullmatch(name):
        raise FeatureError(f"Fastener name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
    label = f"Fastener {name!r}"
    parsed = screw(screw_spec)
    _axis_value(axis, label)
    if head_on is not None and not isinstance(head_on, Ref):
        raise FeatureError(f"{label}: head_on is the planar face the head rests on, e.g. head_on=bracket.face(\"extrude_1.end\").")
    if head_on is None and not (isinstance(axis, (list, tuple)) and len(axis) == 2):
        raise FeatureError(f"{label}: give head_on, the face the head rests on (it sets which way the screw goes in), e.g. "
                           "head_on=bracket.face(\"extrude_1.end\"); or an axis ((x, y, z), (dx, dy, dz)) from the seat toward the tip.")
    names = [clamps] if isinstance(clamps, str) else list(clamps) if isinstance(clamps, (list, tuple)) else None
    if not names or not all(isinstance(n, str) and n for n in names) or len(set(names)) != len(names):
        raise FeatureError(f"{label}: clamps lists the instances the screw passes through, head side first, e.g. clamps=[\"hip_bracket\"].")
    if thread not in THREADS:
        raise FeatureError(f"{label}: thread must be one of {', '.join(map(repr, THREADS))}, not {thread!r}.")
    if thread == "nut":
        if into is not None:
            raise FeatureError(f"{label}: a nut sits on the far side of the clamped parts; leave into out (captive nuts come later).")
    elif not isinstance(into, str) or not into:
        raise FeatureError(f"{label}: into names the instance the screw threads into ({thread}), e.g. into=\"servo_horn\".")
    if into in names:
        raise FeatureError(f"{label}: {into!r} is both clamped and threaded into; list it once.")
    if washer not in (None, False, True, "ISO 7089", "DIN 125"):
        raise FeatureError(f"{label}: washer=True (or \"ISO 7089\") puts a plain washer under the head.")
    if washer and parsed["head"] == "countersunk":
        raise FeatureError(f"{label}: a countersunk head takes no washer.")
    if washer and parsed["size"] not in WASHERS:
        raise FeatureError(f"{label}: STEVE has no washer for {parsed['size']}.")
    if thread == "nut" and parsed["size"] not in NUTS:
        raise FeatureError(f"{label}: STEVE has no nut for {parsed['size']}.")
    if fit not in FITS:
        raise FeatureError(f"{label}: fit must be \"close\", \"normal\" or \"loose\" (ISO 273 clearance holes), not {fit!r}.")
    if insert is not None:
        if thread != "insert":
            raise FeatureError(f"{label}: insert= sizes a heat-set insert; it needs thread=\"insert\".")
        if not (isinstance(insert, (list, tuple)) and len(insert) == 2 and all(_number(v) and v > 0 for v in insert)):
            raise FeatureError(f"{label}: insert=(bore_mm, length_mm), from the insert's datasheet, e.g. insert=(4.0, 5.7).")
        insert = (float(insert[0]), float(insert[1]))
    elif thread == "insert":
        if parsed["size"] not in INSERTS:
            raise FeatureError(f"{label}: STEVE has no standard insert for {parsed['size']}; give insert=(bore_mm, length_mm).")
        insert = INSERTS[parsed["size"]]
    for option, value in (("step", step), ("instance", instance)):
        if value is not None and (not isinstance(value, str) or not value):
            raise FeatureError(f"{label}: {option} must be a name, not {value!r}.")
    if driver is not None and (not isinstance(driver, str) or not driver):
        raise FeatureError(f"{label}: driver names a tool: \"hex_2.5\", \"ph2\", \"socket_7\", or one from design.tool(...).")
    return {"name": name, "screw": parsed, "axis": axis, "head_on": head_on, "clamps": names, "into": into, "thread": thread,
            "washer": bool(washer), "fit": fit, "through": bool(through), "step": step, "driver": driver, "instance": instance,
            "insert": insert, "rules": rules(overrides, label)}


def steps(value) -> list[tuple[str, list[str]]]:
    """`design.assembly_steps`: [(name, [instance names or patterns])], in the order they're installed."""
    usage = ("Assembly steps list what is installed, in order: a list of steps, each an instance name, a list of them, or a "
             "(name, [instances]) pair; or a dict {step name: [instances]}. Patterns like \"screw_*\" work.")
    items = list(value.items()) if isinstance(value, dict) else list(value) if isinstance(value, (list, tuple)) else None
    if not items:
        raise FeatureError(usage)
    out = []
    for index, item in enumerate(items, start=1):
        if isinstance(item, tuple) and len(item) == 2 and isinstance(item[0], str) and isinstance(item[1], (list, tuple, str)):
            name, members = item
        else:
            name, members = f"step_{index}", item
        members = [members] if isinstance(members, str) else list(members) if isinstance(members, (list, tuple)) else None
        if not isinstance(name, str) or not ID.fullmatch(name) or not members or not all(isinstance(m, str) and m for m in members):
            raise FeatureError(f"Assembly step {index}: {usage}")
        if any(name == other for other, _ in out):
            raise FeatureError(f"Assembly step {name!r} is named twice.")
        out.append((name, members))
    return out


def pattern_axes(axes, label: str) -> list:
    """`design.fasten_pattern` axes: a list of axes, or one face reference whose cylinders lie on several axes (a hole
    pattern): one fastener per distinct axis."""
    from .design import Ref
    if isinstance(axes, Ref):
        count = len(_axis_groups(axes.component, axes.ref, label))
        return [{"ref": axes, "group": i} for i in range(count)]
    if isinstance(axes, (list, tuple)) and axes:
        return list(axes)
    raise FeatureError(f"{label}: axes is a list of axes, or one face reference to a pattern's hole walls, "
                       "e.g. bracket.face(\"mount_holes.wall(0)\") per hole, or a name matching them all.")


# ───────── the checks at the build ─────────


def evaluate(design, budget: float = FASTENER_BUDGET) -> dict:
    """Every declared fastener measured on the built geometry, then screw against screw."""
    started = time.monotonic()
    effective = {**RULES, **design.fastener_overrides}
    by_name = {i["name"]: i for i in design.instances}
    parts: dict[str, _Part] = {}

    def part(name: str) -> "_Part":
        if name not in parts:
            parts[name] = _Part(by_name[name])
        return parts[name]

    order = _step_index(design, by_name)
    results, solids, notes = [], {}, []
    for declared in design.fasteners:
        base = {"name": declared["name"], "screw": declared["screw"]["spec"], "thread": declared["thread"], "fit": declared["fit"],
                "clamps": declared["clamps"], "into": declared["into"], "washer": declared["washer"]}
        if time.monotonic() - started > budget:
            results.append({**base, "status": "unchecked", "findings": []})
            continue
        try:
            report, shape = _check(design, declared, by_name, part, {**effective, **declared["rules"]}, order)
            results.append({**base, **report})
            if shape is not None:
                solids[declared["name"]] = (shape, {**effective, **declared["rules"]}["screw_gap_mm"])
        except FeatureError as error:
            design.errors.append(str(error))
            results.append({**base, "status": "fail", "findings": [{"code": "declaration", "status": "fail", "message": str(error)}]})
        except Exception as error:  # A kernel failure measuring one fastener leaves it unchecked, never the build failed.
            results.append({**base, "status": "unchecked", "findings": [],
                            "note": f"The geometry kernel couldn't measure it: {type(error).__name__}: {error}"[:300]})
    unchecked = sum(1 for r in results if r["status"] == "unchecked")
    if unchecked and time.monotonic() - started > budget:
        from .design import budget_words
        notes.append(f"Stopped with {unchecked} fastener(s) unchecked ({budget_words(budget)}).")
    _screw_pairs(results, solids, started, budget, notes)
    for result in results:
        if result["status"] != "unchecked" and result["findings"]:
            result["status"] = "fail" if any(f["status"] == "fail" for f in result["findings"]) else "review"
    counts = {status: sum(1 for r in results if r["status"] == status) for status in ("pass", "review", "fail", "unchecked")}
    rank = {"fail": 0, "unchecked": 1, "review": 2, "pass": 3}
    report = {"version": 1, "pass": not counts["fail"] and not counts["unchecked"], "counts": counts,
              "fasteners": sorted(results, key=lambda r: rank[r["status"]]),
              "rules": {k: list(v) if isinstance(v, tuple) else v for k, v in effective.items()},
              **({"steps": [{"name": n, "instances": m} for n, m in design.steps]} if design.steps else {}),
              "source": SOURCE, "not_checked": NOT_CHECKED}
    if notes:
        report["note"] = " ".join(notes)
    return report


def hardware(fasteners: list[dict]) -> list[dict]:
    """Bill-of-materials lines for declared fasteners: screws by standard, size and length; washers, nuts and inserts."""
    rows: dict[tuple, dict] = {}

    def add(key, row, name):
        entry = rows.setdefault(key, {**row, "link": False, "hardware": True, "quantity": 0, "fasteners": []})
        entry["quantity"] += 1
        entry["fasteners"].append(name)

    for f in fasteners:
        s, name = f["screw"], f["name"]
        add(("screw", s["spec"]), {"item": s["spec"], "name": f"{s['label']} {s['size']}×{s['length']:g}", "kind": "screw",
                                   "standard": s["standard"], "size": s["size"], "length_mm": s["length"]}, name)
        if f["washer"]:
            add(("washer", s["size"]), {"item": f"ISO 7089 {s['size']}", "name": f"Washer {s['size']}", "kind": "washer",
                                        "standard": "ISO 7089", "size": s["size"]}, name)
        if f["thread"] == "nut":
            add(("nut", s["size"]), {"item": f"ISO 4032 {s['size']}", "name": f"Hex nut {s['size']}", "kind": "nut",
                                     "standard": "ISO 4032", "size": s["size"]}, name)
        if f["thread"] == "insert":
            bore, length = f["insert"]
            add(("insert", s["size"], length), {"item": f"Heat-set insert {s['size']}x{length:g}", "name": f"Heat-set insert {s['size']}×{length:g}",
                                                "kind": "insert", "size": s["size"], "length_mm": length, "bore_mm": bore}, name)
    return list(rows.values())


class _Part:
    """One instance probed in its own frame, so the faces a probe hits keep their persistent names."""

    def __init__(self, item: dict):
        from .design import Component, _box, _own_shape
        self.name, self.location = item["name"], item["location"]
        self.component = item["component"] if isinstance(item["component"], Component) else None
        self.local = _own_shape(item)
        self.placed = self.local.moved(self.location) if self.local is not None else None
        self.box = _box(self.placed) if self.placed is not None else None
        self.process = (item.get("print") or {}).get("process")
        self.inverse = cq.Location(self.location.wrapped.Inverted())
        self._caster = None

    def _load(self):
        from OCP.BRepClass3d import BRepClass3d_SolidClassifier
        from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
        self._caster = IntCurvesFace_ShapeIntersector()
        self._caster.Load(self.local.wrapped, 1e-6)
        self._classifiers = [BRepClass3d_SolidClassifier(solid.wrapped) for solid in self.local.Solids()]
        self._names = self.component.names.index() if self.component is not None else {}

    def _inside(self, point: cq.Vector) -> bool:
        from OCP.TopAbs import TopAbs_IN
        for classifier in self._classifiers:
            classifier.Perform(point.toPnt(), 1e-6)
            if classifier.State() == TopAbs_IN:
                return True
        return False

    def spans(self, origin: cq.Vector, direction: cq.Vector, low: float, high: float) -> list[list]:
        """Where the line origin + w·direction (design frame, low ≤ w ≤ high) runs through material: [[w0, w1, the face
        where it enters (name or None), the face where it leaves]]."""
        from OCP.gp import gp_Dir, gp_Lin
        from .design import _move, _turn
        if self._caster is None:
            self._load()
        o, d = _move(self.inverse, origin), _turn(self.inverse, direction)
        self._caster.Perform(gp_Lin(o.toPnt(), gp_Dir(d.x, d.y, d.z)), low, high)
        hits = []
        if self._caster.IsDone():
            for i in range(1, self._caster.NbPnt() + 1):
                hits.append((self._caster.WParameter(i), self._names.get(cq.Face(self._caster.Face(i)))))
        hits.sort(key=lambda hit: hit[0])
        cuts = [low, *[w for w, _ in hits if low < w < high], high]

        def face(w):
            return next((name for at, name in hits if abs(at - w) < 1e-6), None)

        out = []
        for a, b in zip(cuts, cuts[1:]):
            if b - a < 1e-7 or not self._inside(o + d * ((a + b) / 2)):
                continue
            if out and abs(out[-1][1] - a) < 1e-6:
                out[-1][1], out[-1][3] = b, face(b)
            else:
                out.append([a, b, face(a), face(b)])
        return out


def _check(design, f: dict, by_name: dict, part, rule: dict, order) -> tuple[dict, cq.Shape | None]:
    from .design import CLASH_TOLERANCE, _box, _common
    label = f"Fastener {f['name']!r}"
    s, thread = f["screw"], f["thread"]
    d, length, k = s["d"], s["length"], s["k"]
    everyone = ", ".join(by_name)
    ignored = design._not_hardware()  # Component(..., hardware=False): nothing a screw holds, passes or meets.
    for role, names in (("clamps", f["clamps"]), ("into", [f["into"]] if f["into"] else []), ("instance", [f["instance"]] if f["instance"] else [])):
        for name in names:
            if name not in by_name:
                raise FeatureError(f"{label}: {role} names {name!r}, not an instance of this design (instances: {everyone}).")
            if name in ignored:
                raise FeatureError(f"{label}: {role} names {name!r}, which isn't hardware (its component has hardware=False): fasten parts only.")
            if role != "instance" and part(name).placed is None:
                raise FeatureError(f"{label}: {name} has no geometry yet.")
    seat, direction = _frame(design, f, by_name, label)
    helper = cq.Vector(1, 0, 0) if abs(direction.x) < 0.9 else cq.Vector(0, 1, 0)
    u = direction.cross(helper).normalized()
    v = direction.cross(u).normalized()
    findings: list[dict] = []

    def finding(code, status, message, part_name=None, measured=None, limit=None, faces=None, points=None):
        item = {"code": code, "status": status, "message": message}
        if part_name:
            item["part"] = part_name
        if measured is not None:
            item["measured"] = round(measured, 3)
        if limit is not None:
            item["limit"] = round(limit, 3) if isinstance(limit, float) else limit
        if measured is not None or limit is not None:
            item["units"] = "mm³" if code.endswith("clash") else "mm"
        named = sorted({face for face in faces or [] if face})
        if named:
            item["faces"] = named[:8]
        if points:
            item["points"] = points
        findings.append(item)

    def radial(theta: float) -> cq.Vector:
        return u * math.cos(theta) + v * math.sin(theta)

    def at(r: float, theta: float, t: float) -> cq.Vector:
        return seat + direction * t + radial(theta) * r

    def along(p: _Part, r: float, theta: float, low: float, high: float) -> list[list]:
        return [[a + low, b + low, entry, leave] for a, b, entry, leave in p.spans(at(r, theta, low), direction, 0.0, high - low)]

    quarter = [i * math.pi / 2 for i in range(4)]
    eighth = [i * math.pi / 4 for i in range(8)]
    countersunk = s["head"] == "countersunk"
    washer = WASHERS[s["size"]] if f["washer"] else None
    washer_h = washer[2] if washer else 0.0
    if countersunk:  # Flush: the head's top is the head_on face, its cone below it; the length includes the head.
        under, head_top, tip, shank_start = 0.0, 0.0, length, k
    else:
        under = -washer_h
        head_top, tip, shank_start = under - k, under + length, under
    bearing = washer[1] / 2 if washer else s["bearing_r"]
    ring = (s["clearance"]["loose"] / 2 + bearing) / 2   # between a loose clearance hole and the edge of the head
    cone = (lambda r: k * (s["head_r"] - r) / (s["head_r"] - d / 2)) if countersunk else (lambda r: 0.0)
    low, high = head_top - 1.0, tip + max(5.0, 2 * d)
    tolerance = rule["hole_tolerance_mm"]
    measured: dict = {}

    def reach(p: _Part) -> float:
        corner = cq.Vector(*p.box.CornerMin().Coord()), cq.Vector(*p.box.CornerMax().Coord())
        return (corner[1] - corner[0]).Length + (seat - (corner[0] + corner[1]) * 0.5).Length + 1.0

    def hole(p: _Part, first: float, last: float, count: int = 3) -> dict:
        """The narrowest diameter, the largest offset from the screw axis and the thinnest wall, from 8 rays at each level."""
        out = {"diameter": None, "offset": 0.0, "wall": math.inf, "solid": None, "faces": set(), "wall_faces": set()}
        if last - first <= 1e-3:
            return out
        delta = min(0.2, (last - first) / 4)
        levels = [first + delta, (first + last) / 2, last - delta][:count]
        far = reach(p)
        for t in levels:
            radii, total = [], cq.Vector(0, 0, 0)
            for theta in eighth:
                spans = p.spans(at(0.0, theta, t), radial(theta), 0.0, far)
                if not spans:  # Nothing on this side: the hole breaks out of the part.
                    out["wall"] = 0.0
                    continue
                r0, r1, entry, leave = spans[0]
                if r0 < 1e-6:
                    out["solid"] = t
                    break
                radii.append(r0)
                total = total + radial(theta) * r0
                out["faces"].add(entry)
                if r1 < far - 1e-6 and r1 - r0 < out["wall"]:
                    out["wall"], out["wall_faces"] = r1 - r0, {leave}
            if out["solid"] is not None:
                break
            if radii:
                diameter = 2 * sum(radii) / len(radii)
                out["diameter"] = diameter if out["diameter"] is None else min(out["diameter"], diameter)
                if len(radii) == len(eighth):
                    out["offset"] = max(out["offset"], 2 * total.Length / len(eighth))
        return out

    def min_wall(p: _Part) -> float:
        return rule["min_wall_mm"] if rule["min_wall_mm"] is not None else WALLS.get(p.process, WALL_DEFAULT)

    def check_wall(p: _Part, measured_hole: dict) -> None:
        limit = min_wall(p)
        wall = measured_hole["wall"]
        if math.isfinite(wall):
            measured.setdefault("wall_mm", {})[p.name] = round(wall, 3)
            if wall < limit - 1e-6:
                where = f"the {p.process.upper()} print" if p.process else "this part"
                finding("wall", "fail", f"The wall around the hole in {p.name} is {wall:.2f} mm; {where} needs at least {limit:g} mm.",
                        p.name, wall, limit, measured_hole["wall_faces"])

    # The clamped stack: material on the ring the head bears on, contiguous from the seat.
    expected = cone(ring)
    starts, ends, spans_of, seat_part = [], [], {}, None
    for theta in quarter:
        tagged = sorted(((a, b, name, entry) for name in f["clamps"] for a, b, entry, _ in along(part(name), ring, theta, low, high)),
                        key=lambda item: item[0])
        cursor = first = None
        for a, b, name, entry in tagged:
            if b <= expected - 0.05:
                continue
            if cursor is None:
                first, cursor = a, b
                seat_part = seat_part or name
            elif a <= cursor + GAP:
                cursor = max(cursor, b)
            else:
                break
            known = spans_of.setdefault(name, [a, b, set()])
            known[0], known[1] = min(known[0], a), max(known[1], b)
            known[2].add(entry)
        starts.append(first)
        ends.append(cursor)
    stack_end = max((e for e in ends if e is not None), default=expected)
    measured["grip_mm"] = round(stack_end, 3)  # From the head_on face to the far side of the clamped parts.
    if washer:
        measured["washer_mm"] = washer_h
    what = "washer" if washer else "head"
    if all(start is None for start in starts):
        finding("head_seat", "fail", f"Nothing of {', '.join(f['clamps'])} is under the {what}: check the axis and head_on.", f["clamps"][0])
    else:
        faces = set().union(*(known[2] for known in spans_of.values())) if spans_of else set()
        deviation = max((start - expected for start in starts if start is not None), key=abs)
        if any(start is None for start in starts):
            finding("head_seat", "fail", f"The {what} is only partly seated on {seat_part}: the hole is too big for it, or it overhangs an edge.",
                    seat_part, faces=faces)
        elif countersunk and deviation > 0.1:
            finding("head_seat", "review", f"The countersink in {seat_part} is too deep: the head sits about {deviation:.2f} mm below flush.",
                    seat_part, deviation, 0.1, faces)
        elif countersunk and deviation < -0.1:
            finding("head_proud", "fail", f"The countersink in {seat_part} is too small: the head stands about {-deviation:.2f} mm proud.",
                    seat_part, -deviation, 0.1, faces)
        elif not countersunk and deviation > 0.05:
            finding("head_seat", "fail", f"The {what} would rest {deviation:.2f} mm above the material under it in {seat_part}: head_on isn't "
                    "the face it bears on (a counterbore floor?), or the hole there is too big.", seat_part, deviation, 0.05, faces)
        elif not countersunk and deviation < -0.05:
            finding("head_seat", "fail", f"There's material {-deviation:.2f} mm above the seat in {seat_part}: head_on is below the surface, "
                    f"so the {what} would be buried in it.", seat_part, -deviation, 0.05, faces)
    for name in f["clamps"]:
        if name not in spans_of:
            finding("not_clamped", "fail", f"{name} isn't in the stack the screw clamps: nothing of it is under the {what}, contiguous "
                    f"from the seat, along the axis.", name)

    # Counterbores: a head in a recess may not stand proud.
    if seat_part and not countersunk:
        tops = []
        for theta in quarter:  # Outside the counterbore's clearance around the head.
            for a, b, _, _ in along(part(seat_part), bearing + max(1.5, 0.25 * d), theta, low - 20.0, 0.0):
                if a < -0.05 and b >= -0.05:
                    tops.append(a)
        if tops:
            proud = max(tops) - head_top
            measured["counterbore_depth_mm"] = round(-max(tops), 3)
            if proud > rule["head_proud_mm"] + 0.01:
                finding("head_proud", "fail", f"The {s['label'].lower()}'s head stands {proud:.2f} mm proud of its counterbore in {seat_part}; "
                        f"deepen it to {k + washer_h:.2f} mm.", seat_part, proud, rule["head_proud_mm"])

    # Through holes in the clamped parts.
    for name in f["clamps"]:
        if name not in spans_of:
            continue
        p = part(name)
        a, b, _ = spans_of[name]
        found = hole(p, max(a, shank_start), min(b, tip))
        if found["solid"] is not None:
            finding("no_hole", "fail", f"There's no hole for the screw in {name}: material on the axis {found['solid']:.2f} mm below the seat.",
                    name, 0.0, s["clearance"][f["fit"]])
            continue
        if found["diameter"] is None:
            continue
        measured.setdefault("hole_mm", {})[name] = round(found["diameter"], 3)
        required, loose = s["clearance"][f["fit"]], s["clearance"]["loose"]
        if found["diameter"] < required - tolerance:
            finding("through_hole", "fail", f"The hole through {name} is {found['diameter']:.2f} mm; an {s['size']} screw needs {required:g} mm "
                    f"({f['fit']} fit, ISO 273).", name, found["diameter"], required, found["faces"])
        elif found["diameter"] > loose + 0.5:
            finding("through_hole", "review", f"The hole through {name} is {found['diameter']:.2f} mm, oversized for {s['size']} (loose fit "
                    f"is {loose:g} mm): less for the head to bear on.", name, found["diameter"], loose, found["faces"])
        room = (found["diameter"] - d) / 2
        if found["offset"] > max(room, 0.0) + 1e-3:
            finding("concentric", "fail", f"The hole in {name} is {found['offset']:.2f} mm off the screw's axis; the screw would rub its wall.",
                    name, found["offset"], round(max(room, 0.0), 3), found["faces"])
        elif found["offset"] > max(0.05, room / 2):
            finding("concentric", "review", f"The hole in {name} is {found['offset']:.2f} mm off the screw's axis.", name, found["offset"],
                    round(room / 2, 3), found["faces"])
        check_wall(p, found)

    # What the screw threads into. A length that fails gives the standard lengths that would do: (shortest, longest).
    mouth = None
    shortest = longest = None
    if thread == "nut":
        across, height = NUTS[s["size"]]
        engaged = max(0.0, min(tip - stack_end, height))
        measured.update(engagement_mm=round(engaged, 3), required_engagement_mm=height)
        if engaged < height - 0.01:
            shortest = stack_end - under + height + s["pitch"]
            finding("engagement", "fail", f"The screw ends {engaged:.2f} mm into the {height:g} mm nut; it should come through it.", None,
                    engaged, height)
    else:
        p = part(f["into"])
        bore, insert_length = f["insert"] if thread == "insert" else (None, None)
        outer = bore / 2 + 0.4 if thread == "insert" else ring
        mouths, ends_into = [], []
        for theta in quarter:
            spans = [span for span in along(p, outer, theta, low, high) if span[1] > max(stack_end, under) - 0.05]
            if spans:
                mouths.append(spans[0][0])
                end = spans[0][1]
                for a, b, _, _ in spans[1:]:
                    if a > end + GAP:
                        break
                    end = max(end, b)
                ends_into.append(end)
        if not mouths:
            finding("into", "fail", f"{f['into']} isn't on the screw's axis below the clamped parts.", f["into"])
        else:
            mouth, end = max(mouths), min(ends_into)
            if mouth - stack_end > GAP:
                finding("gap", "review", f"There's a {mouth - stack_end:.2f} mm gap between the clamped parts and {f['into']} along the screw; "
                        "tightening pulls them together.", f["into"], mouth - stack_end, GAP)
            axis_spans = [span for span in along(p, 0.0, 0.0, low, high) if span[1] > mouth + 0.05]
            floor = axis_spans[0][0] if axis_spans else None
            if floor is not None and floor <= mouth + 0.05:
                finding("no_hole", "fail", f"There's no hole in {f['into']} for the screw to go into.", f["into"], 0.0)
            else:
                # Hole size and wall where the thread is.
                bottom = min(floor if floor is not None else end, end)
                if thread == "insert":
                    depths = []
                    for theta in quarter:
                        inside = [span for span in along(p, (d / 2 + bore / 2) / 2, theta, mouth, high) if span[0] > mouth + 0.05]
                        depths.append(inside[0][0] - mouth if inside else high - mouth)
                    depth = min(depths)
                    measured["insert_bore_depth_mm"] = round(depth, 3)
                    found = hole(p, mouth, mouth + min(depth, insert_length), 2)
                else:
                    found = hole(p, mouth, min(bottom, max(tip, mouth + 0.5)), 2)
                if found["solid"] is not None:
                    finding("no_hole", "fail", f"There's no hole in {f['into']} at {found['solid']:.2f} mm below the seat.", f["into"], 0.0)
                elif found["diameter"] is not None:
                    diameter = found["diameter"]
                    measured.setdefault("hole_mm", {})[f["into"]] = round(diameter, 3)
                    if thread == "tapped" and not s["tap"] - tolerance <= diameter <= d + 0.05:
                        finding("tapped_hole", "fail", f"The tapped hole in {f['into']} is {diameter:.2f} mm; an {s['size']} thread needs a "
                                f"{s['tap']:g} mm tap drill (or the {d:g} mm thread drawn as the hole).", f["into"], diameter, s["tap"], found["faces"])
                    elif thread == "thread_forming":
                        lo, hi = (round(ratio * d, 2) for ratio in rule["pilot_ratio"])
                        if not lo - 1e-6 <= diameter <= hi + 1e-6:
                            finding("pilot", "fail", f"The pilot hole in {f['into']} is {diameter:.2f} mm; a thread-forming {s['size']} screw "
                                    f"needs {lo:g}–{hi:g} mm.", f["into"], diameter, [lo, hi], found["faces"])
                    elif thread == "insert" and abs(diameter - bore) > tolerance:
                        finding("insert_bore", "fail", f"The insert bore in {f['into']} is {diameter:.2f} mm; the {s['size']} insert needs "
                                f"{bore:g} mm.", f["into"], diameter, bore, found["faces"])
                    check_wall(p, found)
                # Engagement.
                if thread == "insert":
                    depth = measured["insert_bore_depth_mm"]
                    if depth < insert_length - 0.01:
                        finding("insert_bore", "fail", f"The insert bore in {f['into']} is {depth:.2f} mm deep; the {insert_length:g} mm "
                                "insert needs at least its length.", f["into"], depth, insert_length)
                    engaged = max(0.0, min(tip, mouth + insert_length) - max(under, mouth))
                    required = insert_length
                else:
                    lengths = [sum(b - a for a, b, _, _ in along(p, 0.52 * d, theta, shank_start, tip)) for theta in quarter]
                    engaged = min(lengths)
                    multiple = rule["min_engagement_d"] or ENGAGEMENT[thread]
                    required = multiple * d
                measured.update(engagement_mm=round(engaged, 3), required_engagement_mm=round(required, 3))
                if engaged < required - 0.01:
                    shortest = mouth - under + required
                    if thread == "insert":
                        message = f"The screw reaches {engaged:.2f} mm into the {insert_length:g} mm insert in {f['into']}; it should go through it."
                    else:
                        message = (f"Thread engagement in {f['into']} is {engaged:.2f} mm; {thread.replace('_', '-')} threads need "
                                   f"{multiple:g}×d = {required:.2f} mm. A longer screw or a deeper hole fixes it.")
                    finding("engagement", "fail", message, f["into"], engaged, required)
                # Bottoming and breakthrough.
                if floor is not None:
                    gap = floor - tip
                    measured["bottom_gap_mm"] = round(gap, 3)
                    if gap < rule["bottom_gap_mm"] - 1e-6:
                        text = (f"The screw would hit the bottom of the hole in {f['into']}: it's {-gap:.2f} mm too long." if gap < 0 else
                                f"The screw tip stops only {gap:.2f} mm short of the bottom of the hole in {f['into']}.")
                        finding("bottoming", "fail", text + f" Keep {rule['bottom_gap_mm']:g} mm.", f["into"], gap, rule["bottom_gap_mm"])
                        longest = floor - rule["bottom_gap_mm"] - under
                elif tip > end + 0.01 and not f["through"]:
                    finding("breakthrough", "fail", f"The tip comes {tip - end:.2f} mm out of the far side of {f['into']}; pass through=True if "
                            "that's intended.", f["into"], tip - end, 0.0)
                    longest = end - under
    if shortest is not None or longest is not None:
        standard = [n for n in LENGTHS if (shortest is None or n >= shortest - 1e-6) and (longest is None or n <= longest + 1e-6)]
        if standard:
            measured["suggested_length_mm"] = standard[0] if shortest is not None else standard[-1]

    # The screw as a solid: against every other part and, for its own parts, its head.
    def cylinder(radius: float, t0: float, t1: float) -> cq.Solid:
        return cq.Solid.makeCylinder(radius, t1 - t0, at(0.0, 0.0, t0), direction)

    def hexagon(across: float, t0: float, height: float) -> cq.Shape:
        plane = cq.Plane(origin=at(0.0, 0.0, t0).toTuple(), xDir=u.toTuple(), normal=direction.toTuple())
        return cq.Workplane(plane).polygon(6, across / math.cos(math.pi / 6)).extrude(height).val()

    if countersunk:
        head = cq.Solid.makeCone(s["head_r"], d / 2, k, at(0.0, 0.0, 0.0), direction)
    elif s["head"] == "hex":
        head = hexagon(s["dk"], head_top, k)
    else:
        head = cylinder(s["head_r"], head_top, under)
    group = [head] + ([cylinder(washer[1] / 2, under, 0.0).cut(cylinder(washer[0] / 2, under, 0.0))] if washer else [])
    shank = cylinder(d / 2, shank_start, tip)
    screw_shape = cq.Compound.makeCompound([*group, shank])
    nut = None
    if thread == "nut":
        across, height = NUTS[s["size"]]
        nut = hexagon(across, stack_end, height).cut(cylinder(d / 2, stack_end, stack_end + height))
    own = {*f["clamps"], *([f["into"]] if f["into"] else [])}
    screws = {g["instance"] for g in design.fasteners if g["instance"]}  # Placed screws: checked screw against screw.
    screw_box = _box(screw_shape)
    for name in by_name:
        if name in screws or name in ignored:
            continue
        p = part(name)
        if p.placed is None:
            continue
        tests = [("head_clash", cq.Compound.makeCompound(group))] if name in own else [("screw_clash", screw_shape)]
        if nut is not None:
            tests.append(("nut_clash", nut))
        for code, shape in tests:
            if (screw_box if code != "nut_clash" else _box(nut)).IsOut(p.box):
                continue
            common = _common(shape, p.placed)
            if common is None:
                finding(code, "review", f"Couldn't measure whether the screw clears {name} (the exact boolean failed).", name)
            elif common[0] > CLASH_TOLERANCE:
                text = {"head_clash": f"The {what} cuts {common[0]:.3f} mm³ into {name}: the "
                                      f"{'countersink' if countersunk else 'counterbore or clearance around it'} is too small.",
                        "screw_clash": f"The screw cuts {common[0]:.3f} mm³ into {name}, which it isn't declared to pass through or thread into.",
                        "nut_clash": f"The nut cuts {common[0]:.3f} mm³ into {name}."}[code]
                finding(code, "fail", text, name, common[0], 0.0, points=[common[1]])

    # Moving parts can't be screwed together.
    joints = (design.kinematics or {}).get("joints") or []
    if joints:
        by_child = {j["child"]: j for j in joints}

        def chain(name):
            out = []
            for _ in range(64):
                joint = by_child.get(name)
                if joint is None:
                    break
                if joint["type"] != "rigid":
                    out.append(joint["name"])
                name = joint["parent"]
            return tuple(out)

        chains = {name: chain(name) for name in own}
        if len(set(chains.values())) > 1:
            moving = sorted({j for c in chains.values() for j in c})
            finding("moving", "fail", f"{' and '.join(sorted(own))} move relative to each other (joints {', '.join(moving)}), but this screw "
                    "holds them together: make the joint rigid, or fasten parts that move as one.")

    # The driver and the screw itself, from outside, past what is already installed.
    if design.steps is not None or f["driver"]:
        tools = design.tools
        name = f["driver"] or default_tool(s)
        profile = tools.get(name) or builtin_tool(name)
        if profile is None:
            raise FeatureError(f"{label}: driver {name!r} isn't a tool: use hex_<size>, ph1…ph4, socket_<size>, or design.tool({name!r}, ...).")
        present = [name for name in _obstacles(f, order, by_name, label) if name not in ignored]
        top = 0.0 if countersunk else head_top
        out = direction * -1.0
        origin = at(0.0, 0.0, top - 0.05)

        def first_contact(radius: float, start: float, span: float):
            """How far out from the head the cylinder first meets an installed part: (mm, part, point), or None."""
            from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
            from OCP.BRepBndLib import BRepBndLib
            from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
            from OCP.Bnd import Bnd_Box
            from OCP.gp import gp_Ax3, gp_Trsf
            from OCP.BRepGProp import BRepGProp
            from OCP.GProp import GProp_GProps
            envelope = cq.Solid.makeCylinder(radius, span, origin + out * start, out)
            box = _box(envelope)
            frame = gp_Trsf()
            frame.SetTransformation(gp_Ax3(origin.toPnt(), out.toDir(), u.toDir()))  # design → along the tool
            best = None
            for other in present:
                p = part(other)
                if p.placed is None or box.IsOut(p.box):
                    continue
                try:
                    maker = BRepAlgoAPI_Common(envelope.wrapped, p.placed.wrapped)
                except Exception:
                    continue
                if not maker.IsDone() or maker.Shape().IsNull():  # OCP doesn't bind HasErrors on BRepAlgoAPI
                    continue
                props = GProp_GProps()
                BRepGProp.VolumeProperties_s(maker.Shape(), props)
                if props.Mass() <= CLASH_TOLERANCE:
                    continue
                local = BRepBuilderAPI_Transform(maker.Shape(), frame, True).Shape()
                bound = Bnd_Box()
                BRepBndLib.AddOptimal_s(local, bound, False, False)
                distance = max(bound.CornerMin().Z(), 0.0)
                if best is None or distance < best[0]:
                    centre = props.CentreOfMass()
                    best = (distance, other, [round(centre.X(), 4), round(centre.Y(), 4), round(centre.Z(), 4)])
            return best

        span = max(profile["min_free_mm"] * 2, 100.0)
        hit = first_contact(profile["shaft_d"] / 2, 0.0, span)
        free = hit[0] if hit else span
        measured.update(driver=name, free_length_mm=round(free, 3), required_free_mm=profile["min_free_mm"])
        if hit and free < profile["min_free_mm"]:
            finding("driver_access", "fail", f"A {name} driver can't reach the head: {hit[1]} is {free:.1f} mm above it; the tool needs "
                    f"{profile['min_free_mm']:g} mm clear.", hit[1], free, profile["min_free_mm"], points=[hit[2]])
        elif profile["handle_d"]:
            handle = first_contact(profile["handle_d"] / 2, profile["handle_from_mm"], 100.0)
            if handle:
                finding("handle_access", "review", f"The {name} handle meets {handle[1]} {handle[0]:.1f} mm above the head; a stubby tool "
                        "may still reach.", handle[1], handle[0], profile["handle_from_mm"], points=[handle[2]])
        entry = first_contact(max(s["head_r"], washer[1] / 2 if washer else 0.0) + 0.05, 0.0, length + (0.0 if countersunk else k))
        if entry and entry[0] < length:
            finding("insertion", "fail", f"The screw can't go in along its axis: {entry[1]} is {entry[0]:.1f} mm above the head, and the "
                    f"screw needs {length:g} mm to come in.", entry[1], entry[0], length, points=[entry[2]])

    holes = _holes(f, s, seat_part, rule, tip, mouth if mouth is not None else stack_end, under)
    report = {"status": "pass", "seat": [round(c, 4) for c in seat.toTuple()], "direction": [round(c, 6) for c in direction.toTuple()],
              "step": _step_of(f, order), "measured": measured, "holes": holes, "findings": findings}
    if report["step"] is None:
        del report["step"]
    return report, cq.Compound.makeCompound([*group, shank] + ([nut] if nut is not None else []))


def _holes(f: dict, s: dict, seat_part, rule: dict, tip: float, mouth: float, under: float) -> list[dict]:
    """The holes this screw wants, as `model.hole(...)` arguments, for each part (write them into its component file)."""
    out = []
    for name in f["clamps"]:
        arguments = {"diameter": s["clearance"][f["fit"]]}
        if name == (seat_part or f["clamps"][0]):
            if s["head"] == "countersunk":
                arguments.update(kind="countersink", csk_diameter=round(s["dk"] + 0.4, 2), csk_angle=90.0)
            elif s["head"] == "socket":
                margin = 0.6 if s["d"] < 3 else 1.0 if s["d"] <= 6 else 2.0
                arguments.update(kind="counterbore", cbore_diameter=round(s["dk"] + margin, 2),
                                 cbore_depth=round(s["k"] + 0.4 + (WASHERS[s["size"]][2] if f["washer"] else 0.0), 2))
        out.append({"part": name, "role": "clearance", "hole": arguments})
    pitch = s["pitch"]
    if f["thread"] in ("tapped", "thread_forming"):
        multiple = rule["min_engagement_d"] or ENGAGEMENT[f["thread"]]
        depth = round(max(tip - mouth, multiple * s["d"]) + max(rule["bottom_gap_mm"], 2 * pitch), 1)
        diameter = s["tap"] if f["thread"] == "tapped" else round(sum(rule["pilot_ratio"]) / 2 * s["d"], 2)
        hole = {"diameter": diameter, "depth": depth, **({"thread": f"{s['size']}x{pitch:g}"} if f["thread"] == "tapped" else {})}
        out.append({"part": f["into"], "role": "tapped" if f["thread"] == "tapped" else "pilot", "hole": hole})
    elif f["thread"] == "insert":
        bore, length = f["insert"]
        out.append({"part": f["into"], "role": "insert", "hole": {"diameter": bore, "depth": round(max(length + 1.0, tip - mouth + rule["bottom_gap_mm"]), 1)}})
    else:
        across, height = NUTS[s["size"]]
        out.append({"part": None, "role": "nut", "nut": {"standard": "ISO 4032", "across_flats_mm": across, "height_mm": height}})
    return out


def _screw_pairs(results: list[dict], solids: dict, started: float, budget: float, notes: list) -> None:
    """Screw against screw: overlapping, or closer than the screw gap."""
    from .design import CLASH_TOLERANCE, _box, _closest, _common
    by_name = {r["name"]: r for r in results}
    names = list(solids)
    boxes = {name: _box(solids[name][0]) for name in names}
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if time.monotonic() - started > budget * 1.2:
                notes.append("Screws were checked against each other only in part (time budget).")
                return
            gap = min(solids[a][1], solids[b][1])
            if _box(solids[a][0], gap).IsOut(boxes[b]):
                continue
            distance, points = _closest(solids[a][0], solids[b][0])
            if distance >= gap - 1e-9:
                continue
            common = _common(solids[a][0], solids[b][0]) if distance <= 1e-6 else (0.0, None)
            if common is not None and common[0] > CLASH_TOLERANCE:
                for one, other in ((a, b), (b, a)):
                    by_name[one]["findings"].append({"code": "screw_screw", "status": "fail", "other": other, "measured": round(common[0], 3),
                                                     "units": "mm³", "message": f"{one} and {other} cross: their screws overlap by "
                                                     f"{common[0]:.3f} mm³.", "points": [common[1]]})
            else:
                for one, other in ((a, b), (b, a)):
                    by_name[one]["findings"].append({"code": "screw_screw", "status": "review", "other": other, "measured": round(distance, 3),
                                                     "limit": gap, "units": "mm", "message": f"{one} passes {distance:.2f} mm from {other}; "
                                                     f"keep at least {gap:g} mm between screws.", **({"points": points} if points else {})})


def _step_index(design, by_name: dict) -> dict | None:
    """Each instance's assembly step (its index), or None without design.assembly_steps."""
    if design.steps is None:
        return None
    out = {}
    for index, (name, members) in enumerate(design.steps):
        for pattern in members:
            found = [n for n in by_name if fnmatch.fnmatchcase(n, pattern)]
            if not found:
                design.errors.append(f"Assembly step {name!r}: {pattern!r} matches no instance of this design.")
            for n in found:
                out.setdefault(n, index)
    return {"instances": out, "names": [name for name, _ in design.steps]}


def _step_of(f: dict, order) -> str | None:
    if order is None:
        return None
    if f["step"]:
        return f["step"]
    indices = [order["instances"][n] for n in [*f["clamps"], f["into"]] if n in order["instances"]]
    return order["names"][max(indices)] if indices else order["names"][-1]


def _obstacles(f: dict, order, by_name: dict, label: str) -> list[str]:
    """The instances installed when this screw goes in: up to its step (everything, without assembly steps)."""
    if order is None:
        return [n for n in by_name if n != f["instance"]]
    step = _step_of(f, order)
    if step not in order["names"]:
        raise FeatureError(f"{label}: step {step!r} isn't an assembly step (steps: {', '.join(order['names'])}).")
    index = order["names"].index(step)
    return [n for n, i in order["instances"].items() if i <= index and n != f["instance"]]


def _frame(design, f: dict, by_name: dict, label: str) -> tuple[cq.Vector, cq.Vector]:
    """The seat (where the head bears, on the head_on face) and the direction from the head toward the tip, design frame."""
    from .design import Ref, _geometry_axis, _move, _turn
    axis = f["axis"]
    if isinstance(axis, dict) or isinstance(axis, Ref):
        ref = axis["ref"] if isinstance(axis, dict) else axis
        owner = _owner(design, ref.component, f, by_name, "axis", label)
        if isinstance(axis, dict):
            origin, direction = _axis_groups(ref.component, ref.ref, label)[axis["group"]]
        else:
            origin, direction = _geometry_axis(ref.component, ref.ref, f["name"], label=label)
        origin, direction = _move(owner["location"], origin), _turn(owner["location"], direction)
    else:
        origin, direction = cq.Vector(*map(float, axis[0])), cq.Vector(*map(float, axis[1])).normalized()
    if f["head_on"] is None:
        return origin, direction
    ref = f["head_on"]
    owner = _owner(design, ref.component, f, by_name, "head_on", label)
    faces = ref.component.faces(ref.ref)
    if len(faces) != 1 or faces[0].geomType() != "PLANE":
        raise FeatureError(f"{label}: head_on {ref!r} must be one planar face, the one the head rests on.")
    centre = faces[0].Center()
    normal = faces[0].normalAt(centre)
    centre, normal = _move(owner["location"], centre), _turn(owner["location"], normal)
    cosine = direction.dot(normal)
    if abs(cosine) < math.cos(math.radians(2)):
        raise FeatureError(f"{label}: head_on {ref!r} isn't square to the screw's axis ({math.degrees(math.acos(min(abs(cosine), 1.0))):.1f}° off).")
    return origin + direction * ((centre - origin).dot(normal) / cosine), (normal * -1.0).normalized()


def _owner(design, component, f: dict, by_name: dict, role: str, label: str) -> dict:
    """The instance a reference on `component` means: one of the fastener's own parts, else its only placement."""
    for name in [*f["clamps"], f["into"]]:
        if name in by_name and by_name[name]["component"] is component:
            return by_name[name]
    found = [item for item in design.instances if item["component"] is component]
    if len(found) == 1:
        return found[0]
    if not found:
        raise FeatureError(f"{label}: the {role} is on {component.id}, which isn't placed in this design.")
    raise FeatureError(f"{label}: the {role} is on {component.id}, placed {len(found)} times; list the instance it means in clamps or into.")


def _axis_groups(component, ref: str, label: str) -> list[tuple[cq.Vector, cq.Vector]]:
    """The distinct axes of the cylindrical faces a reference names (a hole pattern), in a stable order."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cylinder
    lines = []
    for face in component.faces(ref):
        surface = BRepAdaptor_Surface(face.wrapped)
        if surface.GetType() != GeomAbs_Cylinder:
            continue
        axis = surface.Cylinder().Axis()
        point, direction = axis.Location(), axis.Direction()
        origin, d = cq.Vector(point.X(), point.Y(), point.Z()), cq.Vector(direction.X(), direction.Y(), direction.Z()).normalized()
        origin = origin + d * (face.Center() - origin).dot(d)
        if not any(abs(abs(d.dot(e)) - 1) < 1e-6 and ((origin - o) - e * (origin - o).dot(e)).Length < 1e-4 for o, e in lines):
            lines.append((origin, d))
    if not lines:
        raise FeatureError(f"{label}: {component.id}.face({ref!r}) has no cylindrical faces (hole walls) to fasten through.")
    return sorted(lines, key=lambda line: line[0].dot(cq.Vector(1, 1e-3, 1e-6)))


def _axis_value(axis, label: str) -> None:
    from .design import Ref
    if isinstance(axis, Ref) or (isinstance(axis, dict) and isinstance(axis.get("ref"), Ref)):
        return
    if isinstance(axis, (list, tuple)) and len(axis) == 2 and all(isinstance(v, (list, tuple)) and len(v) == 3 and all(_number(c) for c in v) for v in axis):
        if math.sqrt(sum(float(c) ** 2 for c in axis[1])) < 1e-12:
            raise FeatureError(f"{label}: the axis direction is zero.")
        return
    raise FeatureError(f"{label}: axis is a hole wall or circular edge (e.g. axis=bracket.face(\"bolt_hole.wall(0)\")), "
                       "or ((x, y, z), (dx, dy, dz)) from the seat toward the tip.")


def _number(value) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
