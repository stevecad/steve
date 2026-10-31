"""One Blender document's build, in a fresh headless Blender (blender/blender_backend.py execs it inside the kernel's job
sandbox). Reads request.json from the job directory and writes, as the CAD runtime does:

- preview.glb: the evaluated scene (modifiers applied), in millimetres, Z-up rotated into glTF's Y-up frame exactly as
  CadQuery's previews are, so the app's viewer shows both the same way;
- result.json: {"ok": true, "metadata": {...}}: the scene's measurements (bounds, extent, surface area, and volume and
  centre of mass of its closed meshes), each object's, the scene's facts (cameras, lights, frames, render settings,
  collections) and each object's detail (placement, materials, modifiers, animation) for read_design, and warnings;
- full builds also result.blend (the scene as authored, textures packed), the four inspection views
  view-{isometric,top,front,right}.png, rendered with Cycles on the CPU (no display or GPU needed), and, when the scene
  has a camera and an animation (ANIMATION), its animation as animation.mp4 (H.264), within the build's time budget;
- a "views" job (inspect_model's look: app/derivations.py variants) runs the document again and renders one picture,
  view-<view>.png: an inspection view or the scene's own camera, at a moment of its animation or as a strip of frames.

The document's code (main.py, with its helper modules beside it) runs as __main__ on an empty scene whose length unit is
the millimetre: 1 Blender unit = 1 mm. `from links import <alias>` gives the saved parts and designs the document links:
their models arrive as glTF files (imports/<sha256>.glb, the linked build's preview.glb), never as code.
"""
import json
import math
from pathlib import Path
import re
import struct
import sys
import time
import traceback
import types

import bpy
from mathutils import Matrix, Vector
import numpy as np

STARTED = time.monotonic()
sys.path.insert(0, str(Path(__file__).resolve().parent))
import blender_measure as measure  # noqa: E402  (beside this file; no bpy, so it is tested on its own)
sys.path.pop(0)  # The document's own modules come from its folder only.

# As app/main.py: lowercase module paths, at most 3 folders deep; never one that would shadow main.py, Blender's API or
# the links module.
FILE_PATH = re.compile(r"(?:[a-z][a-z0-9_]{0,63}/){0,3}[a-z][a-z0-9_]{0,63}\.py")
RESERVED = {"main.py", "bpy.py", "bmesh.py", "mathutils.py", "numpy.py", "links.py"}
MAX_FILES = 200
# Objects whose evaluated geometry is a surface mesh (a text, curve or metaball is meshed as Blender renders it).
GEOMETRY = {"MESH", "CURVE", "SURFACE", "FONT", "META"}
MAX_LISTED = 200  # Objects listed one by one in the result; `objects` counts them all.
MAX_DETAILED = 300  # Objects whose detail (read_design detail=<name>) the result keeps; the scene facts count them all.
WIDTH, HEIGHT = 800, 640  # As the CAD inspection views (runtime/screenshots.py).
# Direction from the target to the camera, and the camera's up: the CAD inspection views' (runtime/screenshots.py).
VIEWS = {"isometric": ((1, -1, 1), (0, 0, 1)), "top": ((0, 0, 1), (0, 1, 0)),
         "front": ((0, -1, 0), (0, 0, 1)), "right": ((1, 0, 0), (0, 0, 1))}
SAMPLES = 16
# Links: `from links import <alias>`, each the linked build's model as glTF (app/worker.py blender_inputs).
LINK_ALIAS = re.compile(r"[a-z][a-z0-9_]{0,63}")
LINK_FILE = re.compile(r"[0-9a-f]{64}\.glb")
# glTF is Y-up; Blender's importer turns it Z-up by rotating every node and mesh +90° about X. CadQuery's previews are
# Z-up models under a root rotated -90° about X, so undoing the importer's turn gives back each instance's own frame.
Y_UP = Matrix.Rotation(math.radians(90), 4, "X")
# What a scene starts with besides Blender's factory settings (empty_scene): Cycles on the CPU, 16 samples denoised, at
# 1280×720: about 11 s a frame on a build's 2 CPUs for a lit assembly (32 samples: about 20 s).
DEFAULT_RESOLUTION = (1280, 720)
DEFAULT_SAMPLES = 16
# The video (render_animation): at most this size, Blender's own H.264 in MP4.
MAX_VIDEO = (1920, 1080)
RESERVE_S = 45  # Of a build's budget, kept for writing and sending the result after the video.
# Looks (inspect_model): shading, the strip of frames, picture sizes.
SHADINGS = ("solid", "material", "rendered", "wireframe")
LOOK_VIEWS = (*VIEWS, "camera")
STRIP_DEFAULT, STRIP_MAX = 8, 16
STRIP_WIDTH = 1280  # px across a strip of frames (4 columns): a picture within the views' 4 MB
CAMERA_LONGEST = 1024  # px: a look through the scene's camera, at its aspect
LOOK_SAMPLES = 16
EEVEE = ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT")


class DocumentError(Exception):
    """The document's own mistake, said in a sentence (no traceback of this runner)."""


class OverBudget(DocumentError):
    """The animation would take longer to render than the build's time budget has left (estimated from its first frames)."""

    def __init__(self, message, estimate_s):
        super().__init__(message)
        self.estimate_s = estimate_s


def stage(name):
    """A line app/worker.py last_stage reads ("during render"), and progress.json for the build's progress frames."""
    print(f"STEVE stage: {name}", flush=True)


def progress(stage_name, done=None, of=None):
    """The build's progress (app/kernel_protocol.py clean_progress): written whole, never failing the build."""
    record = {"stage": stage_name, **({"done": done, "of": of} if done is not None and of else {})}
    try:
        Path("progress.json.tmp").write_text(json.dumps(record))
        Path("progress.json.tmp").replace("progress.json")
    except OSError:
        pass


def write_sources(request):
    """main.py and its helper modules into the job directory, which goes first on sys.path so `import params` works."""
    files = request.get("files") or {}
    if not isinstance(files, dict) or len(files) > MAX_FILES:
        raise DocumentError(f"A Blender document holds at most {MAX_FILES} files besides main.py.")
    for name, source in files.items():
        if not isinstance(name, str) or not FILE_PATH.fullmatch(name) or name in RESERVED or name.split("/")[0] == "links" \
                or not isinstance(source, str):
            raise DocumentError(f"{name!r} isn't a valid file of a Blender document: a lowercase Python module beside "
                                "main.py, like params.py or parts/wheel.py.")
        path = Path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        for package in path.parents:
            if str(package) != "." and not (package / "__init__.py").exists():
                (package / "__init__.py").touch()
        path.write_text(source)
    code = request.get("code")
    if not isinstance(code, str):
        raise DocumentError("A Blender document's main.py is missing.")
    Path("main.py").write_text(code)
    sys.path.insert(0, str(Path.cwd()))
    return code


