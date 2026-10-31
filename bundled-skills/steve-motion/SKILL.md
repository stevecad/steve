---
name: steve-motion
description: >-
  Joints (rigid, revolute, slider, cylindrical) with axes from geometry, couplings (gear trains, belts, rack and pinion), limits and selectable limit sets (design.mode), drives, poses, keyframed animations, exploded views (design.explode) and collision sweeps in a design's main.py. Load before adding hinges, sliders, gears, spinning rotors, mechanisms, animation or an exploded view / teardown. Collision studies across several joints, cables through moving joints and the MuJoCo simulation export are in steve-motion-studies.
---

## Steve execution rules

This skill adapts Steve Studio's CAD guidance for Steve running locally. The modeling
examples below describe the shared CAD runtime. These local execution rules take
precedence over upstream service workflows and tool names in that reference.

- Read the active document with `cad_read`; inspect built geometry with `cad_inspect`.
  Do not guess persistent face names, document shapes, revision IDs or import hashes.
- Apply source changes with `cad_build(document=..., expected_revision=...)`, preserving
  the document schema returned by `cad_read`. Use `cad_set_parameters` for parameter
  changes. Inspect the build result and errors before reporting success.
- `cad_api_reference` provides installed Model, Sketch, Component and Design signatures.
  The installed runtime and available tool schemas are authoritative if reference
  examples describe newer or unavailable capabilities.
- Export built geometry using `cad_export` with the current revision and a supported
  format. Drawing PDF/SVG/DXF workflows are available in the drawing UI; do not claim
  the geometry export tool exports drawings unless its schema supports that.
- Find standard parts or locally imported McMaster parts with `cad_find_parts`, then
  cache a part using `cad_import_catalog_part`. Use the returned import hash with
  `Model.import_step`. Import arbitrary STEP files through the local Import UI.
- `cad_source_package` reads a transferable source package; `cad_import_package`
  imports supplied root and dependency documents locally. These do not publish.
- Upstream `read_part`, `edit_part`, `read_design`, `inspect_model`, upload-ticket,
  workspace/server/document-ID and cloud export instructions are reference context,
  not available local commands. Use the local tools above. Do not sign in to Studio,
  upload, publish, or call a connected Studio MCP merely to perform local CAD.
- SaaS upload quotas are not local limits. Simulation, electronics, CAM, teams and
  cloud jobs are outside this local CAD skill. Do not invent their availability.
  References to unbundled skills do not imply those features are installed.

## Upstream CAD reference



# Joints and motion

Joints live in a design's `main.py`, between **placed instances** (the names from `design.add`).
Joints never change geometry: the build resolves each joint to the design frame and the viewer
animates the instances.

```python
design.revolute("hinge", "frame", "lid", axis=frame.face("bore.side(c1)"), limits=(0, 110), value=10)
design.slider("track", "frame", "carriage", axis=frame.face("rail.side(r1.top)"), limits=(0, 40))
design.cylindrical("shaft", "frame", "rod", axis=frame.edge("…"), slide_limits=(0, 20))
design.rigid("bolted", "lid", "handle")
design.drive("hinge", speed=45, check=True)    # deg/s (rotation) or mm/s (sliding)
design.pose("open", hinge=100)
```

## Axes come from geometry, never guessed numbers

- A **cylindrical or conical face** gives its axis, through the face's centre: the bore of a hinge
  or the pin it turns on.
- A **planar face** gives its normal at its centre.
- A **straight or circular edge** gives its direction or circle axis.
- `"X"`, `"Y"`, `"Z"` or `((x, y, z), (dx, dy, dz))` also work, but use them only when no geometry
  defines the axis.
- A reference resolves on the unplaced component, then moves with the instance that owns it.

Find the right face with `read_design` or `inspect_model`: the bore's persistent name, e.g.
`frame.face("hole_1.side(c1)")`.

## Rules

- Each instance has at most one parent joint. Closed loops (four-bars) aren't solved yet: say so and
  model the open chain.
- Instances that no joint moves are grounded.
- `limits` are absolute values (degrees or mm). 0 is the geometry as modelled. `value` sets the
  current position.
- A rigid joint can't be driven.

## Couplings: gear trains, belts, rack and pinion

A coupling is one input that moves several joints together in fixed ratios. At coupling value `x`
each geared joint moves by `x × ratio`, on top of its own value. Joints stay a tree; the coupling
only relates their values, so it is not a closed loop.

```python
design.couple("train", {"sun_spin": 1, "carrier_spin": 0.25, "planet_spin_1": -0.75}, limits=None, value=0)
design.drive("train", speed=60)          # drive and pose a coupling like a joint
design.pose("quarter", train=90)
```

