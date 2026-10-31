"""Designs: several components, each in its own file, placed together (docs/MODELING.md §6).

A `Component` is a full modeling `Model` (sketches, features, bodies, persistent names) with an
identity. Components are modeled in the design's coordinate frame, so one can reference
another's geometry directly (`disk.face("slot.side(r1.left)")`); `Design.add(..., at=...)`
places instances on top of that. `Design.result()` is a named `cq.Assembly`.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from pathlib import Path

import cadquery as cq

from . import progress
from .model import CACHE_VERSION, ID, FeatureError, Model

EASINGS = ("linear", "ease")  # ease: smooth start and stop (smoothstep), as the viewer plays it
SAMPLINGS = ("grid", "random", "poses", "animation")
STUDY_SAMPLES = 2000  # the most poses one collision study checks at a build
STUDY_LISTED = 200    # colliding poses a study lists one by one (sampling="poses" lists every colliding pose)
STUDY_MAP_BINS = 20   # a random study's map: bins per joint
COLLISION_SHAPES = ("box", "sphere", "capsule")
CLASH_TOLERANCE = 1e-3  # mm³: touching faces have no common volume
CONTACTS = ("seated", "press_fit", "threaded")
FIT_LISTED = 100      # pairs a fit check lists
MODES_MAX = 32        # named limit sets (design.mode) a design declares
PREVIEW_BUDGET = 25.0  # s each motion, fastener or cable check of a preview (and of any build but a full one) may take
BOUNDED_FACES = 400   # a pair with more faces than this is measured in a forked child that its check's deadline can stop
_PACKAGE = Path(__file__).resolve().parent
# When a full build's motion, fastener and cable checks must be done by (time.monotonic()), leaving the rest of the job's
# time limit to its exports; None (every other build) keeps PREVIEW_BUDGET. Set by the runtime per build (run.build).
_CHECK_DEADLINE: float | None = None


def check_deadline(deadline: float | None) -> None:
    global _CHECK_DEADLINE
    _CHECK_DEADLINE = deadline


def budget_words(budget: float) -> str:
    """Which time budget a stopped check had, for its note."""
    if _CHECK_DEADLINE is None:
        return f"time budget {budget:g} s, a preview's; a full build checks within its own time limit"
    return f"time budget {budget:.0f} s, this full build's share of its time limit"

_COMPONENTS: list["Component"] = []
_DESIGNS: list["Design"] = []


class Ref:
    """A reference into a component (`disk.face("extrude_1.end")`) or a linked part (`plate.face(...)`), usable from
    another component. `target` is what modelling resolves it on: the component, or a linked part where it's placed."""
    _steve_ref = True

    def __init__(self, component: "Component", ref: str, target=None):
        if not isinstance(ref, str) or not ref:
            raise FeatureError(f"A reference into {component.id} must be a name, like {component.id}.face(\"extrude_1.end\").")
        self.component, self.ref = component, ref
        self.target = component if target is None else target

    def __repr__(self):
        return f"{self.component.id}.ref({self.ref!r})"


class Component(Model):
    """One component of a design: its own sketches, features and bodies. One per file.

    `hardware=False` marks a component that isn't a part to make or buy: a fluid or gas volume added so a flow study
    has the body, a keep-out or envelope. It builds, shows in the viewer and studies (run_study) use it as a body, but
    it is left out of the bill of materials (and a drawing's parts list, cut list and balloons), the design's volume,
    mass and centre of mass, the fit, motion and cable checks, the fastener checks, the print meshes (STL/3MF, print
    set, physics model) and the per-component STEP files and manufacturing checks. Declared once, here: every instance
    follows. The build summary marks it `hardware: false`.

    Built components are cached by the content of their file and every design file it imports
    (plus the runtime version): an edit rebuilds only the components it can affect.
    """

    def __init__(self, id: str, name: str | None = None, hardware: bool = True):
        if not isinstance(id, str) or not ID.fullmatch(id):
            raise FeatureError(f"Component id {id!r} must be lowercase letters, digits and underscores, starting with a letter.")
        if not isinstance(hardware, bool):
            raise FeatureError(f"Component {id}: hardware= is True (a part, the default) or False (not hardware, like a fluid volume), not {hardware!r}.")
        super().__init__(name or id.replace("_", " ").capitalize())
        self.id = id
        self.file = _caller_file()
        self.cache = "off"
        self._cacheable = True
        self._key = _cache_key(self.file) if self.file else None
        if self._key and (record := _cache_read(self._key)):
            try:
                self._restore(record)
                self.cache = "hit"
            except Exception as error:  # A cache entry that doesn't load is rebuilt, never fatal.
                print(f"Warning: component cache entry for {id} ignored: {error!r}"[:300], file=sys.stderr)
                self.__init_fresh(id)
        elif self._key:
            self.cache = "miss"
        self.hardware = hardware  # After a restore: the flag is the file's, which the cache key covers.
        _COMPONENTS.append(self)

    def __init_fresh(self, id):
        name, file, key = self.name, self.file, self._key
        self.__dict__.clear()  # Nothing a half-restored entry left behind (decals, materials, sheet metal) survives.
        Model.__init__(self, name)
        self.id, self.file, self._key, self.cache, self._cacheable, self._restored = id, file, key, "miss", True, False

    def _begin(self, id, kind, name):
        # A component's features belong in its own file; built from elsewhere, its cache key can't see them.
        if self.file and _caller_file() != self.file:
            self._cacheable = False
        return super()._begin(id, kind, name)

    # ───────── build cache (the record and its restore: Model._record, Model._restore) ─────────

    def save_to_cache(self) -> None:
        if self.cache == "miss" and self._cacheable and self._key:
            _cache_write(self._key, self._record())

    def face(self, ref: str) -> Ref:
        """A face of this component (`disk.face("extrude_1.end")`), usable from another component or a joint."""
        return Ref(self, ref)

    def edge(self, ref: str) -> Ref:
        """An edge of this component (`disk.edge("edge(extrude_1.end|extrude_1.side(c1))")`), usable from another
        component or a joint."""
        return Ref(self, ref)

    def vertex(self, ref: str) -> Ref:
        """A vertex of this component, usable from another component or a joint."""
        return Ref(self, ref)

    def ref(self, ref: str) -> Ref:
        """Any reference: a face, edge, vertex, plane, axis or sketch (entity) of this component."""
        return Ref(self, ref)

    def shape(self) -> cq.Shape | None:
        """This component's geometry: one solid, a compound of its bodies, or None before it has any."""
        shapes = list(self.bodies.values())
        if not shapes:
            return None
        shape = shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes)
        shape._steve_model = self
        return shape


SURFACE_BOM_NOTE = "surface (not a part)"
NOT_HARDWARE_NOTE = ("not hardware (Component(..., hardware=False)): built, shown and used by studies, but left out of the bill of "
                     "materials, mass, fit, interference and fastener checks and the part exports")


def is_hardware(part) -> bool:
    """Whether a placed component, linked document or model is hardware: False only for a component declared
    `Component(..., hardware=False)`, or a link to one such component of another design."""
    design = getattr(part, "__dict__", {}).get("_design")
    if isinstance(getattr(part, "source", None), dict) and part.source.get("component") and design is not None and design.instances:
        part = design.instances[0]["component"]  # A linked design's one component (links.py LinkedInstance.name).
    return getattr(part, "hardware", True) is not False


def _surface_only(part) -> bool:
    """A component or linked part whose bodies are all surfaces (model.fill, boundary_surface): no part to make yet."""
    from .links import LinkedInstance
    from .model import is_surface
    if isinstance(part, LinkedInstance):
        try:
            part = getattr(part.result, "_steve_model", None)
        except Exception:  # noqa: BLE001 - a link that failed reports itself elsewhere
            return False
    bodies = list(getattr(part, "bodies", {}).values()) if part is not None else []
    return bool(bodies) and all(is_surface(body) for body in bodies)


def _pattern_points(points, polar: bool) -> list[cq.Location]:
    """Design.pattern's `points` as placements: (x, y[, z]) moves an instance; polar (r, θ[, z]) moves it to radius r
    at θ degrees about Z and turns it by θ. Errors say which point (a table's file and row), never its values."""
    from .tables import Table
    try:
        rows = list(points)
    except TypeError:
        raise FeatureError("points must be a list of (x, y) or (x, y, z) points, or table(\"….csv\").") from None
    if not rows:
        raise FeatureError(f"{points.path if isinstance(points, Table) else 'points'} has no points to place instances at.")
    shape = "(r, θ) or (r, θ, z)" if polar else "(x, y) or (x, y, z)"
    placed = []
    for index, row in enumerate(rows):
        where = points.where(index) if isinstance(points, Table) else f"points[{index}]"
        try:
            values = list(row)
        except TypeError:
            raise FeatureError(f"{where} must be a point {shape}.") from None
        if len(values) not in (2, 3):
            raise FeatureError(f"{where} has {len(values)} values; a point is {shape}"
                               + (" (pick its columns with table(…, columns=(…)))." if isinstance(points, Table) else "."))
        for column, value in enumerate(values):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise FeatureError(f"{where} column {column + 1} isn't a number.")
        if polar:
            radius, angle, z = (*values, 0.0) if len(values) == 2 else values
            turn = math.radians(angle)
            placed.append(cq.Location(cq.Vector(radius * math.cos(turn), radius * math.sin(turn), z), cq.Vector(0, 0, 1), float(angle)))
        else:
            x, y, z = (*values, 0.0) if len(values) == 2 else values
            placed.append(cq.Location(cq.Vector(float(x), float(y), float(z))))
    return placed


def _location(at) -> cq.Location:
    """`(x, y, z)`, `((x, y, z), (axis, degrees))` with axis "X"/"Y"/"Z" or a direction, or None. As in
    `cq.Location(t, axis, angle)`, the rotation (about an axis through the instance's own origin) comes first, then
    the translation: the instance's origin lands at (x, y, z)."""
    if at is None:
        return cq.Location()
    try:
        if len(at) == 3 and all(isinstance(v, (int, float)) for v in at):
            return cq.Location(cq.Vector(*map(float, at)))
        offset, (axis, angle) = at
        direction = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}.get(axis, axis) if isinstance(axis, str) else axis
        if isinstance(direction, str):
            raise ValueError
        return cq.Location(cq.Vector(*map(float, offset)), cq.Vector(*map(float, direction)), float(angle))
    except (TypeError, ValueError):
        raise FeatureError(f"Placement {at!r} must be (x, y, z) or ((x, y, z), (axis, degrees)).") from None