def empty_scene():
    """No factory cube, camera or light: the document makes everything in its scene. Millimetres, as the app. Rendering
    starts as STEVE renders: Cycles on the CPU, 16 samples denoised, 1280×720 (a document sets its own over these)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    units = scene.unit_settings
    units.system, units.scale_length, units.length_unit = "METRIC", 0.001, "MILLIMETERS"
    render = scene.render
    render.engine = "CYCLES"
    render.resolution_x, render.resolution_y, render.resolution_percentage = *DEFAULT_RESOLUTION, 100
    render.use_persistent_data = True  # Frames of an animation reuse the scene's render data.
    scene.cycles.device = "CPU"
    scene.cycles.samples = DEFAULT_SAMPLES
    denoised(scene)


def denoised(scene):
    """OpenImageDenoise, its quicker settings: on a CPU the full-quality prefilter costs more than the samples it saves."""
    scene.cycles.use_denoising, scene.cycles.denoiser = True, "OPENIMAGEDENOISE"
    scene.cycles.denoising_prefilter, scene.cycles.denoising_quality = "FAST", "BALANCED"


# -- Links ------------------------------------------------------------------------------------------------------------

def glb_node_names(path):
    """The node names a GLB file's JSON chunk declares (to tell an instance's own name from Blender's ".001")."""
    with open(path, "rb") as handle:
        header = handle.read(20)
        if len(header) < 20 or header[:4] != b"glTF":
            raise DocumentError("A linked model isn't a glTF file. Generate the linked document again.")
        length = int.from_bytes(header[12:16], "little")
        try:
            gltf = json.loads(handle.read(length))
        except ValueError:
            raise DocumentError("A linked model's glTF file is unreadable. Generate the linked document again.") from None
    return {node.get("name") for node in gltf.get("nodes") or [] if isinstance(node, dict) and isinstance(node.get("name"), str)}


def depth(obj):
    count = 0
    while obj.parent is not None:
        obj, count = obj.parent, count + 1
    return count


def import_glb(path, alias):
    """A linked model, imported once into a collection outside the scene (the template every copy is made from):
    [(object, its instance path, its parent's template object or None)], parents first. Each object keeps its glTF
    node's name (its instance name in STEVE) and frame: millimetres (1 glTF unit = 1 mm, as STEVE's previews), Z up."""
    names = glb_node_names(path)
    scene, layer = bpy.context.scene, bpy.context.view_layer
    holding = bpy.data.collections.new(f"links:{alias}")
    scene.collection.children.link(holding)
    active, scale = layer.active_layer_collection, scene.unit_settings.scale_length
    layer.active_layer_collection = layer.layer_collection.children[holding.name]
    before = set(bpy.data.objects)
    scene.unit_settings.scale_length = 1.0  # The importer scales metres to the scene's unit: STEVE's glTF is in mm.
    try:
        bpy.ops.import_scene.gltf(filepath=str(path), merge_vertices=False, guess_original_bind_pose=False)
        layer.update()  # Every imported object's world frame, evaluated while it is in the scene.
        made = sorted((obj for obj in bpy.data.objects if obj not in before), key=depth)
        # Each object's world frame without the importer's turn, and each mesh as modelled (meshes may be shared).
        worlds = {obj: obj.matrix_world @ Y_UP for obj in made}
    except RuntimeError as exc:
        raise DocumentError(f"The linked model {alias!r} couldn't be read: {str(exc).strip()[:300]}") from None
    finally:
        scene.unit_settings.scale_length = scale
        layer.active_layer_collection = active
        scene.collection.children.unlink(holding)
    turned_back = set()
    for obj in made:
        if obj.type == "MESH" and obj.data is not None and obj.data.name not in turned_back:
            obj.data.transform(Y_UP.inverted())
            turned_back.add(obj.data.name)
    for obj in made:
        obj.rotation_mode = "XYZ"
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_basis = worlds[obj.parent].inverted() @ worlds[obj] if obj.parent in worlds else worlds[obj]
    # The glTF scene's own root (the design, or an unnamed node over a part) only groups the instances: dropped, its
    # placement kept in theirs, so the copy's root (LinkedModel.__call__) places them.
    for obj in [obj for obj in made if obj.parent is None and obj.type == "EMPTY" and obj.children]:
        for child in obj.children:
            child.parent = None
            child.matrix_parent_inverse = Matrix.Identity(4)
            child.matrix_basis = obj.matrix_basis @ child.matrix_basis
        made.remove(obj)
        bpy.data.objects.remove(obj, do_unlink=True)
    original, entries, paths = {}, [], {}
    for obj in sorted(made, key=depth):
        stripped = re.sub(r"\.\d{3,}$", "", obj.name)
        own = obj.name if obj.name in names or stripped not in names else stripped
        original[obj] = own
        paths[obj] = f"{paths[obj.parent]}/{own}" if obj.parent in paths else own
        entries.append((obj, paths[obj], obj.parent if obj.parent in paths else None))
    for index, (obj, path_, _) in enumerate(entries):
        obj["steve_instance"] = path_
        obj["steve_name"] = original[obj]
        obj.name = f"~{alias}.{index}"  # Frees the instance names for the copies.
    return holding, entries


class LinkedModel:
    """`from links import <alias>`: a saved part or design this document links, at its pinned revision, as its model
    (meshes, placements, colours). Calling it adds a copy to the scene."""

    def __init__(self, alias, path, title):
        self.alias, self.path, self.title = alias, path, title
        self.template = None

    def __repr__(self):
        return f"<linked model {self.alias!r}: {self.title}>"

    def __call__(self, at=(0.0, 0.0, 0.0), rotate=None, name=None):
        """One copy of the linked model in a new collection (named `name`, else the alias), placed by its root: moved
        `at` (x, y, z) mm and turned by `rotate`, ("Z", degrees) or a list of such turns applied in order. Its objects
        keep their instance names (a second copy's get ".001"); `instances(copy)` maps instance names to them."""
        placement = Matrix.Translation(vector(at, "at")) @ turns(rotate)
        if name is not None and (not isinstance(name, str) or not name.strip()):
            raise DocumentError(f"{self.alias}(name=…) takes a non-empty name, like \"{self.alias}_left\".")
        if self.template is None:
            self.template = import_glb(self.path, self.alias)
        _, entries = self.template
        collection = bpy.data.collections.new((name or self.alias)[:63])
        bpy.context.scene.collection.children.link(collection)
        root = bpy.data.objects.new(collection.name, None)
        root.empty_display_type = "PLAIN_AXES"
        collection.objects.link(root)
        root.matrix_world = placement
        root["steve_link"], root["steve_instance"] = self.alias, ""
        copies = {}
        for source, path_, parent in entries:
            obj = source.copy()  # Shares its mesh and materials with the other copies (a linked duplicate).
            obj.name = source["steve_name"]
            collection.objects.link(obj)
            obj.parent = copies[parent] if parent is not None else root
            obj.matrix_parent_inverse = Matrix.Identity(4)
            obj.matrix_basis = source.matrix_basis.copy()
            obj["steve_link"] = self.alias
            copies[source] = obj
        collection["steve_link"] = self.alias
        bpy.context.view_layer.update()  # The copy's world frames current, for code that reads them next.
        return collection

    def root(self, copy):
        """The empty a copy hangs from: move, turn or animate it to move the whole copy."""
        return next(obj for obj in copy.objects if obj.get("steve_link") == self.alias and obj.get("steve_instance") == "")

    def instances(self, copy):
        """{instance path: object} of a copy: "rotor", or "gearbox/rotor" inside a linked subassembly."""
        return {obj["steve_instance"]: obj for obj in copy.all_objects if obj.get("steve_instance")}


