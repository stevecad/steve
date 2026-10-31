"""Exploded views (`design.explode`, docs/MOTION.md "Exploded views"): named, stepped moves of instances that the
viewer plays like an animation. Display only: an explode never changes placements, the STEP, the BOM or any check.

A step moves some instances by a vector in the design frame (mm), along a direction by a distance, or (screws placed
as a declared fastener's `instance=`) out along their own axis. Steps play in order, each over its duration and then
its hold, and moves add up: a part moved in step 2 stays where step 2 left it, and moves again only if a later step
names it. `auto=True` works out a teardown from the geometry (`_automatic`).

Instances are named as everywhere in a design: an instance name, a fnmatch pattern ("screw_*"), a declared fastener's
name (its placed screw), or an instance of a linked design by path ("gearbox/housing", "gearbox/*").
"""
from __future__ import annotations

import fnmatch
import math

import cadquery as cq

from .model import ID, FeatureError

DURATION = 1.0     # s each step moves, unless it says otherwise
HOLD = 0.25        # s each step holds after it moves
EXPLODES_MAX = 100
STEPS_MAX = 500
EASINGS = ("linear", "ease")
AXES = {"+Z": (0.0, 0.0, 1.0), "-Z": (0.0, 0.0, -1.0), "+X": (1.0, 0.0, 0.0), "-X": (-1.0, 0.0, 0.0),
        "+Y": (0.0, 1.0, 0.0), "-Y": (0.0, -1.0, 0.0)}   # an automatic explode's directions, in tie-break order
STEP_KEYS = ("move", "by", "along", "distance", "out", "moves", "duration", "hold", "name")
OUT_FACTOR = 1.5   # a fastener comes out this many screw lengths unless the step says how far
AWAY = 0.2         # how squarely (cosine) a way out must point away from the rest for a part to go before sideways ones
EXACT_MAX = 2000   # exact blocking checks an automatic explode makes; past it, bounding boxes alone decide (still deterministic)
NESTED_MAX = 8     # levels of linked designs whose instances an explode can name
USAGE = ('Each step is {"move": instances, "by": (x, y, z)} (mm, design frame), {"move": instances, "along": "+Z", '
         '"distance": 40}, {"move": screws, "out": True} for declared fasteners, or {"moves": {instance: (x, y, z), …}} '
         'for parts moving different ways at once; or the short form (instances, (x, y, z)). Optional per step: "duration" '
         'and "hold" (seconds) and "name".')


