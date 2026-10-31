---
name: steve-blender
description: >-
  Blender documents (kind "blender"): Blender Python (bpy) that builds a scene in a fresh headless Blender: organic or sculpted shapes, product shots, and animated presentations of STEVE parts and designs (exploded views, turntables, spinning mechanisms) rendered to video. Linking saved parts and designs into the scene, the write → look → fix loop, reading the scene (read_design detail), looking at it (inspect_model: camera view, frame strips, shading), lighting, materials and camera that look professional, animation recipes, the video render and its time budget. Load before writing, editing or reviewing a Blender document.
---

## Steve desktop execution (overrides hosted tool names below)

Use `cad_read` to read the active source/revision. Build or edit Blender documents
with `cad_build` and `kind: "blender"`, Python `code`, helper `files`, and revision-pinned
CAD `links`. Use `cad_inspect` for measured scene facts and object details; pass an
object name as `entity`. Use `blender_render` for local camera/inspection images or
animation. Use `cad_export` with BLEND, GLB or MP4 for Blender artifacts. All execution
stays on the local machine; do not use remote MCP to build/render Blender scenes.
A local Blender 4.5 LTS installation is required (Settings → Blender).
Local execution uses process isolation and cancellation, not the hosted security sandbox described below. Python runs with the user’s permissions; Blender offline mode does not sandbox arbitrary Python networking.
The scene starts empty, with 1 Blender unit = 1 millimetre. CAD links are imported
meshes, not editable CAD solids. Native edits in Blender do not update Python source.



# Blender documents: scenes as Blender Python