def vector(value, what):
    try:
        x, y, z = (float(item) for item in value)
    except (TypeError, ValueError):
        raise DocumentError(f"{what}= takes three numbers in mm, like (10, 0, 5).") from None
    return Vector((x, y, z))


def turns(rotate):
    """("Z", 30) or [("X", 90), ("Z", 30)] (applied in that order) as a rotation matrix."""
    if rotate is None:
        return Matrix.Identity(4)
    steps = [rotate] if isinstance(rotate, tuple) and len(rotate) == 2 and isinstance(rotate[0], str) else rotate
    matrix = Matrix.Identity(4)
    try:
        for axis, degrees in steps:
            if axis not in ("X", "Y", "Z"):
                raise ValueError(axis)
            matrix = Matrix.Rotation(math.radians(float(degrees)), 4, axis) @ matrix
    except (TypeError, ValueError):
        raise DocumentError('rotate= takes ("Z", degrees) or a list of such turns, like [("X", 90), ("Z", 30)].') from None
    return matrix


class Links(types.ModuleType):
    """The `links` module: one LinkedModel per alias; a name it doesn't have says how to link one."""

    def __getattr__(self, alias):
        if alias.startswith("__"):
            raise AttributeError(alias)
        raise ImportError(f"This Blender document links nothing called {alias!r}. Link a saved part or design under that "
                          f"name first: link_design(document_id, revision, alias={alias!r}, target_document_id=…).")


def install_links(request):
    """`links` as a module before main.py runs: each link's model is a GLB file the dispatcher sent (imports/)."""
    module = Links("links", "The saved parts and designs this Blender document links.")
    module.__file__ = "links"
    entries = request.get("links") or {}
    if not isinstance(entries, dict):
        raise DocumentError("The build's links are malformed.")
    for alias, entry in entries.items():
        file = entry.get("file") if isinstance(entry, dict) else None
        if not isinstance(alias, str) or not LINK_ALIAS.fullmatch(alias) or not isinstance(file, str) or not LINK_FILE.fullmatch(file):
            raise DocumentError("The build's links are malformed.")
        path = Path("imports") / file
        if not path.is_file():
            raise DocumentError(f"The linked model {alias!r} didn't arrive with the build. Generate it again.")
        setattr(module, alias, LinkedModel(alias, path, str(entry.get("name") or alias)[:100]))
    sys.modules["links"] = module
    return module


def remove_templates(module):
    """The links' templates (outside the scene) once main.py has made its copies: nothing of them stays in the file."""
    for value in vars(module).values():
        if isinstance(value, LinkedModel) and value.template is not None:
            holding, entries = value.template
            for obj, _, _ in reversed(entries):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.collections.remove(holding)
            value.template = None


# -- Running the document ---------------------------------------------------------------------------------------------

def run_document(code):
    """Runs main.py as __main__. Its errors keep only the document's own frames (main.py and its modules)."""
    globals_ = {"__name__": "__main__", "__file__": str(Path("main.py").resolve()), "__builtins__": __builtins__}
    try:
        exec(compile(code, "main.py", "exec"), globals_)
    except SystemExit as exc:
        if exc.code not in (None, 0):
            raise DocumentError(f"main.py exited with {exc.code!r}.") from None
    except DocumentError as exc:  # A link's own message (links module): with the document's line.
        frames = [frame for frame in traceback.extract_tb(exc.__traceback__) if not frame.filename.endswith("blender_run.py")]
        raise DocumentError("Traceback (most recent call last):\n" + "".join(traceback.format_list(frames)) + str(exc)) from None
    except Exception as exc:
        frames = [frame for frame in traceback.extract_tb(exc.__traceback__) if not frame.filename.endswith("blender_run.py")]
        text = "".join(traceback.format_list(frames)) + "".join(traceback.format_exception_only(type(exc), exc))
        raise DocumentError("Traceback (most recent call last):\n" + text) from None


def mesh_arrays(obj):
    """(vertices (n, 3) float64 in the object's space, triangles (m, 3) int64) of an evaluated object, or None."""
    try:
        mesh = obj.to_mesh()
    except RuntimeError:
        return None
    if mesh is None:
        return None
    try:
        mesh.calc_loop_triangles()
        vertices = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.vertices.foreach_get("co", vertices)
        triangles = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int32)
        mesh.loop_triangles.foreach_get("vertices", triangles)
    finally:
        obj.to_mesh_clear()
    return vertices.reshape(-1, 3).astype(np.float64), triangles.reshape(-1, 3).astype(np.int64)


def measure_scene():
    """Every renderable object of the evaluated scene (instances and modifiers included), measured in world millimetres
    (blender_measure.summarize): (metadata, (low, high), {object name: its measurements} for up to MAX_DETAILED)."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    cache, found = {}, []
    instanced_self = set()  # Curves and texts whose evaluated mesh comes as an instance of themselves.
    for instance in depsgraph.object_instances:
        obj = instance.object
        if obj.type not in GEOMETRY or (not instance.is_instance and obj.original.hide_render):
            continue
        name = obj.name
        if instance.is_instance and instance.parent is not None:
            if instance.parent.original == obj.original:
                instanced_self.add(obj.original.name)
            else:
                name = f"{instance.parent.name}/{obj.name}"
        key = (obj.as_pointer(), obj.data.as_pointer() if obj.data is not None else 0)
        if key not in cache:
            arrays = mesh_arrays(obj)
            cache[key] = None if arrays is None or not len(arrays[1]) else (*arrays, measure.closed(*arrays))
        if cache[key] is not None:
            found.append((name, obj.type, instance.is_instance, obj.original.name, key,
                          np.array(instance.matrix_world, dtype=np.float64)))
    placed = [(name, kind.lower(), *cache[key], matrix) for name, kind, is_instance, original, key, matrix in found
              # A curve's or text's own entry when its mesh also came as an instance of itself: counted once, there.
              if is_instance or kind == "MESH" or original not in instanced_self]
    try:
        metadata, (low, high) = measure.summarize(placed, MAX_DETAILED)
    except measure.NoGeometry:
        raise DocumentError("The scene has no renderable geometry: create a mesh, curve or text object with bpy "
                            "(e.g. bpy.ops.mesh.primitive_cube_add(size=20)), and keep it visible in renders.") from None
    measured = {item["name"]: item for item in metadata["scene_objects"]}
    if len(metadata["scene_objects"]) > MAX_LISTED:
        metadata["scene_objects_more"] = metadata.get("scene_objects_more", 0) + len(metadata["scene_objects"]) - MAX_LISTED
        metadata["scene_objects"] = metadata["scene_objects"][:MAX_LISTED]
    return metadata, (Vector(low), Vector(high)), measured


# -- Scene facts (read_design detail="scene" / detail=<object>) -------------------------------------------------------

def rounded(values, digits=4):
    return [round(float(value), digits) + 0.0 for value in values]


def animation_of(id_):
    """(first key frame, last key frame, animated channels, drivers) of a datablock's own animation, or None."""
    data = getattr(id_, "animation_data", None)
    if data is None:
        return None
    keys, channels = [], 0
    action = data.action
    if action is not None:
        for curve in action_curves(action, data):
            channels += 1
            if len(curve.keyframe_points):
                keys += [curve.keyframe_points[0].co.x, curve.keyframe_points[-1].co.x]
    drivers = len(data.drivers)
    if not channels and not drivers:
        return None
    return (min(keys) if keys else None, max(keys) if keys else None, channels, drivers)