- Keys are joint names. For a cylindrical joint, use `<joint>.turn` or `<joint>.travel`. Ratios
  must be finite and nonzero. Rigid joints can't be geared.
- Its range is its `limits` intersected with what the limits of the joints it alone gears allow.
  The build reports this as `bounds`.
- Mixing: two or more couplings may gear the same joint; their terms add up, e.g.
  `design.couple("a", {"left": 1, "right": 1})` with `design.couple("b", {"left": 1, "right": -1})`.
  Such a shared joint doesn't narrow either coupling's `bounds`.
- Saturation: a joint couplings drive stops at its limits (an unlimited turning joint wraps to
  -180…180), in the viewer and in every check, sweep, study, fit, cable and simulation pose alike.
  The build lists where it happens in `kinematics.saturated.poses[<pose>]` and each drive's and
  animation's `saturated` (joint, `part` turn/travel, the summed `value`, `held`, `limit` min/max;
  a drive gives the drive `values` it is held between, an animation the key `time`).
- The code's own pose (every `value=`) must still fit: a joint whose value plus its couplings is
  past its limits there is an error. So is a pose that sets a joint's own value, or a coupling's
  value, outside its own limits.
- An unbounded coupling that only turns joints turns continuously when driven. One that slides a
  joint needs limits or a `range=`.
- Compute ratios from tooth counts in the code (`sun_teeth / (sun_teeth + ring_teeth)`), never as
  rounded literals, so parameter changes keep the train consistent.
- In the viewer, dragging a joint geared by exactly one coupling turns the whole train. A joint
  geared by two or more couplings moves on its own, unless it is a follower (below).

### Followers: joints that only move with their couplings

When a joint must never be set on its own (a mixer's outputs, a differential's wheels), declare it
`follow=True` on `design.revolute`, `design.slider` or `design.cylindrical`. Its own `value` stays
fixed (an offset, 0 by default) and only its couplings move it:

```python
design.revolute("wheel_l", "chassis", "left_wheel", axis=chassis.face("axle_l.side(c1)"), follow=True)
design.revolute("wheel_r", "chassis", "right_wheel", axis=chassis.face("axle_r.side(c1)"), follow=True)
design.couple("forward", {"wheel_l": 1, "wheel_r": 1})
design.couple("steer", {"wheel_l": 1, "wheel_r": -1}, limits=(-90, 90))
design.pose("arc_left", forward=360, steer=-60)   # pose and drive the couplings, never a follower
design.drive("forward", speed=180)
```

- Pose, animate, drive and study the couplings. A pose, animation key, drive, collision study
  (`joints`, `poses`, `hold`) or simulation pose that sets a follower is a build error naming its
  couplings ("joint 'wheel_l' follows forward and steer; set those instead").
- A follower no coupling gears is an error; a cylindrical follower needs both `<joint>.turn` and
  `<joint>.travel` geared.
- Joint limits still apply: a follower's couplings stop it at them (saturation, above).
- The build marks it `follows: true` in `kinematics.joints`; `read_design` shows `follow` in the
  joint outline. In the viewer its slider is read-only ("Follows forward, steer"), the couplings'
  sliders move it, and dragging it back-drives its coupling only when exactly one gears it.
- In the studio: Motion → Gears & links → Custom, "Joints only follow", writes `follow=True` into
  the geared joints.

### Modes: selectable limit sets

When a mechanism has selectable stops or travel ranges (a full and a limited range, a safety stop, a
transport lock), keep the joints' widest limits in code and name each tighter set as a mode:

```python
design.revolute("hinge", "frame", "lid", axis=frame.face("pin.side(c1)"), limits=(0, 120))
design.slider("bolt", "frame", "latch", axis=frame.face("slot.side(r1.top)"), limits=(0, 20))
design.mode("limited", limits={"hinge": (0, 60)})                  # joints or couplings → (min, max)
design.mode("locked", limits={"hinge": (0, 5), "bolt": (0, 2)})
design.pose("closed", hinge=0)
design.pose("half_open", hinge=50, mode="limited")
design.drive("hinge", speed=30, mode="limited", check=True)         # sweeps 0…60 and stops there
design.animation("cycle", [("closed", 0), ("half_open", 2)], mode="limited")
```

- `travel_limits={"shaft": (0, 5)}` sets a cylindrical joint's slide limits (mm).
- The code's own limits are the default mode; a mode only tightens them. A name that isn't a joint or
  coupling, an inverted range or a range past the declared limits is an error.