A **Blender document** (`kind: "blender"`) is a Python script for Blender's own API, `bpy`. Each build runs it in a
fresh, headless Blender (no window, no add-ons beyond Blender's defaults, no network) on an **empty scene**, then
measures what it made and exports its mesh for the viewer. A full build also saves the scene as a `.blend` file,
renders four inspection views and, when the scene is animated through a camera, **renders the animation to an MP4
video**. It is worked with the same tools as every other document: there are no Blender-only tools.

| Blender MCP habit | In STEVE |
|---|---|
| execute code in Blender | the document *is* the code: `write_design` / `edit_design`, then a build runs it |
| get scene info | `read_design` (compact), `read_design(detail="scene")`, `read_design(detail="<object>")` |
| look at the viewport / camera | `inspect_model(view=…, t=…, animation="frames", options={"shading": …})` |
| import assets | link saved STEVE parts and designs (`from links import gearbox`) |

Choose the kind by what the person needs:

- **Part or design (CadQuery)**: exact, dimensioned geometry to manufacture: STEP, drawings, simulation, CAM, checks,
  joints and motion that are checked. Model the thing there.
- **Blender document**: meshes and pictures: organic or sculpted forms, scenes with materials and lights, and
  presentations of CAD parts and designs: renders, exploded views, turntables, animations to video. It links the CAD
  models; it never replaces them.

## The loop

1. **Write** — `write_design(name=…, kind="blender", code=…, files={…}, links={…})`. Saving starts a preview build
   (the scene's mesh and measurements; no renders), so the next step has something to look at.
2. **Look** — `inspect_model(document_id)` renders a look from the latest build, a preview too: right after a save it
   waits for that save's preview (or answers `still_working`: call it again), never for a full build. Look through the shot with `view="camera"`, check motion with `animation="frames"`, read the numbers
   (measurements, objects, warnings) rather than judging sizes from pixels.
3. **Fix** — `edit_design` with every planned edit in one call; then look again. `read_design(detail=…)` answers
   "where is it, what is it made of, does it move" for any object.
4. **Render** — `generate_model(document_id, revision)` once the look is right: the full build saves the `.blend`
   file and renders the video (minutes; see "The video"). Its result lists `model.artifacts.animation` and
   `model.metadata.animation` (frames, fps, seconds, size). Agents outside STEVE get one-time downloads with
   `download=["animation"]` or `["blend"]`; in the app the video plays in the Inspector. A finished render is
   kept: generating the same revision again answers with it, even after STEVE's Blender is updated, and only an edit
   to the scene renders it again. A render started by mistake (the wrong revision) stops once a newer save replaces
   it and nothing waits for it; the person can also stop it with the status bar's Stop button.

A failed build's `error` is the Python traceback with `main.py` line numbers. A result with `retryable: false` used
its whole budget (or stopped early because its video wouldn't fit): change what its `next_step` says rather than
running it again.

## The code

- `code` is `main.py`, run as `__main__`. `files` holds helper modules beside it (`params.py`, `shots/lighting.py`),
  imported as usual. Module names may not shadow Blender's (`bpy.py`, `bmesh.py`, `mathutils.py`, `numpy.py`) or
  `links.py`.
- **Units: 1 Blender unit = 1 mm**, Z up, exactly as in the CAD workspace. Light falloff, camera clip distances and
  depth of field are in those millimetres too.
- The scene starts empty (no cube, camera or light) and set up as STEVE renders: **Cycles on the CPU, 16 samples,
  denoised; 1280 × 720; 24 fps; frames 1–250; AgX**. Set your own: `scene.render.resolution_x/y`,
  `scene.cycles.samples`, `scene.render.fps`, `scene.frame_start/frame_end`.
- Everything the script leaves in the scene that renders is the model. `obj.hide_render = True` leaves an object
  out; cameras, lights and empties never count as geometry.
- `bpy`, `bmesh`, `mathutils` and `numpy` are available. Build meshes with `bpy.data` and `bmesh` (no context
  needed); `bpy.ops` primitives and modifiers work too (set `bpy.context.view_layer.objects.active` first for
  operators that need an active object).
- `matrix_world` is computed when the scene is evaluated: after creating, moving or re-parenting objects, call
  `bpy.context.view_layer.update()` before reading or assigning it, or it is stale (a new object's is the identity)
  and parts end up moved twice.
- Modifiers and geometry nodes are evaluated for the measurements, the viewer's mesh and the renders, and stay live
  in the `.blend` file.
- Nothing comes from outside the code and its links: no image files, HDRIs, fonts beyond Blender's own, or
  downloads. Textures are procedural (noise, voronoi, wave, gradient nodes).

## Linking STEVE parts and designs

A Blender document links saved parts and designs like a design does, pinned to a revision:

- `link_design(document_id=<the Blender document>, revision=…, alias="gearbox", target_document_id=<the design>)`,
  or `links={"gearbox": {"document_id": "…"}}` in `write_design` / `edit_design` (several at once, with the code
  that uses them). `read_design` lists each link's pinned and latest revision ("update available"); relink to move it.
- Only whole parts and designs, from the same workspace. A Blender document is never linked into a part or design.
- The scene gets the linked revision's **built model**: the meshes, the instance names and placements, and the
  colours of its latest successful build (a full build's mesh is finer than a preview's). Its code never runs in the
  Blender build. If the revision has no build yet, building the Blender document builds it first and waits; if it
  fails, the Blender build fails naming it: fix that part or design first.

```python
from links import gearbox          # each alias is a callable

box = gearbox()                    # a copy at the origin, as the design placed its instances
left = gearbox(at=(-150, 0, 0), rotate=("Z", 90), name="gearbox_left")
tilted = gearbox(at=(0, 200, 40), rotate=[("X", 90), ("Z", 30)])   # turns applied in order
```

- Each call adds an **independent copy** in a new collection (named `name`, else the alias) and returns that
  collection. The copy hangs from one empty, `gearbox.root(copy)`: move, turn or animate it to move the whole copy.
- Objects keep the design's **instance names** (read_design on the design lists them): the first copy's are exact
  (`bpy.data.objects["rotor"]`), later copies' get ".001", ".002". `gearbox.instances(copy)` maps instance paths to
  objects for any copy: `{"housing": …, "rotor": …, "motor/shaft": …}` (a linked subassembly's instances under its
  name).
- Each instance object sits where the design placed it: its location and rotation are the instance's placement, its
  mesh the part in its own coordinates. So turning an instance about its own axes turns it about the part's own
  origin and axes; read_design(detail="rotor") shows its placement and extent.
- Copies share mesh data and materials (linked duplicates). Each colour of the model is one material (`mat_0`,
  `mat_1`, …). To recolour one instance only: `slot = obj.material_slots[0]; slot.link = "OBJECT"; slot.material = mine`.
- The model is a triangle mesh in millimetres: good for pictures and video, never for tolerances. Measure the CAD
  document for real dimensions.
- Hundreds of instances are fine; each link's file is read once however many copies.

## Reading the scene (read_design)

`read_design(document_id)` gives the code, the links, and the last build's measurements with the shot in brief
(`scene`: camera, lights, frames, fps, seconds, render engine and size). For more, by name:

- `read_design(document_id, detail="scene")`: every camera (lens, sensor, clip, depth of field), light (kind,
  energy, colour, size), the world, frame range, fps, render settings (engine, resolution, samples, denoise, view
  transform, look, motion blur), collections, counts, and the video's figures when there is one.
- `read_design(document_id, detail="rotor")`: that object's type, parent, collections, location / rotation (degrees)
  / scale, world location, extent, materials, modifiers, constraints, `animation` (first and last key frame,
  channels, drivers), triangles, and volume when it is closed. Detail is kept for the first 300 objects.

- `read_design(document_id, detail="objects")`: every object's measurements (type, triangles, closed, extent,
  area, volume), as the build listed them. Default answers list only the largest objects and say how many are held back.

These describe the **last build** (the save's preview counts): look again after an edit before relying on them.

## Looking (inspect_model)

Every call returns the measurements, the shot in brief and one picture. Looks render from the build the document has
(a preview too), are kept per build, view, moment and shading, and take seconds (a strip a little longer).

| Call | Picture |
|---|---|
| `inspect_model(id)` | isometric inspection view (orthographic, framed on the scene, STEVE's neutral light) |
| `view="top" \| "front" \| "right"` | the other inspection views |
| `view="camera"` | through the scene's own camera, with its lights, world and render settings: the shot as the video frames it |
| `t=2.5` | at that moment, in seconds from the first frame (with any view) |
| `animation="frames"` | a strip of 8 frames across the whole range, left to right, top to bottom; `options={"frames": 12}` for 2–16. `look.cells` gives each frame and its t |
| `options={"shading": "solid"}` | flat studio shading in each material's colour (Workbench): fastest, shows form |
| `options={"shading": "material"}` | the scene's materials under STEVE's neutral light (the inspection views' default) |
| `options={"shading": "rendered"}` | the scene's own lights and world (the camera view's default) |
| `options={"shading": "wireframe"}` | the triangles over a clay surface: density, stray geometry, inside faces |

Check motion with `view="camera", animation="frames", options={"shading": "solid"}` before rendering a video: a
wrong key frame or a part flying away shows in seconds. Black pictures through the camera mean no light reaches the
camera (no lights, a world at strength 0, or a camera inside an object); the build's `warnings` say when the scene
has no lights at all.

## The video

A full build renders `animation.mp4` when, and only when, the scene has **a camera** (`scene.camera`), **more than
one frame** (`frame_end > frame_start`) and **something animated** (key frames or drivers on any object, its data, a
material, the world, a node group or the scene). It renders frames `frame_start` to `frame_end` (every `frame_step`)
at `scene.render.fps / fps_base`, through `scene.camera`, as H.264 in MP4, at the scene's size
(`resolution × percentage`), at most 1920 × 1080 (larger is scaled down, keeping its shape). Cycles renders on the CPU
with the scene's samples and denoising; Workbench scenes render with Workbench (seconds a frame, flat shading); EEVEE
needs a graphics card, so EEVEE scenes render with Cycles. A still scene, or one without a camera, gets no video
(a warning says so when it is animated but has no camera).

**The time budget.** A build has the same time budget as any build (hours). The build times two frames first and,
when the rest wouldn't fit, stops at once with `retryable: false` and the estimate, instead of running out of time.
Plan before rendering: on a build's 2 CPUs a lit 1280 × 720 frame of an assembly takes about **11 s at 16 samples**
(about 20 s at 32, about 1 s with Workbench); time grows with pixels, samples, glass and volumes. So 5 s at 24 fps
(120 frames) is about 20 minutes. Keep first videos short (2–5 s), check them with frame strips, then lengthen.
Halving `resolution_percentage` quarters the time; `frame_step = 2` halves it (the video then plays at half the
frames).

## Animation recipes

Key frames are authored motion: exact poses at exact frames, with easing. Drivers are motion that follows a rule
(`frame * 6`, a gear ratio). Both render in looks and the video. Drivers must be **simple expressions** (`frame`,
numbers, `+ - * / **`, `sin cos tan`, `radians`, `pi`, `min max abs`, and driver variables): full Python
expressions don't run in a build (Blender's script auto-run is off), and handlers (`frame_change_pre`) don't run
in looks: use key frames or simple drivers.

```python
import math
import bpy
from mathutils import Matrix, Vector

scene = bpy.context.scene
scene.frame_start, scene.frame_end, scene.render.fps = 1, 96, 24   # 4 s


def key(obj, path, frames_values, interpolation="BEZIER", easing="EASE_IN_OUT"):
    """Key frames for one property: [(frame, value), …]; easing in and out by default (smooth starts and stops)."""
    for frame, value in frames_values:
        setattr(obj, path, value)
        obj.keyframe_insert(path, frame=frame)
    for curve in obj.animation_data.action.fcurves:
        if curve.data_path == path:
            for point in curve.keyframe_points:
                point.interpolation, point.easing = interpolation, easing
```

**Turntable** (the subject still, the camera circling it, a seamless loop):

```python
pivot = bpy.data.objects.new("Turntable", None)          # an empty at the subject's centre
scene.collection.objects.link(pivot)
pivot.location = centre
camera.parent = pivot                                     # the camera rides on it (camera recipe below),
camera.matrix_parent_inverse = Matrix.Translation(centre).inverted()   # staying where it was
key(pivot, "rotation_euler", [(scene.frame_start, (0, 0, 0)), (scene.frame_end + 1, (0, 0, math.tau))],
    interpolation="LINEAR")                               # constant speed; frame_end + 1 so the loop doesn't stutter
```

**Exploded view and reassembly** of a linked design, moving each instance out along its direction from the centre,
staggered so they leave one after another, holding, then coming back:

```python
from links import gearbox

copy = gearbox()
parts = gearbox.instances(copy)
bpy.context.view_layer.update()   # world frames are current (needed again after moving anything yourself)
centre = sum((obj.matrix_world.translation for obj in parts.values()), Vector()) / len(parts)
for index, (name, obj) in enumerate(sorted(parts.items())):
    rest = obj.location.copy()
    away = obj.matrix_world.translation - centre
    away = away.normalized() if away.length > 1e-6 else Vector((0, 0, 1))
    out = rest + obj.parent.matrix_world.to_3x3().inverted() @ (away * 60)   # 60 mm, in the parent's frame
    start = 10 + 3 * index                                                  # staggered by 3 frames
    key(obj, "location", [(start, rest), (start + 24, out), (start + 48, out), (start + 72, rest)])
```

Instances of a subassembly hang from it: move whole subassemblies by their own object (`parts["motor"]`), or only
the leaves (objects without children) for a full explode.

**Spinning a rotor about its axis.** When the axis is the part's own Z (its object's local Z), spin that:

```python
rotor = parts["rotor"]
rotor.rotation_mode = "XYZ"
driver = rotor.driver_add("rotation_euler", 2).driver
driver.expression = "radians(frame * 15)"                 # 15° a frame: 1 turn a second at 24 fps
```

When the axis is elsewhere, spin a pivot at the axis and let the rotor ride on it (do this before keying the rotor's own location: key frames are in its parent's frame):

```python
pivot = bpy.data.objects.new("Rotor axis", None)
scene.collection.objects.link(pivot)
pivot.parent = rotor.parent                               # moves with the copy
pivot.matrix_world = rotor.matrix_world.copy()            # at the rotor's frame (or a point and axis you know)
bpy.context.view_layer.update()   # a new or re-parented object's matrix_world is stale until the scene is evaluated
world = rotor.matrix_world.copy()
rotor.parent = pivot
rotor.matrix_world = world                                # keeps its place, now riding on the pivot
pivot.driver_add("rotation_euler", 2).driver.expression = "radians(frame * 15)"
```

Meshing gears: drive each from the same expression with its ratio, e.g. a 12-tooth gear driving a 36-tooth one:
`"radians(frame * 15)"` and `"-radians(frame * 15) * 12 / 36"` (opposite directions). An offset of half a tooth
pitch at frame 0 makes teeth mesh rather than clash.

**Camera moves.** Aim the camera with a Track To constraint at an empty, then move either: an orbit is the turntable
above; a dolly keys the camera's location (or `lens` for a zoom) with easing:

```python
target = bpy.data.objects.new("Camera target", None)
scene.collection.objects.link(target)
target.location = centre
aim = camera.constraints.new("TRACK_TO")
aim.target, aim.track_axis, aim.up_axis = target, "TRACK_NEGATIVE_Z", "UP_Y"
key(camera, "location", [(1, (420, -520, 260)), (96, (240, -300, 160))])   # ease in, ease out
```

## Looking professional

**Camera.** A 50–85 mm lens for products (less distortion than the default 50 at close range: prefer 70), framed
with a little room around the subject, slightly above it. Set clip distances for millimetres:

```python
camera = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
scene.collection.objects.link(camera)
scene.camera = camera
camera.data.lens = 70
camera.data.clip_start, camera.data.clip_end = 1, 100_000                  # mm
camera.location = (420, -520, 260)
camera.rotation_euler = (Vector(centre) - camera.location).to_track_quat("-Z", "Y").to_euler()
```

**Light: three-point studio, no HDRI needed.** Area lights in millimetres: power falls off with the square of the
distance, so give each light a power proportional to its distance squared. A key light above and to one side, a
softer fill on the other side, a rim light behind for an edge highlight, and a dark, slightly blue world:

```python
def area_light(name, location, target, strength, size):
    """An area light aimed at `target`; `strength` about 6 for a key, 2 for a fill, 4 for a rim."""
    light = bpy.data.objects.new(name, bpy.data.lights.new(name, "AREA"))
    scene.collection.objects.link(light)
    light.location = location
    light.rotation_euler = (Vector(target) - light.location).to_track_quat("-Z", "Y").to_euler()
    light.data.energy = strength * (Vector(target) - light.location).length ** 2   # W, for mm distances
    light.data.size = size                                                         # mm: bigger is softer
    return light

area_light("Key", (400, -350, 450), centre, 6, 250)
area_light("Fill", (-450, -250, 200), centre, 2, 400)
area_light("Rim", (0, 450, 350), centre, 4, 150)
world = bpy.data.worlds.new("Studio")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.035, 0.04, 0.05, 1)
scene.world = world
```

A large floor plane under the subject grounds it; in Cycles, `floor.is_shadow_catcher = True` keeps only its
shadows (the world shows through it).

**Colour.** Keep the AgX view transform (the default; it handles bright highlights gracefully) and give it contrast
with a look: `scene.view_settings.look = "AgX - Medium High Contrast"` (or `"AgX - Punchy"` for saturated
product shots). Filmic and Standard exist too.

**Materials.** Principled BSDF: brushed metal `Metallic 1, Roughness 0.3–0.4`; anodised or painted parts a colour
with `Roughness 0.35–0.5`; plastics `Roughness 0.4–0.6`; rubber `Roughness 0.8`; glass `Transmission Weight 1,
Roughness 0` (slow: use sparingly). Pure white or black base colours look flat: stay within about 0.05–0.85.

**Depth of field and motion blur, sparingly.** `camera.data.dof.use_dof = True`, `dof.focus_object = target`,
`dof.aperture_fstop = 5.6` (smaller is blurrier; at product scale 2.8–8). Motion blur makes fast spins read as
motion: `scene.render.use_motion_blur = True` (half a frame's shutter by default). Both cost render time.

**Samples.** 16 denoised is clean for most product shots; 32 for fine highlights or glossy close-ups; Workbench for
quick motion studies.

## Limits

- Each build has the same time and memory budget as CAD builds, no network, and only its own scratch folder.
- Blender 4.5 LTS with its default add-ons only; no installing packages or add-ons.
- The inspection views (isometric, top, front, right) use STEVE's own camera and lights; `view="camera"` and the
  video use the scene's.
- The video is H.264 MP4 at most 1920 × 1080, without sound.
- No STEP export, drawings, simulation, CAM or manufacturability checks: for something to manufacture, model it as a
  part or design and link it here to present it.

## What never to claim

- That a render or video shows something you haven't looked at: look (`inspect_model`) or render it first, and only
  say a video exists when `generate_model`'s result lists `animation`.
- That an animation checks a mechanism: Blender moves meshes where the code puts them, with no joints, collisions
  or clearances checked. A design's Motion and its checks do that in the CAD workspace.
- Engineering facts from the scene: linked models are tessellated meshes (sizes within their mesh tolerance), and
  materials and lights are looks, not physics.
- That a render time will be met: say the estimate and that the build checks it.