def action_curves(action, data=None):
    """An action's F-curves: its own (legacy actions) or its slot's channelbag (Blender 4.4's layered actions)."""
    curves = list(getattr(action, "fcurves", None) or [])
    if curves:
        return curves
    for layer in getattr(action, "layers", None) or []:
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", None) or []:
                if data is None or getattr(data, "action_slot", None) is None or bag.slot == data.action_slot:
                    curves += list(bag.fcurves)
    return curves


ANIMATED_DATA = ("objects", "meshes", "curves", "materials", "shape_keys", "worlds", "lights", "cameras", "scenes",
                 "node_groups", "textures")


def animated_ids():
    """Every datablock with key frames or drivers (an object, its data, a material, a world, a node group, the scene)."""
    found = []
    for collection in ANIMATED_DATA:
        for id_ in getattr(bpy.data, collection):
            ids = [id_, *([id_.node_tree] if getattr(id_, "node_tree", None) is not None else [])]
            for item in ids:
                if (animation := animation_of(item)) is not None:
                    found.append((item, animation))
    return found


def euler_degrees(matrix):
    return rounded((math.degrees(angle) for angle in matrix.to_euler("XYZ")), 3)


def object_detail(obj, measured):
    """One object's detail: what it is, where (its own placement, and its world position when parented), what it's made of,
    whether it moves, and its measurements when it renders as geometry."""
    location, rotation, scale = obj.matrix_basis.decompose()
    detail = {"type": obj.type.lower(), "parent": obj.parent.name if obj.parent else None,
              "collections": [collection.name for collection in obj.users_collection][:5],
              "location_mm": rounded(obj.matrix_basis.translation), "rotation_deg": euler_degrees(rotation.to_matrix()),
              "scale": rounded(scale), "hidden": bool(obj.hide_render)}
    if obj.parent is not None:
        detail["world_location_mm"] = rounded(obj.matrix_world.translation)
    if obj.get("steve_link"):
        detail["link"] = str(obj["steve_link"])[:64]
        if obj.get("steve_instance"):
            detail["instance"] = str(obj["steve_instance"])[:128]
    materials = [slot.material.name for slot in obj.material_slots if slot.material is not None]
    if materials:
        detail["materials"] = materials[:10]
    if obj.modifiers:
        detail["modifiers"] = [{"name": modifier.name, "type": modifier.type.lower()} for modifier in obj.modifiers][:10]
    if obj.constraints:
        detail["constraints"] = [{"name": constraint.name, "type": constraint.type.lower(),
                                  **({"target": constraint.target.name} if getattr(constraint, "target", None) else {})}
                                 for constraint in obj.constraints][:10]
    moving = [animation for item in (obj, obj.data, *(slot.material for slot in obj.material_slots if slot.material))
              if item is not None and (animation := animation_of(item)) is not None]
    if moving:
        firsts = [first for first, _, _, _ in moving if first is not None]
        lasts = [last for _, last, _, _ in moving if last is not None]
        detail["animation"] = {"keyframes": [round(min(firsts), 3), round(max(lasts), 3)] if firsts else None,
                               "channels": sum(channels for _, _, channels, _ in moving),
                               "drivers": sum(drivers for _, _, _, drivers in moving)}
    if obj.type == "CAMERA":
        detail["camera"] = camera_facts(obj)
    elif obj.type == "LIGHT":
        detail["light"] = light_facts(obj)
    if (item := measured.get(obj.name)) is not None:
        detail.update({key: item[key] for key in ("triangles", "closed", "extent_mm", "surface_area_mm2", "volume_mm3") if key in item})
    return detail


def camera_facts(obj):
    camera = obj.data
    facts = {"projection": camera.type.lower(), "lens_mm": round(camera.lens, 3), "sensor_mm": round(camera.sensor_width, 3),
             "clip_mm": rounded((camera.clip_start, camera.clip_end), 3)}
    if camera.type == "ORTHO":
        facts["ortho_scale_mm"] = round(camera.ortho_scale, 3)
    if camera.dof.use_dof:
        facts["depth_of_field"] = {"focus": camera.dof.focus_object.name if camera.dof.focus_object else None,
                                   "focus_distance_mm": round(camera.dof.focus_distance, 3), "fstop": round(camera.dof.aperture_fstop, 3)}
    return facts


def light_facts(obj):
    light = obj.data
    facts = {"kind": light.type.lower(), "energy": round(light.energy, 4), "color": rounded(light.color, 4)}
    if light.type == "AREA":
        facts["size_mm"] = round(light.size, 3)
    elif light.type in ("POINT", "SPOT"):
        facts["radius_mm"] = round(light.shadow_soft_size, 3)
    return facts


def world_facts(scene):
    world = scene.world
    if world is None:
        return None
    facts = {"name": world.name}
    if world.use_nodes and world.node_tree is not None:
        background = next((node for node in world.node_tree.nodes if node.type == "BACKGROUND"), None)
        if background is not None:
            color, strength = background.inputs["Color"], background.inputs["Strength"]
            facts["background"] = {"color": None if color.is_linked else rounded(color.default_value[:3], 4),
                                   "strength": None if strength.is_linked else round(strength.default_value, 4)}
    else:
        facts["color"] = rounded(world.color, 4)
    return facts


def frames_per_second(scene):
    return scene.render.fps / (scene.render.fps_base or 1.0)


def scene_facts(scene, animated):
    """The scene as a whole: its frames, cameras, lights, world, render settings and collections (lists capped)."""
    objects = list(scene.objects)
    cameras = [obj for obj in objects if obj.type == "CAMERA"]
    lights = [obj for obj in objects if obj.type == "LIGHT"]
    render = scene.render
    first = [animation[0] for _, animation in animated if animation[0] is not None]
    last = [animation[1] for _, animation in animated if animation[1] is not None]
    counts = {}
    for obj in objects:
        counts[obj.type.lower()] = counts.get(obj.type.lower(), 0) + 1
    width, height = output_size(scene)
    return {
        "frame_start": scene.frame_start, "frame_end": scene.frame_end, "frame_step": scene.frame_step,
        "fps": round(frames_per_second(scene), 4),
        "seconds": round((scene.frame_end - scene.frame_start + 1) / frames_per_second(scene), 3),
        "camera": scene.camera.name if scene.camera else None,
        "cameras": [{"name": obj.name, "location_mm": rounded(obj.matrix_world.translation), **camera_facts(obj)} for obj in cameras][:20],
        "lights": [{"name": obj.name, "location_mm": rounded(obj.matrix_world.translation), **light_facts(obj)} for obj in lights][:30],
        "world": world_facts(scene),
        "render": {"engine": render.engine.lower(), "resolution": [render.resolution_x, render.resolution_y],
                   "percentage": render.resolution_percentage, "output": [width, height],
                   "samples": scene.cycles.samples, "denoise": bool(scene.cycles.use_denoising),
                   "view_transform": scene.view_settings.view_transform, "look": scene.view_settings.look,
                   "exposure": round(scene.view_settings.exposure, 4), "motion_blur": bool(render.use_motion_blur),
                   "film_transparent": bool(render.film_transparent)},
        "animation": {"animated": len(animated), "keyframes": [round(min(first), 3), round(max(last), 3)] if first else None,
                      "drivers": sum(animation[3] for _, animation in animated)} if animated else None,
        "collections": [{"name": collection.name, "objects": len(collection.all_objects),
                         **({"hidden": True} if collection.hide_render else {})}
                        for collection in scene.collection.children_recursive][:50],
        "counts": counts,
    }