def _finite(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _seconds(value, label: str, positive: bool = False) -> float:
    if not _finite(value) or value < 0 or (positive and value <= 0):
        raise FeatureError(f"{label} must be {'more than zero' if positive else 'zero or more'} seconds, not {value!r}.")
    return float(value)


def _vector(value, label: str) -> list[float]:
    if not (isinstance(value, (list, tuple)) and len(value) == 3 and all(_finite(v) for v in value)):
        raise FeatureError(f"{label} must be (x, y, z) in mm, not {value!r}.")
    if all(abs(v) < 1e-12 for v in value):
        raise FeatureError(f"{label} is (0, 0, 0): it moves nothing.")
    return [float(v) for v in value]


def _direction(value, label: str) -> list[float]:
    if isinstance(value, str):
        key = value.strip().upper()
        key = f"+{key}" if key in ("X", "Y", "Z") else key
        if key not in AXES:
            raise FeatureError(f"{label}: along is \"+X\", \"-X\", \"+Y\", \"-Y\", \"+Z\", \"-Z\" or a direction (dx, dy, dz), not {value!r}.")
        return list(AXES[key])
    vector = _vector(value, f"{label}: along")
    length = math.sqrt(sum(v * v for v in vector))
    return [v / length for v in vector]


def _names(value, label: str) -> list[str]:
    names = [value] if isinstance(value, str) else list(value) if isinstance(value, (list, tuple)) else None
    if not names or not all(isinstance(n, str) and n.strip() for n in names):
        raise FeatureError(f"{label}: move names the instances it moves: a name, a pattern like \"screw_*\", a fastener's name "
                           f"or a linked design's instance like \"gearbox/housing\", or a list of them; not {value!r}.")
    return [n.strip() for n in names]


def _step(item, index: int, label: str) -> dict:
    where = f"{label}, step {index}"
    if isinstance(item, (list, tuple)) and len(item) == 2 and not isinstance(item[0], dict):
        item = {"move": item[0], "by": item[1]}
    if not isinstance(item, dict):
        raise FeatureError(f"{where}: {USAGE}")
    unknown = [key for key in item if key not in STEP_KEYS]
    if unknown:
        raise FeatureError(f"{where} doesn't take {', '.join(map(repr, unknown))}; a step takes {', '.join(STEP_KEYS)}.")
    if "moves" in item:
        if any(key in item for key in ("move", "by", "along", "distance", "out")):
            raise FeatureError(f"{where}: \"moves\" gives each instance its own move; leave out move, by, along, distance and out.")
        if not isinstance(item["moves"], dict) or not item["moves"]:
            raise FeatureError(f"{where}: moves maps instances to their moves, e.g. {{\"lid\": (0, 0, 30), \"knob\": (0, 0, 50)}}, not {item['moves']!r}.")
        out = {"moves": [(_names(name, where)[0], _vector(vector, f"{where}: the move of {name!r}")) for name, vector in item["moves"].items()]}
        return _timing(item, out, where)
    if "move" not in item:
        raise FeatureError(f"{where}: name the instances it moves with \"move\". {USAGE}")
    out = {"move": _names(item["move"], where)}
    kinds = [key for key in ("by", "along", "out") if item.get(key) is not None and item.get(key) is not False]
    if len(kinds) != 1:
        raise FeatureError(f"{where}: give one of \"by\", \"along\" (with \"distance\") or \"out\"" + (f", not {' and '.join(kinds)}." if kinds else "."))
    kind = kinds[0]
    if "distance" in item and kind == "by":
        raise FeatureError(f"{where}: \"distance\" goes with \"along\"; \"by\" is the whole move (x, y, z).")
    if kind == "by":
        out["by"] = _vector(item["by"], f"{where}: by")
    elif kind == "along":
        distance = item.get("distance")
        if not _finite(distance) or distance == 0:
            raise FeatureError(f"{where}: along needs \"distance\", a nonzero number of mm, not {distance!r}.")
        unit = _direction(item["along"], where)
        out["by"] = [v * float(distance) for v in unit]
    else:
        value, distance = item["out"], item.get("distance")
        if value is not True and not (_finite(value) and value > 0):
            raise FeatureError(f"{where}: out is True (out by {OUT_FACTOR:g} × the screw's length) or a distance in mm, not {value!r}.")
        if distance is not None and value is not True:
            raise FeatureError(f"{where}: give the distance once, as out=<mm>.")
        if distance is not None and not (_finite(distance) and distance > 0):
            raise FeatureError(f"{where}: distance must be more than 0 mm, not {distance!r}.")
        out["out"] = float(distance if distance is not None else value) if value is not True or distance is not None else None
    return _timing(item, out, where)


def _timing(item: dict, out: dict, where: str) -> dict:
    """A step's own duration, hold and name, when it gives them."""
    for key in ("duration", "hold"):
        if item.get(key) is not None:
            out[key] = _seconds(item[key], f"{where}: {key}", positive=key == "duration")
    if item.get("name") is not None:
        if not isinstance(item["name"], str) or not item["name"].strip() or len(item["name"]) > 60:
            raise FeatureError(f"{where}: name is a short label (up to 60 characters), not {item['name']!r}.")
        out["name"] = item["name"].strip()
    return out


def declaration(name, steps, auto, duration, hold, easing, loop, gap) -> dict:
    """One `design.explode(...)`, checked as far as it can be without geometry."""
    if not isinstance(name, str) or not ID.fullmatch(name):
        raise FeatureError(f"Explode name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
    label = f"Explode {name!r}"
    if auto not in (True, False):
        raise FeatureError(f"{label}: auto is True or False, not {auto!r}.")
    duration = _seconds(duration, f"{label}: duration", positive=True)
    hold = _seconds(hold, f"{label}: hold")
    if easing not in EASINGS:
        raise FeatureError(f"{label}: easing must be \"linear\" or \"ease\", not {easing!r}.")
    if gap is not None and (not _finite(gap) or gap <= 0):
        raise FeatureError(f"{label}: gap is the space (mm) an automatic explode leaves between parts, more than 0, not {gap!r}.")
    if auto:
        if steps is not None:
            raise FeatureError(f"{label}: give steps or auto=True, not both. auto=True works the steps out from the geometry; "
                               "to change them, write them out as steps.")
        parsed = []
    else:
        if gap is not None:
            raise FeatureError(f"{label}: gap spaces an automatic explode (auto=True); steps move by what they say.")
        if not isinstance(steps, (list, tuple)) or not steps:
            raise FeatureError(f"{label}: give its steps in order, e.g. [{{\"move\": \"lid\", \"by\": (0, 0, 40)}}], or auto=True. {USAGE}")
        if len(steps) > STEPS_MAX:
            raise FeatureError(f"{label}: at most {STEPS_MAX} steps.")
        parsed = [_step(item, index, label) for index, item in enumerate(steps, start=1)]
    return {"name": name, "auto": bool(auto), "steps": parsed, "duration": duration, "hold": hold, "easing": easing,
            "loop": bool(loop), "gap": float(gap) if gap is not None else None}


# ───────── at the build ─────────


def catalog(design) -> list[str]:
    """Every instance an explode can name, by path: the design's own ("lid") and, inside a linked design, its instances
    ("gearbox/housing", a level deeper "gearbox/drive/shaft")."""
    from .links import LinkedInstance
    out: list[str] = []

    def walk(instances, prefix: str, depth: int):
        for item in instances:
            out.append(f"{prefix}{item['name']}")
            nested = item["component"].__dict__.get("_design") if isinstance(item["component"], LinkedInstance) else None
            if nested is not None and nested.instances and depth < NESTED_MAX:
                walk(nested.instances, f"{out[-1]}/", depth + 1)
    walk(design.instances, "", 0)
    return out


def _listed(names: list[str]) -> str:
    return ", ".join(names[:40]) + (", …" if len(names) > 40 else "")


def _match(pattern: str, paths: list[str], screws: dict[str, str], where: str) -> list[str]:
    """The instance paths one name or pattern means: instances (a pattern with "/" matches inside linked designs), else
    declared fasteners' placed screws."""
    nested = "/" in pattern
    found = [p for p in paths if ("/" in p) == nested and fnmatch.fnmatchcase(p, pattern)]
    if not found:
        found = sorted({screws[f] for f in screws if fnmatch.fnmatchcase(f, pattern)})
    if not found:
        top = [p for p in paths if "/" not in p]
        raise FeatureError(f"{where}: {pattern!r} matches no instance of this design (instances: {_listed(top)}).")
    return found


def _fastener_axes(design, label: str) -> dict[str, tuple[list[float], float]]:
    """Each placed screw (a declared fastener's `instance`): the way out along its axis (unit, design frame) and its length."""
    from .fasteners import _frame
    by_name = {i["name"]: i for i in design.instances}
    out = {}
    for f in design.fasteners:
        if f["instance"] and f["instance"] in by_name and f["instance"] not in out:
            try:
                _, direction = _frame(design, f, by_name, f"{label}: fastener {f['name']!r}")
            except FeatureError:
                continue   # The fastener check reports its own declaration problems.
            out[f["instance"]] = ([-direction.x, -direction.y, -direction.z], f["screw"]["length"])
    return out


def resolve(design, declared: dict, motions: dict) -> dict:
    """An explode as the viewer plays it: each step's start, duration and hold (seconds) and its moves, {instance path:
    [dx, dy, dz] mm}, added to everything before it. `motions` places the instances at the code's pose (automatic
    explodes measure the geometry there)."""
    label = f"Explode {declared['name']!r}"
    paths = catalog(design)
    screws = {f["name"]: f["instance"] for f in design.fasteners if f["instance"]}
    axes = _fastener_axes(design, label)
    steps = _automatic(design, declared, motions, axes, label) if declared["auto"] else []
    if not declared["auto"]:
        for index, step in enumerate(declared["steps"], start=1):
            where = f"{label}, step {index}"
            moved: list[str] = []
            for pattern in step.get("move", []):
                moved += [p for p in _match(pattern, paths, screws, where) if p not in moved]
            if "moves" in step:
                moves = {}
                for pattern, vector in step["moves"]:
                    for path in _match(pattern, paths, screws, where):
                        moves[path] = [a + b for a, b in zip(moves.get(path, [0.0, 0.0, 0.0]), vector)]
            elif "by" in step:
                moves = {p: list(step["by"]) for p in moved}
            else:
                moves = {}
                for path in moved:
                    if path not in axes:
                        raise FeatureError(f"{where}: out moves placed screws along their axes; {path!r} isn't the instance of a declared "
                                           "fastener (design.fasten(..., instance=...)). Move it with \"by\" or \"along\".")
                    unit, length = axes[path]
                    distance = step["out"] if step["out"] is not None else OUT_FACTOR * length
                    moves[path] = [v * distance for v in unit]
            steps.append({"name": step.get("name") or f"step_{index}", "moves": moves, "duration": step.get("duration", declared["duration"]),
                          "hold": step.get("hold", declared["hold"]), **({"out": True} if "out" in step else {})})
    if not steps:
        raise FeatureError(f"{label}: nothing to move" + (" (it has one part, or none)." if declared["auto"] else "."))
    start, out = 0.0, []
    for step in steps:
        out.append({"name": step["name"], "start": round(start, 6), "duration": step["duration"], "hold": step["hold"],
                    "moves": {path: [round(v, 6) + 0.0 for v in vector] for path, vector in sorted(step["moves"].items())},
                    **({"out": True} if step.get("out") else {})})
        start += step["duration"] + step["hold"]
    moved = sorted({path for step in out for path in step["moves"]})
    return {"name": declared["name"], "steps": out, "duration": round(start, 6), "easing": declared["easing"], "loop": declared["loop"],
            "auto": declared["auto"], "instances": moved}


def offsets(explode: dict, t: float) -> dict[str, list[float]]:
    """Each moved instance's offset (mm, design frame) at `t` seconds: every step's move so far, eased as the viewer plays it."""
    out: dict[str, list[float]] = {}
    for step in explode["steps"]:
        if t <= step["start"]:
            break
        u = min(1.0, (t - step["start"]) / step["duration"]) if step["duration"] > 0 else 1.0
        if explode.get("easing") == "ease":
            u = u * u * (3 - 2 * u)
        for path, vector in step["moves"].items():
            current = out.setdefault(path, [0.0, 0.0, 0.0])
            for k in range(3):
                current[k] += vector[k] * u
    return out


# ───────── automatic explodes ─────────


def _bounds(shape: cq.Shape) -> list[float]:
    """A shape's axis-aligned box [xmin, ymin, zmin, xmax, ymax, zmax], tight (optimal) where the kernel can."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    box = Bnd_Box()
    try:
        BRepBndLib.AddOptimal_s(shape.wrapped, box, False, False)
    except Exception:   # noqa: BLE001  The ordinary box, a little looser.
        box = Bnd_Box()
        BRepBndLib.Add_s(shape.wrapped, box)
    return [*box.CornerMin().Coord(), *box.CornerMax().Coord()]


def _volume(box: list[float]) -> float:
    return max(box[3] - box[0], 0.0) * max(box[4] - box[1], 0.0) * max(box[5] - box[2], 0.0)


def _centre(box: list[float]) -> list[float]:
    return [(box[k] + box[k + 3]) / 2 for k in range(3)]


def _overlap(a: list[float], b: list[float]) -> bool:
    return all(a[k] < b[k + 3] and b[k] < a[k + 3] for k in range(3))


def _blocked_span(a: list[float], b: list[float], unit: list[float], gap: float) -> tuple[float, float] | None:
    """The distances d along `unit` at which box a moved by d·unit overlaps box b, grown by `gap` along the axes the move
    mostly follows (so parts end up `gap` apart that way, and side by side parts don't push each other out): an open
    interval, or None when they never overlap."""
    low, high = -math.inf, math.inf
    for k in range(3):
        g = gap if abs(unit[k]) >= 0.3 else 0.0
        lo_b, hi_b = b[k] - g, b[k + 3] + g
        if abs(unit[k]) < 1e-12:
            if not (a[k] < hi_b and lo_b < a[k + 3]):
                return None
            continue
        x, y = (lo_b - a[k + 3]) / unit[k], (hi_b - a[k]) / unit[k]
        low, high = max(low, min(x, y)), min(high, max(x, y))
    return (low, high) if low < high else None


def _beyond(box: list[float], unit: list[float], others: list[list[float]], gap: float) -> float:
    """How far along `unit` `box` must go to be past every one of `others` in its way (each grown by `gap` that way), so it
    never stops among them: the end of the furthest overlap ahead, or 0 when nothing is in the way."""
    return max([high for other in others if (span := _blocked_span(box, other, unit, gap)) is not None and (high := span[1]) > 0], default=0.0)


class _Blocking:
    """Whether a part can slide out one way past the parts still assembled: the prism its box sweeps that way (to past
    the whole design) against each one's box, then, where the boxes meet, its exact solids (a part inside a housing's
    open cavity is free upward though the boxes overlap). After EXACT_MAX exact checks the boxes alone decide."""

    def __init__(self, shapes: dict[str, cq.Shape], boxes: dict[str, list[float]], whole: list[float]):
        self.shapes, self.boxes, self.whole, self.exact = shapes, boxes, whole, 0
        self.cache: dict[tuple, bool] = {}

    def prism(self, name: str, axis: str) -> list[float]:
        box, k, sign = self.boxes[name], "XYZ".index(axis[1]), 1 if axis[0] == "+" else -1
        size = [box[i + 3] - box[i] for i in range(3)]
        out = [box[i] + min(0.05, size[i] / 4) if i != k else 0.0 for i in range(3)] + \
              [box[i + 3] - min(0.05, size[i] / 4) if i != k else 0.0 for i in range(3)]
        reach = (self.whole[k + 3] - self.whole[k]) + 1.0
        if sign > 0:
            out[k], out[k + 3] = box[k + 3] + 0.01, max(box[k + 3], self.whole[k + 3]) + reach
        else:
            out[k], out[k + 3] = min(box[k], self.whole[k]) - reach, box[k] - 0.01
        return out

    def blocked(self, name: str, axis: str, assembled: list[str]) -> bool:
        prism = self.prism(name, axis)
        for other in assembled:
            if other == name or not _overlap(prism, self.boxes[other]):
                continue
            key = (name, axis, other)
            if key not in self.cache:
                self.cache[key] = self._exact(prism, other)
            if self.cache[key]:
                return True
        return False

    def _exact(self, prism: list[float], other: str) -> bool:
        if self.exact >= EXACT_MAX:
            return True
        self.exact += 1
        from OCP.BRepExtrema import BRepExtrema_DistShapeShape
        solid = cq.Solid.makeBox(prism[3] - prism[0], prism[4] - prism[1], prism[5] - prism[2], cq.Vector(prism[0], prism[1], prism[2]))
        try:
            measure = BRepExtrema_DistShapeShape(self.shapes[other].wrapped, solid.wrapped)
            measure.Perform()
            return not measure.IsDone() or measure.Value() <= 1e-6 or measure.InnerSolution()
        except Exception:   # noqa: BLE001  Not measurable: count it as in the way.
            return True


def _automatic(design, declared: dict, motions: dict, screws: dict, label: str) -> list[dict]:
    """An automatic teardown, the reverse of assembly. With design.assembly_steps: the last step's parts come off first,
    each step's placed screws (fasteners' `instance`) before its other parts; the largest part of the first step (with
    everything no step names) stays. Without: every placed screw comes out first, then layer by layer the parts that
    can slide out past the rest, the largest part staying. Screws come out along their own axes; each other part moves
    along ±X, ±Y or ±Z: of the ways it's free to slide out past what's still assembled (exact solids against the box it
    sweeps), the one pointing most away from the rest (+Z on a tie); a layer takes the parts free to come straight off
    before any that could only slide sideways (a lid under a knob waits for the knob). Each part goes as far as it must
    to get past, by `gap` (default 5 % of the design's size, at least 2 mm), everything in its way that was still
    assembled when it came off, where it sat and where it ends, so the parts that come off first end furthest out (the
    knob beyond the lid) and no two parts' boxes overlap at the end. Deterministic: the same design always explodes the same way."""
    shapes, boxes = {}, {}
    for item in design.instances:   # This design's own instances; a linked design moves as one.
        from .design import _instance_shape
        shape = _instance_shape(item)
        if shape is None:
            continue
        motion = motions.get(item["name"])
        shape = shape.moved(cq.Location(motion)) if motion is not None else shape
        shapes[item["name"]], boxes[item["name"]] = shape, _bounds(shape)
    names = [i["name"] for i in design.instances if i["name"] in boxes]
    if len(names) < 2:
        return []
    whole = [min(boxes[n][k] for n in names) for k in range(3)] + [max(boxes[n][k + 3] for n in names) for k in range(3)]
    size = math.dist(whole[:3], whole[3:])
    gap = declared["gap"] if declared["gap"] is not None else max(2.0, 0.05 * size)
    blocking = _Blocking(shapes, boxes, whole)
    is_screw = {n for n in names if n in screws}
    largest = lambda group: max(sorted(group), key=lambda n: _volume(boxes[n]))  # noqa: E731  (ties: the first by name)

    # The order: groups of instances, the first group the base's.
    if design.steps:
        index: dict[str, int] = {}
        for i, (step, members) in enumerate(design.steps):
            for pattern in members:
                for n in names:
                    if fnmatch.fnmatchcase(n, pattern):
                        index.setdefault(n, i)
        by_fastener = {f["instance"]: f for f in design.fasteners if f["instance"]}
        step_names = [step for step, _ in design.steps]
        for n in sorted(is_screw - set(index)):   # A screw no step names goes in with the parts it fastens.
            f = by_fastener[n]
            own = f["step"] if f["step"] in step_names else None
            parts = [index[p] for p in [*f["clamps"], f["into"]] if p in index]
            index[n] = step_names.index(own) if own else max(parts) if parts else len(step_names) - 1
        groups = [[n for n in names if index.get(n, 0) == i] for i in range(len(design.steps))]
        titles = step_names
        candidates = [n for n in groups[0] if n not in is_screw]
        base = largest(candidates or [n for n in names if n not in is_screw] or names)
        plan = []
        for i in reversed(range(len(groups))):
            group = [n for n in groups[i] if n != base]
            screwed, parts = [n for n in group if n in is_screw], [n for n in group if n not in is_screw]
            plan.append((f"{titles[i]}_screws" if parts else titles[i], screwed))
            plan.append((titles[i], parts))
    else:
        base = largest([n for n in names if n not in is_screw] or names)
        plan = [("screws", sorted(is_screw - {base}))]
        plan.append(("layers", None))   # Worked out as it goes: whatever can slide out past the rest.

    assembled = list(names)
    order: list[tuple[str, list[str], dict[str, list[float]], list[str]]] = []   # (title, parts, their ways out, assembled then)

    def direction(n: str) -> tuple[list[float], bool, float]:
        """The way `n` comes out, whether it's free to, and how much that way points away from the rest (1: straight away)."""
        if n in screws:
            return screws[n][0], True, 1.0
        rest = [m for m in assembled if m != n]
        here = _centre(boxes[n])
        middle = _centre([min(boxes[m][k] for m in rest) for k in range(3)] + [max(boxes[m][k + 3] for m in rest) for k in range(3)]) if rest else here
        away = [here[k] - middle[k] for k in range(3)]
        length = math.sqrt(sum(v * v for v in away)) or 1.0
        score = {axis: sum(AXES[axis][k] * away[k] for k in range(3)) / length + (0.05 if axis == "+Z" else 0.0) for axis in AXES}
        ranked = sorted(AXES, key=lambda axis: -score[axis])
        for axis in ranked:
            if not blocking.blocked(n, axis, rest):
                return list(AXES[axis]), True, score[axis]
        return list(AXES[ranked[0]]), False, score[ranked[0]]

    def take(title: str, group: list[str]):
        """A step of the teardown: these parts come off now, each its way."""
        if group:
            order.append((title, group, {n: direction(n)[0] for n in group}, list(assembled)))
        for n in group:
            assembled.remove(n)

    for title, group in plan:
        if group is not None:
            take(title, group)
            continue
        layer = 1
        while True:
            rest = [n for n in assembled if n != base]
            if not rest:
                break
            ways = {n: direction(n) for n in rest}
            # Parts free to come straight off (away from the rest) go first; one only free to slide sideways waits for them.
            free = [n for n in rest if ways[n][1] and ways[n][2] > AWAY] or [n for n in rest if ways[n][1]]
            if not free:   # Interlocked as far as the solids tell: the part farthest out goes first.
                middle = _centre(boxes[base])
                free = [max(sorted(rest), key=lambda n: math.dist(_centre(boxes[n]), middle))]
            take(f"layer_{layer}", sorted(free))
            layer += 1

    # How far: from the last part off to the first, so a part that came off earlier ends beyond those that came off after
    # it (the knob beyond the lid it sat on). Each goes past, by `gap`, everything in its way: what was still assembled
    # when it came off (where it sat then, and where each of those ends); within a step the part nearer the rest goes first.
    placed: dict[str, list[float]] = {}
    moves_of: dict[str, list[float]] = {}
    for title, group, ways, before in reversed(order):
        middle = _centre([min(boxes[m][k] for m in before) for k in range(3)] + [max(boxes[m][k + 3] for m in before) for k in range(3)])
        for n in sorted(group, key=lambda n: (sum((_centre(boxes[n])[k] - middle[k]) * ways[n][k] for k in range(3)), n)):
            unit = ways[n]
            others = [boxes[m] for m in before if m != n] + [box for m, box in placed.items() if m != n]
            d = max(_beyond(boxes[n], unit, others, gap), gap)
            moves_of[n] = [v * d for v in unit]
            placed[n] = [boxes[n][k] + moves_of[n][k % 3] for k in range(6)]
    return [{"name": title, "moves": {n: moves_of[n] for n in group}, "duration": declared["duration"], "hold": declared["hold"],
             **({"out": True} if all(n in screws for n in group) else {})} for title, group, _, _ in order]