class Design:
    """Places components (and repeated instances of them) into one assembly."""

    def __init__(self, name: str | None = None):
        self.name = name or "design"
        self.instances: list[dict] = []
        self.errors: list[str] = []
        self.documents: dict[str, str] = {}   # instance name → linked document id
        self.joints: list[dict] = []
        self.couplings: list[dict] = []
        self.drives: list[dict] = []
        self.poses: dict[str, dict] = {}
        self.modes: list[dict] = []
        self.pose_modes: dict[str, str] = {}  # pose name → the mode it is in (design.pose(..., mode=))
        self.animations: list[dict] = []
        self.explodes: list[dict] = []
        self.studies: list[dict] = []
        self.collision_shapes: list[dict] = []
        self.mass_overrides: list[dict] = []
        self.lumped_masses: list[dict] = []
        self.sites: list[dict] = []
        self.collision_filters: list[dict] = []
        self.contact_pairs: list[dict] = []
        self.contact_excludes: list[dict] = []
        self.contacts: list[dict] = []
        self.gaps: dict = {"default": 0.0, "pairs": []}
        self.fits: list[dict] = []
        self.fasteners: list[dict] = []
        self.steps: list[tuple[str, list[str]]] | None = None
        self.tools: dict[str, dict] = {}
        self.fastener_overrides: dict = {}
        self.cables: list[dict] = []
        self.harnesses: list[dict] = []
        self.kinematics: dict | None = None
        self.fastener_report: dict | None = None
        self.cable_report: dict | None = None
        self._study_poses: dict[str, list[dict]] = {}  # each study's checked poses (every value), for the cable checks
        self._simple: dict[str, list] = {}  # each instance's collision shapes as solids, as modelled, for the studies' scores
        self._checks_left = 1  # timed checks still to run at the build (result()), sharing a full build's time
        self._exact: _Exact | None = None  # the build's exact pair answers, which its checks share (`_answers`)
        self._context: str | None = None  # what every check of this build depends on but its own definition (`_check_context`)
        self.reused_checks = 0  # checks whose results an earlier build made (`_reuse`)

    def _answers(self) -> "_Exact":
        """The exact pair answers of this build's checks, and the instances' solids at rest they are keyed on."""
        if self._exact is None:
            self._exact = _Exact({item["name"]: shape for item in self.instances
                                  if is_hardware(item["component"]) and (shape := _instance_shape(item)) is not None})
        return self._exact

    def _not_hardware(self) -> set[str]:
        """The instances of components that aren't hardware (`Component(..., hardware=False)`): no check looks at them."""
        return {item["name"] for item in self.instances if not is_hardware(item["component"])}

    def _budget(self) -> float:
        """The next timed check's budget: PREVIEW_BUDGET, or in a full build an even share of the time left to the checks
        still to run (never less than a preview's), so one long check can't starve the ones after it."""
        import time
        left, self._checks_left = self._checks_left, max(self._checks_left - 1, 1)
        if _CHECK_DEADLINE is None:
            return PREVIEW_BUDGET
        return max(PREVIEW_BUDGET, (_CHECK_DEADLINE - time.monotonic()) / left)

    def _check_context(self, joints: list[dict], couplings: list[dict]) -> str | None:
        """What every motion and fit check of this build depends on but its own definition, as one digest: each
        instance's geometry (its component's cache key, or the linked document and its overrides) and placement, the
        resolved joints and couplings, and the declared poses, animations, contacts, clearances and collision shapes.
        None (every check runs, and none is kept) without a cache entry for the checks (`reuse_checks`), or when an
        instance's geometry has no key: built from another file, or a linked design's own component."""
        from .links import LinkedInstance
        if _CHECKS_KEY is None:
            return None
        instances = []
        for item in self.instances:
            part = item["component"]
            if isinstance(part, Component):
                if not (getattr(part, "_cacheable", False) and getattr(part, "_key", None) and part.file and not part.file.startswith(".")):
                    return None
                geometry = {"component": part._key}
            elif isinstance(part, LinkedInstance):
                geometry = {"link": part.alias, "overrides": part.overrides,
                            "source": {k: part.source.get(k) for k in ("kind", "document_id", "revision", "component")}}
            else:
                return None
            instances.append({"name": item["name"], **geometry, "at": _placement(item["location"])})
        try:  # Anything that isn't plain data reads as its repr: an object's differs between builds, so nothing is reused.
            text = json.dumps({"instances": instances, "joints": joints, "couplings": couplings, "poses": self.poses,
                               **({"modes": [self.modes, self.pose_modes]} if self.modes else {}), "animations": self.animations, "contacts": self.contacts, "gaps": self.gaps,
                               "collision_shapes": self.collision_shapes}, sort_keys=True, default=repr)
        except (TypeError, ValueError, RecursionError):
            return None
        return hashlib.sha256(text.encode()).hexdigest()

    def _reuse(self, kind: str, definition: dict, run) -> dict:
        """A motion or fit check's result: `run(budget)`'s, or an earlier build's (marked `reused`) when nothing it
        depends on changed: the same cache entry (main's code and everything it reads, looks aside: `reuse_checks`)
        holding a result for the same fingerprint (this build's `_context`, the check's kind and its definition). Only
        a result that holds whatever the time is kept for the next build (`_settled`): never one cut short, with an
        unverified pair or made past its budget, so such a check always runs again."""
        import time
        fingerprint = None
        if self._context:
            try:
                fingerprint = hashlib.sha256(json.dumps([self._context, kind, definition], sort_keys=True, default=repr).encode()).hexdigest()
            except (TypeError, ValueError, RecursionError):
                fingerprint = None
        stored = _checks_stored().get(fingerprint) if fingerprint else None
        if isinstance(stored, dict):
            self._budget()  # Its share of the build's time goes to the checks after it.
            self.reused_checks += 1
            return {**stored, "reused": True}
        budget = self._budget()
        started = time.monotonic()
        result = run(budget)
        if fingerprint and time.monotonic() - started < budget and _settled(result):
            try:
                _CHECKS_NEW[fingerprint] = json.loads(json.dumps(result, allow_nan=False))
            except (TypeError, ValueError, RecursionError):
                pass  # Not plain data: checked again next time.
        return result

    def add(self, component, at=None, name: str | None = None, print=None) -> str:
        """Places a component (from its file) or a linked design or part (`bolt(length=30)`). `at=(x, y, z)` moves
        the instance by (x, y, z) mm; `at=((x, y, z), (axis, degrees))` first turns it about `axis` ("X", "Y", "Z" or a
        direction) through its own origin, then moves its origin to (x, y, z) in the design's frame: with
        `at=((10, 0, 0), ("Z", 90))` its origin is at (10, 0, 0) and its +X points along +Y. `print={...}` marks the
        instance as a 3D-printed part for File → Export → Print set: `process` ("fdm", "sla", "sls", "mjf"; default
        "fdm"), `build_direction` (the part's own axis that points up on the printer: "+Z", "-Z", "+X", "-X", "+Y",
        "-Y"; default "+Z"), and optionally `material` (a filament or resin, e.g. "petg"), `group` (a variant group)
        and `notes`. Identical instances with the same settings share one print file with a quantity."""
        from .links import Link, LinkedInstance
        if isinstance(component, Link):
            component = component()  # A link used without overrides.
        if not isinstance(component, (Component, LinkedInstance)):
            raise FeatureError(f"design.add takes a Component (imported from its file) or a link like bolt(length=30), not {type(component).__name__}.")
        used = {i["name"] for i in self.instances}
        base = name or component.id
        instance = base if base not in used else next(f"{base}_{n}" for n in range(2, 10_000) if f"{base}_{n}" not in used)
        settings = _print_settings(print, instance)
        if settings and not is_hardware(component):
            raise FeatureError(f"{instance}: print= marks a part to print, but {component.id} isn't hardware (hardware=False): leave print= out.")
        self.instances.append({"name": instance, "component": component, "location": _location(at), "at": at, **({"print": settings} if settings else {})})
        return instance

    def pattern(self, component, count: int | None = None, axis="Z", angle: float = 360.0, direction=None, spacing: float | None = None,
                at=None, name: str | None = None, print=None, points=None, polar: bool = False) -> list[str]:
        """Instances of one component or link: around an axis through the origin (`angle` spread evenly; a full turn
        doesn't repeat the first), along `direction` every `spacing` mm, or one at each of `points`, spaced however
        they are: (x, y) or (x, y, z) in mm, or with `polar=True` (r, θ degrees) or (r, θ, z), each instance turned by
        θ about Z as in a circular pattern. `points=table("holes.csv")` reads them from the design's table. `at`
        places the whole pattern, as in `add`: each instance's own step comes first, then `at` turns the pattern about
        the design's origin and moves it by (x, y, z). `print={...}` marks every instance as printed (see `add`)."""
        if points is not None:
            offsets = _pattern_points(points, polar)
            if count is not None and count != len(offsets):
                raise FeatureError(f"This pattern has {len(offsets)} points but count={count!r}: leave out count when placing at points.")
            count = len(offsets)
        elif polar:
            raise FeatureError("polar=True reads points as (r, θ degrees): pass them as points=[(r, θ), …] or points=table(\"….csv\").")
        if not isinstance(count, int) or count < 1:
            raise FeatureError("A pattern needs a whole number of instances (count ≥ 1), or points to place them at.")
        base_name = name or getattr(component, "id", "item")
        names = []
        for i in range(count):
            if points is not None:
                local = offsets[i]
            elif direction is not None:
                if spacing is None:
                    raise FeatureError("A linear pattern needs spacing (mm between instances).")
                d = cq.Vector(*map(float, direction)).normalized() * (float(spacing) * i)
                local = cq.Location(d)
            else:
                step = float(angle) / (count if abs(float(angle) - 360.0) < 1e-9 else max(count - 1, 1))
                axis_vector = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}.get(axis, axis) if isinstance(axis, str) else axis
                local = cq.Location(cq.Vector(0, 0, 0), cq.Vector(*map(float, axis_vector)), step * i)
            placed = _location(at) * local if at is not None else local
            names.append(self.add(component, name=f"{base_name}_{i + 1}", print=print))
            self.instances[-1].update(location=placed, at={"pattern": base_name, "index": i})
        return names

    # ───────── joints and motion (docs/MOTION.md) ─────────
    #
    # A joint lets a child instance move relative to its parent: about an axis (revolute), along it
    # (slider), both (cylindrical), or not at all (rigid). Axes come from geometry (a cylindrical
    # face's axis, a planar face's normal, a straight or circular edge), never typed numbers unless
    # given literally. Joints never change geometry: the build reports them, and the viewer moves
    # instances. Instances that no joint moves are grounded.

    def rigid(self, name: str, parent, child) -> str:
        """Fastens `child` to `parent`: it moves with it."""
        return self._joint(name, "rigid", parent, child, None, None, 0.0)

    def revolute(self, name: str, parent, child, axis, limits=None, value: float = 0.0, follow: bool = False) -> str:
        """`child` turns about `axis` (degrees, right-handed); `limits=(min, max)` in degrees. `follow=True`: it moves only
        through the couplings that gear it (its own value stays at `value`); poses, drives and studies set those instead."""
        return self._joint(name, "revolute", parent, child, axis, limits, value, follow=follow)

    def slider(self, name: str, parent, child, axis, limits=None, value: float = 0.0, follow: bool = False) -> str:
        """`child` slides along `axis` (mm); `limits=(min, max)` in mm. `follow=True`: it moves only through its couplings."""
        return self._joint(name, "slider", parent, child, axis, limits, value, follow=follow)

    def cylindrical(self, name: str, parent, child, axis, limits=None, slide_limits=None, value: float = 0.0, slide: float = 0.0,
                    follow: bool = False) -> str:
        """`child` turns about and slides along `axis`: `limits` in degrees, `slide_limits` in mm. `follow=True`: both
        motions move only through couplings (`<joint>.turn` and `<joint>.travel` each geared)."""
        return self._joint(name, "cylindrical", parent, child, axis, limits, value, slide_limits=slide_limits, slide=slide, follow=follow)

    def couple(self, name: str, gears: dict, limits=None, value: float = 0.0) -> str:
        """A coupling: one input that moves several joints together in fixed ratios (gears, belts, rack and pinion).
        `gears` maps each joint to its ratio: at coupling value x, the joint moves by x·ratio on top of its own value
        (degrees for turning, mm for sliding). A cylindrical joint's two motions are `<joint>.turn` and `<joint>.travel`.
        `limits=(min, max)` bound the coupling; the limits of the joints it gears bound it too. Drive and pose it like a joint."""
        if not isinstance(name, str) or not ID.fullmatch(name):
            raise FeatureError(f"Coupling name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
        if any(j["name"] == name for j in self.joints) or any(c["name"] == name for c in self.couplings):
            raise FeatureError(f"There is already a joint or coupling named {name!r}.")
        if not isinstance(gears, dict) or not gears:
            raise FeatureError(f"Coupling {name!r}: gears must map joints to ratios, e.g. {{\"sun\": 1, \"carrier\": 0.25}}.")
        ratios = {}
        for key, ratio in gears.items():
            if not isinstance(key, str) or not key:
                raise FeatureError(f"Coupling {name!r}: {key!r} isn't a joint name.")
            if isinstance(ratio, bool) or not isinstance(ratio, (int, float)) or not math.isfinite(ratio) or ratio == 0:
                raise FeatureError(f"Coupling {name!r}: the ratio for {key!r} must be a finite nonzero number, not {ratio!r}.")
            ratios[key] = float(ratio)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise FeatureError(f"Coupling {name!r}: value must be a number, not {value!r}.")
        self.couplings.append({"name": name, "gears": ratios, "limits": _range(limits, f"coupling {name}"), "value": float(value)})
        return name

    def drive(self, joint: str, speed: float | None = None, range=None, check: bool = False, samples: int = 24, mode: str | None = None) -> None:
        """Animates a joint or coupling: `speed` in degrees (or mm) per second; it sweeps `range` (default: its limits)
        back and forth, or turns continuously when it only turns joints without limits. `check=True` sweeps it at the build
        and reports which instances collide, and where (exact solids, `samples` poses across the range). `mode`: a
        design.mode whose limits it sweeps and stops at (default: the code's own limits)."""
        if speed is not None and (isinstance(speed, bool) or not isinstance(speed, (int, float)) or speed == 0):
            raise FeatureError(f"A drive's speed must be a nonzero number (degrees or mm per second), not {speed!r}.")
        if not isinstance(samples, int) or not 2 <= samples <= 360:
            raise FeatureError(f"Drive {joint!r}: samples must be a whole number from 2 to 360.")
        self.drives.append({"joint": joint, "speed": float(speed) if speed is not None else None, "range": _range(range, f"drive {joint}"),
                            "check": bool(check), "samples": samples, "mode": _mode_name(mode, f"Drive {joint!r}")})

    def pose(self, name: str, mode: str | None = None, **values) -> None:
        """A named set of joint (or coupling) values, e.g. `design.pose("open", lid=110)`. `mode`: the design.mode it is in;
        what it sets must be within that mode's limits, and joints its couplings drive stop at them."""
        if mode is not None and not isinstance(mode, str):  # A joint named "mode".
            values, mode = {"mode": mode, **values}, None
        for joint, value in values.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise FeatureError(f"Pose {name!r}: {joint} must be a number, not {value!r}.")
        self.poses[name] = {joint: float(value) for joint, value in values.items()}
        if mode is not None:
            self.pose_modes[name] = _mode_name(mode, f"Pose {name!r}")
        else:
            self.pose_modes.pop(name, None)

    def mode(self, name: str, limits=None, travel_limits=None) -> str:
        """A named set of tighter limits (a mode: full and limited travel, a selectable stop): while it is selected, each
        joint or coupling in `limits={name: (min, max)}` (degrees or mm, as the joint's own) and each cylindrical joint in
        `travel_limits={name: (min, max)}` (mm) has those limits instead of its declared ones, and couplings' bounds follow.
        The code's own limits are the default mode; a mode only tightens them. Drives, poses, animations, collision studies
        and fit checks name it with `mode="<name>"`; the viewer's Motion panel switches between modes."""
        if not isinstance(name, str) or not ID.fullmatch(name):
            raise FeatureError(f"Mode name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
        if name == "default":
            raise FeatureError("The code's own limits are the default mode; give this mode another name, e.g. \"limited\".")
        if any(m["name"] == name for m in self.modes):
            raise FeatureError(f"There is already a mode named {name!r}.")
        if len(self.modes) >= MODES_MAX:
            raise FeatureError(f"A design has at most {MODES_MAX} modes.")
        parsed = {}
        for option, given in (("limits", limits), ("travel_limits", travel_limits)):
            if given is not None and not isinstance(given, dict):
                raise FeatureError(f"Mode {name!r}: {option} must map joints or couplings to (min, max), e.g. {{\"flap\": (-10, 10)}}.")
            parsed[option] = {}
            for target, span in (given or {}).items():
                if not isinstance(target, str) or not target:
                    raise FeatureError(f"Mode {name!r}: {target!r} isn't a joint or coupling name.")
                parsed[option][target] = _range(span, f"Mode {name!r}: {target}")
        if not parsed["limits"] and not parsed["travel_limits"]:
            raise FeatureError(f"Mode {name!r}: name the limits it sets, e.g. design.mode({name!r}, limits={{\"flap\": (-10, 10)}}).")
        self.modes.append({"name": name, **parsed})
        return name

    def animation(self, name: str, keys, loop: bool = False, easing: str = "ease", check: bool = False, samples: int = 48,
                  mode: str | None = None) -> str:
        """A keyframed animation: `keys` lists (pose, seconds) in time order, e.g. `[("closed", 0), ("open", 2), ("open", 3),
        ("closed", 5)]`. A pose is a name from `design.pose(...)` or a dict of joint/coupling values; what a key doesn't name
        keeps its value from the key before (the code's pose at the start). Between keys every value moves from one key to
        the next (`easing`: "linear", or "ease" for a smooth start and stop); the same pose twice holds. `loop=True` plays
        it over and over. `check=True` sweeps it at the build (exact solids, `samples` poses across its length) and reports
        which instances collide, and when. `mode`: the design.mode it plays in (its keys within that mode's limits; the
        viewer switches to it when it plays)."""
        if not isinstance(name, str) or not ID.fullmatch(name):
            raise FeatureError(f"Animation name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
        if any(a["name"] == name for a in self.animations):
            raise FeatureError(f"There is already an animation named {name!r}.")
        if not isinstance(keys, (list, tuple)) or len(keys) < 2:
            raise FeatureError(f"Animation {name!r}: keys must list at least two (pose, seconds) pairs, e.g. [(\"closed\", 0), (\"open\", 2)].")
        parsed, last = [], None
        for index, key in enumerate(keys, start=1):
            if not isinstance(key, (list, tuple)) or len(key) != 2:
                raise FeatureError(f"Animation {name!r}: key {index} must be a (pose, seconds) pair, not {key!r}.")
            pose, time = key
            if isinstance(time, bool) or not isinstance(time, (int, float)) or not math.isfinite(time) or time < 0:
                raise FeatureError(f"Animation {name!r}: key {index}'s time must be zero or more seconds, not {time!r}.")
            if last is not None and time < last:
                raise FeatureError(f"Animation {name!r}: key {index} at {time:g} s comes before the key before it ({last:g} s); list keys in time order.")
            if isinstance(pose, str) and pose:
                parsed.append({"pose": pose, "time": float(time)})
            elif isinstance(pose, dict) and pose:
                for target, value in pose.items():
                    if not isinstance(target, str) or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                        raise FeatureError(f"Animation {name!r}: key {index} sets {target!r} to {value!r}; use joint or coupling names and numbers.")
                parsed.append({"values": {target: float(value) for target, value in pose.items()}, "time": float(time)})
            else:
                raise FeatureError(f"Animation {name!r}: key {index}'s pose must be a pose name or a dict of joint values, not {pose!r}.")
            last = time
        if parsed[-1]["time"] <= parsed[0]["time"]:
            raise FeatureError(f"Animation {name!r}: its keys are all at {parsed[0]['time']:g} s; give the last key a later time.")
        if easing not in EASINGS:
            raise FeatureError(f"Animation {name!r}: easing must be \"linear\" or \"ease\", not {easing!r}.")
        if not isinstance(samples, int) or isinstance(samples, bool) or not 2 <= samples <= 360:
            raise FeatureError(f"Animation {name!r}: samples must be a whole number from 2 to 360.")
        if any(e["name"] == name for e in self.explodes):
            raise FeatureError(f"There is already an explode named {name!r}; animations and explodes share the timeline, so their names differ.")
        mode = _mode_name(mode, f"Animation {name!r}")
        self.animations.append({"name": name, "keys": parsed, "loop": bool(loop), "easing": easing, "check": bool(check), "samples": samples,
                                **({"mode": mode} if mode else {})})
        return name

    def explode(self, name: str, steps=None, auto: bool = False, duration: float = 1.0, hold: float = 0.25, easing: str = "ease",
                loop: bool = False, gap: float | None = None) -> str:
        """A named exploded view the viewer plays like an animation (Motion timeline, share page, inspect_model's
        explode=). Display only: placements, the STEP, the BOM and every check stay as built. `steps` move instances in
        order, each step's moves added to everything before it: {"move": instances, "by": (x, y, z)} (mm, design frame),
        {"move": instances, "along": "+Z" or (dx, dy, dz), "distance": mm}, or {"move": screws, "out": True} (placed
        screws of design.fasten(..., instance=...) out along their own axis, 1.5 × their length, or out=<mm>), or
        {"moves": {instance: (x, y, z), …}} (parts going different ways at once); the short form is (instances, (x, y, z)). Instances: a name, a pattern ("screw_*"), a fastener's name, or a linked design's
        instance by path ("gearbox/housing"); a list moves several together. Each step moves over `duration` seconds
        (`easing` "ease" or "linear") then holds `hold` seconds; a step's own "duration", "hold" and "name" override.
        `auto=True` works out a teardown from the geometry instead: assembly_steps reversed (else layer by layer), placed
        screws first along their axes, each part along the ±X/±Y/±Z it can slide out by, `gap` mm clear of the rest
        (bounding boxes; default 5 % of the design's size). `loop=True` plays it over and over."""
        from .explodes import EXPLODES_MAX, declaration
        if any(e["name"] == name for e in self.explodes) or any(a["name"] == name for a in self.animations):
            raise FeatureError(f"There is already an animation or explode named {name!r}; they share the timeline, so their names differ.")
        if len(self.explodes) >= EXPLODES_MAX:
            raise FeatureError(f"A design has at most {EXPLODES_MAX} explodes.")
        self.explodes.append(declaration(name, steps, auto, duration, hold, easing, loop, gap))
        return name

    def collision_study(self, name: str, joints=None, sampling: str = "random", samples: int | None = None, steps=None, seed: int = 0, poses=None,
                        hold=None, ranges=None, ignore=None, pairs=None, clearance: float = 0.0, boundary=None, tolerance: float = 0.1,
                        boundary_values: int = 11, map=None, animation: str | None = None, at=None, between=None, mode: str | None = None) -> str:
        """Self-collision across combinations of joint values (joint space), not one path: finds clashes that only happen
        when several joints move together. `joints` lists the joints or couplings that vary, over their limits (or
        `ranges={joint: (min, max)}`); everything else stays at `hold` (a pose name or values; default the code's pose).
        `sampling`: "random" (`samples` poses, default 400, reproducible with `seed`), "grid" (`steps` in degrees or mm,
        one number or per joint; default about `samples` poses), "poses" (`poses`: pose names or dicts of values, e.g. a
        recorded motion; every colliding one is listed) or "animation" (the poses of `animation`, as it plays: `at="keys"`
        at each key's time, `at=[seconds, …]` at those times, or else `samples` times evenly across it (default the
        animation's own samples); `between=(t0, t1)` keeps to that window; every colliding pose is listed with its time,
        and with `pairs`, each listed pair's closest approach over the motion). Every two instances that move relative to each other are checked with
        exact solids, except `ignore`d pairs (designed contacts) and those already overlapping in the code's pose; `pairs`
        checks only the pairs it lists. Each colliding pair reports its overlap volume and depth with a witness point.
        `clearance` (mm) also reports near misses closer than that, with their closest points. `boundary=(a, b)` finds
        b's first contact, moving away from its held value, at `boundary_values` values of a across its range (to
        `tolerance`). `map=(a, b)` maps which pair collides over two joints (default for a two-joint grid). Pairs whose
        instances both have `design.collision_shape`s also score those shapes against the exact solids. `mode`: the
        design.mode whose limits its joints vary over and stop at (one following an animation defaults to the animation's)."""
        label = f"Collision study {name!r}"
        mode = _mode_name(mode, label)
        if not isinstance(name, str) or not ID.fullmatch(name):
            raise FeatureError(f"Collision study name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
        if any(s["name"] == name for s in self.studies):
            raise FeatureError(f"There is already a collision study named {name!r}.")
        if sampling not in SAMPLINGS:
            raise FeatureError(f"{label}: sampling must be \"grid\", \"random\", \"poses\" or \"animation\", not {sampling!r}.")
        names = [joints] if isinstance(joints, str) else list(joints) if isinstance(joints, (list, tuple)) else [] if joints is None else None
        if names is None or not all(isinstance(n, str) and n for n in names) or len(set(names)) != len(names):
            raise FeatureError(f"{label}: joints must list joint or coupling names once each, e.g. [\"joint_1\", \"joint_2\"].")
        if not names and sampling not in ("poses", "animation"):
            raise FeatureError(f"{label}: name the joints that vary, e.g. joints=[\"joint_1\", \"joint_2\"].")
        if samples is not None and (isinstance(samples, bool) or not isinstance(samples, int) or not 1 <= samples <= STUDY_SAMPLES):
            raise FeatureError(f"{label}: samples must be a whole number from 1 to {STUDY_SAMPLES}.")
        times = None
        if sampling == "animation":
            if not isinstance(animation, str) or not animation:
                raise FeatureError(f"{label}: sampling=\"animation\" needs animation=\"<name>\", one of the design's animations.")
            if names:
                raise FeatureError(f"{label}: the animation sets which joints move; leave out joints (hold sets the others).")
            seconds = lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and v >= 0  # noqa: E731
            if at == "keys" or at is None:
                times = at
            elif isinstance(at, (list, tuple)) and at and all(seconds(t) for t in at):
                if len(at) > STUDY_SAMPLES:
                    raise FeatureError(f"{label}: {len(at)} times; a build checks at most {STUDY_SAMPLES}.")
                times = sorted({float(t) for t in at})
            else:
                raise FeatureError(f"{label}: at must be \"keys\" or a list of times in seconds, e.g. at=[0.5, 1.2], not {at!r}.")
            if times is not None and samples is not None:
                raise FeatureError(f"{label}: give at or samples, not both.")
            if between is not None:
                if not (isinstance(between, (list, tuple)) and len(between) == 2 and all(seconds(t) for t in between) and between[0] < between[1]):
                    raise FeatureError(f"{label}: between must be (start, end) in seconds with start before end, e.g. between=(1, 3), not {between!r}.")
                between = [float(between[0]), float(between[1])]
        else:
            for option, value in (("animation", animation), ("at", at), ("between", between)):
                if value is not None:
                    raise FeatureError(f"{label}: {option} is for sampling=\"animation\".")
            samples = 400 if samples is None else samples
        if isinstance(seed, bool) or not isinstance(seed, int):
            raise FeatureError(f"{label}: seed must be a whole number, not {seed!r}.")
        positive = lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and v > 0  # noqa: E731
        if steps is not None and not positive(steps) and not (isinstance(steps, dict) and all(isinstance(k, str) and positive(v) for k, v in steps.items())):
            raise FeatureError(f"{label}: steps must be a positive number (degrees or mm) or one per joint, e.g. {{\"joint_1\": 2}}.")
        listed = []
        if sampling == "poses":
            if not isinstance(poses, (list, tuple)) or not poses:
                raise FeatureError(f"{label}: sampling=\"poses\" needs poses=[…], pose names or dicts of joint values.")
            if len(poses) > STUDY_SAMPLES:
                raise FeatureError(f"{label}: {len(poses)} poses; a build checks at most {STUDY_SAMPLES}. Check a recorded motion in parts, or sample it.")
            for index, pose in enumerate(poses, start=1):
                listed.append(_pose_values(pose, f"{label}: pose {index}"))
        elif poses is not None:
            raise FeatureError(f"{label}: poses are for sampling=\"poses\".")
        held = _pose_values(hold, f"{label}: hold") if hold is not None else None
        if ranges is not None and not isinstance(ranges, dict):
            raise FeatureError(f"{label}: ranges must map joints to (min, max), e.g. {{\"joint_1\": (-20, 30)}}.")
        spans = {key: _range(value, f"{label}: range of {key}") for key, value in (ranges or {}).items()}
        couples = []
        for option, items in (("ignore", ignore), ("pairs", pairs)):
            if items is None:
                couples.append(None)
                continue
            if not isinstance(items, (list, tuple)) or not all(isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(n, str) for n in p) for p in items):
                raise FeatureError(f"{label}: {option} must list pairs of instance names, e.g. [(\"servo\", \"bracket\")].")
            couples.append([tuple(p) for p in items])
        if isinstance(clearance, bool) or not isinstance(clearance, (int, float)) or not math.isfinite(clearance) or clearance < 0:
            raise FeatureError(f"{label}: clearance must be zero or more mm, not {clearance!r}.")
        if boundary is not None and not (isinstance(boundary, (list, tuple)) and len(boundary) == 2 and all(isinstance(n, str) for n in boundary)
                                         and boundary[0] != boundary[1]):
            raise FeatureError(f"{label}: boundary must name two joints, e.g. boundary=(\"joint_1\", \"joint_2\").")
        if not positive(tolerance):
            raise FeatureError(f"{label}: tolerance must be a positive number (degrees or mm).")
        if isinstance(boundary_values, bool) or not isinstance(boundary_values, int) or not 2 <= boundary_values <= 101:
            raise FeatureError(f"{label}: boundary_values must be a whole number from 2 to 101.")
        if map is not None:
            if not (isinstance(map, (list, tuple)) and len(map) == 2 and all(isinstance(n, str) for n in map) and map[0] != map[1]):
                raise FeatureError(f"{label}: map must name two joints, e.g. map=(\"joint_1\", \"joint_2\").")
            if sampling in ("poses", "animation"):
                raise FeatureError(f"{label}: map is for sampling=\"grid\" or \"random\".")
        self.studies.append({"name": name, "joints": names, "sampling": sampling, "samples": samples, "steps": steps, "seed": seed, "poses": listed,
                             "hold": held, "ranges": spans, "ignore": couples[0] or [], "pairs": couples[1], "clearance": float(clearance),
                             "boundary": list(boundary) if boundary else None, "tolerance": float(tolerance), "boundary_values": boundary_values,
                             "map": list(map) if map else None,
                             **({"animation": animation, "at": times, "between": between} if sampling == "animation" else {}),
                             **({"mode": mode} if mode else {})})
        return name

    def collision_shape(self, instance: str, kind: str, size=None, at=(0, 0, 0), radius=None, start=None, end=None) -> None:
        """A simple collision shape for `instance`, as simulators use instead of its exact solids, in the instance's own
        (component) frame, mm: "box" (`size=(x, y, z)`, centred `at`), "sphere" (`radius`, centred `at`) or "capsule"
        (`radius`, from `start` to `end`). An instance may have several. Collision studies score them against the exact
        solids (detection, false positives, missed depth) for pairs whose instances both have shapes, and the MuJoCo
        export collides with them instead of the instance's mesh hull."""
        label = f"Collision shape of {instance!r}"
        if not isinstance(instance, str) or not instance:
            raise FeatureError(f"Collision shape: name the instance, e.g. design.collision_shape(\"arm\", \"capsule\", radius=12, start=(0, 0, 0), end=(0, 0, -80)).")
        if kind not in COLLISION_SHAPES:
            raise FeatureError(f"{label}: kind must be \"box\", \"sphere\" or \"capsule\", not {kind!r}.")
        number = lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)  # noqa: E731

        def point(value, what: str) -> list[float]:
            if not (isinstance(value, (list, tuple)) and len(value) == 3 and all(number(v) for v in value)):
                raise FeatureError(f"{label}: {what} must be a point (x, y, z) in mm, not {value!r}.")
            return [float(v) for v in value]

        shape = {"instance": instance, "type": kind}
        if kind == "box":
            if not (isinstance(size, (list, tuple)) and len(size) == 3 and all(number(v) and v > 0 for v in size)):
                raise FeatureError(f"{label}: a box needs size=(x, y, z), three positive lengths in mm.")
            shape.update(size=[float(v) for v in size], at=point(at, "at"))
        else:
            if not number(radius) or radius <= 0:
                raise FeatureError(f"{label}: a {kind} needs a positive radius in mm.")
            shape["radius"] = float(radius)
            if kind == "sphere":
                shape["at"] = point(at, "at")
            else:
                shape.update(start=point(start, "start"), end=point(end, "end"))
                if math.dist(shape["start"], shape["end"]) < 1e-6:
                    raise FeatureError(f"{label}: a capsule's start and end must differ; use a sphere for a point.")
        self.collision_shapes.append(shape)

    # ───────── simulation model export (runtime/steve/physics.py) ─────────
    #
    # Masses, frames and contact rules the MuJoCo export (Motion tab → Export → Simulation model) writes; the build
    # checks them and reports them as modelled in `kinematics.simulation`.

    def fill(self, instances, fraction: float) -> None:
        """Printed parts' infill: their mass (from material and exact volume) and inertia scale by `fraction` (0.4 for
        40 %) in the simulation model export. `instances`: names or patterns like "printed_*"."""
        from .physics import mass_override
        self.mass_overrides.append(mass_override("fill", instances, fraction=fraction))

    def mass(self, instances, grams: float, center=None) -> None:
        """A datasheet mass for each of `instances` (names or patterns, e.g. "servo_*") whose model is an envelope: the
        export uses `grams`, with the centre of mass and inertia of its solids at uniform density (no material needed),
        or the centre of mass at `center` (x, y, z) in the instance's own frame, mm."""
        from .physics import mass_override
        self.mass_overrides.append(mass_override("mass", instances, grams=grams, center=center))

    def measured_mass(self, instances, grams: float) -> None:
        """A weighed set of instances (names or patterns): the export scales their masses and inertias by one factor so
        they total `grams`, keeping their centre of mass. Applies after `fill` and `mass`."""
        from .physics import mass_override
        self.mass_overrides.append(mass_override("measured", instances, grams=grams))

    def lumped_mass(self, name: str, on: str, grams: float, at=(0, 0, 0), box=None) -> str:
        """A mass that isn't modelled as a solid (battery, cable bundle, ballast), fastened to instance `on` and exported
        with its link: centred `at`, a point (x, y, z) in `on`'s own frame (mm) or a face of it (`part.face("…")`,
        axes as for `site`), as a uniform box of `box=(x, y, z)` mm along those axes, or a point mass without one."""
        from .physics import lumped_mass
        if any(m["name"] == name for m in self.lumped_masses):
            raise FeatureError(f"There is already a lumped mass named {name!r}.")
        self.lumped_masses.append(lumped_mass(name, on, grams, at, box))
        return name

    def site(self, name: str, at, x_dir=None) -> str:
        """A named frame for controllers (IMU, foot centre, tool tip, camera), exported as a MuJoCo `<site>` on its
        instance's link. `at`: (instance, part.face("…")) (a planar face: origin at its centre, Z its outward normal,
        X along its first straight edge), (instance, (x, y, z)) (a point in the instance's own frame, mm, with its
        axes) or a face reference alone (a component placed once). `x_dir` (x, y, z), in the instance's frame, sets X."""
        from .physics import site
        if any(s["name"] == name for s in self.sites):
            raise FeatureError(f"There is already a site named {name!r}.")
        self.sites.append(site(name, at, x_dir))
        return name

    def collision_filter(self, instances, contype: int = 1, conaffinity: int = 1, group=None, condim=None, friction=None) -> None:
        """Contact filtering for the collision geoms of `instances` (names or patterns) in the simulation export:
        MuJoCo's `contype`/`conaffinity` bit masks (two geoms collide when one's contype shares a bit with the other's
        conaffinity; 0 and 0 only collide through `contact_pair`), and optionally `group` (0–5), `condim` (1, 3, 4, 6)
        and `friction` (sliding, or (sliding, torsional, rolling)). The last filter matching an instance applies."""
        from .physics import collision_filter
        self.collision_filters.append(collision_filter(instances, contype, conaffinity, group, condim, friction))

    def contact_pair(self, a: str, b: str, condim=None, friction=None) -> None:
        """An explicit contact between instances `a` and `b` (every collision geom of one against the other's), checked
        whatever their filter bits: self-collision between named parts only (an arm against the base)."""
        from .physics import contact_rule
        self.contact_pairs.append(contact_rule("pair", a, b, condim, friction))

    def contact_exclude(self, a: str, b: str) -> None:
        """Instances `a` and `b`'s links never collide in the simulation export (a parent and child never do anyway)."""
        from .physics import contact_rule
        self.contact_excludes.append(contact_rule("exclude", a, b))

    def contact(self, a: str, b: str, kind: str = "seated", max_overlap_mm3: float | None = None) -> None:
        """A contact that is meant to exist, for `design.fit_check`: instances `a` and `b` (names, or patterns like
        "screw_*"; "*" is any instance) may touch, and overlap by up to `max_overlap_mm3` of common volume. `kind`:
        "seated" (face to face) or "press_fit" (no overlap allowed unless `max_overlap_mm3` says how much), "threaded"
        (a screw in its hole: any overlap unless `max_overlap_mm3` is given). Fastening with `design.rigid` is not a
        contact: rigidly fastened parts still may not overlap. The first contact that matches a pair applies. A fit check's
        `contacts` say of each whether any pair it applies to touched (`touching`, at any pose checked) and, if none did,
        the `closest` of them with its gap: a seat that isn't seated is reported, not failed. Animation checks honour it
        too: a declared pair within its allowance is listed under `contacts`, not `collisions`."""
        label = f"Contact {a!r}/{b!r}"
        if not all(isinstance(n, str) and n for n in (a, b)):
            raise FeatureError(f"{label}: name two instances (or patterns like \"screw_*\"), e.g. design.contact(\"servo\", \"bracket\").")
        if kind not in CONTACTS:
            raise FeatureError(f"{label}: kind must be \"seated\", \"press_fit\" or \"threaded\", not {kind!r}.")
        if max_overlap_mm3 is not None and (isinstance(max_overlap_mm3, bool) or not isinstance(max_overlap_mm3, (int, float))
                                            or not math.isfinite(max_overlap_mm3) or max_overlap_mm3 < 0):
            raise FeatureError(f"{label}: max_overlap_mm3 must be zero or more mm³, not {max_overlap_mm3!r}.")
        allowance = float(max_overlap_mm3) if max_overlap_mm3 is not None else math.inf if kind == "threaded" else 0.0
        self.contacts.append({"a": a, "b": b, "kind": kind, "allowance": allowance})

    def clearance(self, default: float = 0.0, pairs=None) -> None:
        """The gap `design.fit_check` requires between instances with no declared contact: `default` mm for every pair,
        and `pairs={("plug", "shell"): 1.0}` for some (names or patterns; the last match applies). Touching is no gap."""
        positive = lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and v >= 0  # noqa: E731
        if not positive(default):
            raise FeatureError(f"Clearance: default must be zero or more mm, not {default!r}.")
        usage = "Clearance: pairs must map two instance names (or patterns) to mm, e.g. pairs={(\"plug\", \"shell\"): 1.0}."
        if pairs is not None and not isinstance(pairs, dict):
            raise FeatureError(usage)
        listed = []
        for key, gap in (pairs or {}).items():
            if not (isinstance(key, tuple) and len(key) == 2 and all(isinstance(n, str) and n for n in key)) or not positive(gap):
                raise FeatureError(usage)
            listed.append((key, float(gap)))
        self.gaps = {"default": float(default), "pairs": listed}

    def fit_check(self, name: str = "fit", instances=None, poses=None, motion: bool = True, samples: int = 24, refine: float = 0.1,
                  mode: str | None = None) -> str:
        """Interference and clearance at the build: every two instances (or each of `instances`, names or patterns, against
        everything) as modelled, at each named pose in `poses`, and with `motion=True` through every joint or coupling
        that moves one of them, over its limits in `samples` steps, refined between steps until each step moves the
        parts at most `refine` mm, so a contact between two samples isn't missed. Reports each pair that overlaps
        (exact common volume) or comes closer than its clearance (`design.clearance`), with witness points and the pose
        where it's worst; declared contacts (`design.contact`) are listed apart, and fail only past their allowance.
        `mode`: the design.mode whose limits it sweeps over and places its poses in."""
        label = f"Fit check {name!r}"
        mode = _mode_name(mode, label)
        if not isinstance(name, str) or not ID.fullmatch(name):
            raise FeatureError(f"Fit check name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
        if any(f["name"] == name for f in self.fits):
            raise FeatureError(f"There is already a fit check named {name!r}.")
        names = [instances] if isinstance(instances, str) else list(instances) if isinstance(instances, (list, tuple)) else None
        if instances is not None and (not names or not all(isinstance(n, str) and n for n in names)):
            raise FeatureError(f"{label}: instances must list instance names or patterns, e.g. [\"hip_bracket\", \"screw_*\"].")
        listed = [poses] if isinstance(poses, str) else list(poses) if isinstance(poses, (list, tuple)) else [] if poses is None else None
        if listed is None or not all(isinstance(p, str) and p for p in listed):
            raise FeatureError(f"{label}: poses must list pose names from design.pose(...), e.g. [\"home\", \"folded\"].")
        if isinstance(samples, bool) or not isinstance(samples, int) or not 2 <= samples <= 360:
            raise FeatureError(f"{label}: samples must be a whole number from 2 to 360.")
        if isinstance(refine, bool) or not isinstance(refine, (int, float)) or not math.isfinite(refine) or refine <= 0:
            raise FeatureError(f"{label}: refine must be a positive number of mm.")
        self.fits.append({"name": name, "instances": names, "poses": listed, "motion": bool(motion), "samples": samples, "refine": float(refine),
                          **({"mode": mode} if mode else {})})
        return name

    # ───────── fasteners (runtime/steve/fasteners.py) ─────────
    #
    # A declared screw joint: the screw, its axis, the parts it clamps and what it threads into. Every build measures it
    # on the geometry as built (holes, seat, engagement, bottoming, walls, clashes, driver access) and lists it in the BOM.

    def fasten(self, name: str, screw: str, axis, head_on=None, clamps=None, into: str | None = None, thread: str = "tapped",
               washer=None, fit: str = "normal", through: bool = False, step: str | None = None, driver: str | None = None,
               instance: str | None = None, insert=None, rules=None) -> str:
        """Declares a screw joint, checked at every build on the geometry as built. `screw`: standard, size and length,
        e.g. "ISO 4762 M3x8" (ISO 4762/DIN 912 socket head, ISO 7380 button, ISO 10642/DIN 7991 countersunk, ISO 4017/
        DIN 933 hex, ISO 7045 pan; M2–M12). `axis`: a hole wall or circular edge (bracket.face("bolt_hole.wall(0)")) or
        ((x, y, z), (dx, dy, dz)). `head_on`: the planar face the head (or washer) rests on, which sets the direction;
        a countersunk head sits flush with it. `clamps`: instances the screw passes through, head side first. `into`:
        the instance it threads into. `thread`: "tapped", "thread_forming" (a pilot in plastic), "insert" (heat-set;
        `insert=(bore_mm, length_mm)` overrides the standard one) or "nut" (on the far side; no `into`). `washer=True`:
        an ISO 7089 washer under the head. `fit`: "close", "normal" or "loose" clearance holes (ISO 273). `through=True`
        allows the tip out of the far side. `step` (from design.assembly_steps) and `driver` ("hex_2.5", "ph2",
        "socket_7" or design.tool(...)) add the driver-access and insertion checks. `instance`: a placed screw part that
        is this fastener (not clashed, counted once in the BOM). `rules`: overrides, as design.fastener_rules."""
        from .fasteners import FASTENERS_MAX, declaration
        if any(f["name"] == name for f in self.fasteners):
            raise FeatureError(f"There is already a fastener named {name!r}.")
        if len(self.fasteners) >= FASTENERS_MAX:
            raise FeatureError(f"A design checks at most {FASTENERS_MAX} fasteners.")
        self.fasteners.append(declaration(name, screw, axis, head_on, clamps, into, thread, washer, fit, through, step, driver, instance, insert, rules))
        return name

    def fasten_pattern(self, name: str, screw: str, axes, head_on=None, **options) -> list[str]:
        """The same fastener on every hole of a pattern: `axes` lists axes, or is one face reference whose hole walls
        lie on several axes (one fastener each). Named `<name>_1`, `<name>_2`, … in a stable order; the other
        arguments are design.fasten's."""
        from .fasteners import pattern_axes
        return [self.fasten(f"{name}_{index}", screw, axis, head_on=head_on, **options)
                for index, axis in enumerate(pattern_axes(axes, f"Fastener pattern {name!r}"), start=1)]

    def assembly_steps(self, steps) -> list[str]:
        """The order instances are installed, for driver access: a list of steps, each an instance name, a list of them
        or a (name, [instances]) pair, or a dict {step: [instances]} (patterns like "screw_*" work). A fastener is
        driven at its `step` (default: the step of its last part), past everything installed up to then. Declaring
        steps checks driver access and insertion for every fastener."""
        from .fasteners import steps as parse
        self.steps = parse(steps)
        return [name for name, _ in self.steps]

    def tool(self, name: str, shaft_d: float, min_free_mm: float = 20.0, handle_d: float | None = None, handle_from_mm: float | None = None) -> str:
        """A driver profile for design.fasten(driver=...): a shaft of `shaft_d` mm that must be clear for `min_free_mm`
        above the head, and optionally a handle of `handle_d` mm from `handle_from_mm` (reported, not failed). Built in:
        hex_<key> (an L-key, 20 mm), ph1…ph4 (screwdrivers, 45 mm) and socket_<across flats> (nut drivers, 45 mm)."""
        from .fasteners import tool
        self.tools[name] = tool(name, shaft_d, min_free_mm, handle_d, handle_from_mm)
        return name

    def fastener_rules(self, **rules) -> None:
        """Overrides the fastener checks' generic rules for this design: min_engagement_d (× diameter; default 1.5
        tapped, 2.0 thread-forming), pilot_ratio (0.85, or a range like (0.8, 0.9)), min_wall_mm (default by print
        process: FDM 1.6, otherwise 1.0), bottom_gap_mm (0.5), screw_gap_mm (0.5), head_proud_mm (0) and
        hole_tolerance_mm (0.1)."""
        from .fasteners import rules as parse
        self.fastener_overrides = {**self.fastener_overrides, **parse(rules, "Fastener rules")}

    # ───────── cables and harnesses (runtime/steve/cables.py) ─────────
    #
    # A flexible element whose path points are fastened to instances: redrawn at every pose the build checks, and checked
    # for clearance, contact, cable-to-cable gaps, connector housings, bend radius and length change. A BOM line each.

    def cable(self, name: str, diameter: float, start, end, via=None, min_bend_radius: float | None = None, clearance: float = 0.5,
              slack_mm: float = 0.0, max_slack_mm: float | None = None, connector_start=None, connector_end=None,
              conductors: int | None = None, ignore=None) -> str:
        """A cable whose path points are fastened to instances, so it moves with the mechanism. `start`, `end` and each of
        `via` are (instance, (x, y, z)) (where the point is in the design as modelled, every joint at 0), (instance,
        part.face("…")) (a face's centre; a planar end face sets the direction the cable leaves it), a reference alone,
        or (x, y, z) fixed in the design. Between them the cable is a smooth curve, redrawn at every pose: the code's
        pose, each named pose, along every drive and animation and at each collision study's poses. Checked there:
        `clearance` (mm) to every part (contact is a fail), other cables (no overlap; `design.harness` sets a spacing),
        `min_bend_radius` (mm, from the datasheet), and length: its length is the path as modelled plus `slack_mm`,
        a pose needing more is a stretch fail, and more than `max_slack_mm` spare is a slack fail. `connector_start` /
        `connector_end`: a housing (length along the cable, width, height in mm), checked against every part but the
        one at that end, or a name for the BOM, or {"name": …, "size": (…)}. `ignore`: instances it may touch (clips).
        `diameter` is the outer diameter (mm); `conductors` is listed in the BOM with the cut length."""
        from .cables import CABLES_MAX, declaration
        if any(c["name"] == name for c in self.cables):
            raise FeatureError(f"There is already a cable named {name!r}.")
        if len(self.cables) >= CABLES_MAX:
            raise FeatureError(f"A design checks at most {CABLES_MAX} cables.")
        self.cables.append(declaration(name, diameter, start, end, via, min_bend_radius, clearance, slack_mm, max_slack_mm,
                                       connector_start, connector_end, conductors, ignore))
        return name

    def harness(self, name: str, cables, spacing: float = 0.0) -> str:
        """Cables routed together: every two of them stay at least `spacing` mm apart (surface to surface) at every pose
        checked. Route them side by side through their own via points (a diameter plus the spacing apart)."""
        from .cables import harness
        if any(h["name"] == name for h in self.harnesses):
            raise FeatureError(f"There is already a harness named {name!r}.")
        self.harnesses.append(harness(name, cables, spacing))
        return name

    def _joint(self, name, type_, parent, child, axis, limits, value, slide_limits=None, slide=0.0, follow=False) -> str:
        if not isinstance(name, str) or not ID.fullmatch(name):
            raise FeatureError(f"Joint name {name!r} must be lowercase letters, digits and underscores, starting with a letter.")
        if any(j["name"] == name for j in self.joints) or any(c["name"] == name for c in self.couplings):
            raise FeatureError(f"There is already a joint or coupling named {name!r}.")
        if type_ != "rigid" and axis is None:
            raise FeatureError(f"Joint {name!r} needs an axis: a face or edge (e.g. axis=frame.face(\"pivot.side(c1)\")), \"X\"/\"Y\"/\"Z\", "
                               "or ((x, y, z), (dx, dy, dz)).")
        for label, number in (("value", value), ("slide", slide)):
            if isinstance(number, bool) or not isinstance(number, (int, float)):
                raise FeatureError(f"Joint {name!r}: {label} must be a number, not {number!r}.")
        if not isinstance(follow, bool):
            raise FeatureError(f"Joint {name!r}: follow must be True or False, not {follow!r}.")
        self.joints.append({"name": name, "type": type_, "parent": parent, "child": child, "axis": axis,
                            "limits": _range(limits, f"joint {name}"), "slide_limits": _range(slide_limits, f"joint {name}"),
                            "value": float(value), "slide": float(slide), "follow": follow})
        return name

    def _instance(self, item, joint: str, role: str) -> dict:
        """An instance by name, the one returned by add/pattern, or a component placed exactly once."""
        if isinstance(item, str):
            found = [i for i in self.instances if i["name"] == item]
            if found:
                return found[0]
            names = ", ".join(i["name"] for i in self.instances)
            raise FeatureError(f"Joint {joint!r}: {role} {item!r} isn't an instance of this design (instances: {names}).")
        found = [i for i in self.instances if i["component"] is item or (getattr(item, "alias", None) and getattr(i["component"], "alias", None) == item.alias)]
        if len(found) == 1:
            return found[0]
        label = getattr(item, "id", repr(item))
        if not found:
            raise FeatureError(f"Joint {joint!r}: {role} {label} isn't placed in this design; add it first.")
        raise FeatureError(f"Joint {joint!r}: {label} is placed {len(found)} times; name the instance "
                           f"({', '.join(i['name'] for i in found)}).")

    def _axis(self, joint: dict, parent: dict, child: dict) -> tuple[cq.Vector, cq.Vector]:
        """The joint axis in the design frame (origin, unit direction) at the zero pose."""
        axis = joint["axis"]
        if isinstance(axis, str) and axis in ("X", "Y", "Z"):
            return cq.Vector(0, 0, 0), cq.Vector(*{"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}[axis])
        if isinstance(axis, (list, tuple)) and len(axis) == 2 and all(isinstance(v, (list, tuple)) and len(v) == 3 for v in axis):
            origin, direction = cq.Vector(*map(float, axis[0])), cq.Vector(*map(float, axis[1]))
            if direction.Length < 1e-12:
                raise FeatureError(f"Joint {joint['name']!r}: the axis direction is zero.")
            return origin, direction.normalized()
        if isinstance(axis, Ref):
            component, ref = axis.component, axis.ref
            owner = parent if parent["component"] is component else child if child["component"] is component else \
                next((i for i in self.instances if i["component"] is component), None)
        elif isinstance(axis, str):
            owner = parent if isinstance(parent["component"], Component) else child
            component, ref = owner["component"], axis
            if not isinstance(component, Component):
                raise FeatureError(f"Joint {joint['name']!r}: name the axis on a component, e.g. axis=frame.face({axis!r}).")
        else:
            raise FeatureError(f"Joint {joint['name']!r}: the axis must be a face or edge reference, \"X\"/\"Y\"/\"Z\" or ((x, y, z), (dx, dy, dz)).")
        origin, direction = _geometry_axis(component, ref, joint["name"])
        if owner is not None:  # References follow the unplaced component; joints act where the instance is.
            placed = owner["location"]
            origin = _move(placed, origin)
            direction = _turn(placed, direction)
        return origin, direction

    def _kinematics(self) -> dict:
        """Joints resolved to the design frame, and the couplings that gear them: the kinematic tree the viewer animates."""
        self._exact = None  # Each build (result()) measures its own instances.
        joints, parents = [], {}
        for joint in self.joints:
            try:
                parent = self._instance(joint["parent"], joint["name"], "parent")
                child = self._instance(joint["child"], joint["name"], "child")
                if parent is child:
                    raise FeatureError(f"Joint {joint['name']!r} joins {child['name']} to itself.")
                if child["name"] in parents:
                    raise FeatureError(f"{child['name']} is already moved by joint {parents[child['name']]!r}; an instance has one parent joint "
                                       f"(closed loops come later). Make {joint['name']!r} rigid on another instance, or remove it.")
                origin, direction = self._axis(joint, parent, child) if joint["type"] != "rigid" else (cq.Vector(0, 0, 0), cq.Vector(0, 0, 1))
                # The tree may not loop back: walking up from the parent must never reach the child.
                up = parent["name"]
                while up in parents:
                    up = next(j["parent"] for j in joints if j["name"] == parents[up])
                    if up == child["name"]:
                        raise FeatureError(f"Joint {joint['name']!r} closes a loop ({child['name']} → … → {parent['name']}); closed loops come later.")
                parents[child["name"]] = joint["name"]
                entry = {"name": joint["name"], "type": joint["type"], "parent": parent["name"], "child": child["name"],
                         "origin": [round(v, 9) for v in origin.toTuple()], "axis": [round(v, 12) for v in direction.toTuple()],
                         "limits": joint["limits"], "value": joint["value"]}
                if joint["type"] == "cylindrical":
                    entry.update(slide_limits=joint["slide_limits"], slide=joint["slide"])
                if joint.get("follow") and joint["type"] != "rigid":
                    entry["follows"] = True
                joints.append(entry)
            except FeatureError as error:
                self.errors.append(str(error))
        couplings = self._couplings(joints)
        # A joint's position is its own value plus what its couplings add; as written it must be within the joint's
        # limits (elsewhere a driven joint stops at them).
        live = _effective(joints, couplings, clamp=False)
        for joint in joints:
            value, slide = live[joint["name"]]
            for low_high, current, unit in ((joint["limits"], value, "°" if joint["type"] != "slider" else " mm"),
                                            (joint.get("slide_limits"), slide, " mm")):
                if low_high and not low_high[0] - 1e-9 <= current <= low_high[1] + 1e-9:
                    via = " with its couplings" if joint.get("driven_by") else ""
                    self.errors.append(f"Joint {joint['name']!r}: {current:g}{unit}{via} is outside its limits {low_high[0]:g}…{low_high[1]:g}{unit}.")
        names = {j["name"] for j in joints}
        coupled = {c["name"]: c for c in couplings}
        modes = self._modes(joints, couplings)
        by_mode = {m["name"]: m for m in modes}
        declared_modes = {m["name"] for m in self.modes}

        def in_mode(mode: str | None, label: str) -> tuple[list[dict], list[dict]]:
            """The joints and couplings with `mode`'s limits and bounds (the code's own without one)."""
            if mode is None:
                return joints, couplings
            if mode not in by_mode:
                known = ", ".join(m["name"] for m in self.modes) or "none yet; add design.mode(…) first"
                raise FeatureError(f"{label}: mode {mode!r} " + ("has an error; fix it first." if mode in declared_modes else f"isn't defined (modes: {known})."))
            return _in_mode(joints, couplings, by_mode[mode])

        self._context, self.reused_checks = self._check_context(joints, couplings), 0
        drives, sweeps = [], []
        for drive in self.drives:
            target = drive["joint"]
            try:
                mode_joints, mode_couplings = in_mode(drive["mode"], f"Drive {target!r}")
            except FeatureError as error:
                self.errors.append(str(error))
                continue
            coupling = next((c for c in mode_couplings if c["name"] == target), None)
            joint = next((j for j in mode_joints if j["name"] == target), None)
            if coupling is None and joint is None:
                declared = {j["name"] for j in self.joints} | {c["name"] for c in self.couplings}
                self.errors.append(f"Drive: {target!r} isn't a joint or coupling of this design" + (" (it has an error)." if target in declared else "."))
                continue
            if joint is not None and joint["type"] == "rigid":
                self.errors.append(f"Drive: joint {joint['name']!r} is rigid; drive a revolute, slider or cylindrical joint.")
                continue
            if problem := _follower_set(joints, [target]):
                self.errors.append(f"Drive: {problem}.")
                continue
            if coupling is not None:
                sweep = drive["range"] or coupling["bounds"]
                slides = any(_dof_kind(joints, key) == "travel" for key in coupling["gears"])
                if sweep is None and slides:
                    self.errors.append(f"Drive: coupling {target!r} moves a sliding joint without limits; give it limits or a range, "
                                       f"e.g. design.drive({target!r}, range=(0, 40)).")
                    continue
                speed = drive["speed"] or (90.0 if not slides else max(abs(sweep[1] - sweep[0]) / 2, 1.0))
            else:
                sweep = drive["range"] or joint["limits"]
                if sweep is None and joint["type"] == "slider":
                    self.errors.append(f"Drive: slider {joint['name']!r} needs limits or a range to sweep, e.g. design.drive({joint['name']!r}, range=(0, 40)).")
                    continue
                speed = drive["speed"] or (90.0 if joint["type"] != "slider" else max(abs(sweep[1] - sweep[0]) / 2, 1.0))
            entry = {"joint": target, "speed": speed, "range": sweep, **({"coupling": True} if coupling is not None else {}),
                     **({"mode": drive["mode"]} if drive["mode"] else {})}
            if held := _drive_held(mode_joints, mode_couplings, target, sweep or [-180.0, 180.0], drive["samples"]):
                entry["saturated"] = held
            if drive["check"] and not _SHEETS_ONLY:
                progress.stage("drives", target, of=drive["samples"])
                swept = sweep or [-180.0, 180.0]
                entry["check"] = self._reuse("drive", {"target": target, "range": swept, "samples": drive["samples"],
                                                       **({"mode": drive["mode"]} if drive["mode"] else {})},
                                             lambda budget, target=target, swept=swept, samples=drive["samples"], mj=mode_joints, mc=mode_couplings:
                                             self._sweep(mj, mc, target, swept, samples, budget))
            drives.append(entry)
            sweeps.append((target, sweep or [-180.0, 180.0], drive["samples"]))
        poses, followers = {}, {j["name"] for j in joints if j.get("follows")}
        for name, values in self.poses.items():
            unknown = sorted(set(values) - names - set(coupled))
            if unknown:
                self.errors.append(f"Pose {name!r}: {', '.join(unknown)} {'is not a joint or coupling' if len(unknown) == 1 else 'are not joints or couplings'} of this design.")
            if problem := _follower_set(joints, values):
                self.errors.append(f"Pose {name!r}: {problem}.")
            poses[name] = {k: v for k, v in values.items() if (k in names or k in coupled) and k not in followers}
        stopped, pose_modes = {}, {}  # Each named pose's driven joints that stop at a limit there; each pose's mode.
        for name, values in poses.items():
            mode = self.pose_modes.get(name)
            try:
                mode_joints, mode_couplings = in_mode(mode, f"Pose {name!r}")
            except FeatureError as error:
                self.errors.append(str(error))
                continue
            if mode is not None:
                pose_modes[name] = mode
                # What the pose sets itself must be within its mode's limits.
                if problem := _limit_problem([j for j in mode_joints if j["name"] in values], [c for c in mode_couplings if c["name"] in values],
                                             *_animation_frame(joints, values)):
                    self.errors.append(f"Pose {name!r} in mode {mode!r}: {problem}.")
            _effective(mode_joints, mode_couplings, *_animation_frame(joints, values), saturated=stopped.setdefault(name, []))
        stopped = {name: items for name, items in stopped.items() if items}
        animations = self._animations(joints, couplings, poses, in_mode)
        explodes = self._explodes(joints, couplings)
        shapes = self._collision_shapes()
        from .physics import resolve
        simulation = resolve(self)
        studies = []
        for study in self.studies if self.cables or not _SHEETS_ONLY else ():  # The cables are checked at its poses.
            progress.stage("collision_study", study["name"])
            try:
                # A study that follows an animation is in the animation's mode unless it names its own.
                mode = study.get("mode") or next((a.get("mode") for a in animations if a["name"] == study.get("animation")), None)
                mj, mc = in_mode(mode, f"Collision study {study['name']!r}")
                if self.cables:  # Its poses are the cables' too (`_study_poses`): checked at this build.
                    result = self._study(study, mj, mc, poses, self._budget(), animations)
                else:
                    played = [{k: v for k, v in a.items() if k != "check"} for a in animations]
                    result = self._reuse("study", {"study": study, "animations": played, **({"mode": mode} if mode else {})},
                                         lambda budget, study=study, mj=mj, mc=mc: self._study(study, mj, mc, poses, budget, animations))
                studies.append({**result, "mode": mode} if mode else result)
            except FeatureError as error:
                self.errors.append(str(error))
        fits = []
        for fit in () if _SHEETS_ONLY else self.fits:
            progress.stage("fit_check", fit["name"])
            try:
                mj, mc = in_mode(fit.get("mode"), f"Fit check {fit['name']!r}")
                result = self._reuse("fit", {"fit": fit}, lambda budget, fit=fit, mj=mj, mc=mc: self._fit(fit, mj, mc, poses, budget))
                fits.append({**result, "mode": fit["mode"]} if fit.get("mode") else result)
            except FeatureError as error:
                self.errors.append(str(error))
        if self.cables:
            from .cables import evaluate
            progress.stage("cable_check")
            try:
                self.cable_report = evaluate(self, joints, couplings, self._cable_frames(poses, sweeps, animations), self._budget())
            except Exception as error:  # A reporting problem never fails the build.
                self.errors.append(f"Cable checks failed: {type(error).__name__}: {error}"[:300])
        _keep_checks()
        if self.reused_checks:
            print(f"Reused {self.reused_checks} motion and fit check{'s' if self.reused_checks != 1 else ''} from an earlier build: "
                  "nothing they depend on changed.", file=sys.stderr)
        moved = {j["child"] for j in joints}
        return {"version": 1, "units": {"length": "mm", "angle": "deg"}, "joints": joints, "couplings": couplings, "drives": drives, "poses": poses,
                **({"modes": modes} if modes else {}), **({"pose_modes": pose_modes} if pose_modes else {}),
                **({"saturated": {"poses": stopped}} if stopped else {}), "animations": animations, **({"explodes": explodes} if explodes else {}), **({"studies": studies} if studies else {}), **({"fits": fits} if fits else {}),
                **({"cables": self.cable_report} if self.cable_report else {}), **({"collision_shapes": shapes} if shapes else {}),
                **({"simulation": simulation} if simulation else {}), "ground": [i["name"] for i in self.instances if i["name"] not in moved]}

    def _collision_shapes(self) -> list[dict]:
        """Declared collision shapes as modelled, in the design frame (mm): boxes with their centre and rotation (w, x,
        y, z), spheres with their centre, capsules end to end. Also each instance's shapes as solids, for the studies."""
        from OCP.gp import gp_Pnt
        by_name = {i["name"]: i for i in self.instances}
        out, self._simple = [], {}
        for shape in self.collision_shapes:
            item = by_name.get(shape["instance"])
            if item is None:
                self.errors.append(f"Collision shape: {shape['instance']!r} isn't an instance of this design (instances: {', '.join(by_name)}).")
                continue
            location = item["location"]
            trsf = location.wrapped.Transformation()
            def placed(p, trsf=trsf) -> list[float]:
                moved = gp_Pnt(*p).Transformed(trsf)
                return [round(moved.X(), 6) + 0.0, round(moved.Y(), 6) + 0.0, round(moved.Z(), 6) + 0.0]

            entry = {"instance": shape["instance"], "type": shape["type"]}
            if shape["type"] == "box":
                quat = trsf.GetRotation()
                entry.update(size=shape["size"], at=placed(shape["at"]), quat=[round(quat.W(), 9), round(quat.X(), 9), round(quat.Y(), 9), round(quat.Z(), 9)])
                sx, sy, sz = shape["size"]
                solids = [cq.Solid.makeBox(sx, sy, sz, cq.Vector(shape["at"][0] - sx / 2, shape["at"][1] - sy / 2, shape["at"][2] - sz / 2))]
            elif shape["type"] == "sphere":
                entry.update(radius=shape["radius"], at=placed(shape["at"]))
                solids = [cq.Solid.makeSphere(shape["radius"], cq.Vector(*shape["at"]), angleDegrees1=-90)]
            else:  # A capsule: a cylinder with a sphere at each end.
                entry.update(radius=shape["radius"], start=placed(shape["start"]), end=placed(shape["end"]))
                start, end = cq.Vector(*shape["start"]), cq.Vector(*shape["end"])
                solids = [cq.Solid.makeCylinder(shape["radius"], (end - start).Length, start, (end - start).normalized()),
                          *(cq.Solid.makeSphere(shape["radius"], p, angleDegrees1=-90) for p in (start, end))]
            out.append(entry)
            self._simple.setdefault(shape["instance"], []).extend(solid.moved(location) for solid in solids)
        return out

    def _cable_frames(self, poses: dict, sweeps: list[tuple], animations: list[dict]) -> list[tuple[dict, dict]]:
        """The poses cables are checked at, as (when, values): the code's pose, each named pose, every drive across its
        range and every animation across its length (at their `samples`), and each collision study's checked poses.
        `when.values` is what differs from the code's pose."""
        rounded = lambda values: {k: round(v, 6) for k, v in values.items()}  # noqa: E731
        frames = [({"pose": "rest", "values": {}}, {})]
        frames += [({"pose": name, "values": rounded(values)}, values) for name, values in poses.items()]
        for target, (low, high), samples in sweeps:
            for i in range(samples):
                value = low + (high - low) * i / (samples - 1)
                frames.append(({"drive": target, "values": {target: round(value, 6)}}, {target: value}))
        samples_of = {a["name"]: a["samples"] for a in self.animations}
        for entry in animations:
            count = samples_of.get(entry["name"], 48)
            for i in range(count):
                t = entry["duration"] * i / (count - 1)
                values = _animation_values(entry, t)
                frames.append(({"animation": entry["name"], "time": round(t, 6), "values": rounded(values)}, values))
        for name, listed in self._study_poses.items():
            frames += [({"study": name, "index": index, "values": rounded(values)}, values) for index, values in enumerate(listed)]
        return frames

    def _animations(self, declared_joints: list[dict], declared_couplings: list[dict], poses: dict, in_mode=None) -> list[dict]:
        """Each animation with every key's full set of values (carried forward from the key before), checked against
        the joints' limits (its mode's, through `in_mode`), and its collision sweep when asked for."""
        rest = {j["name"]: j["value"] for j in declared_joints if j["type"] != "rigid"} | {c["name"]: c["value"] for c in declared_couplings}
        out = []
        for animation in self.animations:
            label = f"Animation {animation['name']!r}"
            try:
                mode = animation.get("mode")
                joints, couplings = in_mode(mode, label) if in_mode else (declared_joints, declared_couplings)
                resolved = []
                for index, key in enumerate(animation["keys"], start=1):
                    if "pose" in key:
                        if key["pose"] not in poses:
                            known = f" (poses: {', '.join(poses)})" if poses else ""
                            raise FeatureError(f"{label}: pose {key['pose']!r} isn't defined; add design.pose({key['pose']!r}, …) first{known}.")
                        values = poses[key["pose"]]
                    else:
                        unknown = sorted(set(key["values"]) - set(rest))
                        if unknown:
                            raise FeatureError(f"{label}: key {index} names {', '.join(unknown)}, not a movable joint or coupling of this design.")
                        if problem := _follower_set(joints, key["values"]):
                            raise FeatureError(f"{label}: key {index}: {problem}.")
                        values = key["values"]
                    resolved.append((key, values))
                targets = sorted({target for _, values in resolved for target in values if target in rest})
                if not targets:
                    raise FeatureError(f"{label}: its poses move nothing; name joints or couplings in them.")
                full, keys = {t: rest[t] for t in targets}, []
                for key, values in resolved:
                    full = {**full, **{t: v for t, v in values.items() if t in full}}
                    keys.append({"time": key["time"], **({"pose": key["pose"]} if "pose" in key else {}), "values": dict(full)})
                entry = {"name": animation["name"], "keys": keys, "targets": targets, "loop": animation["loop"],
                         "easing": animation["easing"], "duration": keys[-1]["time"], **({"mode": mode} if mode else {})}
                # Easing keeps every value between its two keys, so keys within the limits keep the whole animation within
                # them; and every joint's sum moves linearly between keys, so a driven joint that stops at a limit anywhere
                # does at a key.
                held = []
                for key in keys:
                    own, coupled = _animation_frame(joints, key["values"])
                    if problem := _limit_problem(joints, couplings, own, coupled):
                        raise FeatureError(f"{label}: at {key['time']:g} s {problem}.")
                    saturated = []
                    _effective(joints, couplings, own, coupled, saturated)
                    held += [{"time": key["time"], **item} for item in saturated]
                if held:
                    entry["saturated"] = held
                if animation["check"] and not _SHEETS_ONLY:
                    duration = entry["duration"]
                    times = [duration * i / (animation["samples"] - 1) for i in range(animation["samples"])]
                    progress.stage("animation_check", animation["name"], of=len(times))
                    entry["check"] = self._reuse(
                        "animation", {"animation": entry, "samples": animation["samples"]},
                        lambda budget, entry=entry, targets=targets, times=times: self._collisions(
                            joints, couplings, set(targets), times, lambda t: _animation_frame(joints, _animation_values(entry, t)), budget))
                out.append(entry)
            except FeatureError as error:
                self.errors.append(str(error))
        return out

    def _explodes(self, joints: list[dict], couplings: list[dict]) -> list[dict]:
        """Each explode as the viewer plays it (runtime/steve/explodes.py resolve), from the code's pose."""
        if not self.explodes:
            return []
        from .explodes import resolve
        progress.stage("explodes", of=len(self.explodes))
        motions = _instance_motions(joints, _effective(joints, couplings))
        out = []
        for index, declared in enumerate(self.explodes, start=1):
            progress.step(index, item=declared["name"])
            try:
                out.append(resolve(self, declared, motions))
            except FeatureError as error:
                self.errors.append(str(error))
        return out

    def _couplings(self, joints: list[dict]) -> list[dict]:
        """Each coupling with its gears named canonically (`joint`, or `joint.turn`/`joint.travel` for a cylindrical joint) and
        `bounds`: the values it can take with its limits and the limits of every motion it alone gears (None when
        unbounded); a motion geared by several couplings adds them up and stops at its limits (`_effective`).
        Marks each geared joint `driven_by`."""
        by_name = {j["name"]: j for j in joints}
        declared = {j["name"] for j in self.joints}
        out = []
        for coupling in self.couplings:
            try:
                gears = {}
                for key, ratio in coupling["gears"].items():
                    name, _, part = key.partition(".")
                    joint = by_name.get(name)
                    if joint is None:
                        raise FeatureError(f"Coupling {coupling['name']!r}: {name!r} isn't a joint of this design" + (" (it has an error)." if name in declared else "."))
                    if joint["type"] == "rigid":
                        raise FeatureError(f"Coupling {coupling['name']!r}: joint {name!r} is rigid; couple revolute, slider or cylindrical joints.")
                    if part not in ("", "turn", "travel") or (joint["type"] == "revolute" and part == "travel") or (joint["type"] == "slider" and part == "turn"):
                        raise FeatureError(f"Coupling {coupling['name']!r}: {key!r} isn't a motion of {joint['type']} joint {name!r}; "
                                           "use the joint's name, or <joint>.turn / <joint>.travel for a cylindrical joint.")
                    canonical = (f"{name}.travel" if part == "travel" else f"{name}.turn") if joint["type"] == "cylindrical" else name
                    if canonical in gears:
                        raise FeatureError(f"Coupling {coupling['name']!r} gears {canonical!r} twice.")
                    gears[canonical] = ratio
                out.append({"name": coupling["name"], "gears": gears, "limits": coupling["limits"], "value": coupling["value"]})
            except FeatureError as error:
                self.errors.append(str(error))
        geared = [key for coupling in out for key in coupling["gears"]]
        for coupling in out:
            for key in coupling["gears"]:
                driven = by_name[key.partition(".")[0]].setdefault("driven_by", [])
                if coupling["name"] not in driven:
                    driven.append(coupling["name"])
            coupling["bounds"], empty = _coupling_bounds(coupling, by_name, geared)
            if empty:
                self.errors.append(f"Coupling {coupling['name']!r} can't move: the limits of the joints it gears leave no common range.")
            if coupling["limits"] and not coupling["limits"][0] <= coupling["value"] <= coupling["limits"][1]:
                self.errors.append(f"Coupling {coupling['name']!r}: {coupling['value']:g} is outside its limits "
                                   f"{coupling['limits'][0]:g}…{coupling['limits'][1]:g}.")
        # A follower moves only through its couplings: every motion it has must be geared by one.
        for joint in joints:
            if not joint.get("follows"):
                continue
            motions = [f"{joint['name']}.turn", f"{joint['name']}.travel"] if joint["type"] == "cylindrical" else [joint["name"]]
            ungeared = [key for key in motions if key not in geared]
            if len(ungeared) == len(motions):
                self.errors.append(f"Joint {joint['name']!r} follows nothing: gear it with design.couple(…), or drop follow=True.")
            elif ungeared:
                self.errors.append(f"Joint {joint['name']!r} follows its couplings, but none gears {ungeared[0]!r}: add it to a coupling's gears, "
                                   "or drop follow=True.")
        return out

    def _modes(self, joints: list[dict], couplings: list[dict]) -> list[dict]:
        """Each design.mode resolved against the built joints and couplings: {name, joints: {joint: {limits and/or
        slide_limits}}, couplings: {coupling: {limits, bounds}}} (every coupling's bounds with the mode's limits, as
        `_couplings` works them out). A name that isn't a joint or coupling, or a range past the declared limits, is an
        error (that mode is left out)."""
        by_joint, by_coupling = {j["name"]: j for j in joints}, {c["name"]: c for c in couplings}
        declared = {j["name"] for j in self.joints} | {c["name"] for c in self.couplings}
        geared = [key for coupling in couplings for key in coupling["gears"]]
        out = []
        for mode in self.modes:
            label = f"Mode {mode['name']!r}"
            try:
                joint_limits, coupling_limits = {}, {}
                for option, items in (("limits", mode["limits"]), ("travel_limits", mode["travel_limits"])):
                    for target, span in items.items():
                        joint, coupling = by_joint.get(target), by_coupling.get(target) if option == "limits" else None
                        if joint is None and coupling is None:
                            kind = "a cylindrical joint" if option == "travel_limits" else "a joint or coupling"
                            raise FeatureError(f"{label}: {target!r} isn't {kind} of this design" + (" (it has an error)." if target in declared else "."))
                        if joint is not None and joint["type"] == "rigid":
                            raise FeatureError(f"{label}: joint {target!r} is rigid; it has no limits to set.")
                        if option == "travel_limits" and joint["type"] != "cylindrical":
                            raise FeatureError(f"{label}: travel_limits are a cylindrical joint's slide limits; set {target!r} in limits.")
                        if joint is not None:
                            own = joint.get("slide_limits") if option == "travel_limits" else joint["limits"]
                            unit = " mm" if option == "travel_limits" or joint["type"] == "slider" else "°"
                        else:
                            own, unit = coupling["limits"] or coupling["bounds"], ""
                        if own and (span[0] < own[0] - 1e-9 or span[1] > own[1] + 1e-9):
                            raise FeatureError(f"{label}: {target!r} {span[0]:g}…{span[1]:g}{unit} goes past its limits {own[0]:g}…{own[1]:g}{unit}; "
                                               "a mode only tightens them.")
                        if joint is not None:
                            joint_limits.setdefault(target, {})["slide_limits" if option == "travel_limits" else "limits"] = span
                        else:
                            coupling_limits[target] = span
                limited = {name: {**joint, **joint_limits.get(name, {})} for name, joint in by_joint.items()}
                resolved = {}
                for coupling in couplings:
                    tightened = {**coupling, "limits": coupling_limits.get(coupling["name"], coupling["limits"])}
                    bounds, empty = _coupling_bounds(tightened, limited, geared)
                    if empty:
                        raise FeatureError(f"{label}: coupling {coupling['name']!r} can't move: the limits of the joints it gears leave no common range.")
                    resolved[coupling["name"]] = {"limits": tightened["limits"], "bounds": bounds}
                out.append({"name": mode["name"], "joints": joint_limits, "couplings": resolved})
            except FeatureError as error:
                self.errors.append(str(error))
        return out

    def _sweep(self, joints: list[dict], couplings: list[dict], target: str, sweep: list[float], samples: int, budget: float = PREVIEW_BUDGET) -> dict:
        """Collision check across a drive's range: what the joint (or coupling) moves against everything it moves relative to."""
        coupling = next((c for c in couplings if c["name"] == target), None)
        own = {j["name"]: (j["value"], j.get("slide", 0.0)) for j in joints}
        low, high = sweep
        steps = [low + (high - low) * i / (samples - 1) for i in range(samples)]
        if coupling:
            def frame(value):
                return own, {target: value}
        else:
            def frame(value):
                return dict(own, **{target: (value, own[target][1])}), {}
        return self._collisions(joints, couplings, {target}, steps, frame, budget)

    def _declared_contact(self, a: str, b: str) -> dict | None:
        """The first design.contact that matches instances a and b (names or patterns, either way round), or None."""
        import fnmatch
        match = fnmatch.fnmatchcase
        return next((c for c in self.contacts if (match(a, c["a"]) and match(b, c["b"])) or (match(b, c["a"]) and match(a, c["b"]))), None)

    def _collisions(self, joints: list[dict], couplings: list[dict], moving: set[str], params: list[float], frame, budget: float = PREVIEW_BUDGET) -> dict:
        """Exact common volume between instances that `moving` (joint and coupling names) move relative to each other, at
        each of `params` (a drive value or an animation time); `frame(param)` gives the joints' own values and the
        couplings'. Overlaps that already exist in the code's pose (a pin modelled in its bore) are reported apart.
        Colliding samples in a row become spans of `params`."""
        import time
        started = time.monotonic()
        clashes = _Clashes(self, joints, couplings, moving, deadline=started + budget)
        hits: dict[tuple, dict] = {}
        checked = 0
        for param in params:
            if time.monotonic() - started > budget:
                break
            for (a, b), volume in clashes.check(*frame(param))[0].items():
                hit = hits.setdefault((a, b), {"a": a, "b": b, "values": [], "volume": 0.0})
                hit["values"].append(round(param, 6))
                hit["volume"] = max(hit["volume"], volume)
            checked += 1
            progress.step(checked, len(params))
        at_rest = clashes.at_rest
        step = (params[-1] - params[0]) / max(len(params) - 1, 1)
        report = []
        for hit in hits.values():  # Consecutive colliding samples become spans.
            spans, start, last = [], None, None
            for value in hit["values"]:
                if start is None or value - last > step * 1.5:
                    if start is not None:
                        spans.append([start, last])
                    start = value
                last = value
            spans.append([start, last])
            report.append({"a": hit["a"], "b": hit["b"], "spans": spans, "max_volume_mm3": round(hit["volume"], 3)})
        # A declared contact (design.contact) within its allowance is meant to touch: listed apart, as fit checks do.
        contacts, collisions = [], []
        for item in report:
            contact = self._declared_contact(item["a"], item["b"])
            if contact is not None and item["max_volume_mm3"] <= contact["allowance"]:
                contacts.append({**item, "kind": contact["kind"]})
            else:
                collisions.append({**item, **({"declared": contact["kind"], "max_overlap_mm3": contact["allowance"]} if contact else {})})
        complete = checked == len(params)  # A check cut short is incomplete, never clear: the poses it skipped weren't checked.
        return {"samples": checked, "of": len(params), "complete": complete, "clear": complete and not collisions and not clashes.unverified,
                "collisions": collisions, **({"contacts": contacts} if contacts else {}),
                "at_rest": [{"a": a, "b": b} for a, b in sorted(at_rest)], **_unverified(clashes),
                **({"note": f"Stopped after {checked} of {len(params)} poses ({budget_words(budget)}); incomplete, not clear."} if not complete else {})}

    def _study(self, study: dict, joints: list[dict], couplings: list[dict], poses: dict, budget: float = PREVIEW_BUDGET,
               animations: list[dict] = ()) -> dict:
        """A collision study at the build: its poses from the sampling (or an animation's, from its resolved entry in
        `animations`), every pair that moves relative to another checked at each, then the collision fraction, the pairs
        ranked, each joint's collision-free share across its range, the colliding poses and the first-contact boundary."""
        import itertools
        import random
        import statistics
        import time
        started = time.monotonic()
        label = f"Collision study {study['name']!r}"
        by_joint = {j["name"]: j for j in joints}
        by_coupling = {c["name"]: c for c in couplings}
        rest = {j["name"]: j["value"] for j in joints if j["type"] != "rigid"} | {c["name"]: c["value"] for c in couplings}

        def values_of(pose, where: str) -> dict:
            if isinstance(pose, str):
                if pose not in poses:
                    known = f" (poses: {', '.join(poses)})" if poses else ""
                    raise FeatureError(f"{label}: {where} uses pose {pose!r}, which isn't defined; add design.pose({pose!r}, …) first{known}.")
                return poses[pose]
            unknown = sorted(set(pose) - set(rest))
            if unknown:
                raise FeatureError(f"{label}: {where} names {', '.join(unknown)}, not a movable joint or coupling of this design.")
            return pose

        def frame(values: dict):
            return _animation_frame(joints, {**base, **values})

        def outside(values: dict) -> str | None:  # A driven joint stops at its limits; what a pose sets must fit its own.
            return _limit_problem(joints, couplings, *frame(values))

        base = {**rest, **(values_of(study["hold"], "hold") if study["hold"] is not None else {})}
        if problem := outside({}):
            raise FeatureError(f"{label}: at its held pose {problem}.")
        listed = [values_of(pose, f"pose {index}") for index, pose in enumerate(study["poses"], start=1)]
        times = None
        if study["sampling"] == "animation":  # The animation's values as it plays, at its keys, the given times or evenly.
            played = study["animation"]
            entry = next((a for a in animations if a["name"] == played), None)
            if entry is None:
                if any(a["name"] == played for a in self.animations):
                    raise FeatureError(f"{label}: animation {played!r} has an error; fix it first.")
                known = ", ".join(a["name"] for a in self.animations) or "none yet; add design.animation(…) first"
                raise FeatureError(f"{label}: there is no animation named {played!r} (animations: {known}).")
            duration = entry["duration"]
            start, end = study["between"] or (0.0, duration)
            late = [t for t in [end] + list(study["at"] if isinstance(study["at"], list) else []) if t > duration + 1e-9]
            if late:
                raise FeatureError(f"{label}: {max(late):g} s is after animation {played!r} ends ({duration:g} s).")
            inside = lambda t: start - 1e-9 <= t <= end + 1e-9  # noqa: E731
            if study["at"] == "keys":
                times = sorted({key["time"] for key in entry["keys"] if inside(key["time"])})
            elif study["at"] is not None:
                times = [t for t in study["at"] if inside(t)]
            else:
                count = study["samples"] or next(a["samples"] for a in self.animations if a["name"] == played)
                times = [start + (end - start) * i / (count - 1) for i in range(count)] if count > 1 else [start]
            if not times:
                raise FeatureError(f"{label}: none of its times fall between {start:g} and {end:g} s.")
            listed = [_animation_values(entry, t) for t in times]
        targets = list(study["joints"]) + sorted({t for pose in listed for t in pose} - set(study["joints"]))
        unknown = [t for t in targets if t not in rest]
        if unknown:
            raise FeatureError(f"{label}: {', '.join(map(repr, unknown))} {'is not a movable joint or coupling' if len(unknown) == 1 else 'are not movable joints or couplings'} "
                               f"of this design (movable: {', '.join(rest) or 'none'}).")
        if problem := _follower_set(joints, targets + list(study["hold"] if isinstance(study["hold"], dict) else [])):
            raise FeatureError(f"{label}: {problem}.")
        steps = study["steps"] if isinstance(study["steps"], dict) else {}
        for option, keys in (("ranges", study["ranges"]), ("steps", steps), ("boundary", study["boundary"] or []), ("map", study["map"] or [])):
            for key in keys:
                if key not in targets:
                    raise FeatureError(f"{label}: {option} names {key!r}, which isn't one of its joints ({', '.join(targets)}).")
        sampling, boundary = study["sampling"], study["boundary"]
        ranges = {}
        for target in (targets if sampling in ("grid", "random") else boundary or []):
            joint = by_joint.get(target)
            limits = joint["limits"] if joint else by_coupling[target]["bounds"]
            slides = joint["type"] == "slider" if joint else any(_dof_kind(joints, key) == "travel" for key in by_coupling[target]["gears"])
            given, unit = study["ranges"].get(target), " mm" if slides else "°"
            if given and limits and (given[0] < limits[0] - 1e-9 or given[1] > limits[1] + 1e-9):
                raise FeatureError(f"{label}: the range of {target!r} ({given[0]:g}…{given[1]:g}{unit}) goes past its limits {limits[0]:g}…{limits[1]:g}{unit}.")
            if not (given or limits) and slides:
                raise FeatureError(f"{label}: {target!r} slides without limits; give it a range, e.g. ranges={{{target!r}: (0, 40)}}.")
            ranges[target] = list(given or limits or [-180.0, 180.0])

        axes = {}
        if sampling == "grid":
            for target in targets:
                low, high = ranges[target]
                step = steps.get(target, None if isinstance(study["steps"], dict) else study["steps"])
                if step is None:  # About `samples` poses in all, spread evenly.
                    count = max(2, int(study["samples"] ** (1 / len(targets)) + 1e-9))
                    axes[target] = [low + (high - low) * i / (count - 1) for i in range(count)]
                else:
                    count = int((high - low) / step + 1e-9)
                    axes[target] = [low + step * i for i in range(count + 1)] + ([high] if low + step * count < high - 1e-9 else [])
            total = math.prod(len(axis) for axis in axes.values())
            if total > STUDY_SAMPLES:
                raise FeatureError(f"{label}: its grid has {total:,} poses; a build checks at most {STUDY_SAMPLES:,}. Use larger steps or fewer joints, "
                                   "or sampling=\"random\" for many joints.")
            samples = [{t: round(v, 9) for t, v in zip(targets, combo)} for combo in itertools.product(*(axes[t] for t in targets))]
        elif sampling == "random":
            draw = random.Random(study["seed"])
            samples = [{t: draw.uniform(*ranges[t]) for t in targets} for _ in range(study["samples"])]
        else:
            samples = [dict(pose) for pose in listed]
            for index, pose in enumerate(samples, start=1):
                if problem := outside(pose):
                    raise FeatureError(f"{label}: at pose {index} {problem}.")

        instances = [i["name"] for i in self.instances]
        for pair in study["ignore"] + (study["pairs"] or []):
            for name in pair:
                if name not in instances:
                    raise FeatureError(f"{label}: {name!r} isn't an instance of this design (instances: {', '.join(instances)}).")
        clashes = _Clashes(self, joints, couplings, set(targets), ignore=study["ignore"], only=study["pairs"], simple=self._simple,
                           deadline=started + budget)
        measure = sampling == "animation" and study["pairs"] is not None  # Each listed pair's closest approach over the motion.
        results = []
        for values in samples:
            if time.monotonic() - started > budget * (0.6 if boundary else 1.0):
                break
            results.append(clashes.detail(*frame(values), study["clearance"], measure))
            progress.step(len(results), len(samples))

        checked = len(results)
        if self.cables:  # Cables are checked at the same poses.
            self._study_poses[study["name"]] = [{**base, **samples[index]} for index in range(checked)]
        colliding = [index for index, (hits, _, _) in enumerate(results) if hits]
        found, near, scores, gaps = {}, {}, {}, {}
        for index, (hits, close, simple) in enumerate(results):
            for (a, b), (volume, depth, at) in hits.items():
                item = found.setdefault((a, b), {"a": a, "b": b, "samples": 0, "first": index, "volumes": [], "depths": [], "deepest": index, "at": at})
                item["samples"] += 1
                if depth > max(item["depths"], default=-1.0):
                    item["deepest"], item["at"] = index, at
                item["volumes"].append(volume)
                item["depths"].append(depth)
                if measure:  # Overlapping: no gap at all.
                    gap = gaps.setdefault((a, b), {"a": a, "b": b, "min_distance_mm": math.inf, "colliding": 0})
                    gap["colliding"] += 1
                    if gap["min_distance_mm"] > 0:
                        gap.update(min_distance_mm=0.0, closest=index, points=None)
            for (a, b), (distance, points) in close.items():
                if measure:
                    gap = gaps.setdefault((a, b), {"a": a, "b": b, "min_distance_mm": math.inf, "colliding": 0})
                    if distance < gap["min_distance_mm"]:
                        gap.update(min_distance_mm=distance, closest=index, points=points)
                    if not study["clearance"] or distance > study["clearance"]:
                        continue
                item = near.setdefault((a, b), {"a": a, "b": b, "samples": 0, "min_distance_mm": math.inf, "first": index})
                item["samples"] += 1
                if distance < item["min_distance_mm"]:
                    item.update(min_distance_mm=distance, closest=index, points=points)
            for (a, b), flagged in simple.items():  # The collision shapes against the exact solids at the same pose.
                score = scores.setdefault((a, b), {"a": a, "b": b, "colliding": 0, "detected": 0, "free": 0, "false_positives": 0, "missed_depth_mm": 0.0})
                if (a, b) in hits:
                    score["colliding"] += 1
                    score["detected"] += flagged
                    if not flagged and hits[(a, b)][1] >= score["missed_depth_mm"]:
                        score["missed_depth_mm"], score["missed"] = hits[(a, b)][1], index
                else:
                    score["free"] += 1
                    score["false_positives"] += flagged
        share = lambda count: round(count / checked, 6) if checked else 0.0  # noqa: E731
        ranked = lambda items: sorted(items, key=lambda item: (-item["samples"], item["a"], item["b"]))  # noqa: E731

        def spread(values: list[float]) -> dict:
            ordered = sorted(values)
            return {"median": round(statistics.median(ordered), 3), "p95": round(ordered[math.ceil(0.95 * len(ordered)) - 1], 3), "max": round(ordered[-1], 3)}

        def when(index) -> dict:  # The animation time (s) of a pose, for studies that follow one.
            return {"time": round(times[index], 6)} if times is not None and index is not None else {}

        def pair_of(item: dict) -> dict:
            volumes, depths = item.pop("volumes"), item.pop("depths")
            return {**item, "fraction": share(item["samples"]), "max_volume_mm3": round(max(volumes), 3), "volume_mm3": spread(volumes), "depth_mm": spread(depths),
                    **when(item["deepest"])}

        report = {"name": study["name"], "sampling": sampling, "joints": targets, "ranges": ranges, "hold": base,
                  **({"seed": study["seed"]} if sampling == "random" else {}),
                  **({"animation": study["animation"], **({"at": "keys"} if study["at"] == "keys" else {}),
                      **({"between": study["between"]} if study["between"] else {})} if times is not None else {}),
                  **({"grid": {t: len(axis) for t, axis in axes.items()}} if axes else {}),
                  "samples": checked, "of": len(samples), "complete": checked == len(samples),
                  "clear": checked == len(samples) and not colliding and not clashes.unverified, "colliding": len(colliding), "fraction": share(len(colliding)),
                  **({"interval": _wilson(len(colliding), checked)} if sampling == "random" and checked else {}),
                  "pairs": ranked(pair_of(item) for item in found.values()),
                  "pairs_checked": len(clashes.live), "ignored": [list(pair) for pair in study["ignore"]],
                  "at_rest": [{"a": a, "b": b} for a, b in sorted(clashes.at_rest)], **_unverified(clashes)}
        if study["clearance"]:
            report["clearance_mm"] = study["clearance"]
            report["near"] = ranked({**item, "fraction": share(item["samples"]), "min_distance_mm": round(item["min_distance_mm"], 4), **when(item["closest"])}
                                    for item in near.values())
        if measure:  # Every listed pair the study checks, closest first; None where no distance could be measured in time.
            for a, b in clashes.live:
                gaps.setdefault((a, b), {"a": a, "b": b, "min_distance_mm": math.inf, "colliding": 0})
            report["clearances"] = sorted(({**gap, "min_distance_mm": round(gap["min_distance_mm"], 4) if math.isfinite(gap["min_distance_mm"]) else None,
                                            **when(gap.get("closest"))} for gap in gaps.values()),
                                          key=lambda gap: (gap["min_distance_mm"] is None, gap["min_distance_mm"] or 0.0, gap["a"], gap["b"]))
        if colliding:
            report["volume_mm3"] = spread([max(hit[0] for hit in results[index][0].values()) for index in colliding])
            report["depth_mm"] = spread([max(hit[1] for hit in results[index][0].values()) for index in colliding])
        if clashes.scored:
            rate = lambda count, of: round(count / of, 6) if of else None  # noqa: E731
            report["shapes"] = sorted(({**score, "detection_rate": rate(score["detected"], score["colliding"]),
                                        "false_positive_rate": rate(score["false_positives"], score["free"]),
                                        "missed_depth_mm": round(score["missed_depth_mm"], 3)} for score in scores.values()),
                                      key=lambda score: (score["detection_rate"] if score["detection_rate"] is not None else 1.0,
                                                         -(score["false_positive_rate"] or 0.0), score["a"], score["b"]))
        listing = STUDY_SAMPLES if sampling in ("poses", "animation") else STUDY_LISTED

        def pose_of(index: int) -> dict:
            hits = results[index][0]
            pairs = sorted(hits)
            return {"index": index, **when(index), "values": {t: round(v, 6) for t, v in samples[index].items()}, "pairs": [list(pair) for pair in pairs],
                    "depth_mm": [round(hits[pair][1], 3) for pair in pairs], "at": [hits[pair][2] for pair in pairs]}

        report["poses"] = [pose_of(index) for index in colliding[:listing]]
        plane = study["map"] or (targets if sampling == "grid" and len(targets) == 2 else None)
        if plane and sampling in ("grid", "random") and checked:
            # Which pair collides over two joints: the grid's own values, or bins across the ranges (random), over the other joints.
            rank = {(item["a"], item["b"]): k for k, item in enumerate(report["pairs"])}
            if sampling == "grid":
                values = {t: axes[t] for t in plane}
                slots = {t: {round(v, 9): k for k, v in enumerate(axes[t])} for t in plane}
            else:
                values = {t: [ranges[t][0] + (ranges[t][1] - ranges[t][0]) * (k + 0.5) / STUDY_MAP_BINS for k in range(STUDY_MAP_BINS)] for t in plane}

            def slot(t: str, value: float) -> int:
                if sampling == "grid":
                    return slots[t][value]
                low, high = ranges[t]
                return min(int((value - low) / (high - low) * STUDY_MAP_BINS), STUDY_MAP_BINS - 1) if high > low else 0
            x, y = plane
            counts = [[[0, 0, {}] for _ in values[x]] for _ in values[y]]
            for index, (hits, _, _) in enumerate(results):
                cell = counts[slot(y, samples[index][y])][slot(x, samples[index][x])]
                cell[0] += 1
                cell[1] += bool(hits)
                for pair in hits:
                    cell[2][pair] = cell[2].get(pair, 0) + 1
            top = lambda tally: min(tally, key=lambda pair: (-tally[pair], rank[pair])) if tally else None  # noqa: E731
            report["map"] = {"x": x, "y": y, "xs": [round(v, 6) for v in values[x]], "ys": [round(v, 6) for v in values[y]], "binned": sampling == "random",
                             "cells": [[[n, hit, rank[top(tally)] if tally else -1] for n, hit, tally in row] for row in counts]}
        if sampling in ("grid", "random") and checked:
            # Each joint's collision-free share at each value (grid) or in ten bins across its range (random), over the other joints.
            report["marginals"] = {}
            for target in targets:
                low, high = ranges[target]
                bins: dict[float, list[int]] = {}
                for index, (hits, _, _) in enumerate(results):
                    value = samples[index][target]
                    if sampling == "random":
                        k = min(int((value - low) / (high - low) * 10), 9) if high > low else 0
                        value = low + (high - low) * (k + 0.5) / 10
                    row = bins.setdefault(round(value, 6), [0, 0])
                    row[0] += 1
                    row[1] += not hits
                report["marginals"][target] = [[value, round(free / count, 6), count] for value, (count, free) in sorted(bins.items())]

        notes = []
        if checked < len(samples):
            notes.append(f"Stopped after {checked} of {len(samples)} poses ({budget_words(budget)}); the results cover the poses checked, "
                         "so the study is incomplete, not clear.")
        if len(colliding) > listing:
            notes.append(f"Lists the first {listing} of {len(colliding)} colliding poses.")
        if boundary:
            # First contact of b moving away from its held value, at values of a across its range: 24 steps to the limit, then bisection.
            a, b = boundary
            low, high = ranges[b]
            start, tolerance, count = min(max(base[b], low), high), study["tolerance"], study["boundary_values"]
            rows = []

            def free(values: dict) -> bool:
                return not clashes.collides(*frame(values))

            for at in (ranges[a][0] + (ranges[a][1] - ranges[a][0]) * i / (count - 1) for i in range(count)):
                if time.monotonic() - started > budget:
                    notes.append(f"The boundary stopped after {len(rows)} of {count} values of {a} ({budget_words(budget)}); incomplete, not clear.")
                    report["complete"] = report["clear"] = False
                    break
                if not free({a: at, b: start}):
                    rows.append({"at": round(at, 6), "start": "colliding"})
                    continue
                row = {"at": round(at, 6), "above": None, "below": None}
                for side, end in (("above", high), ("below", low)):
                    last = start
                    for k in range(1, 25):
                        value = start + (end - start) * k / 24
                        if abs(value - last) < 1e-12:
                            break
                        if free({a: at, b: value}):
                            last = value
                            continue
                        clear, hit = last, value
                        while abs(hit - clear) > tolerance:
                            middle = (clear + hit) / 2
                            clear, hit = (middle, hit) if free({a: at, b: middle}) else (clear, middle)
                        row[side] = round(hit, 6)
                        break
                rows.append(row)
            report["boundary"] = {"joint": a, "moving": b, "from": round(start, 6), "tolerance": tolerance, "rows": rows}
        if notes:
            report["note"] = " ".join(notes)
        return report

    def _fit(self, check: dict, joints: list[dict], couplings: list[dict], poses: dict, budget: float = PREVIEW_BUDGET) -> dict:
        """A fit check at the build: each pair that overlaps (exact common volume) or comes closer than its clearance, as
        modelled, at the named poses and through the joints and couplings that move a checked instance. Sweeps are
        refined between samples: a pair is clear between two samples when its gaps at both ends leave more than its
        clearance after the most the parts can move between them (the step × the farthest point from the joint axis);
        otherwise the step is halved, until it moves the parts at most `refine` mm."""
        import fnmatch
        import itertools
        import time
        from OCP.gp import gp_Dir, gp_Pnt, gp_Vec
        started = time.monotonic()
        label = f"Fit check {check['name']!r}"
        match = fnmatch.fnmatchcase
        everyone = [i["name"] for i in self.instances]
        exact = self._answers()
        shapes = exact.shapes
        names = list(shapes)

        def matching(pattern: str, where: str) -> list[str]:
            found = [n for n in everyone if match(n, pattern)]
            if not found:
                raise FeatureError(f"{where}: {pattern!r} matches no instance of this design (instances: {', '.join(everyone)}).")
            return found

        scope = set(names) if check["instances"] is None else {n for p in check["instances"] for n in matching(p, label) if n in shapes}
        for contact in self.contacts:
            for pattern in (contact["a"], contact["b"]):
                matching(pattern, f"Contact {contact['a']!r}/{contact['b']!r}")
        for pair, _ in self.gaps["pairs"]:
            for pattern in pair:
                matching(pattern, "Clearance")
        for pose in check["poses"]:
            if pose not in poses:
                known = f" (poses: {', '.join(poses)})" if poses else ""
                raise FeatureError(f"{label}: pose {pose!r} isn't defined; add design.pose({pose!r}, …) first{known}.")

        def either(a: str, b: str, p: str, q: str) -> bool:
            return (match(a, p) and match(b, q)) or (match(b, p) and match(a, q))

        pairs, rules = [], {}
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                if a not in scope and b not in scope:
                    continue
                contact = next((c for c in self.contacts if either(a, b, c["a"], c["b"])), None)
                gap = self.gaps["default"]
                for (p, q), value in self.gaps["pairs"]:
                    gap = value if either(a, b, p, q) else gap
                pairs.append((a, b))
                rules[(a, b)] = (contact, 0.0 if contact else gap)
        invalid = sorted(n for n in names if not shapes[n].Solids() or not shapes[n].isValid())
        found: dict[tuple, tuple] = {}
        touched: dict[tuple, dict] = {}  # undeclared pairs that touch without overlapping, where they first did

        def record(pair: tuple, m: dict, when: dict) -> None:
            contact, gap = rules[pair]
            volume, distance = m["volume"], m["distance"]
            over = volume is None or volume > (contact["allowance"] if contact else 0.0) + CLASH_TOLERANCE
            close = not m["bound"] and distance < gap - 1e-9
            touching = contact is not None and not m["bound"] and ((volume or 0.0) > CLASH_TOLERANCE or distance <= 1e-6)
            if contact is None and not (over or close) and not m["bound"] and distance <= 1e-6 and pair not in touched:
                a, b = pair
                touched[pair] = {"a": a, "b": b, "overlap_mm3": round(volume, 3), "min_distance_mm": round(distance, 4), "points": m["points"],
                                 "when": when, **({"approximate": True} if a in invalid or b in invalid else {})}
            if not (over or close or touching):
                return
            severity = (over or close, volume is None, volume or 0.0, gap - distance)
            if pair in found and found[pair][0] >= severity:
                return
            a, b = pair
            allowance = contact and (None if math.isinf(contact["allowance"]) else contact["allowance"])
            found[pair] = (severity, {"a": a, "b": b, "overlap_mm3": None if volume is None else round(volume, 3), "min_distance_mm": round(distance, 4),
                                      "clearance_mm": gap, **({"contact": contact["kind"], "allowance_mm3": allowance} if contact else {}),
                                      "points": m["points"], "when": when, **({"unverified": True} if volume is None else {}),
                                      **({"approximate": True} if a in invalid or b in invalid else {})})

        deadline, late = started + budget, []

        def unanswered(answer, pair: tuple) -> bool:
            """Whether an exact call gave no answer by the deadline (or its child died); late pairs are named in a note."""
            if answer is _LATE and pair not in late:
                late.append(pair)
            return isinstance(answer, _NoAnswer)

        def measure(placed: dict, motions: dict, a: str, b: str, reach: float) -> dict:
            """Common volume (None when the boolean failed or ran out of time), the distance (or, when `bound`, a lower
            bound of it: farther apart than `reach`) and witness points."""
            box = _box(placed[b])
            if _box(placed[a], reach).IsOut(box):
                return {"volume": 0.0, "distance": reach, "bound": True, "points": None}
            if not _box(placed[a]).IsOut(box):
                common = exact.overlap(placed, motions, a, b, deadline)
                if common is None or unanswered(common, (a, b)):
                    return {"volume": None, "distance": 0.0, "bound": False, "points": None}
                if common[0] > CLASH_TOLERANCE:
                    return {"volume": common[0], "distance": 0.0, "bound": False, "points": [common[2]]}
            if not reach and rules[(a, b)][0] is None and exact.apart(motions, a, b):
                # No gap to keep, no declared contact, and the overlap's mesh pre-check found them more than PROXIMITY_MM
                # apart: not touching, so nothing reads the distance and it isn't measured (the exact distance is most of
                # a fit check's time). Pairs it couldn't rule out are measured: record() lists those that touch. A sweep
                # asks with reach = gap + its step, zero only when the step is (its pairs then settle at any distances).
                # The same answer as boxes apart.
                return {"volume": 0.0, "distance": reach, "bound": True, "points": None}
            closest = exact.closest(placed, motions, a, b, deadline)
            if unanswered(closest, (a, b)):  # No overlap, the distance unknown: unverified only where a clearance needs it.
                return {"volume": None if reach > 0 and rules[(a, b)][0] is None else 0.0, "distance": 0.0, "bound": True, "points": None}
            distance, points = closest
            return {"volume": 0.0, "distance": distance, "bound": False, "points": points}

        rule_of = {id(c): i for i, c in enumerate(self.contacts)}
        seats: dict[int, dict] = {}  # each contact rule applied: whether a pair of it touched, else its closest approach

        def seat(pair: tuple, m: dict, placed: dict, values: dict, when: dict) -> None:
            """Keep a declared contact's state: touching once any of its pairs touches; else its closest measured pair
            and, of its pairs whose boxes don't meet (not measured), the one whose boxes come nearest."""
            contact = rules[pair][0]
            if contact is None:
                return
            state = seats.setdefault(rule_of[id(contact)], {"touching": False, "closest": None, "apart": None})
            if state["touching"] or m["volume"] is None:
                return
            if not m["bound"]:
                if m["volume"] > CLASH_TOLERANCE or m["distance"] <= 1e-6:
                    state["touching"] = True
                elif math.isfinite(m["distance"]) and (state["closest"] is None or m["distance"] < state["closest"]["distance"]):
                    state["closest"] = {"distance": m["distance"], "pair": pair, "points": m["points"], "when": when}
                return
            first, second = _corners(_box(placed[pair[0]])), _corners(_box(placed[pair[1]]))
            boxes = math.sqrt(sum(max(0.0, first[i] - second[i + 3], second[i] - first[i + 3]) ** 2 for i in range(3)))
            if state["apart"] is None or boxes < state["apart"]["boxes"]:
                state["apart"] = {"boxes": boxes, "pair": pair, "values": values, "when": when}

        def placement(values: dict, chosen: list) -> tuple[dict, dict]:
            motions = _instance_motions(joints, _effective(joints, couplings, *_animation_frame(joints, values))) if joints else {}
            return {n: shapes[n].moved(cq.Location(motions[n])) if n in motions else shapes[n] for pair in chosen for n in pair}, motions

        def evaluate(values: dict, chosen: list, reach, when: dict) -> dict:
            placed, motions = placement(values, chosen)
            out = {}
            measured = _each(chosen, lambda pair: (measure(placed, motions, *pair, reach(pair)), pair in late), exact)
            for pair, (m, ran_out) in zip(chosen, measured):  # In order, as if measured one by one.
                if ran_out and pair not in late:
                    late.append(pair)
                out[pair] = m
                record(pair, m, when)
                seat(pair, m, placed, values, when)
            return out

        def spent() -> bool:
            return time.monotonic() - started > budget

        notes, checked = [], []
        requested = ["rest", *check["poses"]]
        for pose in requested:
            if spent():
                notes.append(f"Stopped before pose {pose!r} ({budget_words(budget)}); incomplete, not clear.")
                break
            evaluate(poses.get(pose, {}) if pose != "rest" else {}, pairs, lambda pair: rules[pair][1], {"pose": pose})
            checked.append(pose)
            progress.step(len(checked), len(check["poses"]) + 1)

        sweeps, unswept = [], []  # unswept: the sweeps the time ran out before (or during), so incomplete
        if check["motion"] and joints:
            by_joint = {j["name"]: j for j in joints}
            rest_motions, boxes = {}, {}  # Filled once a sweep runs: a check out of time before any doesn't need them.

            def below(name: str) -> list[str]:  # An instance and everything jointed below it.
                out = [name]
                for item in out:
                    out += [j["child"] for j in joints if j["parent"] == item and j["child"] not in out]
                return out

            def reach_per_degree(joint: dict) -> float:
                """How far (mm) a degree of this joint moves the farthest point it carries: its distance from the axis."""
                if not boxes:
                    rest_motions.update(_instance_motions(joints, _effective(joints, couplings)))
                    boxes.update({n: _corners(_box(shapes[n].moved(cq.Location(rest_motions[n])) if n in rest_motions else shapes[n]))
                                  for n in names})
                origin, axis = gp_Pnt(*joint["origin"]), gp_Dir(*joint["axis"])
                parent = rest_motions.get(joint["parent"])
                if parent is not None:
                    origin, axis = origin.Transformed(parent), axis.Transformed(parent)
                far = max((gp_Vec(origin, gp_Pnt(*corner)).Crossed(gp_Vec(axis)).Magnitude()
                           for n in below(joint["child"]) if n in boxes
                           for corner in itertools.product(*zip(boxes[n][:3], boxes[n][3:]))), default=0.0)
                return far * math.pi / 180

            targets = []  # (name, span, its rate when swept, what it moves)
            for joint in joints:
                if joint["type"] != "rigid" and not joint.get("driven_by"):
                    turning = joint["type"] != "slider"
                    targets.append((joint["name"], joint["limits"] or ([-180.0, 180.0] if turning else None),
                                    (lambda joint=joint: reach_per_degree(joint)) if turning else (lambda: 1.0), set(below(joint["child"]))))
            for coupling in couplings:
                keys = coupling["gears"]
                turning = all(_dof_kind(joints, key) == "turn" for key in keys)
                rate = lambda keys=keys: sum(abs(ratio) * (reach_per_degree(by_joint[key.partition(".")[0]]) if _dof_kind(joints, key) == "turn" else 1.0)  # noqa: E731
                                             for key, ratio in keys.items())
                targets.append((coupling["name"], coupling["bounds"] or ([-180.0, 180.0] if turning else None), rate,
                                {n for key in keys for n in below(by_joint[key.partition(".")[0]]["child"])}))

            def swept(item: tuple) -> bool:  # Whether a target is swept at all: it moves a checked pair apart and has limits.
                _, span, _, moved = item
                return span is not None and any((a in moved) != (b in moved) for a, b in pairs)

            for index, (target, span, rate, moved) in enumerate(targets):
                chosen = [pair for pair in pairs if (pair[0] in moved) != (pair[1] in moved)]
                if not chosen:
                    continue
                if span is None:
                    notes.append(f"{target!r} slides without limits, so it wasn't swept; give it limits.")
                    continue
                if spent():
                    unswept = [item[0] for item in targets[index:] if swept(item)]
                    notes.append(f"Stopped before sweeping {target!r} ({budget_words(budget)}); incomplete, not clear.")
                    break
                rate = rate()
                low, high = span
                values = [low + (high - low) * i / (check["samples"] - 1) for i in range(check["samples"])]
                step = rate * (high - low) / (check["samples"] - 1)
                results = {}
                for value in values:
                    if spent():
                        break
                    results[value] = evaluate({target: value}, chosen, lambda pair: rules[pair][1] + step, {"values": {target: round(value, 6)}})
                    progress.step(len(results), len(values))
                sampled = len(results)

                def settled(pair, first: dict, second: dict, travel: float) -> bool:
                    """Already reported at an end, a declared contact, or too far apart at both ends to meet in between."""
                    contact, gap = rules[pair]
                    if contact or any(m["volume"] is None or m["volume"] > CLASH_TOLERANCE or (not m["bound"] and m["distance"] < gap) for m in (first, second)):
                        return True
                    return (first["distance"] + second["distance"] - travel) / 2 >= gap

                stack = [(values[i], values[i + 1], chosen, 0) for i in range(len(results) - 1)]
                while stack and not spent():
                    v0, v1, candidates, depth = stack.pop()
                    travel = rate * abs(v1 - v0)
                    unsure = [pair for pair in candidates if not settled(pair, results[v0][pair], results[v1][pair], travel)]
                    if not unsure or travel <= check["refine"] or depth >= 8:
                        continue
                    middle = (v0 + v1) / 2
                    results[middle] = evaluate({target: middle}, unsure, lambda pair, half=travel / 2: rules[pair][1] + half, {"values": {target: round(middle, 6)}})
                    stack += [(v0, middle, unsure, depth + 1), (middle, v1, unsure, depth + 1)]
                whole = sampled == len(values) and not stack
                sweeps.append({"target": target, "range": [low, high], "samples": sampled, "of": len(values), "refined": len(results) - sampled,
                               "complete": whole})
                if not whole:
                    unswept = [item[0] for item in targets[index + 1:] if swept(item)]
                    notes.append(f"The sweep of {target!r} stopped ({budget_words(budget)}); it covers the poses checked, so the check is "
                                 "incomplete, not clear.")
                    break

        for state in seats.values():  # A declared contact that never touched: its closest approach, one exact call at most.
            apart = state["apart"]
            if state["touching"] or apart is None or (state["closest"] and state["closest"]["distance"] <= apart["boxes"]):
                continue
            placed, motions = placement(apart["values"], [apart["pair"]])
            closest = exact.closest(placed, motions, *apart["pair"], deadline)
            if isinstance(closest, _NoAnswer) or not math.isfinite(closest[0]):
                if state["closest"] is None:  # Unmeasured: at least as far apart as the boxes.
                    state["closest"] = {"distance": apart["boxes"], "pair": apart["pair"], "points": None, "when": apart["when"], "at_least": True}
            elif closest[0] <= 1e-6:
                state["touching"] = True
            elif state["closest"] is None or closest[0] < state["closest"]["distance"]:
                state["closest"] = {"distance": closest[0], "pair": apart["pair"], "points": closest[1], "when": apart["when"]}

        def contact_state(index: int, contact: dict) -> dict:
            """A declared contact as reported: whether any pair it applies to touched (absent when none was checked), and
            when none did, the closest of them."""
            out = {"a": contact["a"], "b": contact["b"], "kind": contact["kind"],
                   "max_overlap_mm3": None if math.isinf(contact["allowance"]) else contact["allowance"]}
            state = seats.get(index)
            if state is None or not (state["touching"] or state["closest"]):
                return out
            out["touching"] = state["touching"]
            if not state["touching"]:
                near = state["closest"]
                out["closest"] = {"a": near["pair"][0], "b": near["pair"][1], "min_distance_mm": round(near["distance"], 4),
                                  **({"at_least": True} if near.get("at_least") else {}), "points": near["points"], "when": near["when"]}
            return out

        contacts = [contact_state(index, contact) for index, contact in enumerate(self.contacts)]
        ranked = sorted(found.values(), key=lambda entry: entry[0], reverse=True)
        issues = [item for severity, item in ranked if severity[0]]
        intended = [item for severity, item in ranked if not severity[0]]
        touching = [item for pair, item in touched.items() if pair not in found]  # a pair that's an issue elsewhere is listed there
        def named(late_pairs: list) -> str:
            return ", ".join(f"{a!r}/{b!r}" for a, b in late_pairs[:10]) + (f" and {len(late_pairs) - 10} more" if len(late_pairs) > 10 else "")

        # A late pair is listed as unverified where an overlap or a clearance needed its answer; the rest (no clearance,
        # no declared contact, the distance late) only lack whether they touch, which doesn't decide clear. Both notes
        # say "ran out of time", so neither result is kept for reuse (_settled).
        unverified = [pair for pair in late if pair in found and found[pair][1].get("unverified")]
        undetermined = [pair for pair in late if pair not in unverified]
        if unverified:
            notes.append(f"The exact check of {named(unverified)} ran out of time ({budget_words(budget)}); listed as unverified, not clear.")
        if undetermined:
            notes.append(f"The exact distance of {named(undetermined)} ran out of time ({budget_words(budget)}); whether they touch wasn't "
                         "determined (that alone doesn't fail the check).")
        if invalid:
            notes.append(f"Not valid closed solids, so results with them are approximate: {', '.join(invalid)}.")
        if max(len(issues), len(intended)) > FIT_LISTED:
            notes.append(f"Lists the worst {FIT_LISTED} pairs of each kind.")
        if len(touching) > FIT_LISTED:
            notes.append(f"Lists the first {FIT_LISTED} of {len(touching)} touching pairs.")
        # Every requested pose and sweep checked, or the check is incomplete: never clear, the rest named in `unchecked`.
        skipped = {"poses": requested[len(checked):], "sweeps": unswept}
        complete = not skipped["poses"] and not unswept and all(sweep["complete"] for sweep in sweeps)
        report = {"name": check["name"], "instances": sorted(scope) if check["instances"] is not None else None, "poses": checked, "sweeps": sweeps,
                  "clearance_mm": self.gaps["default"], "pairs_checked": len(pairs), "complete": complete, "clear": complete and not issues,
                  **({"unchecked": skipped} if skipped["poses"] or unswept else {}), "issues": issues[:FIT_LISTED],
                  "intended": intended[:FIT_LISTED], "contacts": contacts, "touching": touching[:FIT_LISTED], "touching_count": len(touching)}
        if invalid:
            report["approximate"] = invalid
        if notes:
            report["note"] = " ".join(notes)
        return report

    def components(self) -> list[Component]:
        """Each component placed in the design, once (linked documents aside)."""
        seen: list[Component] = []
        for item in self.instances:
            if isinstance(item["component"], Component) and item["component"] not in seen:
                seen.append(item["component"])
        return seen

    def bom(self, instances: bool = False) -> list[dict]:
        """Bill of materials: each component, and each linked document with its overrides, with its quantity. Printed
        instances (`print=`) are rows of their own per print settings, listing their instances: one print file each.
        Declared fasteners (`design.fasten`) add their screws, washers, nuts and inserts; a placed screw that is a
        fastener's `instance` is counted there, once. Declared cables (`design.cable`) are a line each, with their cut length.
        Components that aren't hardware (`Component(..., hardware=False)`) have no row.
        `instances=True` lists every row's placed instances (a drawing's balloons point at them)."""
        from .cables import bom_rows
        from .fasteners import hardware
        from .links import LinkedInstance
        rows: dict[tuple, dict] = {}
        declared = {f["instance"] for f in self.fasteners if f["instance"]}
        for item in self.instances:
            if item["name"] in declared or not is_hardware(item["component"]):
                continue
            part = item["component"]
            printed = item.get("print")
            settings = json.dumps(printed, sort_keys=True) if printed else None
            if isinstance(part, LinkedInstance):
                key = ("link", part.alias, json.dumps(part.overrides, sort_keys=True), settings)
                row = rows.setdefault(key, {"item": part.alias, "name": part.name, "kind": part.source.get("kind", "part"), "link": True,
                                            "document_id": part.source.get("document_id"), "revision": part.source.get("revision"),
                                            "parameters": part.overrides, "quantity": 0})
            else:
                row = rows.setdefault(("component", part.id, settings), {"item": part.id, "name": part.name, "kind": "component", "link": False, "quantity": 0})
            if "surface" not in row and _surface_only(part):  # Only surface bodies: listed, but marked as no part to make.
                row.update(surface=True, note=SURFACE_BOM_NOTE)
            row["quantity"] += 1
            if printed:
                row["print"] = printed
            if printed or instances:
                row.setdefault("instances", []).append(item["name"])
        fasteners = hardware(self.fasteners)
        if instances:  # A declared fastener's placed screw is its screw row's.
            placed = {f["name"]: f["instance"] for f in self.fasteners if f["instance"]}
            for row in fasteners:
                row["instances"] = [placed[name] for name in row["fasteners"] if name in placed] if row["kind"] == "screw" else []
        return [*rows.values(), *fasteners, *bom_rows(self)]

    def result(self) -> cq.Assembly:
        """The design's assembly, one node per instance, and its checks run: end main.py with
        `result = design.result()`."""
        assembly = cq.Assembly(name=self.name)
        placed, failures = 0, []
        from .links import LinkedInstance, placement_problems
        progress.stage("components", of=len(self.instances))
        for index, item in enumerate(self.instances):
            progress.step(index + 1, item=item["name"])
            part = item["component"]
            if isinstance(part, LinkedInstance):
                result = part.result
                if part.source.get("document_id"):
                    self.documents[item["name"]] = part.source["document_id"]
                if getattr(result, "_steve_empty", False):  # A linked part or design with nothing modelled yet.
                    continue
                if isinstance(result, cq.Assembly):
                    assembly.add(result, name=item["name"], loc=item["location"])
                else:
                    values = result.vals() if isinstance(result, cq.Workplane) else [result]
                    shape = values[0] if len(values) == 1 else cq.Compound.makeCompound(values)
                    _add_colored(assembly, shape, item, (0.55, 0.62, 0.72))
                placed += 1
                continue
            shape = part.shape()
            if shape is None:
                # A component with nothing modelled yet is normal; one whose features failed is an error.
                failed = [f"{f.name}: {f.error}" for f in part.features if f.status == "error"]
                if failed:
                    failures.append(f"{part.name} has no bodies: " + " ".join(failed))
                    self.errors.append(failures[-1])
                continue
            missed = _add_colored(assembly, shape, item, (0.39, 0.72, 0.65))
            if missed:
                self.errors.append(f"{item['name']}: couldn't colour {', '.join(missed)}; shown in the instance's colour.")
            placed += 1
        if not placed and failures:
            raise FeatureError(" ".join(["The design has no geometry yet.", *failures]))
        self.errors.extend(placement_problems(self))
        for component in self.components():
            component.save_to_cache()
        # Nothing modelled yet (no components, or only empty ones): an empty design, not a build error. The runtime
        # exports it without geometry; the summary still lists its components and sketches.
        assembly._steve_empty = not placed
        self._checks_left = max(1, sum(1 for d in self.drives if d["check"]) + sum(1 for a in self.animations if a["check"]) + len(self.studies)
                                + len(self.fits) + bool(self.cables) + bool(self.fasteners))
        self.kinematics = self._kinematics() if placed and (self.joints or self.couplings or self.drives or self.poses or self.animations or self.studies
                                                                     or self.fits or self.cables or self.explodes) else None
        if placed and self.fasteners and not _SHEETS_ONLY:
            from .fasteners import evaluate
            progress.stage("fastener_check")
            try:
                self.fastener_report = evaluate(self, self._budget())
            except Exception as error:  # A reporting problem never fails the build.
                self.errors.append(f"Fastener checks failed: {type(error).__name__}: {error}"[:300])
        assembly._steve_design = self
        _DESIGNS.append(self)
        progress.stage("main")  # Back in main.py's code.
        return assembly

    def summary(self) -> dict:
        """The build's report: each component's own summary, the instances and where they are, linked documents, the
        bill of materials, motion and fastener checks, what came from earlier builds (`reused`: components restored from
        the cache, parts whose viewer topology did, motion and fit checks), and errors. Components and instances that
        aren't hardware (`Component(..., hardware=False)`) are marked `hardware: false`."""
        reused = {"components": sum(1 for c in self.components() if c.cache == "hit"), "topology": _TOPOLOGY_REUSED, "checks": self.reused_checks}
        return {"version": 1, "name": self.name, **({"reused": reused} if any(reused.values()) else {}),
                "components": {c.id: {"name": c.name, "file": c.file, "cache": c.cache, **({} if is_hardware(c) else {"hardware": False}), **c.summary()}
                               for c in self.components()},
                "instances": [{"name": i["name"], "component": i["component"].id, "at": _jsonable(i["at"]),
                               **({} if is_hardware(i["component"]) else {"hardware": False}),
                               **({"link": True} if not isinstance(i["component"], Component) else {"bodies": _placed_extents(i)}),
                               **({"print": i["print"], "placement": _placement(i["location"])} if i.get("print") else {})}
                              for i in self.instances],
                "links": {i["component"].alias: {"name": i["component"].name, "kind": i["component"].source.get("kind"),
                                                 **({} if is_hardware(i["component"]) else {"hardware": False}),
                                                 "document_id": i["component"].source.get("document_id"), "revision": i["component"].source.get("revision"),
                                                 "summary": i["component"].summary}
                          for i in self.instances if not isinstance(i["component"], Component)},
                "bom": self.bom(), **({"kinematics": self.kinematics} if self.kinematics else {}),
                **({"fasteners": self.fastener_report} if self.fastener_report else {}), "errors": self.errors}


def _add_colored(assembly: cq.Assembly, shape: cq.Shape, item: dict, default: tuple) -> list[str]:
    """One instance in the design's assembly (one named node, which the STEP keeps), coloured as the viewer shows it:
    its bodies' material colours (steve/materials.py body_colors), the others `default`. A one-body part takes its
    body's colour; several bodies carry theirs as sub-shape colours, per solid (a body made by model.add from several
    solids is a compound, which CadQuery's sub-shape lookup doesn't find inside the node's compound). The inspection
    views read them from the STEP. Returns the ids of bodies that couldn't be coloured: colour never fails a build."""
    from .materials import body_colors, face_colors
    model = getattr(shape, "_steve_model", None)
    colors = body_colors(model)
    faces = face_colors(model)
    single = len(colors) == 1 and len(model.bodies) == 1
    # Material colours are opaque (alpha 1).
    color = cq.Color(*next(iter(colors.values())), 1) if single else cq.Color(*default)
    assembly.add(shape, name=item["name"], loc=item["location"], color=color)
    missed = []
    node = assembly.children[-1]  # The node just added.
    if colors and not single:
        for body_id, rgb in colors.items():
            try:
                for solid in model.bodies[body_id].Solids():
                    node.addSubshape(solid, color=cq.Color(*rgb, 1))
            except Exception:  # The body keeps the instance's colour.
                missed.append(body_id)
    for face, rgb in faces:  # model.appearance(faces=...): over the body's colour.
        try:
            node.addSubshape(face, color=cq.Color(*rgb, 1))
        except Exception:  # The face keeps its body's colour.
            pass
    return missed


PRINT_PROCESSES = ("fdm", "sla", "sls", "mjf")
BUILD_DIRECTIONS = ("+Z", "-Z", "+X", "-X", "+Y", "-Y")


def _print_settings(settings, instance: str) -> dict | None:
    """`print=` of design.add/pattern: None (not printed), True (FDM, +Z up) or a dict of settings, checked."""
    if settings is None or settings is False:
        return None
    if settings is True:
        settings = {}
    if not isinstance(settings, dict):
        raise FeatureError(f"{instance}: print= takes True or a dict like {{\"process\": \"fdm\", \"build_direction\": \"+Z\", \"material\": \"petg\"}}.")
    unknown = sorted(set(settings) - {"process", "build_direction", "material", "group", "notes"})
    if unknown:
        raise FeatureError(f"{instance}: print= doesn't take {', '.join(map(repr, unknown))}; it takes process, build_direction, material, group and notes.")
    process = settings.get("process", "fdm")
    if process not in PRINT_PROCESSES:
        raise FeatureError(f"{instance}: print process {process!r} must be one of {', '.join(PRINT_PROCESSES)}.")
    up = settings.get("build_direction", "+Z")
    up = up.strip().upper() if isinstance(up, str) else up
    up = f"+{up}" if isinstance(up, str) and up in ("X", "Y", "Z") else up
    if up not in BUILD_DIRECTIONS:
        raise FeatureError(f"{instance}: print build_direction {settings.get('build_direction')!r} must be one of {', '.join(BUILD_DIRECTIONS)} "
                           "(the part's own axis that points up on the printer).")
    out = {"process": process, "build_direction": up}
    for key in ("material", "group", "notes"):
        value = settings.get(key)
        if value is None:
            continue
        if not isinstance(value, str) or not value.strip():
            raise FeatureError(f"{instance}: print {key} must be text, not {value!r}.")
        out[key] = value.strip()
    if "material" in out:
        from .materials import library
        density = library().get(out["material"], {}).get("density")
        if density:
            out["density_g_cm3"] = density
    return out


def _placement(location: cq.Location) -> list[list[float]]:
    """A placement's 3×4 [R|t] (mm), as the print meshes carry it."""
    trsf = location.wrapped.Transformation()
    return [[round(trsf.Value(row, col), 12) + 0.0 for col in range(1, 5)] for row in range(1, 4)]


def _placed_extents(item: dict) -> dict:
    """Each body's exact extent where the instance is placed (as modelled), for exact print placement."""
    from .model import _extent
    return {body_id: _extent(body.moved(item["location"])) for body_id, body in item["component"].bodies.items()}


def _instance_shape(item: dict) -> cq.Shape | None:
    """An instance's solids where it is placed (rest pose)."""
    shape = _own_shape(item)
    return shape.moved(item["location"]) if shape is not None else None


def _own_shape(item: dict) -> cq.Shape | None:
    """An instance's solids in its component's (or linked document's) own frame."""
    part = item["component"]
    if isinstance(part, Component):
        shape = part.shape()
    else:
        result = part.result
        if isinstance(result, cq.Assembly):
            shape = result.toCompound()
        else:
            values = result.vals() if isinstance(result, cq.Workplane) else [result]
            shape = values[0] if len(values) == 1 else cq.Compound.makeCompound(values)
    return shape


class _Clashes:
    """Exact common volume between every two instances that `moving` (joint and coupling names) move relative to each
    other: one moved and one not, or moved by different joints. Instances moved by the same joints (fastened together)
    move as one body and aren't checked. Nor are `ignore`d pairs, pairs missing from `only` (when given), or pairs that
    already overlap in the code's pose (a pin modelled in its bore: `at_rest`). Instances are placed with the viewer's
    forward kinematics (`_effective` + `_instance_motions`). `simple` (instance → collision-shape solids, as modelled)
    scores the live pairs whose instances both have them. Large pairs get no answer past `deadline` (time.monotonic(),
    `_bounded`): unverified, never clear."""

    def __init__(self, design: "Design", joints: list[dict], couplings: list[dict], moving: set[str], ignore=(), only=None, simple=None,
                 deadline: float | None = None):
        self.joints, self.couplings, self.deadline = joints, couplings, deadline
        self.exact = design._answers()
        self.shapes = self.exact.shapes
        by_coupling = {c["name"]: c for c in couplings}
        geared = set()
        for name in moving:
            geared |= {key.partition(".")[0] for key in by_coupling[name]["gears"]} if name in by_coupling else {name}
        by_child = {j["child"]: j for j in joints}

        def chain(name: str) -> frozenset:  # The moving joints between an instance and the ground.
            out = set()
            for _ in range(64):
                joint = by_child.get(name)
                if joint is None:
                    break
                if joint["name"] in geared:
                    out.add(joint["name"])
                name = joint["parent"]
            return frozenset(out)

        chains = {name: chain(name) for name in self.shapes}
        skip = {frozenset(pair) for pair in ignore}
        wanted = {frozenset(pair) for pair in only} if only is not None else None
        names, pairs = list(self.shapes), []
        for i, a in enumerate(names):
            for b in names[i + 1:]:
                key = frozenset((a, b))
                if chains[a] == chains[b] or key in skip or (wanted is not None and key not in wanted):
                    continue
                pairs.append((a, b) if len(chains[a]) >= len(chains[b]) else (b, a))  # What moves more is named first.
        self.unverified: set[tuple] = set()  # Pairs whose boolean failed somewhere: not known to be clear.
        motions = self.motions(None, {})
        rest = self.place(None, {}, {name for pair in pairs for name in pair}, motions)
        boxes = {name: _box(shape) for name, shape in rest.items()}
        touching = [(a, b) for a, b in pairs if not boxes[a].IsOut(boxes[b])]
        self.at_rest = [pair for pair, volume in zip(touching, self.volumes(rest, motions, touching)) if volume > CLASH_TOLERANCE]
        self.live = [pair for pair in pairs if pair not in self.at_rest]
        self.needed = {name for pair in self.live for name in pair}
        for name in sorted(self.needed):  # Meshed once here, so the forked workers share them (_Exact._apart).
            self.exact._mesh(name)
        self.simple = simple or {}
        self.scored = [(a, b) for a, b in self.live if a in self.simple and b in self.simple]

    def motions(self, own: dict | None, coupled: dict) -> dict:
        return _instance_motions(self.joints, _effective(self.joints, self.couplings, own, coupled))

    def place(self, own: dict | None, coupled: dict, names, motions: dict | None = None) -> dict[str, cq.Shape]:
        motions = self.motions(own, coupled) if motions is None else motions
        return {name: self.shapes[name].moved(cq.Location(motions[name])) if name in motions else self.shapes[name] for name in names}

    def collides(self, own: dict | None, coupled: dict) -> bool:
        """Whether any pair collides at a pose: stops at the first (the boundary search only needs yes or no)."""
        motions = self.motions(own, coupled)
        placed = self.place(own, coupled, self.needed, motions)
        boxes = {name: _box(shape) for name, shape in placed.items()}
        return any(not boxes[a].IsOut(boxes[b]) and self.volume(placed, motions, a, b) > CLASH_TOLERANCE for a, b in self.live)

    def detail(self, own: dict | None, coupled: dict, clearance: float = 0.0, measure: bool = False) -> tuple[dict, dict, dict]:
        """A study's look at one pose: each colliding pair's (common volume mm³, overlap depth mm, overlap centre); with a
        clearance, each clear pair within it as (distance mm, closest points on a and b), or every clear pair however far
        with `measure` (for studies that list their pairs); and for the scored pairs, whether their collision shapes collide."""
        motions = self.motions(own, coupled)
        placed = self.place(own, coupled, self.needed, motions)
        boxes = {name: _box(shape) for name, shape in placed.items()}
        hits, near, simple = {}, {}, {}

        def one(pair: tuple) -> tuple:  # (overlap, closest, unverified) of a pair: its effects, applied below in order.
            a, b = pair
            failed = False
            if boxes[a].IsOut(boxes[b]):
                if not measure and (not clearance or _box(placed[a], clearance).IsOut(boxes[b])):
                    return None, None, failed
            else:
                overlap = self.exact.overlap(placed, motions, a, b, self.deadline)
                if overlap is None or isinstance(overlap, _NoAnswer):
                    failed = True
                elif overlap[0] > CLASH_TOLERANCE:
                    return overlap, None, failed
                if not clearance and not measure:
                    return None, None, failed
            closest = self.exact.closest(placed, motions, a, b, self.deadline)
            if not isinstance(closest, _NoAnswer) and (measure and math.isfinite(closest[0]) or closest[0] <= clearance):
                return None, closest, failed
            return None, None, failed

        for pair, (overlap, closest, failed) in zip(self.live, _each(self.live, one, self.exact)):
            if failed:
                self.unverified.add(pair)
            if overlap is not None:
                hits[pair] = overlap
            if closest is not None:
                near[pair] = closest
        if self.scored:
            moved = {name: [solid.moved(cq.Location(motions[name])) if name in motions else solid for solid in self.simple[name]]
                     for name in {name for pair in self.scored for name in pair}}
            boxed = {name: [_box(solid) for solid in solids] for name, solids in moved.items()}
            for a, b in self.scored:
                simple[(a, b)] = any(not boxed[a][i].IsOut(boxed[b][j]) and (_volume(p, q) or 0.0) > CLASH_TOLERANCE
                                     for i, p in enumerate(moved[a]) for j, q in enumerate(moved[b]))
        return hits, near, simple

    def volume(self, placed: dict, motions: dict, a: str, b: str) -> float:
        return self.volumes(placed, motions, [(a, b)])[0]

    def volumes(self, placed: dict, motions: dict, pairs: list) -> list[float]:
        """Each pair's common volume; a pair whose boolean failed is unverified, its volume 0."""
        def one(pair: tuple):
            overlap = self.exact.overlap(placed, motions, *pair, self.deadline)
            return None if overlap is None or isinstance(overlap, _NoAnswer) else overlap[0]
        out = []
        for pair, volume in zip(pairs, _each(pairs, one, self.exact)):
            if volume is None:
                self.unverified.add(pair)
            out.append(volume or 0.0)
        return out

    def check(self, own: dict | None, coupled: dict, clearance: float = 0.0) -> tuple[dict, dict]:
        """Each colliding pair's common volume (mm³) at a pose; with a clearance, how close clear pairs within it come (mm)."""
        motions = self.motions(own, coupled)
        placed = self.place(own, coupled, self.needed, motions)
        boxes = {name: _box(shape) for name, shape in placed.items()}
        hits, near = {}, {}

        def one(pair: tuple) -> tuple:  # (volume, distance, unverified) of a pair: its effects, applied below in order.
            a, b = pair
            failed = False
            if boxes[a].IsOut(boxes[b]):
                if not clearance or _box(placed[a], clearance).IsOut(boxes[b]):
                    return None, None, failed
            else:
                overlap = self.exact.overlap(placed, motions, a, b, self.deadline)
                failed = overlap is None or isinstance(overlap, _NoAnswer)
                volume = 0.0 if failed else overlap[0]
                if volume > CLASH_TOLERANCE:
                    return volume, None, failed
                if not clearance:
                    return None, None, failed
            closest = self.exact.closest(placed, motions, a, b, self.deadline)
            if not isinstance(closest, _NoAnswer) and closest[0] <= clearance:
                return None, closest[0], failed
            return None, None, failed

        for pair, (volume, distance, failed) in zip(self.live, _each(self.live, one, self.exact)):
            if failed:
                self.unverified.add(pair)
            if volume is not None:
                hits[pair] = volume
            if distance is not None:
                near[pair] = distance
        return hits, near


def _unverified(clashes: _Clashes) -> dict:
    """Pairs whose exact boolean failed: reported, never counted as clear."""
    return {"unverified": [{"a": a, "b": b} for a, b in sorted(clashes.unverified)]} if clashes.unverified else {}


def _box(shape: cq.Shape, gap: float = 0.0):
    from OCP.BRepBndLib import BRepBndLib
    from OCP.Bnd import Bnd_Box
    box = Bnd_Box()
    BRepBndLib.Add_s(shape.wrapped, box)
    if gap:
        box.Enlarge(gap)
    return box


def _corners(box) -> tuple:
    """(xmin, ymin, zmin, xmax, ymax, zmax) of a Bnd_Box, its gap included."""
    return (*box.CornerMin().Coord(), *box.CornerMax().Coord())


def _volume(a: cq.Shape, b: cq.Shape) -> float | None:
    """The exact common volume (mm³), or None when the boolean failed: never a silent zero."""
    common = _common(a, b)
    return common[0] if common else None


def _common(a: cq.Shape, b: cq.Shape) -> tuple[float, list[float]] | None:
    """The common volume (mm³) and its centre, or None when the boolean failed."""
    overlap = _overlap(a, b)
    return (overlap[0], overlap[2]) if overlap else None


def _overlap(a: cq.Shape, b: cq.Shape) -> tuple[float, float, list[float]] | None:
    """The common volume (mm³), its depth (mm, `_thickness`) and its centre, or None when the boolean failed."""
    overlap = _exact_overlap(a, b)
    return (overlap[0], overlap[1], _rounded(overlap[2])) if overlap else None


def _rounded(point) -> list[float]:
    return [round(point[0], 4), round(point[1], 4), round(point[2], 4)]


def _exact_overlap(a: cq.Shape, b: cq.Shape) -> tuple[float, float, tuple] | None:
    """`_overlap` with its centre unrounded, so a kept answer can be moved to a new placement (`_Exact`)."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    from OCP.BRepGProp import BRepGProp
    from OCP.collections import List_TopoDS_Shape as TopTools_ListOfShape
    from OCP.GProp import GProp_GProps
    try:
        common = BRepAlgoAPI_Common()
        arguments, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
        arguments.Append(a.wrapped)
        tools.Append(b.wrapped)
        common.SetArguments(arguments)
        common.SetTools(tools)
        common.SetUseOBB(True)  # Only faces whose oriented boxes meet are intersected: the same result, less work.
        common.Build()
    except Exception:  # a kernel failure reads as unverified, never as a crashed build
        return None
    # IsDone only: OCP doesn't bind HasErrors on the BRepAlgoAPI classes (it's protected in OCCT)
    if not common.IsDone() or common.Shape().IsNull():
        return None
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(common.Shape(), props)
    centre, volume = props.CentreOfMass(), max(props.Mass(), 0.0)
    depth = _thickness(props.MatrixOfInertia(), volume) if volume > CLASH_TOLERANCE else 0.0
    return volume, depth, (centre.X(), centre.Y(), centre.Z())


def _thickness(inertia, volume: float) -> float:
    """How thick a solid is across its thinnest direction, from its volume and inertia about its centre: the box with the
    same second moments (exact for a box- or slab-shaped overlap, an estimate otherwise; a ball reads 0.77 × its
    diameter). Along a principal axis with moment I, ∫x² dV = trace/2 − I, smallest for the largest I; a box's side is
    √(12 ∫x² dV / V)."""
    m = [[inertia.Value(row, col) for col in (1, 2, 3)] for row in (1, 2, 3)]
    trace = m[0][0] + m[1][1] + m[2][2]
    off = m[0][1] ** 2 + m[0][2] ** 2 + m[1][2] ** 2
    if off == 0:
        largest = max(m[0][0], m[1][1], m[2][2])
    else:  # The largest eigenvalue of a symmetric 3×3 matrix, in closed form.
        q = trace / 3
        p = math.sqrt(((m[0][0] - q) ** 2 + (m[1][1] - q) ** 2 + (m[2][2] - q) ** 2 + 2 * off) / 6)
        n = [[(m[r][c] - (q if r == c else 0.0)) / p for c in range(3)] for r in range(3)]
        det = (n[0][0] * (n[1][1] * n[2][2] - n[1][2] * n[2][1]) - n[0][1] * (n[1][0] * n[2][2] - n[1][2] * n[2][0])
               + n[0][2] * (n[1][0] * n[2][1] - n[1][1] * n[2][0]))
        largest = q + 2 * p * math.cos(math.acos(min(max(det / 2, -1.0), 1.0)) / 3)
    return math.sqrt(max(12 * (trace / 2 - largest) / volume, 0.0))


def _closest(a: cq.Shape, b: cq.Shape) -> tuple[float, list | None]:
    """The minimum distance (mm) and the two closest points (on a, then on b)."""
    distance, points = _exact_closest(a, b)
    return distance, [_rounded(p) for p in points] if points else None


def _exact_closest(a: cq.Shape, b: cq.Shape) -> tuple[float, list | None]:
    """`_closest` with its points unrounded (`_Exact`)."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    measure = BRepExtrema_DistShapeShape(a.wrapped, b.wrapped)
    if not measure.IsDone() or measure.NbSolution() < 1:
        return math.inf, None
    points = [measure.PointOnShape1(1), measure.PointOnShape2(1)]
    return measure.Value(), [(p.X(), p.Y(), p.Z()) for p in points]


_IDENTITY = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0)


def _matrix(trsf) -> tuple:
    """A motion's 3×4 [R|t], exactly as stored (none: the identity)."""
    return _IDENTITY if trsf is None else tuple(trsf.Value(row, col) for row in (1, 2, 3) for col in (1, 2, 3, 4))


class _Exact:
    """The exact answers (common volume, minimum distance) of the pairs one build's checks measure, kept for the build.
    Both depend only on the two instances' solids and where b sits in a's frame, so a pair met again in the same
    relative placement (at rest and at each named pose while neither moves against the other, or at a study's poses
    that only move other joints) is answered from its first measurement instead of again: one pair of curved parts
    took 64 s each time. The placement must match exactly, the same 3×4 matrix to the last bit (no tolerance), and the
    answer's points are moved from where a sat then to where it sits now (unchanged, bit for bit, when a hasn't moved).
    A boolean that failed, a distance with no solution and a call that ran out of time (`_NoAnswer`) are never kept:
    they are asked again, as they always were. `shapes` (instance → its solids at rest) is the build's own: the checks
    share it, so the names key it."""

    def __init__(self, shapes: dict):
        self.shapes = shapes
        self.answers: dict[tuple, tuple] = {}  # key → (a's motion then, as `_matrix`, raw answer): plain data a worker can send
        self.probing = False  # `_each`: an answer not kept yet raises _Unknown instead of being measured
        self.fresh: list[tuple] = []  # keys kept since a worker of `_each` began its item
        self.meshes: dict[str, object] = {}  # instance → meshed copy of its solids at rest, or None (`_mesh`)

    def _apart(self, motions: dict, a: str, b: str) -> bool:
        """Whether a and b, where `motions` puts them, are certainly apart, so they share no volume and the exact
        boolean (about 0.4 s a pair on curved parts) can be skipped. Their meshes (`_mesh`) must stay more than
        PROXIMITY_MM apart, many times the most two touching surfaces' meshes can be apart (twice MESH_DEFLECTION_MM),
        and neither may lie inside the other. Anything unsure (a face without a mesh, a failed mesh) says no, and the
        boolean answers as before."""
        try:
            mesh_a, mesh_b = self._mesh(a), self._mesh(b)
            if mesh_a is None or mesh_b is None:
                return False
            from OCP.BRepExtrema import BRepExtrema_ShapeProximity
            from OCP.TopLoc import TopLoc_Location
            here, there = motions.get(a), motions.get(b)
            moved_a = mesh_a.Moved(TopLoc_Location(here)) if here is not None else mesh_a
            moved_b = mesh_b.Moved(TopLoc_Location(there)) if there is not None else mesh_b
            proximity = BRepExtrema_ShapeProximity(moved_a, moved_b, PROXIMITY_MM)
            if proximity.ElementSet1() is None or proximity.ElementSet2() is None:
                return False
            proximity.Perform()
            if proximity.OverlapSubShapes1().Size() or proximity.OverlapSubShapes2().Size():
                return False
            # One lies inside the other only if its box lies inside the other's box (a cheap test first).
            box_a, box_b = _corners(_box(cq.Shape.cast(moved_a))), _corners(_box(cq.Shape.cast(moved_b)))
            return not (_box_within(box_a, box_b) and _inside(moved_a, moved_b)) \
                and not (_box_within(box_b, box_a) and _inside(moved_b, moved_a))
        except Exception:  # noqa: BLE001 - unsure: the exact boolean answers
            return False

    def _mesh(self, name: str):
        """A meshed copy of the instance's solids at rest (the topology copied, so the build's own shapes and their
        export meshes are untouched), or None when any face couldn't be meshed. Made once per build; forked workers
        inherit the ones made before them."""
        if name not in self.meshes:
            from OCP.BRep import BRep_Tool
            from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
            from OCP.BRepMesh import BRepMesh_IncrementalMesh
            from OCP.TopAbs import TopAbs_FACE
            from OCP.TopExp import TopExp_Explorer
            from OCP.TopLoc import TopLoc_Location
            from OCP.TopoDS import TopoDS
            copy = BRepBuilderAPI_Copy(self.shapes[name].wrapped, False).Shape()
            BRepMesh_IncrementalMesh(copy, MESH_DEFLECTION_MM, False, MESH_ANGLE, False)
            faces = TopExp_Explorer(copy, TopAbs_FACE)
            while faces.More():
                if BRep_Tool.Triangulation_s(TopoDS.Face(faces.Current()), TopLoc_Location()) is None:
                    copy = None
                    break
                faces.Next()
            self.meshes[name] = copy
        return self.meshes[name]

    def overlap(self, placed: dict, motions: dict, a: str, b: str, deadline: float | None):
        """`_overlap(placed[a], placed[b])` through `_bounded`: (volume, depth, centre), None or a `_NoAnswer`."""
        answer = self._ask(_exact_overlap, placed, motions, a, b, deadline)
        if answer is None or isinstance(answer, _NoAnswer):
            return answer
        (volume, depth, centre), move = answer
        return volume, depth, _rounded(move(centre))

    def apart(self, motions: dict, a: str, b: str) -> bool:
        """Whether the overlap of a and b in this relative placement was answered by the mesh pre-check (`_apart`): they
        are certainly more than PROXIMITY_MM apart, so not touching. False when it wasn't asked or was unsure."""
        here, there = motions.get(a), motions.get(b)
        return ("apart", a, b, _relative(motions, a, b, here, there, _matrix(here), _matrix(there))) in self.answers

    def closest(self, placed: dict, motions: dict, a: str, b: str, deadline: float | None):
        """`_closest(placed[a], placed[b])` through `_bounded`: (distance, points) or a `_NoAnswer`."""
        answer = self._ask(_exact_closest, placed, motions, a, b, deadline)
        if isinstance(answer, _NoAnswer):
            return answer
        (distance, points), move = answer
        return distance, [_rounded(move(p)) for p in points] if points else None

    def _ask(self, work, placed: dict, motions: dict, a: str, b: str, deadline: float | None):
        """(raw answer, how to move its points to a's placement now), None (a failed boolean) or a `_NoAnswer`."""
        here, there = motions.get(a), motions.get(b)
        mine, theirs = _matrix(here), _matrix(there)
        relative = _relative(motions, a, b, here, there, mine, theirs)
        key = (work.__name__, a, b, relative)
        if key not in self.answers:
            if self.probing:
                raise _Unknown
            if work is _exact_overlap and self._apart(motions, a, b):
                answer = _NO_COMMON  # What the boolean returns for two solids that don't meet.
                self.answers[("apart", a, b, relative)] = (mine, True)  # kept beside it: `apart`
                self.fresh.append(("apart", a, b, relative))
            else:
                answer = _bounded(work, placed[a], placed[b], deadline)
            if answer is None or isinstance(answer, _NoAnswer):
                return answer
            if work is _exact_closest and answer[1] is None:  # No solution: as it came, never kept.
                return answer, lambda p: p
            self.answers[key] = (mine, answer)
            self.fresh.append(key)
        then, answer = self.answers[key]
        if then == mine:
            return answer, lambda p: p
        from OCP.gp import gp_Pnt, gp_Trsf
        move = gp_Trsf()
        move.SetValues(*then)
        move.Invert()  # Back into a's own frame, then to where a is now.
        if here is not None:
            move = here.Multiplied(move)
        return answer, lambda p: (lambda q: (q.X(), q.Y(), q.Z()))(gp_Pnt(*p).Transformed(move))


# The mesh pre-check of the exact overlap (_Exact._apart): meshes this close to the true surface, and pairs whose meshes
# come within PROXIMITY_MM of each other go to the exact boolean. Two surfaces that touch have meshes at most about
# twice the deflection apart; the margin is five times that.
MESH_DEFLECTION_MM = 0.1
MESH_ANGLE = 0.3  # radians
PROXIMITY_MM = 1.0
_NO_COMMON = (0.0, 0.0, (0.0, 0.0, 0.0))  # `_exact_overlap` of two solids that share no volume


def _box_within(inner: tuple, outer: tuple, slack: float = PROXIMITY_MM) -> bool:
    """Whether box `inner` (`_corners`) lies within box `outer`, give or take `slack`: a solid can lie inside another
    only if its box does."""
    return all(inner[i] >= outer[i] - slack for i in range(3)) and all(inner[i] <= outer[i] + slack for i in range(3, 6))


def _inside(a, b) -> bool:
    """Whether any solid of a has a point inside (or on) a solid of b: a part wholly inside another shares volume with it
    though their surfaces never meet. One vertex of each solid of a, classified against each solid of b; a solid
    with no vertex counts as inside (unsure)."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_OUT, TopAbs_SOLID, TopAbs_VERTEX
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    def solids(shape):
        found, explorer = [], TopExp_Explorer(shape, TopAbs_SOLID)
        while explorer.More():
            found.append(explorer.Current())
            explorer.Next()
        return found

    others = solids(b)
    for solid in solids(a):
        vertex = TopExp_Explorer(solid, TopAbs_VERTEX)
        if not vertex.More():
            return True
        point = BRep_Tool.Pnt_s(TopoDS.Vertex(vertex.Current()))
        for other in others:
            classifier = BRepClass3d_SolidClassifier(other, point, 1e-7)
            if classifier.State() != TopAbs_OUT:
                return True
    return False


def _relative(motions: dict, a: str, b: str, here, there, mine: tuple, theirs: tuple) -> tuple:
    """Where b sits in a's frame, as `_matrix`. From the joints that move only one of them (_Motions.chains) when
    known: the joints they share cancel, so a pair whose own joints haven't moved gets the same matrix to the last bit
    at every pose, however the joints below them turned (multiplying the whole chains instead rounds differently at
    each pose, and the pair would be measured again)."""
    chains = getattr(motions, "chains", None)
    if chains is not None:
        from OCP.gp import gp_Trsf
        mine_chain, theirs_chain = chains.get(a, ()), chains.get(b, ())
        if (here is None) == (a not in chains) and (there is None) == (b not in chains):  # The chains are these motions'.
            shared = 0
            for (x, _), (y, _) in zip(mine_chain, theirs_chain):
                if x != y:
                    break
                shared += 1

            def product(links):
                out = None
                for _, own in links:
                    out = own if out is None else out.Multiplied(own)
                return out

            own_a, own_b = product(mine_chain[shared:]), product(theirs_chain[shared:])
            if own_a is None:
                return _matrix(own_b)
            return _matrix(own_a.Inverted().Multiplied(own_b if own_b is not None else gp_Trsf()))
    if mine == theirs:  # Moved together (or neither moved): b is where it is modelled in a's frame.
        return _IDENTITY
    if mine == _IDENTITY:
        return theirs
    from OCP.gp import gp_Trsf
    return _matrix(here.Inverted().Multiplied(there if there is not None else gp_Trsf()))


class _NoAnswer:
    """What `_bounded` returns instead of an answer: the deadline passed first (`_LATE`), or its child died (`_LOST`)."""


_LATE, _LOST = _NoAnswer(), _NoAnswer()
FORK_MEMORY = 64 * 1024 * 1024  # the least memory left for which a pair is measured in a child rather than in this process


def _faces(shape: cq.Shape) -> int:
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher
    faces = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
    TopExp.MapShapes_s(shape.wrapped, TopAbs_FACE, faces)
    return faces.Extent()


def _memory_left() -> int | None:
    """Bytes this job's container can still use (cgroup v2), or None if unlimited (as run.memory_headroom)."""
    try:
        limit = Path("/sys/fs/cgroup/memory.max").read_text().strip()
        return None if limit == "max" else int(limit) - int(Path("/sys/fs/cgroup/memory.current").read_text())
    except (OSError, ValueError):
        return None


def _bounded(work, a: cq.Shape, b: cq.Shape, deadline: float | None):
    """`work(a, b)`, an exact kernel call that can't be interrupted, answered by `deadline` (time.monotonic()) or not at
    all (`_LATE`). Small pairs (most) are measured in this process, as always; a pair with more than BOUNDED_FACES faces
    is measured in a forked child that shares the placed shapes and is killed at the deadline, so one pair (coplanar
    plates with hundreds of holes) can't hold its check, and the build, past the check's budget. Same exact answers."""
    import multiprocessing
    import signal
    import time
    if deadline is None or _faces(a) + _faces(b) <= BOUNDED_FACES:
        return work(a, b)
    left = deadline - time.monotonic()
    if left <= 0:
        return _LATE
    if (memory := _memory_left()) is not None and memory < FORK_MEMORY:
        return work(a, b)
    reader, writer = multiprocessing.Pipe(duplex=False)

    def child():
        signal.signal(signal.SIGALRM, signal.SIG_IGN)  # the parent's topology timer isn't the child's
        reader.close()
        try:
            answer = (True, work(a, b))
        except Exception:  # noqa: BLE001 - only that it failed crosses back, never the kernel's text
            answer = (False, None)
        writer.send(answer)

    process = multiprocessing.get_context("fork").Process(target=child, daemon=True)
    try:
        process.start()
    except OSError:  # no process to spare: measured here, as always
        reader.close()
        writer.close()
        return work(a, b)
    writer.close()
    try:
        if not reader.poll(left):
            return _LATE
        done, answer = reader.recv()
    except EOFError:  # the child died without answering (out of memory)
        return _LOST
    finally:
        reader.close()
        if process.is_alive():
            process.kill()
        process.join()
    if not done:
        raise FeatureError("An exact interference or distance check failed in the geometry kernel.")
    return answer


class _Unknown(Exception):
    """An exact answer `_each`'s first pass found not kept yet: that item goes to a worker."""


CHECK_WORKERS = 4  # the most forked workers a full build's checks measure pairs in at once (a kernel pod's CPU limit)
WORKER_MEMORY = 450 * 1024 * 1024  # what one worker may add on top of the shared, copy-on-write build (as run.WORKER_MEMORY)


def _workers() -> int:
    """How many pairs a check may measure at once: in a full build (which the person starts; `_CHECK_DEADLINE`), the
    CPUs this job may use (its container's CPU quota, cgroup v2 cpu.max, and the CPUs it may run on; a kernel runs one
    job at a time), at most CHECK_WORKERS and no more than the memory left carries; 1 in every other build (previews
    and derived jobs stay on one core, as their reservations assume)."""
    if _CHECK_DEADLINE is None:
        return 1
    cpus = len(os.sched_getaffinity(0))
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()[:2]
        if quota != "max":
            cpus = min(cpus, int(quota) // int(period))
    except (OSError, ValueError, ZeroDivisionError):
        pass
    workers = min(cpus, CHECK_WORKERS)
    if workers >= 2 and (memory := _memory_left()) is not None:
        workers = min(workers, int((memory - 300 * 1024 * 1024) // WORKER_MEMORY))
    return max(1, workers)


_FORKED = None  # (items, work, exact) of the `_each` running: what its forked workers inherit (never pickled)


def _each(items: list, work, exact: "_Exact") -> list:
    """`work(item)` for each item, in order. In a full build with CPUs to spare (`_workers`), the items whose exact
    answers aren't kept yet (a first pass asks `exact` without measuring) are measured by forked workers at once, which
    share the placed shapes; each worker's new answers join `exact` as if measured here, and each item's result lands
    in its place, so a check's results, their order and the answers kept are what one process makes. `work` has no
    effects but its result (it may run in a worker), and its own exact calls keep their deadlines (`_bounded`). A
    worker that dies (out of memory) or fails leaves its item to this process, where it is measured as it always was
    (and fails, if it does, with the same error); a FeatureError a worker raises (`_bounded`'s child failed) is raised
    here."""
    import multiprocessing
    from multiprocessing.connection import wait
    workers = _workers()
    if workers < 2 or len(items) < 2:
        return [work(item) for item in items]
    results, pending = [None] * len(items), []
    exact.probing = True
    try:
        for index, item in enumerate(items):
            try:
                results[index] = work(item)
            except _Unknown:
                pending.append(index)
    finally:
        exact.probing = False
    if len(pending) < 2:
        for index in pending:
            results[index] = work(items[index])
        return results
    global _FORKED
    _FORKED = (items, work, exact)
    context, busy, queue = multiprocessing.get_context("fork"), {}, list(pending)
    try:
        for _ in range(min(workers, len(pending))):
            mine, theirs = context.Pipe()
            # Not a daemon: a worker may fork `_bounded`'s child for a large pair.
            process = context.Process(target=_worker, args=(theirs,), daemon=False)
            try:
                process.start()
            except OSError:  # no process to spare: the rest are measured here
                mine.close()
                break
            theirs.close()
            busy[mine] = (process, None)
        if not busy:
            for index in pending:
                results[index] = work(items[index])
            return results

        def give(conn) -> None:
            index = queue.pop(0) if queue else None
            busy[conn] = (busy[conn][0], index)
            conn.send(index)

        for conn in list(busy):
            give(conn)
        while any(index is not None for _, index in busy.values()):
            for conn in wait([conn for conn, (_, index) in busy.items() if index is not None]):
                process, index = busy[conn]
                try:
                    done, result, answers = conn.recv()
                except (EOFError, OSError):  # The worker died: its item, and the rest if none is left, are measured here.
                    done = None
                if done is None:
                    busy[conn] = (process, None)
                    results[index] = work(items[index])
                    if not any(i is not None for _, i in busy.values()):
                        while queue:
                            index = queue.pop(0)
                            results[index] = work(items[index])
                    continue
                if not done:
                    raise result
                results[index] = result
                exact.answers.update(answers)
                give(conn)
    finally:
        _FORKED = None
        for conn, (process, _) in busy.items():
            conn.close()
            if process.is_alive():
                process.kill()
            process.join()
    return results


def _worker(conn) -> None:
    """One of `_each`'s workers: measures the items it is sent until it is sent None."""
    import signal
    signal.signal(signal.SIGALRM, signal.SIG_IGN)  # the parent's topology timer isn't the worker's
    items, work, exact = _FORKED
    while (index := conn.recv()) is not None:
        exact.fresh = []
        try:
            answer = (True, work(items[index]), {key: exact.answers[key] for key in exact.fresh})
        except FeatureError as error:
            answer = (False, FeatureError(str(error)), None)
        except Exception:  # noqa: BLE001 - the item is measured again in the parent, which fails as it always did
            answer = (None, None, None)
        conn.send(answer)


def _wilson(hits: int, n: int, z: float = 1.96) -> list[float]:
    """The 95 % confidence interval of a sampled fraction (Wilson score)."""
    p, d = hits / n, 1 + z * z / n
    centre, half = (p + z * z / (2 * n)) / d, z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(centre - half, 0.0), 6), round(min(centre + half, 1.0), 6)]


def _pose_values(pose, label: str):
    """A pose name, or a dict of joint and coupling values."""
    if isinstance(pose, str) and pose:
        return pose
    if isinstance(pose, dict) and pose and all(isinstance(k, str) and not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)
                                               for k, v in pose.items()):
        return {k: float(v) for k, v in pose.items()}
    raise FeatureError(f"{label} must be a pose name or a dict of joint values, not {pose!r}"[:300] + ".")


def _joint_trsf(joint: dict, value: float, slide: float):
    """The child's motion with its parent held still: about/along the joint axis (as the viewer computes it)."""
    from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
    trsf = gp_Trsf()
    if joint["type"] == "rigid":
        return trsf
    origin, axis = joint["origin"], joint["axis"]
    turns = joint["type"] in ("revolute", "cylindrical")
    if turns and value:
        trsf.SetRotation(gp_Ax1(gp_Pnt(*origin), gp_Dir(*axis)), math.radians(value))
    travel = value if joint["type"] == "slider" else slide if joint["type"] == "cylindrical" else 0.0
    if travel:
        move = gp_Trsf()
        move.SetTranslation(gp_Vec(*(a * travel for a in axis)))
        trsf = move.Multiplied(trsf)
    return trsf


def _effective(joints: list[dict], couplings: list[dict], own: dict | None = None, coupled: dict | None = None,
               saturated: list | None = None, clamp: bool = True) -> dict:
    """Each joint's (value, slide): its own position plus, for every coupling that gears it, coupling value × ratio.
    A joint couplings drive is then held within its limits and slide limits (an unlimited turning joint wraps to
    [-180, 180)), exactly as the viewer's effectivePose (web/src/motion/kinematics.ts clampValue/clampSlide) places it.
    `saturated`, when given, collects each motion held at a limit as {joint, part ("turn" or "travel"), value (the
    sum), held, limit ("min" or "max")}; `clamp=False` gives the sums as written."""
    out = dict(own) if own is not None else {j["name"]: (j["value"], j.get("slide", 0.0)) for j in joints}
    for coupling in couplings:
        x = (coupled or {}).get(coupling["name"], coupling["value"])
        for key, ratio in coupling["gears"].items():
            name, _, part = key.partition(".")
            if name not in out:
                continue
            value, slide = out[name]
            out[name] = (value, slide + x * ratio) if part == "travel" else (value + x * ratio, slide)
    if not clamp:
        return out
    for joint in joints:
        if not joint.get("driven_by") or joint["name"] not in out:
            continue
        value, slide = out[joint["name"]]
        held = (_clamp_value(joint, value), _clamp_slide(joint, slide))
        out[joint["name"]] = held
        if saturated is None:
            continue
        for part, raw, kept, limits in (("travel" if joint["type"] == "slider" else "turn", value, held[0], joint["limits"]),
                                        ("travel", slide, held[1], joint.get("slide_limits") if joint["type"] == "cylindrical" else None)):
            if limits and abs(raw - kept) > 1e-9:
                saturated.append({"joint": joint["name"], "part": part, "value": round(raw, 6), "held": kept,
                                  "limit": "max" if raw > kept else "min"})
    return out


def _coupling_bounds(coupling: dict, by_name: dict, geared: list[str]) -> tuple[list[float] | None, bool]:
    """A coupling's bounds: the values it can take with its limits and the limits of every motion it alone gears (None
    when unbounded), and whether those leave no common range (then it is held at the low end)."""
    low, high = coupling["limits"] or (-math.inf, math.inf)
    for key, ratio in coupling["gears"].items():
        name, _, part = key.partition(".")
        joint = by_name[name]
        limits = joint.get("slide_limits") if part == "travel" else joint["limits"]
        # A motion several couplings gear (a mixer) adds them up and stops at its limits: it bounds none of them.
        if not limits or geared.count(key) > 1:
            continue
        base = joint.get("slide", 0.0) if part == "travel" else joint["value"]
        ends = sorted(((limits[0] - base) / ratio, (limits[1] - base) / ratio))
        low, high = max(low, ends[0]), min(high, ends[1])
    empty = low > high + 1e-9
    if empty:
        high = low
    return ([round(low, 9), round(high, 9)] if math.isfinite(low) and math.isfinite(high) else None), empty


def _mode_name(mode, label: str) -> str | None:
    """A drive's, pose's, animation's, study's or fit check's `mode=`: None (the code's own limits) or a mode's name."""
    if mode is None:
        return None
    if not isinstance(mode, str) or not ID.fullmatch(mode):
        raise FeatureError(f"{label}: mode must name a design.mode, e.g. mode=\"limited\", not {mode!r}.")
    return mode


def _in_mode(joints: list[dict], couplings: list[dict], mode: dict | None) -> tuple[list[dict], list[dict]]:
    """The joints and couplings with a resolved mode's limits and bounds in place of their own (kinematics `modes`)."""
    if not mode:
        return joints, couplings
    limits, bounds = mode.get("joints") or {}, mode.get("couplings") or {}
    return ([{**j, **limits[j["name"]]} if j["name"] in limits else j for j in joints],
            [{**c, **bounds[c["name"]]} if c["name"] in bounds else c for c in couplings])


def mode_of(kinematics: dict, mode: str | None) -> dict | None:
    """A build's resolved mode by name (kinematics `modes`), or None for the code's own limits."""
    if mode is None:
        return None
    found = next((m for m in kinematics.get("modes") or [] if isinstance(m, dict) and m.get("name") == mode), None)
    if found is None:
        raise FeatureError(f"Mode {mode!r} isn't one of this design's.")
    return found


def _drive_held(joints: list[dict], couplings: list[dict], target: str, sweep: list[float], samples: int) -> list[dict]:
    """The driven joints a drive stops at a limit across its range, at the drive's samples (as its check places them):
    each motion and limit once, with where it is held and the first and last drive value it is held at."""
    own = {j["name"]: (j["value"], j.get("slide", 0.0)) for j in joints}
    coupling = any(c["name"] == target for c in couplings)
    low, high = sweep
    found = {}
    for i in range(samples):
        value = low + (high - low) * i / (samples - 1)
        saturated = []
        if coupling:
            _effective(joints, couplings, own, {target: value}, saturated)
        else:
            _effective(joints, couplings, dict(own, **{target: (value, own[target][1])}), None, saturated)
        for item in saturated:
            entry = found.setdefault((item["joint"], item["part"], item["limit"]), {
                "joint": item["joint"], "part": item["part"], "limit": item["limit"], "held": item["held"], "values": [round(value, 6)] * 2})
            entry["values"][1] = round(value, 6)
    return list(found.values())


def _clamp_value(joint: dict, value: float) -> float:
    """Clamped to the joint's limits; an unlimited turning joint wraps to [-180, 180) (as clampValue in the viewer)."""
    if joint["limits"]:
        return min(joint["limits"][1], max(joint["limits"][0], value))
    if joint["type"] in ("revolute", "cylindrical"):
        return math.fmod(math.fmod(value + 180, 360) + 360, 360) - 180  # JavaScript's %, which is fmod.
    return value


def _clamp_slide(joint: dict, slide: float) -> float:
    limits = joint.get("slide_limits")
    return min(limits[1], max(limits[0], slide)) if limits else slide


def _limit_problem(joints: list[dict], couplings: list[dict], own: dict, coupled: dict) -> str | None:
    """What a pose sets outside its limits, not counting what couplings add (a driven joint stops at its limits): a
    joint's own value, or a coupling's value outside the coupling's own limits. None when all fit."""
    for joint in joints:
        value, limits = own.get(joint["name"], (joint["value"], 0.0))[0], joint["limits"]
        if limits and not limits[0] - 1e-9 <= value <= limits[1] + 1e-9:
            unit = " mm" if joint["type"] == "slider" else "°"
            return f"joint {joint['name']!r} would be at {value:g}{unit}, outside its limits {limits[0]:g}…{limits[1]:g}{unit}"
    for coupling in couplings:
        value, limits = coupled.get(coupling["name"], coupling["value"]), coupling["limits"]
        if limits and not limits[0] - 1e-9 <= value <= limits[1] + 1e-9:
            return f"coupling {coupling['name']!r} would be at {value:g}, outside its limits {limits[0]:g}…{limits[1]:g}"
    return None


def _follower_set(joints: list[dict], targets) -> str | None:
    """What's wrong when `targets` (joint or coupling names; "<joint>.travel" too) set a follower joint directly: it moves
    only through its couplings, so name those instead. None when none does."""
    followers = {j["name"]: j.get("driven_by") or [] for j in joints if j.get("follows")}
    for target in targets:
        name = target.partition(".")[0]
        if name in followers:
            by = followers[name]
            listed = ", ".join(by[:-1]) + f" and {by[-1]}" if len(by) > 1 else by[0] if by else "its couplings"
            return f"joint {name!r} follows {listed}; set {'that' if len(by) == 1 else 'those'} instead"
    return None


def _animation_values(animation: dict, t: float) -> dict:
    """Every target's value at `t` seconds: between the two keys around it, eased as the viewer plays it."""
    keys = animation["keys"]
    if t <= keys[0]["time"]:
        return dict(keys[0]["values"])
    if t >= keys[-1]["time"]:
        return dict(keys[-1]["values"])
    after = next(i for i, key in enumerate(keys) if key["time"] >= t and i > 0)
    a, b = keys[after - 1], keys[after]
    span = b["time"] - a["time"]
    u = (t - a["time"]) / span if span > 0 else 1.0
    if animation["easing"] == "ease":
        u = u * u * (3 - 2 * u)
    return {target: a["values"][target] + (b["values"][target] - a["values"][target]) * u for target in a["values"]}


def _animation_frame(joints: list[dict], values: dict) -> tuple[dict, dict]:
    """Animation values as the joints' own (value, slide) and the couplings' values."""
    own = {j["name"]: (values.get(j["name"], j["value"]), j.get("slide", 0.0)) for j in joints}
    names = {j["name"] for j in joints}
    return own, {target: value for target, value in values.items() if target not in names}


def _dof_kind(joints: list[dict], key: str) -> str:
    """Whether a coupled motion turns (degrees) or travels (mm)."""
    name, _, part = key.partition(".")
    joint = next((j for j in joints if j["name"] == name), None)
    return "travel" if part == "travel" or (joint is not None and joint["type"] == "slider") else "turn"


class _Motions(dict):
    """Instance → its motion (gp_Trsf), plus `chains`: instance → the joints that move it, from the ground, as
    ((joint name, its own motion), …). A pair's placement against each other depends only on the joints that aren't
    shared (_Exact._ask), so it can be computed from those alone."""

    def __init__(self):
        super().__init__()
        self.chains: dict[str, tuple] = {}


def _instance_motions(joints: list[dict], values: dict) -> dict:
    """Each moved instance's motion from the modelled geometry: its parent's, then its own joint's (forward kinematics)."""
    by_child = {j["child"]: j for j in joints}
    out = _Motions()

    def resolve(name, depth=0):
        if name in out:
            return out[name]
        joint = by_child.get(name)
        if joint is None or depth > 64:
            return None
        parent = resolve(joint["parent"], depth + 1)
        # Joint values are absolute: 0 is the geometry as modelled (as the viewer moves it).
        value, slide = values.get(joint["name"], (joint["value"], joint.get("slide", 0.0)))
        own = _joint_trsf(joint, value, slide)
        out[name] = parent.Multiplied(own) if parent is not None else own
        out.chains[name] = out.chains.get(joint["parent"], ()) + ((joint["name"], own),)
        return out[name]

    for joint in joints:
        resolve(joint["child"])
    return out


def posed_motions(kinematics: dict, pose: str | None = None, animation: str | None = None, t: float = 0.0,
                  explode: str | None = None) -> tuple[dict, dict]:
    """A build's named pose, its animation at `t` seconds or its explode at `t` seconds, as each moved instance's motion
    from the geometry as modelled ({instance: gp_Trsf}; an explode may name a linked design's instance by path,
    "gearbox/housing", whose motion includes its parent's) and the joint and coupling values it sets (an explode's
    are the code's pose: it sets none): inspect_model's posed views, placed as the animation check and the viewer
    place them. `kinematics` is the build's (modeling.design.kinematics); animation keys trimmed to their changes
    (runtime/kernel.py _animation_keys) are carried forward again."""
    joints, couplings = kinematics.get("joints") or [], kinematics.get("couplings") or []
    if explode is not None:
        from OCP.gp import gp_Trsf, gp_Vec
        from .explodes import offsets
        entry = next((e for e in kinematics.get("explodes") or [] if e.get("name") == explode), None)
        if entry is None:
            raise FeatureError(f"Explode {explode!r} isn't one of this design's.")
        motions = _instance_motions(joints, _effective(joints, couplings))
        moved = offsets(entry, t)
        out = _Motions()
        out.update(motions)
        out.chains.update(motions.chains)
        for path in sorted(moved, key=lambda p: p.count("/")):
            parts = path.split("/")
            total = [sum(moved.get("/".join(parts[:i]), [0.0, 0.0, 0.0])[k] for i in range(1, len(parts) + 1)) for k in range(3)]
            shift = gp_Trsf()
            shift.SetTranslation(gp_Vec(*total))
            base = motions.get(parts[0])
            out[path] = shift.Multiplied(base) if base is not None else shift
        return out, {}
    if pose is not None:
        poses = kinematics.get("poses") or {}
        if pose not in poses:
            raise FeatureError(f"Pose {pose!r} isn't one of this design's.")
        values = dict(poses[pose])
        mode = (kinematics.get("pose_modes") or {}).get(pose)
    else:
        entry = next((a for a in kinematics.get("animations") or [] if a.get("name") == animation), None)
        if entry is None:
            raise FeatureError(f"Animation {animation!r} isn't one of this design's.")
        keys, full = [], {}
        for key in entry["keys"]:
            full = {**full, **key["values"]}
            keys.append({**key, "values": dict(full)})
        values = _animation_values({**entry, "keys": keys}, t)
        mode = entry.get("mode")
    # A pose or animation in a mode stops the joints its couplings drive at that mode's limits.
    limited, geared = _in_mode(joints, couplings, mode_of(kinematics, mode) if kinematics.get("modes") else None)
    return _instance_motions(joints, _effective(limited, geared, *_animation_frame(joints, values))), values


def _range(value, label: str):
    if value is None:
        return None
    try:
        low, high = (float(v) for v in value)
    except (TypeError, ValueError):
        raise FeatureError(f"{label}: limits must be (min, max), not {value!r}.") from None
    if not low < high:
        raise FeatureError(f"{label}: limits ({low:g}, {high:g}) need min < max.")
    return [low, high]


def _geometry_axis(component: Component, ref: str, joint: str, label: str | None = None) -> tuple[cq.Vector, cq.Vector]:
    """A joint (or fastener) axis from geometry: a cylinder's or cone's axis, a planar face's normal at its centre, or an edge."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane
    try:
        faces = component.faces(ref)
    except FeatureError:
        faces = []
    if len(faces) >= 1:
        surfaces = [BRepAdaptor_Surface(face.wrapped) for face in faces]
        kinds = {surface.GetType() for surface in surfaces}
        if kinds <= {GeomAbs_Cylinder, GeomAbs_Cone}:
            axis = surfaces[0].Cylinder().Axis() if surfaces[0].GetType() == GeomAbs_Cylinder else surfaces[0].Cone().Axis()
            point, direction = axis.Location(), axis.Direction()
            origin, d = cq.Vector(point.X(), point.Y(), point.Z()), cq.Vector(direction.X(), direction.Y(), direction.Z())
            # A point on the axis level with the face (where the viewer draws the joint).
            centre = faces[0].Center()
            return origin + d * (centre - origin).dot(d), d.normalized()
        if len(faces) == 1 and kinds == {GeomAbs_Plane}:
            return faces[0].Center(), faces[0].normalAt(faces[0].Center()).normalized()
        raise FeatureError(f"{label or f'Joint {joint!r}'}: {component.id}.face({ref!r}) gives no single axis; pick a cylindrical face (a pin or bore), "
                           "one planar face (its normal), or a straight or circular edge.")
    axis = component.axis_of(ref)
    point, direction = axis.Location(), axis.Direction()
    return cq.Vector(point.X(), point.Y(), point.Z()), cq.Vector(direction.X(), direction.Y(), direction.Z()).normalized()


def _move(location: cq.Location, point: cq.Vector) -> cq.Vector:
    moved = point.toPnt().Transformed(location.wrapped.Transformation())
    return cq.Vector(moved.X(), moved.Y(), moved.Z())


def _turn(location: cq.Location, direction: cq.Vector) -> cq.Vector:
    turned = direction.toDir().Transformed(location.wrapped.Transformation())
    return cq.Vector(turned.X(), turned.Y(), turned.Z()).normalized()


def _jsonable(value):
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value if isinstance(value, (int, float, str)) or value is None else str(value)


# ───────── build cache plumbing ─────────
#
# The runtime reads entries from STEVE_COMPONENT_CACHE (read-only in a kernel) and writes new
# ones to STEVE_COMPONENT_CACHE_OUT; the trusted worker publishes those, so user code never
# writes to the shared cache itself.


def _caller_file() -> str | None:
    """The design file (relative to the job's directory) whose code is calling into the library."""
    root = Path.cwd().resolve()
    frame = sys._getframe(1)
    while frame is not None:  # Library, contextlib and CadQuery frames are skipped: the first one in the job's directory.
        path = Path(frame.f_code.co_filename)
        if path.is_absolute() and _PACKAGE not in path.parents and path.parent != _PACKAGE and root in path.resolve().parents:
            return path.resolve().relative_to(root).as_posix()
        frame = frame.f_back
    return None


_RUNTIME: str | None = None


def _runtime_hash() -> str:
    global _RUNTIME
    if _RUNTIME is None:
        digest = hashlib.sha256(f"{CACHE_VERSION}|{cq.__version__}".encode())
        for source in sorted(_PACKAGE.rglob("*.py")):
            digest.update(source.relative_to(_PACKAGE).as_posix().encode())
            digest.update(source.read_bytes())
        _RUNTIME = digest.hexdigest()
    return _RUNTIME


def _job_files() -> dict[str, str]:
    """The job's design files as the dispatcher has them (main aside): its Python files and its tables."""
    root = Path.cwd()
    files = {p.relative_to(root).as_posix(): p.read_text() for p in root.rglob("*.py")
             if p.name != "__init__.py" and p.relative_to(root).as_posix() != "model.py"}
    files.update({p.name: p.read_text() for p in root.glob("*.csv")})   # The design's tables (steve.tables).
    return files


def _cache_key(file: str) -> str | None:
    """The same key the dispatcher computes (steve.cachekeys) from the job's design files."""
    if not (os.environ.get("STEVE_COMPONENT_CACHE") or os.environ.get("STEVE_COMPONENT_CACHE_OUT")):
        return None
    from .cachekeys import component_key
    return component_key(_job_files(), file, os.environ.get("STEVE_RUNTIME_VERSION") or _runtime_hash())


# A design build's motion and fit check results (Design._reuse) live in one cache entry of their own, keyed as the
# dispatcher keys it (steve.cachekeys.checks_key): each result under its fingerprint, which a later build with the same
# entry reuses when nothing the check depends on changed (an appearance, material or decal edit, say).
_CHECKS_KEY: str | None = None  # this build's entry (`reuse_checks`), or None: every check runs and none is kept
_CHECKS: dict | None = None  # the results it holds, by fingerprint, once read (`_checks_stored`)
_CHECKS_FOUND = False  # whether the entry came with the job: the dispatcher keeps an entry's first version only
_CHECKS_NEW: dict = {}  # the results this build made that a later one may reuse (`_keep_checks`)
_TOPOLOGY_REUSED = 0  # components whose viewer topology came from the cache (run.write_topology, `reused_topology`)
# A build of the drawing sheets alone (mode "drawing", run.drawing_job): it returns the sheets only, which read the
# instances and the bill of materials, never a check's result, so its drive, animation, study, fit and fastener checks
# aren't run. The cable check still is: the bill of materials lists the cut lengths it measures.
_SHEETS_ONLY = False


def reuse_checks(request) -> None:
    """Names this build's cache entry of motion and fit check results, as the dispatcher computes it from the same
    request (app/worker.py component_keys): a design's preview or full build, and a topology job that runs one again.
    A drawing build runs none of them (`_SHEETS_ONLY`); any other build checks as always."""
    global _CHECKS_KEY, _CHECKS, _CHECKS_FOUND, _TOPOLOGY_REUSED, _SHEETS_ONLY
    _CHECKS_KEY, _CHECKS, _CHECKS_FOUND, _TOPOLOGY_REUSED = None, None, False, 0
    _SHEETS_ONLY = request.get("mode") == "drawing"
    _CHECKS_NEW.clear()
    mode = request.get("mode", "full")
    if mode == "topology":
        mode = "preview" if request.get("topology_of") == "preview" else "full"
    if request.get("kind") != "design" or mode not in ("preview", "full") or not request.get("files"):
        return
    if not (os.environ.get("STEVE_COMPONENT_CACHE") or os.environ.get("STEVE_COMPONENT_CACHE_OUT")):
        return
    from .cachekeys import checks_key
    _CHECKS_KEY = checks_key(_job_files(), request.get("code") or "", os.environ.get("STEVE_RUNTIME_VERSION") or _runtime_hash(),
                             mode, request.get("links"), request.get("imports"), request.get("materials"))


def _checks_stored() -> dict:
    """This build's entry's results by fingerprint ({} without one; an unreadable entry reads as none)."""
    global _CHECKS, _CHECKS_FOUND
    if _CHECKS is None:
        _CHECKS = {}
        if _CHECKS_KEY:
            try:
                entry = _cache_read(_CHECKS_KEY)
            except (OSError, ValueError):
                entry = None
            if isinstance(entry, dict):
                _CHECKS_FOUND = True
                _CHECKS = entry["checks"] if isinstance(entry.get("checks"), dict) else {}
    return _CHECKS


def _keep_checks() -> None:
    """Writes the results this build made to its entry, for the next build, when the job brought none (the dispatcher
    keeps an entry's first version)."""
    if _CHECKS_KEY and _CHECKS_NEW and not _CHECKS_FOUND:  # Results were looked up (`_reuse`) before any was made.
        _cache_write(_CHECKS_KEY, {"version": CACHE_VERSION, "checks": dict(_CHECKS_NEW)})


def _settled(result) -> bool:
    """Whether a check's result holds whatever its time budget: everything it was asked to check was checked, and
    every pair got its exact answer. Anything else (cut short, an unverified pair, a distance not measured in time) is
    never kept, so the check runs again next time instead of being reused as clear."""
    if not isinstance(result, dict) or result.get("complete") is not True or result.get("unverified"):
        return False
    if any(isinstance(pair, dict) and pair.get("unverified") for pair in [*result.get("issues", ()), *result.get("intended", ())]):
        return False
    if any(isinstance(gap, dict) and gap.get("min_distance_mm") is None for gap in result.get("clearances", ())):
        return False
    return "ran out of time" not in str(result.get("note", ""))


def reused_topology() -> None:
    """Counts a component whose viewer topology came from the cache (run.write_topology), for the build's summary."""
    global _TOPOLOGY_REUSED
    _TOPOLOGY_REUSED += 1


def cached_topology(component, mode: str) -> dict | None:
    """A cacheable component's viewer topology for this tessellation `mode`, as an earlier build described it
    (run.write_topology): {"data": description, "coarse": coarser edge points}, from its own cache entry."""
    if not getattr(component, "_cacheable", False) or not getattr(component, "_key", None):
        return None
    from .cachekeys import topology_key
    key = topology_key(component._key, mode)
    entry = (_cache_read(key) or _cache_out_read(key) or {}).get("topology")
    return entry if isinstance(entry, dict) and "data" in entry and "coarse" in entry else None


def cache_topology(component, mode: str, data: dict, coarse: list) -> None:
    """Stores a freshly described topology in its own cache entry, for the next build of this component."""
    if not getattr(component, "_cacheable", False) or not getattr(component, "_key", None):
        return
    from .cachekeys import topology_key
    _cache_write(topology_key(component._key, mode), {"version": CACHE_VERSION, "topology": {"data": data, "coarse": coarse}})


def _cache_out_read(key: str) -> dict | None:
    folder = os.environ.get("STEVE_COMPONENT_CACHE_OUT")
    path = Path(folder) / f"{key}.json" if folder else None
    if not path or not path.is_file():
        return None
    record = json.loads(path.read_text())
    return record if record.get("version") == CACHE_VERSION else None


def _cache_read(key: str) -> dict | None:
    folder = os.environ.get("STEVE_COMPONENT_CACHE")
    path = Path(folder) / f"{key}.json" if folder else None
    if not path or not path.is_file():
        return None
    record = json.loads(path.read_text())
    return record if record.get("version") == CACHE_VERSION else None


def _cache_write(key: str, record: dict) -> None:
    folder = os.environ.get("STEVE_COMPONENT_CACHE_OUT")
    if not folder:
        return
    try:
        Path(folder).mkdir(parents=True, exist_ok=True)
        temporary = Path(folder) / f".{key}.tmp"
        temporary.write_text(json.dumps(record, default=str))
        temporary.replace(Path(folder) / f"{key}.json")
    except OSError as error:
        print(f"Warning: component cache not written: {error!r}"[:300], file=sys.stderr)


def active_design() -> Design | None:
    return _DESIGNS[-1] if _DESIGNS else None


def degrees(radians: float) -> float:
    return math.degrees(radians)