def scene_record(scene, measured):
    """(scene facts, {object name: detail}) for the result, each object's detail for up to MAX_DETAILED objects."""
    animated = animated_ids()
    objects = sorted(scene.objects, key=lambda obj: (obj.type not in GEOMETRY, obj.name))[:MAX_DETAILED]
    return scene_facts(scene, animated), {obj.name[:128]: object_detail(obj, measured) for obj in objects}, animated


def scene_warnings(scene, animated):
    """What would surprise the person in the renders."""
    warnings = []
    lit = any(obj.type == "LIGHT" and not obj.hide_render for obj in scene.objects) or (scene.world is not None)
    if scene.camera is not None and not lit:
        warnings.append("The scene has a camera but no lights and no world, so renders through it are black (unless its "
                        "materials emit light): add lights, e.g. a key, fill and rim light, or a world.")
    if animated and scene.camera is None:
        warnings.append("The scene is animated but has no camera (scene.camera), so no video was rendered.")
    if scene.render.engine in EEVEE:
        warnings.append("EEVEE needs a graphics card; STEVE renders this scene with Cycles on the CPU instead.")
    return warnings


# -- Pictures --------------------------------------------------------------------------------------------------------

def export_preview(scene, animated):
    """preview.glb: what renders, modifiers applied; Blender units are millimetres, as in CadQuery's previews. An
    animated scene's objects carry their motion (sampled every frame of the scene's range, so constraints, drivers and
    parents come out as the renders show them) and its camera comes along, so the app plays the animation and looks
    through the shot (web/src/motion/SceneAnimation). Material and light animation (a glow) shows only in renders."""
    current = scene.frame_current
    moving = bool(animated)
    bpy.ops.export_scene.gltf(filepath=str(Path("preview.glb").resolve()), export_format="GLB", export_yup=True,
                              export_apply=True, use_renderable=True, use_active_scene=True,
                              export_cameras=scene.camera is not None, export_lights=False, export_extras=False,
                              export_animations=moving,
                              **({"export_animation_mode": "SCENE", "export_force_sampling": True, "export_frame_range": True,
                                  "export_frame_step": 1} if moving else {}))
    scene.frame_set(current)


def save_blend():
    """result.blend: the scene as the document made it (before the inspection camera and lights), its images packed."""
    try:
        bpy.ops.file.pack_all()
    except RuntimeError as exc:
        print(f"Warning: some images couldn't be packed into the .blend file: {exc}", file=sys.stderr)
    bpy.ops.wm.save_as_mainfile(filepath=str(Path("result.blend").resolve()), check_existing=False, compress=False,
                                copy=True)


class Inspection:
    """STEVE's own camera and light for the inspection views: an orthographic camera framing an extent along a view's
    direction, a sun over the viewer's shoulder and a light grey world. Added to the scene only for the picture."""

    def __init__(self, scene):
        self.scene = scene
        self.camera_data = bpy.data.cameras.new("STEVE inspection camera")
        self.camera_data.type = "ORTHO"
        self.camera = bpy.data.objects.new("STEVE inspection camera", self.camera_data)
        scene.collection.objects.link(self.camera)
        sun_data = bpy.data.lights.new("STEVE inspection sun", "SUN")
        sun_data.energy = 2.2
        self.sun = bpy.data.objects.new("STEVE inspection sun", sun_data)
        scene.collection.objects.link(self.sun)
        self.world = inspection_world()

    def aim(self, view, low, high, width, height):
        """Points the camera along `view` (VIEWS) at the extent low..high, framed for a width × height picture."""
        direction, up = (Vector(v) for v in VIEWS[view])
        center, size = (low + high) / 2, high - low
        radius = max(size.length / 2, 1e-3)
        self.camera_data.clip_start, self.camera_data.clip_end = radius * 0.01, radius * 10
        basis = view_basis(direction, up)
        self.camera.matrix_world = Matrix.Translation(center + direction.normalized() * radius * 3) @ basis.to_4x4()
        # A headlight from over the viewer's shoulder, like the CAD views' light.
        self.sun.matrix_world = (basis @ Matrix.Rotation(math.radians(-20), 3, "X") @ Matrix.Rotation(math.radians(15), 3, "Y")).to_4x4()
        corners = [Vector((x, y, z)) for x in (low.x, high.x) for y in (low.y, high.y) for z in (low.z, high.z)]
        local = [basis.transposed() @ (corner - center) for corner in corners]  # The extent in the camera's own axes.
        across = max(p.x for p in local) - min(p.x for p in local)
        tall = max(p.y for p in local) - min(p.y for p in local)
        self.camera_data.ortho_scale = max(across, tall * width / height, 1e-3) * 1.15
        self.scene.camera = self.camera


def render_views(scene, low, high):
    """view-<name>.png for each inspection view (Inspection), with the scene's materials. Cycles on the CPU."""
    inspection = Inspection(scene)
    scene.world = inspection.world
    cycles(scene, SAMPLES, denoise=False)
    scene.view_settings.view_transform, scene.view_settings.look = "Standard", "None"
    still(scene, WIDTH, HEIGHT)
    for name in VIEWS:
        inspection.aim(name, low, high, WIDTH, HEIGHT)
        scene.render.filepath = str(Path(f"view-{name}.png").resolve())
        bpy.ops.render.render(write_still=True)


def cycles(scene, samples, denoise=True):
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = max(1, int(samples))
    scene.cycles.use_adaptive_sampling = denoise
    scene.cycles.use_denoising = denoise
    if denoise:
        denoised(scene)


def still(scene, width, height):
    render = scene.render
    render.resolution_x, render.resolution_y, render.resolution_percentage = width, height, 100
    render.film_transparent = False
    render.image_settings.file_format, render.image_settings.color_mode = "PNG", "RGB"


def view_basis(direction, up):
    """A camera's rotation looking from `direction` (towards the target) with `up` at the top of the picture: Blender
    cameras look along their -Z with +Y up."""
    back = direction.normalized()
    right = up.cross(back).normalized()
    return Matrix((right, back.cross(right), back)).transposed()


def inspection_world():
    """A light background for the picture, and a dimmer grey ambient light for the shading (camera rays see the one,
    everything else the other)."""
    world = bpy.data.worlds.new("STEVE inspection world")
    world.use_nodes = True
    world.color = (0.94, 0.95, 0.96)  # What Workbench (solid) shows behind the model.
    nodes, links = world.node_tree.nodes, world.node_tree.links
    nodes.clear()  # (Removing nodes one by one leaves stale references to the others.)
    output = nodes.new("ShaderNodeOutputWorld")
    ambient, backdrop = nodes.new("ShaderNodeBackground"), nodes.new("ShaderNodeBackground")
    ambient.inputs["Color"].default_value, ambient.inputs["Strength"].default_value = (0.75, 0.77, 0.8, 1.0), 0.45
    backdrop.inputs["Color"].default_value, backdrop.inputs["Strength"].default_value = (0.94, 0.95, 0.96, 1.0), 1.0
    path, mix = nodes.new("ShaderNodeLightPath"), nodes.new("ShaderNodeMixShader")
    links.new(path.outputs["Is Camera Ray"], mix.inputs[0])
    links.new(ambient.outputs[0], mix.inputs[1])
    links.new(backdrop.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], output.inputs[0])
    return world