- While a mode is selected, its limits replace those it names, and every coupling's `bounds` follow.
  Drives, poses, animations, collision studies (`mode=`; one following an animation takes the
  animation's) and fit checks name a mode: their sweeps, saturation and limit checks use it. A pose
  setting something outside its mode's limits is an error naming the pose and the mode.
- The build lists `kinematics.modes` (each mode's joint limits, and every coupling's `limits` and
  `bounds` under it) and `pose_modes`; drives, animations, studies and fits carry their `mode`.
  `inspect_model(pose=…)` or `animation=…` draws them in their own mode.
- In the studio: Properties → Motion has a Mode selector above the joints ("Default" is the code's
  limits). Switching re-clamps the sliders and the pose without a rebuild; drives, poses and the
  timeline switch to their own mode as they play. Shares that let visitors move the mechanism have it too.

Ratios:
- **External mesh:** `ratio_b = -Z_a / Z_b` relative to gear a; they turn opposite ways.
- **Internal mesh** (a pinion in a ring): `+Z_a / Z_b`.
- **Belt or chain:** `+d_a / d_b`.
- **Rack and pinion:** travel in mm per degree is `π · m · Z / 360` (pitch circumference per turn).
- **Planetary set (Willis):** `(ω_s − ω_c) / (ω_r − ω_c) = −Z_r / Z_s`, with `Z_r = Z_s + 2·Z_p`.
  - With the ring fixed and the sun as input: `ω_c = ω_s · Z_s / (Z_s + Z_r)`.
  - Each planet, jointed to the carrier, turns relative to it at `−(Z_s / Z_p) · (ω_s − ω_c)`.
  - The planets are children of the carrier (`design.revolute("planet_spin_1", "carrier", "planet_1", …)`),
    so their joint values are relative to the carrier.
  - Equal spacing of N planets needs `(Z_s + Z_r) % N == 0`.
  - Phase each planet so its teeth fall in the sun's gaps: with the sun's tooth 0 on +X and a planet
    at angle θ, turn the planet by `θ + 180 − 180/Z_p + θ·Z_s/Z_p` degrees.
  - Reference design: Samples → Planetary gearset.

## Animations: keyframes between poses

For "show it opening and closing" or a sequence of moves, name the positions as poses and put them on
a timeline. Each key is a (pose, seconds) pair in time order:

```python
design.pose("closed", lid=0)
design.pose("open", lid=110)
design.animation("open_close", [("closed", 0), ("open", 2), ("open", 3), ("closed", 5)], loop=True, check=True)
```

- A pose may be a dict instead of a name: `({"lid": 45}, 1.5)`. What a key doesn't name keeps its
  value from the key before (the code's pose at the start).
- The same pose twice in a row holds it. `easing="ease"` (default) starts and stops each move
  gently; `"linear"` keeps constant speed. `loop=True` plays it over and over.
- Poses can set couplings, so one key can turn a whole gear train (`design.pose("geared", train=40)`).
- Keys within the joints' limits keep the whole animation within them; a key that sets a joint
  past its limits is an error that names the key's time (a joint couplings push past a limit
  stops there and is listed in the animation's `saturated`).
- `check=True` sweeps the animation with exact solids (`samples`, default 48) and reports colliding
  instance pairs with the times they touch (`kinematics.animations[i].check`). Parts meant to meet (a lid
  closing onto its base, a pin in its bore) are declared with `design.contact(a, b, kind=…, max_overlap_mm3=…)`:
  within that allowance the check lists them under `contacts`, not `collisions`. Declare a contact only where
  the parts are designed to meet, never to silence a real clash. It checks every pair
  the animation moves, so on a big design or a long animation, or to know how close two parts come,
  use a collision study that follows the animation instead (steve-motion-studies skill:
  `sampling="animation"`, only the `pairs` in question, at its keys or a time window). A preview
  stops each check at 25 s; run a full build before concluding from a check that stopped.
- To look at the motion yourself, one still at a time: `inspect_model(document_id, pose="open")`
  draws the design in a named pose, `inspect_model(document_id, animation="open_close", t=1.5)` at
  that moment (seconds) of an animation; both take any view and show/hide.
- In the studio, the Motion tab's timeline plays, scrubs and retimes it, and exports it as an
  animated GLB or a video. Prefer an animation over a drive when the motion has stops or several
  joints moving in sequence; use a drive for a motor that just turns.

## Explode a design

For "show how it comes apart", a teardown or an assembly-instructions sequence, use an explode, not slider
joints: it is display only (placements, the STEP, the BOM and every check stay as built) and plays on the
same timeline as animations.

```python
design.explode("teardown", [
    {"move": "cover_screw_*", "out": True},           # placed screws out along their own axes
    {"move": ["cover", "gasket"], "along": "+Z", "distance": 40},
    ("board", (0, 0, 25)),                             # short form: (instances, (x, y, z)) in mm
    {"moves": {"left_panel": (-30, 0, 0), "right_panel": (30, 0, 0)}, "duration": 1.5},
])
design.explode("apart", auto=True)                     # worked out from the geometry
```

- Steps play in order (each `duration`, default 1 s, then `hold`, default 0.25 s) and moves add up: a
  part moved in step 2 stays there and moves on only if a later step names it. Name instances, patterns,
  a fastener's name (its placed screw) or a linked design's instance by path (`"gearbox/housing"`).
- `out` works only for screws placed as `design.fasten(..., instance=...)`: 1.5 × the screw's length,
  or `"out": 12` (mm).
- An explode moves only what it names, from the code's pose: a joint's child doesn't follow its parent,
  so list both to move them together. Its name must differ from every animation's.
- `auto=True`: assembly steps reversed (else layer by layer), screws first, each part along the ±X/±Y/±Z
  it is free to slide out by, past everything in its way by `gap` (default 5 % of the design's size), so
  parts that came off first end furthest out and nothing overlaps at the end (bounding boxes). Start
  there, look, then write explicit steps if the person wants a different order or direction.
- Look at it: `inspect_model(document_id, explode="teardown", step=2)` (the moment step 2 has finished;
  `t=` for seconds, `step=0` at rest); `summary.posed.moved` gives each moved part's offset.
  `metadata.modeling.design.kinematics.explodes` has each step's start, duration and moves.
- In the studio: the timeline plays, scrubs and loops it (with trails), Motion → Explode steps edits it,
  and Export → Video or Animated GLB records it.

## Spin a rotor

A turbocharger, fan or pump rotor:
- One revolute joint on the bearing bore: `axis=housing.face("bore.side(c1)")`.
- Fasten the wheels to the shaft with `design.rigid`.
- `design.drive("spin", speed=720, check=True)` with no limits turns continuously. The check confirms
  the blades clear the housing.
- Reference design: Samples → Turbocharger rotor.

## Check the build

After `generate_model`, read `metadata.modeling.design.kinematics`:
- `joints` (the moving ones: origin, axis, limits, value, `driven_by`, `follows`; `rigid_joints` counts the rest), `couplings`
  (gears, limits, value, `bounds`), `drives` (`coupling: true` for a coupling; `saturated`), `poses`, `saturated`
  (driven joints held at a limit in each pose), `animations` (`targets`, `loop`, `easing`, `duration`, `check`,
  `saturated`, and how many `keys`) and how many instances are `ground`;
- every joint, the ground instances and each animation's keys with every target's value:
  `read_design(document_id, detail="kinematics")`;
- `explodes`: each explode's steps (start, duration, hold, moves per instance) and the instances it moves;
- `read_design` lists joints, couplings, modes, poses, drives, animations, explodes, cables and harnesses with their line numbers;
- errors, worded with the fix (unknown instance, loops, values outside limits, geometry with no
  single axis, couplings of rigid or unknown joints, couplings whose joints leave no common range).

With `check=True` the build sweeps the drive's range with exact solids and reports colliding
instance pairs and the values where they touch. Every two instances that move relative to each other
are checked, including two moving parts (a gripper against its own arm); parts fastened together
are one body. Report collisions plainly and suggest clearance (a gap, a shorter part, a limit change).
A check (drive, animation or fit) is clear only when it finished: one that ran out of time has
`complete: false` and `clear: false`, with `samples` of `of` poses (a fit check's skipped poses and
sweeps in `unchecked`, each sweep with `samples`/`of`). Report it as incomplete with those counts,
never as clear, and run a full build (`generate_model`, more time) or check fewer poses.
A check (or study) with `reused: true` is an earlier build's result, given again because nothing it
depends on changed (only appearances, materials or decals were edited): it is as valid as a fresh one.
Only finished checks with every pair answered are reused; the design summary's `reused` counts them.

After editing a moving design, prefer a fit check (steve-designs skill: `design.fit_check`,
`design.contact`, `design.clearance`): it also sweeps every joint and coupling that moves a checked
instance over its limits (`samples`, default 24, refined between steps until a step moves the parts
at most `refine` mm, default 0.1), measures clearance as well as overlap, and
`inspect_model(checks=["interference"])` shows only what got new or worse since the last revision.
Its sweeps move one joint or coupling at a time; use a collision study (steve-motion-studies skill) for joints moving together.

## Studies, cables and simulation export

Collision studies across several joints, cables and harnesses through moving joints, and preparing a design for the MuJoCo simulation export are in the steve-motion-studies skill: load it for those.