def output_size(scene):
    """The scene's picture size as Blender renders it (resolution × percentage)."""
    render = scene.render
    scale = render.resolution_percentage / 100
    return max(1, round(render.resolution_x * scale)), max(1, round(render.resolution_y * scale))


def set_time(scene, t):
    """Moves the scene to `t` seconds after its first frame (a fraction of a frame as a subframe); returns the frame."""
    frame = scene.frame_start + float(t) * frames_per_second(scene)
    whole = math.floor(frame)
    scene.frame_set(whole, subframe=frame - whole)
    return round(frame, 4)


def scene_bounds(scene):
    """The evaluated extent of everything that renders as geometry, at the current frame, from bounding boxes (quick)."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    low, high = Vector((math.inf,) * 3), Vector((-math.inf,) * 3)
    for instance in depsgraph.object_instances:
        obj = instance.object
        if obj.type not in GEOMETRY or (not instance.is_instance and obj.original.hide_render):
            continue
        matrix = instance.matrix_world
        for corner in obj.bound_box:
            point = matrix @ Vector(corner)
            low = Vector(np.minimum(low, point))
            high = Vector(np.maximum(high, point))
    if low.x == math.inf:
        raise DocumentError("The scene has no renderable geometry at that moment.")
    return low, high


def shade(scene, shading, inspection):
    """Sets up the renderer for a look's shading. solid: Workbench's studio light on each material's colour (fast);
    material: the scene's materials under STEVE's neutral light (as the inspection views); rendered: the scene's own
    lights, world and render settings (Cycles); wireframe: the triangles drawn over a clay surface."""
    if shading == "solid":
        for material in bpy.data.materials:
            base = principled_color(material)
            if base is not None:
                material.diffuse_color = base
        scene.render.engine = "BLENDER_WORKBENCH"
        display = scene.display.shading
        display.light, display.color_type = "STUDIO", "MATERIAL"
        display.show_cavity, display.cavity_type = True, "WORLD"
        display.show_shadows = False
        if inspection is not None:
            scene.world = inspection.world
        scene.view_settings.view_transform, scene.view_settings.look = "Standard", "None"
    elif shading == "material":
        if inspection is not None:
            scene.world = inspection.world
        for obj in scene.objects:
            if obj.type == "LIGHT" and obj is not getattr(inspection, "sun", None):
                obj.hide_render = True
        cycles(scene, SAMPLES, denoise=True)
        scene.view_settings.view_transform, scene.view_settings.look = "Standard", "None"
    elif shading == "wireframe":
        if inspection is not None:
            scene.world = inspection.world
        bpy.context.view_layer.material_override = wire_material()
        cycles(scene, SAMPLES, denoise=False)
        scene.view_settings.view_transform, scene.view_settings.look = "Standard", "None"
    else:  # rendered: as the scene is set up, on the CPU and with the samples a look needs.
        if inspection is not None:
            inspection.sun.hide_render = True
        if scene.render.engine != "BLENDER_WORKBENCH":
            samples = scene.cycles.samples if scene.render.engine == "CYCLES" else LOOK_SAMPLES
            cycles(scene, min(samples, LOOK_SAMPLES), denoise=True)


def principled_color(material):
    """A material's Principled BSDF base colour (RGBA), unless a texture drives it."""
    if not material.use_nodes or material.node_tree is None:
        return None
    node = next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
    if node is None or node.inputs["Base Color"].is_linked:
        return None
    return tuple(node.inputs["Base Color"].default_value)


def wire_material():
    """Dark triangle edges a pixel wide over a light clay surface."""
    material = bpy.data.materials.new("STEVE wireframe")
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    output, wire, mix = nodes.new("ShaderNodeOutputMaterial"), nodes.new("ShaderNodeWireframe"), nodes.new("ShaderNodeMixShader")
    clay, line = nodes.new("ShaderNodeBsdfDiffuse"), nodes.new("ShaderNodeEmission")
    wire.use_pixel_size, wire.inputs["Size"].default_value = True, 1.0
    clay.inputs["Color"].default_value = (0.8, 0.8, 0.8, 1.0)
    line.inputs["Color"].default_value, line.inputs["Strength"].default_value = (0.05, 0.08, 0.12, 1.0), 1.0
    links.new(wire.outputs[0], mix.inputs[0])
    links.new(clay.outputs[0], mix.inputs[1])
    links.new(line.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], output.inputs[0])
    return material


def picture_size(scene, view, longest):
    """A look's size: the scene camera's aspect (its render size) or the inspection views' 800 × 640, `longest` px at most."""
    if view != "camera":
        width, height = WIDTH, HEIGHT
    else:
        width, height = output_size(scene)
    scale = min(1.0, longest / max(width, height))
    return max(16, round(width * scale / 2) * 2), max(16, round(height * scale / 2) * 2)


def look(scene, request):
    """inspect_model's look (app/derivations.py variant): one picture, view-<view>.png, through the scene's camera or
    from an inspection view, at a moment (`t` seconds) or as a strip of `frames` frames across the scene's range."""
    view = request.get("view")
    if view not in LOOK_VIEWS:
        raise DocumentError(f"A look is from {', '.join(LOOK_VIEWS)}, not {view!r}.")
    shading = request.get("shading") or ("rendered" if view == "camera" else "material")
    if shading not in SHADINGS:
        raise DocumentError(f"Shading is one of {', '.join(SHADINGS)}, not {shading!r}.")
    frames = request.get("frames")
    t = request.get("t")
    if frames is not None and (not isinstance(frames, int) or isinstance(frames, bool) or not 2 <= frames <= STRIP_MAX):
        raise DocumentError(f"A strip of frames has 2 to {STRIP_MAX} frames.")
    if t is not None and (not isinstance(t, (int, float)) or isinstance(t, bool) or not math.isfinite(t) or t < 0):
        raise DocumentError("t is a time in seconds from the scene's first frame, 0 or more.")
    camera = scene.camera
    if view == "camera" and camera is None:
        raise DocumentError("The scene has no camera to look through: add one and set it as scene.camera (the skill's "
                            "camera recipe), or look from isometric, top, front or right.")
    fps = frames_per_second(scene)
    if frames:  # Whole frames, evenly from the first to the last.
        span = max(0, scene.frame_end - scene.frame_start)
        moments = [round(round(i * span / (frames - 1)) / fps, 6) for i in range(frames)]
    else:  # One moment: `t`, or the scene's current frame (as the full build's views show it).
        moments = [float(t) if t is not None else None]
    if view != "camera":  # Framed on everything the moments show, so a strip keeps one framing.
        boxes = []
        for moment in moments:
            if moment is not None:
                set_time(scene, moment)
            boxes.append(scene_bounds(scene))
        low = Vector(np.min([tuple(box[0]) for box in boxes], axis=0))
        high = Vector(np.max([tuple(box[1]) for box in boxes], axis=0))
    # STEVE's neutral light and world for every look but the scene's own (rendered) through its own camera.
    inspection = None if view == "camera" and shading == "rendered" else Inspection(scene)
    if view == "camera":
        scene.camera = camera
        if inspection is not None:  # The headlight comes from the camera.
            inspection.sun.matrix_world = Matrix.Translation(camera.matrix_world.translation) @ camera.matrix_world.to_quaternion().to_matrix().to_4x4()
    shade(scene, shading, inspection)
    if frames:
        columns = 4
        width, height = picture_size(scene, view, STRIP_WIDTH // columns)
        if scene.render.engine == "CYCLES":
            scene.cycles.samples = min(scene.cycles.samples, 16)
    else:
        columns = 1
        width, height = picture_size(scene, view, CAMERA_LONGEST if view == "camera" else max(WIDTH, HEIGHT))
    still(scene, width, height)
    if view != "camera":
        inspection.aim(view, low, high, width, height)
    cells = []
    for index, moment in enumerate(moments):
        progress("views", index, len(moments))
        if moment is None:
            frame = scene.frame_current
            moment = round((frame - scene.frame_start) / fps, 4)
        else:
            frame = set_time(scene, moment)
        scene.render.filepath = str(Path(f"cell-{index}.png").resolve())
        bpy.ops.render.render(write_still=True)
        cells.append({"frame": frame, "t": moment})
    out = Path(f"view-{view}.png").resolve()
    if len(cells) == 1:
        Path("cell-0.png").replace(out)
    else:
        sheet([Path(f"cell-{index}.png") for index in range(len(cells))], columns, width, height, out)
    return {"view": view, "shading": shading, "engine": scene.render.engine.lower(), "size": [width, height],
            "camera": camera.name if view == "camera" else None, "fps": round(fps, 4),
            "frame_range": [scene.frame_start, scene.frame_end],
            **({"cells": cells, "columns": columns} if frames else {"frame": cells[0]["frame"], "t": cells[0]["t"]}),
            **({"extent_mm": [*rounded(low), *rounded(high)]} if view != "camera" else {})}


def sheet(paths, columns, width, height, out):
    """The pictures `paths` (each width × height) as one, row by row, `columns` across, a thin light gap between them."""
    gap = 4
    rows = math.ceil(len(paths) / columns)
    canvas = np.ones(((height + gap) * rows - gap, (width + gap) * columns - gap, 4), dtype=np.float32)
    canvas[..., :3] = 0.85
    for index, path in enumerate(paths):
        image = bpy.data.images.load(str(path.resolve()))
        pixels = np.empty(width * height * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        bpy.data.images.remove(image)
        row, column = divmod(index, columns)
        top = (rows - 1 - row) * (height + gap)  # Blender's pixels start at the bottom row.
        left = column * (width + gap)
        canvas[top:top + height, left:left + width] = pixels.reshape(height, width, 4)
    image = bpy.data.images.new("STEVE strip", canvas.shape[1], canvas.shape[0], alpha=False)
    image.pixels.foreach_set(canvas.ravel())
    image.filepath_raw, image.file_format = str(out), "PNG"
    image.save()


# -- The animation ----------------------------------------------------------------------------------------------------

def video_size(scene):
    """The video's size: the scene's (resolution × percentage), fitted inside MAX_VIDEO keeping its shape, even."""
    width, height = output_size(scene)
    scale = 1.0  # Local rendering respects the scene resolution; no SaaS video-size cap.
    return max(2, int(width * scale) // 2 * 2), max(2, int(height * scale) // 2 * 2)


def lasted(seconds):
    seconds = max(0.0, float(seconds))
    return f"{round(seconds)} s" if seconds < 120 else f"{round(seconds / 60)} min" if seconds < 7200 else f"{seconds / 3600:.1f} h"


def render_animation(scene, deadline):
    """animation.mp4: the scene's frames through its camera, at its frame rate, as Blender renders them (Cycles on the
    CPU, denoised; Workbench stays Workbench; EEVEE, which needs a GPU, becomes Cycles), at most MAX_VIDEO. Two frames
    are rendered first to time it: when the rest wouldn't fit in what's left of the budget, the build stops now
    (OverBudget) rather than running out of time."""
    stage("render")
    frames = list(range(scene.frame_start, scene.frame_end + 1, max(1, scene.frame_step)))
    if scene.render.engine == "CYCLES":
        scene.cycles.device = "CPU"  # Its own samples and denoising, as the document set them.
    elif scene.render.engine != "BLENDER_WORKBENCH":
        cycles(scene, DEFAULT_SAMPLES)
    width, height = video_size(scene)
    render = scene.render
    render.resolution_x, render.resolution_y, render.resolution_percentage = width, height, 100
    render.film_transparent = False
    render.use_persistent_data = True
    render.image_settings.file_format, render.image_settings.color_mode = "PNG", "RGB"
    timed = []
    for frame in sorted({frames[0], frames[len(frames) // 2]}):
        progress("render", 0, len(frames))
        scene.frame_set(frame)
        render.filepath = str(Path("timing.png").resolve())
        clock = time.monotonic()
        bpy.ops.render.render(write_still=True)
        timed.append(time.monotonic() - clock)
    per_frame = max(timed)
    estimate = per_frame * len(frames) * 1.1 + 10
    left = deadline - time.monotonic()
    if estimate > left:
        raise OverBudget(
            f"Rendering this scene's animation would take about {lasted(estimate)} ({len(frames)} frames at about "
            f"{lasted(per_frame)} each, {width}×{height}, from its first frames), more than the {lasted(max(left, 0))} its "
            "build has left, so it stopped here instead of running out of time. Render fewer frames (scene.frame_end, or "
            "scene.frame_step), a smaller picture (scene.render.resolution_percentage) or fewer samples "
            "(scene.cycles.samples), or simplify the scene; then generate again.", round(estimate))
    render.image_settings.file_format = "FFMPEG"
    ffmpeg = render.ffmpeg
    ffmpeg.format, ffmpeg.codec, ffmpeg.audio_codec = "MPEG4", "H264", "NONE"
    ffmpeg.constant_rate_factor, ffmpeg.ffmpeg_preset = "HIGH", "GOOD"
    ffmpeg.gopsize = max(1, round(frames_per_second(scene)))
    render.filepath = str(Path("animation.mp4").resolve())
    render.use_file_extension = False
    done = []

    def frame_done(*_):
        done.append(1)
        progress("render", len(done), len(frames))
    bpy.app.handlers.render_post.append(frame_done)
    clock = time.monotonic()
    try:
        bpy.ops.render.render(animation=True)
    finally:
        bpy.app.handlers.render_post.remove(frame_done)
    if not Path("animation.mp4").is_file():
        raise DocumentError("Blender wrote no video for the animation.")
    faststart(Path("animation.mp4"))
    return {"file": "animation.mp4", "frames": len(frames), "frame_start": scene.frame_start, "frame_end": scene.frame_end,
            "fps": round(frames_per_second(scene), 4), "seconds": round(len(frames) * max(1, scene.frame_step) / frames_per_second(scene), 3),
            "size": [width, height], "engine": render.engine.lower(),
            **({"samples": scene.cycles.samples} if render.engine == "CYCLES" else {}),
            "render_s": round(time.monotonic() - clock, 1), "estimate_s": round(estimate)}


CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"dinf", b"udta"}


def mp4_boxes(read, start, end):
    """(type, start, header size, size) of each box from `start` to `end` (ISO BMFF), `read(offset, count)` reading."""
    while start + 8 <= end:
        size, kind = struct.unpack(">I4s", read(start, 8))
        header = 8
        if size == 1:
            size, header = struct.unpack(">Q", read(start + 8, 8))[0], 16
        elif size == 0:
            size = end - start
        if size < header or start + size > end:
            raise ValueError("A box runs past its parent.")
        yield kind, start, header, size
        start += size


def faststart(path):
    """Moves the video's index (moov) before its frames (mdat), shifting its chunk offsets, so a browser starts playing
    while the rest loads. Left as Blender wrote it when it is already so, or the offsets wouldn't fit."""
    with open(path, "rb") as handle:
        def read(offset, count):
            handle.seek(offset)
            return handle.read(count)
        total = path.stat().st_size
        top = list(mp4_boxes(read, 0, total))
        kinds = [kind for kind, *_ in top]
        if b"moov" not in kinds or b"mdat" not in kinds or kinds.index(b"moov") < kinds.index(b"mdat"):
            return
        _, start, _, size = top[kinds.index(b"moov")]
        moov = bytearray(read(start, size))

    def shift(begin, end):
        for kind, at, header, length in mp4_boxes(lambda offset, count: bytes(moov[offset:offset + count]), begin, end):
            if kind in CONTAINERS:
                shift(at + header, at + length)
            elif kind in (b"stco", b"co64"):
                count = struct.unpack_from(">I", moov, at + header + 4)[0]
                width, code = (4, ">I") if kind == b"stco" else (8, ">Q")
                for index in range(count):
                    place = at + header + 8 + index * width
                    value = struct.unpack_from(code, moov, place)[0] + size
                    if width == 4 and value >= 2 ** 32:
                        raise OverflowError
                    struct.pack_into(code, moov, place, value)
    try:
        shift(8, len(moov))
    except (OverflowError, ValueError, struct.error):
        return
    moved = path.with_name(path.name + ".faststart")
    with open(path, "rb") as source, open(moved, "wb") as out:
        first_data = kinds.index(b"mdat")
        for kind, at, _, length in top[:first_data]:
            source.seek(at)
            out.write(source.read(length))
        out.write(moov)
        for kind, at, _, length in top[first_data:]:
            if kind == b"moov":
                continue
            source.seek(at)
            remaining = length
            while remaining:
                chunk = source.read(min(remaining, 1 << 20))
                out.write(chunk)
                remaining -= len(chunk)
    moved.replace(path)


def wants_video(scene, animated):
    """The rule (steve-blender skill, "Animation"): a video when the scene has a camera (scene.camera), more than one
    frame (frame_end > frame_start) and something animated (key frames or drivers on any object, its data, a material,
    the world, a node group or the scene)."""
    return scene.camera is not None and scene.frame_end > scene.frame_start and bool(animated)


# -- The build --------------------------------------------------------------------------------------------------------

def build(mode, timeout):
    started = time.perf_counter()
    deadline = STARTED + timeout - RESERVE_S if timeout else math.inf
    request = json.loads(Path("request.json").read_bytes())
    Path("request.json").unlink()
    if not isinstance(request, dict) or request.get("kind") != "blender":
        raise DocumentError("The Blender kernel builds Blender documents (kind \"blender\") only.")
    if mode not in ("preview", "full", "views", "render", "save"):
        raise DocumentError(f"A Blender document builds as a preview or in full, or renders a view, not {mode!r}.")
    if mode == "views" and not isinstance(request.get("look"), dict):
        raise DocumentError("A view needs a look request.")
    code = write_sources(request)
    empty_scene()
    links = install_links(request)
    timings = {}
    clock = time.perf_counter()
    stage("main")
    progress("main")
    run_document(code)
    remove_templates(links)
    timings["main"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    scene = bpy.context.scene
    scene.frame_set(scene.frame_current)  # Everything as the animation has it at the scene's current frame, as renders show.
    if mode == "render":
        if scene.camera is None:
            raise DocumentError("Add a camera and assign scene.camera before rendering the camera view.")
        stage("render")
        progress("render")
        if scene.render.engine in EEVEE:
            cycles(scene, scene.cycles.samples)
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = str(Path("view-camera.png").resolve())
        bpy.ops.render.render(write_still=True)
        return {"kind": "blender", "drawn": {"view": "camera"}, "timings_ms": {"render": round((time.perf_counter()-clock)*1000)}}
    if mode == "views":
        stage("views")
        drawn = look(scene, request["look"])
        return {"kind": "blender", "drawn": drawn, "timings_ms": {"main": timings["main"], "look": round((time.perf_counter() - clock) * 1000)}}
    stage("measure")
    metadata, (low, high), measured = measure_scene()
    facts, details, animated = scene_record(scene, measured)
    warnings = metadata.pop("warnings", []) + scene_warnings(scene, animated)
    timings["measure"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    export_preview(scene, animated)
    timings["glb"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    views, video = [], None
    if mode in ("full", "save"):
        save_blend()
        timings["blend"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    if mode == "full":
        camera = scene.camera  # The inspection views use their own camera, world and settings: the scene's come back.
        world, engine, view_transform = scene.world, scene.render.engine, scene.view_settings.view_transform
        look_name, samples, denoise = scene.view_settings.look, scene.cycles.samples, scene.cycles.use_denoising
        resolution = (scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage)
        stage("views")
        progress("views")
        render_views(scene, low, high)
        views = list(VIEWS)
        timings["views"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
        if wants_video(scene, animated):
            for name in ("STEVE inspection camera", "STEVE inspection sun"):
                bpy.data.objects.remove(bpy.data.objects[name], do_unlink=True)
            scene.camera, scene.world, scene.render.engine = camera, world, engine
            scene.view_settings.view_transform, scene.view_settings.look = view_transform, look_name
            scene.cycles.samples, scene.cycles.use_denoising = samples, denoise
            scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = resolution
            video = render_animation(scene, deadline)
            timings["video"] = round((time.perf_counter() - clock) * 1000)
    timings["build"] = round((time.perf_counter() - started) * 1000)
    return {"kind": "blender", "blender_version": bpy.app.version_string, **metadata,
            **({"warnings": warnings} if warnings else {}), "scene": facts, "object_details": details,
            "inspection_views": {"available": views}, **({"animation": video} if video else {}), "timings_ms": timings}


def main():
    try:
        arguments = sys.argv[sys.argv.index("--") + 1:]
        timeout = int(arguments[1]) if len(arguments) > 1 else 14400
        metadata = build(arguments[0], timeout)
        Path("result.json").write_text(json.dumps({"ok": True, "metadata": metadata}, allow_nan=False, separators=(",", ":")))
    except BaseException as exc:  # noqa: BLE001  Everything becomes a build error, said once.
        error = str(exc) if isinstance(exc, DocumentError) else traceback.format_exc()
        print(error, file=sys.stderr, flush=True)
        reason = "memory" if isinstance(exc, MemoryError) else "time" if isinstance(exc, OverBudget) else None
        Path("result.json").write_text(json.dumps({"ok": False, "error": error[-12000:], "reason": reason,
                                                   **({"estimate_s": exc.estimate_s} if isinstance(exc, OverBudget) else {})}))
        sys.stdout.flush()
        sys.stderr.flush()
        import os
        os._exit(1)


if __name__ == "__main__":
    main()
