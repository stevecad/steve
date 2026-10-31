"""Runs only inside the geometry sandbox (a kernel job child, or a one-shot runtime container)."""
import json
import math
import importlib
import os
import re
import signal
import struct
import sys
import time
import traceback
from array import array
from pathlib import Path
from steve.reporting import surface_area, volume_properties

STARTED = time.monotonic()

SURFACES = {"Plane": "plane", "Cylinder": "cylinder", "Cone": "cone", "Sphere": "sphere", "Torus": "torus", "BSplineSurface": "bspline",
            "BezierSurface": "bezier", "SurfaceOfRevolution": "revolution", "SurfaceOfExtrusion": "extrusion", "OffsetSurface": "offset"}
CURVES = {"Line": "line", "Circle": "circle", "Ellipse": "ellipse", "BSplineCurve": "bspline", "BezierCurve": "bezier"}
# GLB tessellation (linear mm, angular rad): the viewer's model, the same in previews and full builds. A full build's
# was finer (0.05 mm, 0.1 rad): on 69 real designs that made its model 1.9x the preview's (up to 3.2x, about 3x the
# triangles) for a view people already see at the preview's detail after every save. Exports (STEP, print meshes)
# keep their own exact tolerances.
TESSELLATION = {"full": (0.1, 0.2), "preview": (0.1, 0.2)}
# The viewer's model (preview.glb) stays one every browser loads, a phone's too (a 250 MB model failed on an
# iPhone): past this size it is meshed again coarser, a step at a time (PREVIEW_STEPS), never failing the build. 64 MB
# is still a few million triangles. Exports (STEP, print meshes) keep their exact tolerances.
PREVIEW_BUDGET = 64 * 1024 * 1024
PREVIEW_STEPS = [(0.1, 0.2), (0.25, 0.35), (0.5, 0.5), (1.0, 0.7)]


def export_preview(assembly, tessellation: str) -> list[float]:
    """preview.glb at the tessellation's tolerances, or coarser while it is over PREVIEW_BUDGET: the same geometry always
    comes out at the same step, so the topology job (topology_job) meshes it as the build did. Returns the tolerances
    used (mm, rad)."""
    from OCP.BRepTools import BRepTools
    steps = [TESSELLATION[tessellation]] + [step for step in PREVIEW_STEPS if step[0] > TESSELLATION[tessellation][0]]
    for index, (tolerance, angular_tolerance) in enumerate(steps):
        if index:
            # A shape keeps a finer mesh rather than coarsen it: drop the last one before meshing again.
            BRepTools.Clean_s(assembly.toCompound().wrapped)   # the parts' shapes themselves (instances share them)
            print(f"Warning: the viewer's model was {Path('preview.glb').stat().st_size // (1024 * 1024)} MB at "
                  f"{steps[index - 1][0]} mm: meshed again at {tolerance} mm so a browser can load it.", file=sys.stderr)
        assembly.export("preview.glb", tolerance=tolerance, angularTolerance=angular_tolerance)
        if Path("preview.glb").stat().st_size <= PREVIEW_BUDGET:
            break
    return [tolerance, angular_tolerance]


def topology_cache(tessellation: str, used: list[float]) -> str | None:
    """The tessellation whose cached component topology fits the viewer's model, or None when export_preview meshed it
    coarser: a cached topology's edges are the mesh's own nodes (write_topology polyline), so one described at the
    mode's tolerances would sit off a coarser mesh. Such a model's components are described afresh, and not cached."""
    return tessellation if list(TESSELLATION[tessellation]) == list(used) else None
STAGE = "STEVE stage: "
# Seconds a preview build's topology may take at most; full builds use what's left of their time limit.
PREVIEW_TOPOLOGY_CAP = 30


# The stages a build's progress names (steve.progress; app/kernel_protocol.py PROGRESS_STAGES) for the steps above.
PROGRESS = {"sheet-metal export": "sheet_metal", "STEP export": "step_export", "drawings": "drawings", "preview mesh": "meshes",
            "topology": "meshes", "print mesh": "meshes"}


def stage(text):
    """Notes in build.log which step runs next, so a native crash (no result.json) can say where it happened
    (app/worker.py crash_error), and tells the person waiting (steve.progress)."""
    print(STAGE + text, file=sys.stderr, flush=True)
    if text in PROGRESS:
        from steve import progress
        progress.stage(PROGRESS[text])


def enable_old_ocp_names():
    """Designs written for OCP 7 keep working: cadquery.occ_compat puts back the names OCP 8 renamed or dropped
    (TopoDS.Face_s, TColStd_Array1OfReal, BRepTopAdaptor_FClass2d, Bnd_Box.Get() ...), and parametricCurve and imprint keep
    CadQuery 2.8's defaults, and a build's selections and booleans give the same shapes in the same order every time
    (keep_selection_order, keep_booleans_serial). Idempotent; the compat layer only adds names, and Steve's own code
    uses OCP 8's names and never relies on it. The kernel calls it once before forking jobs."""
    from cadquery import occ_compat
    occ_compat.enable()
    keep_parametric_curve_smoothing()
    keep_imprint_glue()
    keep_selection_order()
    keep_booleans_serial()


def keep_booleans_serial():
    """CadQuery's booleans run serially in builds, as Steve's own do (steve.model: _boolean, _fuse_all). The
    fork runs them on OCCT's thread pool (Shape.fuse/cut/intersect/split and the free functions' booleans), and a
    parallel boolean sometimes built the same geometry with its faces and edges in another order, or changed its
    inputs' tolerances differently, from one build to the next: a different print mesh and G-code for the same part.
    Kernels get two CPUs per job, so little speed is lost: on two CPUs, 130 printed parts built 5.6% slower in all, the
    slowest single part 29%. Code that asks for parallel=True gets it. Idempotent."""
    from cadquery.occ_impl import shapes
    method = shapes.Shape._bool_op
    if getattr(method, "_steve_serial", False):
        return

    def _bool_op(self, args, tools, op, parallel=False):
        return method(self, args, tools, op, parallel)

    function = shapes._bool_op

    def bool_op(s1, s2, builder, tol=0.0, parallel=False):
        return function(s1, s2, builder, tol, parallel)

    options = shapes._set_builder_options

    def set_builder_options(builder, tol):
        options(builder, tol)
        builder.SetRunParallel(False)

    for patched, fork in ((_bool_op, method), (bool_op, function), (set_builder_options, options)):
        patched.__doc__, patched.__qualname__, patched.__module__ = fork.__doc__, fork.__qualname__, fork.__module__
        patched._steve_serial = True
    shapes.Shape._bool_op, shapes._bool_op, shapes._set_builder_options = _bool_op, bool_op, set_builder_options


def keep_selection_order():
    """CadQuery's selections that combine others ("not |Z", "|X and >Z", "%LINE or %CIRCLE", selector `-`/`&`/`+`,
    Workplane.ancestors and siblings, Shape.siblings, a compound's `&`/`|`/`%`) hold the same shapes in the same order
    in every build. The fork builds them as Python sets, and a shape's hash is its TShape's address, so they
    came out in a different order in each process; a fillet or chamfer on those edges then built the same geometry
    with its faces and edges in another order, and so a different print mesh and G-code. Now: in the order of the list
    they were picked from ("or": the left side's, then the right side's), or of the context solid's own map of its
    sub-shapes (TopExp, fixed by the B-rep). Which shapes are selected doesn't change. Idempotent."""
    import cadquery as cq
    from cadquery import selectors
    from cadquery.occ_impl import shapes
    if getattr(selectors.AndSelector.filterResults, "_steve_ordered", False):
        return

    def ordered(function):
        function._steve_ordered = True
        return function

    @ordered
    def and_results(self, r_left, r_right):
        right = set(r_right)
        return list(dict.fromkeys(o for o in r_left if o in right))

    @ordered
    def sum_results(self, r_left, r_right):
        return list(dict.fromkeys(list(r_left) + list(r_right)))

    @ordered
    def subtract_results(self, r_left, r_right):
        right = set(r_right)
        return list(dict.fromkeys(o for o in r_left if o not in right))

    selectors.AndSelector.filterResults = and_results
    selectors.SumSelector.filterResults = sum_results
    selectors.SubtractSelector.filterResults = subtract_results  # InverseSelector ("not") subtracts too.

    def in_context(found, ctx):
        """`found` (sub-shapes of `ctx`) in ctx's own order, each kind in TopExp's indexed map of it; a shape that
        isn't in ctx (none should be) last, in the order given."""
        position: dict = {}
        for kind in dict.fromkeys(shape.ShapeType() for shape in found):
            for i, sub in enumerate(ctx._entities(kind)):
                position.setdefault(cq.Shape.cast(sub), (len(position), i))
        return sorted(found, key=lambda shape: position.get(shape, (len(position), 0)))

    def compound_siblings(fork):
        @ordered
        def siblings(self, ctx, kind, level=1):
            return cq.Compound.makeCompound(in_context(list(fork(self, ctx, kind, level)), ctx))
        siblings.__doc__, siblings.__qualname__ = fork.__doc__, fork.__qualname__
        return siblings

    shapes.Shape.siblings = compound_siblings(shapes.Shape.siblings)
    shapes.Compound.siblings = compound_siblings(shapes.Compound.siblings)

    workplane_ancestors, workplane_siblings = cq.Workplane.ancestors, cq.Workplane.siblings

    @ordered
    def ancestors(self, kind, tag=None):
        found = workplane_ancestors(self, kind, tag)
        return self.newObject(in_context(list(found.objects), self.findSolid()))

    @ordered
    def siblings(self, kind, level=1, tag=None):
        found = workplane_siblings(self, kind, level, tag)
        return self.newObject(in_context(list(found.objects), self.findSolid()))

    ancestors.__doc__, siblings.__doc__ = workplane_ancestors.__doc__, workplane_siblings.__doc__
    cq.Workplane.ancestors, cq.Workplane.siblings = ancestors, siblings

    def members(shape):
        return list(shape) if isinstance(shape, cq.Compound) else [shape]

    @ordered
    def both(self, other):
        right = set(members(other))
        return shapes.compound(*dict.fromkeys(s for s in members(self) if s in right))

    @ordered
    def either(self, other):
        return shapes.compound(*dict.fromkeys(members(self) + members(other)))

    @ordered
    def without(self, other):
        right = set(members(other))
        return shapes.compound(*dict.fromkeys(s for s in members(self) if s not in right))

    both.__doc__, either.__doc__, without.__doc__ = (shapes.Shape.__and__.__doc__, shapes.Shape.__or__.__doc__,
                                                     shapes.Shape.__mod__.__doc__)
    shapes.Shape.__and__, shapes.Shape.__or__, shapes.Shape.__mod__ = both, either, without


_ENGINE = None
GITHUB_REPO = re.compile(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")


def engine_info():
    """Where the running CadQuery and OCP come from, for the app's credits (Settings → About, the status bar):
    cadquery_source is the repository and commit pip installed CadQuery from (its direct_url.json, PEP 610; the
    runtime Dockerfile's pin), or None when CadQuery isn't a git install; ocp_version is cadquery-ocp's version, whose
    first three numbers are the OCCT release it wraps (8.0.1.1: OCCT 8.0.1). Once per process; a fresh copy each call."""
    global _ENGINE
    if _ENGINE is None:
        source = None
        try:
            from importlib import metadata
            direct = json.loads(metadata.distribution("cadquery").read_text("direct_url.json") or "null") or {}
            url = re.sub(r"\.git$", "", str(direct.get("url", "")).removeprefix("git+").rstrip("/"))
            commit = str((direct.get("vcs_info") or {}).get("commit_id", ""))
            if GITHUB_REPO.fullmatch(url) and re.fullmatch(r"[0-9a-f]{40}", commit):
                source = {"url": url, "commit": commit}
        except Exception:
            source = None
        try:
            import OCP
            ocp = str(OCP.__version__)
        except Exception:
            ocp = None
        _ENGINE = {"cadquery_source": source, "ocp_version": ocp,
                   "occt_version": ".".join(ocp.split(".")[:3]) if ocp else None}
    return json.loads(json.dumps(_ENGINE))


def keep_imprint_glue():
    """imprint keeps CadQuery 2.8's gluing when a design leaves glue out. The fork's (upstream CadQuery's) default
    became glue="partial" (OCCT's GlueShift); 2.8's cadquery.occ_impl.shapes.imprint (re-exported as
    cadquery.func.imprint) glued "full", and its cadquery.occ_impl.assembly.imprint connected the solids with no gluing
    option (BOPAlgo_MakeConnected), which glue=None reproduces on the fork's builder. Code that passes glue gets what
    it asks for. Nothing in CadQuery or Steve calls these; they are reachable from design code only. Idempotent."""
    import cadquery.func as func
    import cadquery.occ_impl.assembly as assembly
    import cadquery.occ_impl.shapes as shapes
    fork = shapes.imprint
    if not getattr(fork, "_steve_default_glue", False):
        def imprint(*shapes_, tol=0.0, glue="full", history=None, name=None):
            return fork(*shapes_, tol=tol, glue=glue, history=history, name=name)
        imprint.__doc__, imprint.__qualname__, imprint.__module__ = fork.__doc__, fork.__qualname__, fork.__module__
        imprint._steve_default_glue = True
        shapes.imprint = imprint
    if getattr(func, "imprint", None) is fork:
        func.imprint = shapes.imprint
    fork_assembly = assembly.imprint
    if not getattr(fork_assembly, "_steve_default_glue", False):
        def assembly_imprint(assy, tol=0.0, glue=None):
            return fork_assembly(assy, tol=tol, glue=glue)
        assembly_imprint.__doc__, assembly_imprint.__qualname__ = fork_assembly.__doc__, fork_assembly.__qualname__
        assembly_imprint.__module__ = fork_assembly.__module__
        assembly_imprint._steve_default_glue = True
        assembly.imprint = assembly_imprint


def keep_parametric_curve_smoothing():
    """Workplane.parametricCurve keeps CadQuery 2.8's default, smoothing=(1, 1, 1), so a design that leaves smoothing
    out draws the curve it always drew. Steve's CadQuery fork made None the default (tolerance-controlled
    approximation, closer to the sampled function): the same call would move the curve by up to about 1e-3 mm on
    ordinary profiles. Code that passes smoothing, None included, gets what it asks for. Idempotent."""
    import cadquery as cq
    fork = cq.Workplane.parametricCurve
    if getattr(fork, "_steve_default_smoothing", False):
        return

    def parametricCurve(self, func, N=400, start=0, stop=1, tol=1e-6, minDeg=1, maxDeg=6, smoothing=(1, 1, 1),
                        makeWire=True):
        return fork(self, func, N=N, start=start, stop=stop, tol=tol, minDeg=minDeg, maxDeg=maxDeg,
                    smoothing=smoothing, makeWire=makeWire)
    parametricCurve.__doc__ = (fork.__doc__ or "").replace("(default: None)", "(default: (1, 1, 1))")
    parametricCurve.__qualname__ = fork.__qualname__
    parametricCurve._steve_default_smoothing = True
    cq.Workplane.parametricCurve = parametricCurve


COMPAT_KEY = "occ_compat:"  # timings_ms keys counting the old OCP names a build's code used (compat_uses)


def compat_uses(request) -> dict:
    """{"occ_compat:<Owner.name>": count} for the old OCP names (occ_compat.restored()) the build's code refers to,
    plus calls of the restored Bnd_Box.Get() / Bnd_Box2d.Get(). Counts of those fixed names only: no code, nothing of
    the design's own. Never fails a build."""
    import ast
    try:
        from cadquery import occ_compat
        names = occ_compat.restored()
        if not names:
            return {}
        sources = [request.get("code") or "", *(request.get("files") or {}).values()]
        pending = [request.get("links") or {}]
        while pending:  # Linked documents' code (nested links too).
            for source in pending.pop().values():
                if isinstance(source, dict):
                    sources += [source.get("code") or "", *(source.get("files") or {}).values()]
                    pending.append(source.get("links") or {})
        counts = {}
        for text in sources:
            try:
                tree = ast.parse(text if isinstance(text, str) else "")
            except (SyntaxError, ValueError):
                continue
            for node in ast.walk(tree):
                keys = []
                if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("OCP."):
                    keys = [node.module.split(".")[-1] + "." + alias.name for alias in node.names]
                elif isinstance(node, ast.Attribute):
                    owner = node.value
                    owner = owner.id if isinstance(owner, ast.Name) else owner.attr if isinstance(owner, ast.Attribute) else None
                    keys = [f"{owner}.{node.attr}"] if owner else []
                for key in keys:
                    if names.get(key) not in (None, "patched"):
                        counts[COMPAT_KEY + key] = counts.get(COMPAT_KEY + key, 0) + 1
        for key, calls in occ_compat.calls().items():
            counts[COMPAT_KEY + key] = counts.get(COMPAT_KEY + key, 0) + calls
        return counts
    except Exception as exc:  # Telemetry only.
        print(f"Warning: old OCP names not counted: {exc!r}"[:300], file=sys.stderr)
        return {}


def _prepare(request) -> str:
    """Writes the document's source into the job's directory: main as model.py, a design's or shop's other files
    (params.py, components/*.py, tools/*.py) importable from it, its tables (holes.csv, beside main: data that
    steve.table reads, never imported), its logo images (logo.png beside main, as bytes: only a drawing's title block
    draws them), and its links at their pinned revisions (`from links import bolt`;
    steve.links). Returns main's code."""
    code = request["code"]
    Path("model.py").write_text(code)
    files = request.get("files") or {}
    for path, text in files.items():
        if re.fullmatch(r"[a-z][a-z0-9_]{0,63}\.csv", path):
            Path(path).write_text(text)
            continue
        if re.fullmatch(r"[a-z][a-z0-9_]{0,63}\.(?:png|jpe?g)", path):   # A logo image (steve/images.py), as its bytes.
            from steve import images
            images.write(path, text)
            continue
        if not re.fullmatch(r"(?:[a-z][a-z0-9_]{0,63}/){0,3}[a-z][a-z0-9_]{0,63}\.py", path) or path in {"model.py", "steve.py"}:
            raise ValueError(f"Invalid design file path {path!r}.")
        target = Path(path)
        for folder in reversed(target.parents[:-1]):
            folder.mkdir(exist_ok=True)
            (folder / "__init__.py").touch()
        target.write_text(text)
    links = request.get("links") or {}
    if links:
        from steve import links as linked
        linked.install(links)
    if files or links:
        sys.path.insert(0, os.getcwd())
        importlib.invalidate_caches()
    if request.get("imports"):  # Uploaded STEP files this code references; the kernel put them in ./imports.
        from steve import imports
        imports.register(request["imports"], Path("imports").resolve())
    if request.get("materials"):  # The person's own materials this code names (app/user_materials.py), beside the library.
        from steve import materials
        materials.register(request["materials"])
    return code


MAIN = "/work/model.py"   # The name main's code runs under (tracebacks show it), as a design's.
# What a shop's records may take of result.json (app/kernel_protocol.py MAX_JSON, 1 MiB), leaving room for the rest.
SHOP_RECORDS_LIMIT = 1024 * 1024 - 16 * 1024


def _shop_source(path: str, root: Path) -> str:
    """A shop item's source file as the document names it (main.py, tools/em6.py; a linked shop's under links/<alias>/),
    not the job directory's path."""
    if path == MAIN:
        return "main.py"
    try:
        relative = Path(path).resolve().relative_to(root)
    except (ValueError, OSError):
        return path
    parts = relative.parts
    if parts == ("model.py",):
        return "main.py"
    if len(parts) > 3 and parts[0] == ".linked":   # .linked/<alias>/v<n>/<file>
        return "/".join(("links", parts[1], *parts[3:]))
    return relative.as_posix()


def shop_build(request):
    """A shop document's build (runtime/steve/shop.py): runs main.py like a design's (its files and linked shops
    importable) and returns its `shop`'s items as library records, by kind. No geometry: the records are the result,
    applied to the manufacturing library on request (app/manufacturing/shop.py)."""
    clock = time.perf_counter()
    code = _prepare(request)
    from steve.shop import Shop
    namespace = {"__name__": "__main__", "__file__": MAIN}
    stage("shop")
    exec(compile(code, MAIN, "exec"), namespace)
    shop = namespace.get("shop")
    if not isinstance(shop, Shop):
        raise ValueError("A shop's main.py makes its shop as `shop = Shop()` (from steve.shop import Shop) and adds items to it.")
    root = Path.cwd().resolve()
    records = shop.records()
    for record in records:
        record["file"] = _shop_source(record["file"], root)
    size = len(json.dumps(records, separators=(",", ":"), allow_nan=False))
    if size > SHOP_RECORDS_LIMIT:
        raise ValueError(f"This shop's {len(records)} items come to {size:,} bytes of records, more than a build can return "
                         f"({SHOP_RECORDS_LIMIT:,}): split it into several shop documents and link them.")
    counts: dict[str, int] = {}
    for record in records:
        counts[record["kind"]] = counts.get(record["kind"], 0) + 1
    return {"kind": "shop", "records": records, "counts": counts,
            "timings_ms": {"execute": round((time.perf_counter() - clock) * 1000)}}


CAM_PROGRAM_LIMIT = 256 * 1024   # A program's source as the program store takes it (manufacturing/programs.py).


def cam_build(request):
    """A CAM document's build (runtime/steve/cam.py): runs main.py with its links (the part named, never built; the
    shop's items) and returns `program` as data, its shop items and part targets as references. No geometry: running
    the program is the server's (app/manufacturing/cam_documents.py)."""
    clock = time.perf_counter()
    code = _prepare(request)
    from steve.cam import data
    namespace = {"__name__": "__main__", "__file__": MAIN}
    stage("cam")
    exec(compile(code, MAIN, "exec"), namespace)
    program = namespace.get("program")
    if not isinstance(program, dict):
        raise ValueError("A CAM program's main.py makes `program = {...}` (api_reference(\"Program\")), naming its part and "
                         "shop items through its links: `from links import part, shop`.")
    program = data(program)
    size = len(json.dumps(program, separators=(",", ":"), allow_nan=False))
    if size > CAM_PROGRAM_LIMIT:
        raise ValueError(f"This program comes to {size:,} bytes, more than a program can hold ({CAM_PROGRAM_LIMIT:,}): split its "
                         "setups into several programs.")
    return {"kind": "cam", "program": program, "timings_ms": {"execute": round((time.perf_counter() - clock) * 1000)}}


CHECKS_RESERVE = 120  # s of a full build's time limit its motion checks leave to the exports at the least (else half of it)


def check_deadline(request) -> float | None:
    """When a design's motion, fastener and cable checks must be done by (steve.design._budget). A full build, which the
    person starts, shares its own time limit among them, leaving half of it (CHECKS_RESERVE at the least) to STEP, GLB,
    topology and drawings. None keeps 25 s per check: previews (made on every save) and the jobs derived from a build
    (topology, drawing, simulation, manufacturing, print meshes), which re-run the code but don't use its checks."""
    if request.get("mode", "full") != "full" or request.get("_final") is False:
        return None
    timeout = request.get("timeout", 120)
    return STARTED + timeout - max(timeout / 2, CHECKS_RESERVE)


def build(request):
    import cadquery as cq
    from steve import progress
    from steve.design import check_deadline as checks_by, reuse_checks

    progress.stage("main")
    code = _prepare(request)
    checks_by(check_deadline(request))
    reuse_checks(request)  # A design's motion and fit checks: an earlier build's results when nothing they depend on changed.
    if "steve.drawing" in sys.modules:  # A part's full build runs its code twice: only the last run's sheets count.
        sys.modules["steve.drawing"].SHEETS.clear()
    if "steve.model" in sys.modules:  # Likewise the part's own models (steve.model part_record): this run's.
        sys.modules["steve.model"]._MAIN_MODELS.clear()
    namespace = {"__name__": "__main__", "__file__": "/work/model.py"}
    enable_old_ocp_names()
    timings, clock = {}, time.perf_counter()
    exec(compile(code, "/work/model.py", "exec"), namespace)
    if "result" not in namespace:
        raise ValueError("Assign your final CadQuery part or assembly to a variable named 'result'.")
    result = namespace["result"]
    if getattr(result, "_steve_empty", False):
        return empty_build(request, timings, clock)

    if request["kind"] == "design":
        # main.py ends with `result = design.result()` (steve.Design), or builds its own cq.Assembly.
        if not isinstance(result, cq.Assembly):
            raise TypeError("A design's main.py must end with result = design.result() (a steve.Design) or a cq.Assembly.")
        assembly = result
        shape = assembly.toCompound()
        components = sum(1 for _ in assembly)
        if components == 0:
            raise ValueError("The assembly has no components.")
    else:
        if isinstance(result, cq.Assembly):
            raise TypeError("Part builds cannot return cq.Assembly. Use a design for several components.")
        if isinstance(result, cq.Workplane):
            values = result.vals()
            if not values or any(not isinstance(v, cq.Shape) for v in values):
                raise ValueError("The Workplane must contain solid geometry.")
            shape = values[0] if len(values) == 1 else cq.Compound.makeCompound(values)
        elif isinstance(result, cq.Shape):
            shape = result
        else:
            raise TypeError("Part builds require result to be a CadQuery Workplane or Shape.")
        # Modeling documents may hold several bodies on purpose (new-body features, copies, splits);
        # a plain CadQuery part must be one solid, which catches geometry that was meant to be fused.
        if len(shape.Solids()) != 1 and getattr(shape, "_steve_model", None) is None:
            raise ValueError("A part must contain one solid. Use a design for separate components.")
        components = 1
        assembly = cq.Assembly(shape, name="part", color=cq.Color(0.39, 0.72, 0.65))

    # Surface bodies (model.fill, model.boundary_surface) anywhere in the result. A part or design may hold only those:
    # it builds, with the model's warning, and is left out of meshes, mass, simulation and machining.
    surfaces = surface_bodies(result)
    if not shape.isValid() or not (shape.Solids() or (surfaces and shape.Faces())):
        broken = invalid_instances(assembly) if request["kind"] == "design" else []
        raise ValueError("The result must contain valid solid geometry." + (f" {'; '.join(broken)}." if broken else ""))
    simulation = None
    if request.get("simulation"):
        from steve.simulation import export_archive
        simulation = export_archive(result, instances=request.get("simulation_instances", []), pose=request.get("simulation_pose"))
    if request.get("manufacturing_curves"):
        from steve.manufacturing_curves import export_curves
        export_curves(result, request['manufacturing_curves'])
    if 'manufacturing_sheets' in request:
        from steve.manufacturing_sheets import export_sheets
        export_sheets(result, request['manufacturing_sheets'],
            root_source={key: request[key] for key in ('document_id','revision')},
            frozen_sha256=request['manufacturing_frozen_sha256'])
    if request.get("mode") == "simulation":
        if simulation is None:
            raise ValueError("Simulation mode requires the geometry export request.")
        return {"simulation_geometry": simulation, "cadquery_version": cq.__version__,
                "units": "mm", "solids": len(shape.Solids())}
    if request.get("_final") is False:
        # The first, uninstrumented run of a full part build (app/features/runtime.build) only provides the shape the
        # instrumented run is checked against: its exports would be overwritten, so it makes none.
        return {"replay": True}
    if request.get("mode") == "manufacturing":
        return manufacturing_facts(result, request, timings, clock)
    if request.get("mode") == "topology":
        return topology_job(assembly, request, timings, clock)
    if request.get("mode") == "print_mesh":
        return print_mesh_job(result, request, timings, clock)
    if request.get("mode") == "drawing":
        return drawing_job(shape, components, request, timings, clock)
    if request.get("mode") == "step":
        return step_job(assembly, shape, request, timings, clock)
    timings["execute"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    mode = request.get("mode", "full")
    from steve.sheetmetal.export import write_artifacts as sheet_metal_artifacts
    def sheet_viewer(flat_assembly):
        flat_assembly.export('sheet-metal-flat.glb', tolerance=TESSELLATION[mode][0], angularTolerance=TESSELLATION[mode][1])
        write_topology(flat_assembly, preview_path='sheet-metal-flat.glb', topology_path='sheet-metal-flat-topology.json')
    stage("sheet-metal export")
    sheet_metal = sheet_metal_artifacts(result, full=mode != "preview", source_sha256=request.get('_source_sha256'), viewer=sheet_viewer)
    # No STEP export here: the STEP file is made when something needs it (an export, a send, a download, the inspection
    # views, a circuit linked into a design), by a job of its own (mode "step", step_job; app/derivations.py).
    drawings = None
    if mode != "preview" and "steve.drawing" in sys.modules:
        # The code's Drawing sheets (steve.drawing): drawing.svg and drawings.zip. Optional, like the print meshes: a
        # drawing that can't be made says why in the metadata and never fails the build.
        stage("drawings")
        from steve.drawing import write_artifacts as drawing_artifacts
        drawings = drawing_artifacts(deadline=STARTED + request.get("timeout", 120) - 45, projections=bool(request.get("projections")))
    # Browser geometry is derived from the same result; assemblies stay unfused.
    if mode != "preview":
        timings["drawings"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    # Stage lines in previews too: a preview that runs out of time says where (none: still in the model's code).
    stage("preview mesh")
    preview_tessellation = export_preview(assembly, "preview" if mode == "preview" else "full")
    timings["glb"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    stage("topology")
    # Topology is an optional viewer aid. It never fails a build: a full build may use what's left of the job's own time
    # limit but never its last 30 s (the summary below needs them on large models); a preview stops after
    # PREVIEW_TOPOLOGY_CAP so it arrives soon and frees the preview kernel. Only when that runs out is what's described
    # kept, and the app completes it with a topology job (mode "topology", app/derivations.py), which runs the model again.
    topology = timed_topology(assembly, topology_cache("preview" if mode == "preview" else "full", preview_tessellation), request,
                              cap=PREVIEW_TOPOLOGY_CAP if mode == "preview" else None)
    timings["topology"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    # Manufacturing facts for inspect_model's checks are made on demand (mode "manufacturing", below), not in every
    # full build: they cost more than the rest of a build on large models and most builds are never checked.
    manufacturing = None
    stage("summary")
    # With surface bodies, volume, area and centre of mass are the solids' alone (a surface has none to weigh); the
    # surfaces are reported apart, with their area. Without them, measured exactly as before.
    hardware, left_out, others = split_hardware(assembly) if request["kind"] == "design" else (None, [], None)
    if hardware is None:
        xmin, ymin, zmin, xmax, ymax, zmax, volume, area, centre = measure(shape, solids_only=bool(surfaces))
    else:  # Components that aren't hardware (a fluid volume): in the extent, not in the volume, area or centre of mass.
        xmin, ymin, zmin, xmax, ymax, zmax = measure(others)[:6]
        volume, area, centre = 0.0, 0.0, None
        if hardware.Solids() or hardware.Faces():
            *box, volume, area, centre = measure(hardware, solids_only=bool(surfaces))
            xmin, ymin, zmin = min(xmin, box[0]), min(ymin, box[1]), min(zmin, box[2])
            xmax, ymax, zmax = max(xmax, box[3]), max(ymax, box[4]), max(zmax, box[5])
    timings["summary"] = round((time.perf_counter() - clock) * 1000)
    metadata = {
        "cadquery_version": cq.__version__,
        **({"simulation_geometry": simulation} if simulation else {}),
        **({"sheet_metal": sheet_metal} if sheet_metal else {}),
        **({"manufacturing": manufacturing} if manufacturing else {}),
        **({"drawings": drawings} if drawings else {}),
        "units": "mm",
        "components": components,
        "solids": len(shape.Solids()),
        "faces": len(shape.Faces()),
        "bounds_mm": [xmax - xmin, ymax - ymin, zmax - zmin],
        # Exact [xmin, ymin, zmin, xmax, ymax, zmax] (same algorithm as the print/simulation geometry checks).
        "extent_mm": [xmin, ymin, zmin, xmax, ymax, zmax],
        "volume_mm3": volume,
        "surface_area_mm2": area,
        "center_of_mass_mm": centre,
        **({"surface_bodies": surface_report(surfaces)} if surfaces else {}),
        **({"not_hardware": not_hardware_report(left_out)} if left_out else {}),
        "component_documents": component_documents(assembly),
        # The viewer's model's tolerances: coarser than the mode's past PREVIEW_BUDGET (export_preview).
        "tessellation": {"tolerance_mm": preview_tessellation[0], "angular_tolerance_rad": preview_tessellation[1]},
        "timings_ms": timings,  # This execution only; the kernel adds the job total.
        "topology": {"state": topology},  # complete | partial | missing: what the viewer can pick (faces, edges, vertices)
        **({"modeling": modeling} if (modeling := modeling_summary()) else {}),
    }
    if mode == "full" and request["kind"] == "part" and request.get("part_record"):
        write_part_record(result)
    return metadata


PART_RECORD = "part-geometry.json"  # app/kernel_protocol.py ARTIFACT_LIMITS


def write_part_record(result) -> None:
    """A full part build's geometry (steve.model Model._record): its bodies as BREP, names, history and sketches, for
    a later build of the same geometry with only its looks changed (steve.cachekeys part_key) to restore instead of
    running every feature again. Kept with this build only (app/worker.py part_geometry); never served. Optional:
    nothing is written for plain CadQuery, a part restored itself, or one that made several models, and a record that
    can't be made never fails the build."""
    try:
        from steve.model import recordable_part
    except ImportError:
        return
    model = getattr(result, "_steve_model", None)
    if not recordable_part(model):
        return
    stage("geometry record")
    try:
        record = json.dumps(model._record(), default=str, separators=(",", ":"))
        Path(PART_RECORD + ".tmp").write_text(record)
        Path(PART_RECORD + ".tmp").replace(PART_RECORD)
    except Exception as exc:  # noqa: BLE001  The next build of a recolour builds normally.
        Path(PART_RECORD + ".tmp").unlink(missing_ok=True)
        print(f"Warning: the part's geometry wasn't kept for faster look-only rebuilds: {type(exc).__name__}", file=sys.stderr)


def surface_bodies(result) -> list[dict]:
    """The result's surface bodies (steve.Model faces or open shells), per instance: [{"instance", "body", "area_mm2"}].
    Empty for plain CadQuery and for results with solids only."""
    try:
        from steve.model import is_surface
        from steve.simulation import _components
        found, per_model = [], {}  # A component placed many times is looked at once.
        for instance, model, location, _ in _components(result):
            if model is None:
                continue
            if id(model) not in per_model:
                per_model[id(model)] = [(body_id, round(surface_area(body), 4)) for body_id, body in (getattr(model, "bodies", None) or {}).items()
                                        if is_surface(body)]
            found += [{"instance": instance, "body": body_id, "area_mm2": area} for body_id, area in per_model[id(model)]]
        return found
    except ImportError:
        return []
    except Exception as exc:  # A design that can't be walked (its errors are reported elsewhere): measured as before.
        print(f"Warning: surface bodies not listed: {type(exc).__name__}", file=sys.stderr)
        return []


def surface_report(surfaces: list[dict]) -> dict:
    """The build summary's `surface_bodies`: what volume, mass and the centre of mass leave out, and why."""
    from steve.model import SURFACE_NOTE
    return {"count": len(surfaces), "area_mm2": round(sum(s["area_mm2"] for s in surfaces), 4),
            "bodies": surfaces[:200],
            "note": f"Volume, surface area and centre of mass are the solids' only; {SURFACE_NOTE}."}


def split_hardware(assembly):
    """A design's hardware and the rest: (its compound without the components that aren't hardware, placed as
    toCompound places them; the instances left out, by path; their compound), or (None, [], None) when everything is
    hardware (steve.design Component(..., hardware=False): a fluid volume or envelope)."""
    import cadquery as cq

    def not_hardware(shape) -> bool:
        return getattr(getattr(shape, "_steve_model", None), "hardware", True) is False

    if not any(not_hardware(shape) for _, node in assembly.traverse() for shape in node.shapes):
        return None, [], None
    left_out = []

    def walk(node, path: str):
        kept, dropped = [], []
        for shape in node.shapes:
            if not_hardware(shape):
                left_out.append(path or node.name)
                dropped.append(shape)
            else:
                kept.append(shape)
        for child in node.children:
            own, other = walk(child, f"{path}/{child.name}" if path else child.name)
            kept.append(own)
            dropped.append(other)
        return cq.Compound.makeCompound(kept).locate(node.loc), cq.Compound.makeCompound(dropped).locate(node.loc)

    hardware, others = walk(assembly, "")
    return hardware, left_out, others


def not_hardware_report(instances: list[str]) -> dict:
    """The build summary's `not_hardware`: the instances whose components aren't hardware, which volume, area and the
    centre of mass leave out, and why."""
    from steve.design import NOT_HARDWARE_NOTE
    return {"count": len(instances), "instances": instances[:200],
            "note": f"Volume, surface area and centre of mass are the hardware's only; {NOT_HARDWARE_NOTE}."}


def measure(shape, solids_only=False):
    """The summary's exact extent (xmin, ymin, zmin, xmax, ymax, zmax; the algorithm the print/simulation geometry checks
    use, independent of the GLB's triangles), volume, surface area and centre of mass. A solid placed several times (a
    linked part, a pattern, repeated vendor parts) is measured once and its results moved to each placement; only an
    extent under a rotation other than quarter turns is measured where the solid sits. Same results as measuring the
    whole compound, which on a large assembly redid every placement's integrals (the volume twice) and could outlast
    the time limit after everything else was done. `solids_only` (a result with surface bodies): volume, area and centre
    of mass are the solids' only, and None for the centre when there are none; the extent covers the surfaces too."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SOLID, TopAbs_VERTEX
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher

    def extent(item):
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(item, box, False, False)
        low, high = box.CornerMin(), box.CornerMax()
        return low.X(), low.Y(), low.Z(), high.X(), high.Y(), high.Z()

    def mass(item):
        volume, area = volume_properties(item), GProp_GProps()
        BRepGProp.SurfaceProperties_s(item, area)
        return volume.Mass(), volume.CentreOfMass(), surface_area(item)

    whole = shape.wrapped
    loose = not solids_only and any(TopExp_Explorer(whole, kind, outside).More()
                for kind, outside in ((TopAbs_FACE, TopAbs_SOLID), (TopAbs_EDGE, TopAbs_FACE), (TopAbs_VERTEX, TopAbs_EDGE)))
    if loose:  # Faces, edges or vertices outside any solid: measured with the whole shape, as they always were.
        volume, centre, area = mass(whole)
        return (*extent(whole), volume, area, point_list(centre))
    definitions, measured = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher(), {}
    low, high = [math.inf] * 3, [-math.inf] * 3
    volume = area = 0.0
    moment = [0.0, 0.0, 0.0]
    explorer = TopExp_Explorer(whole, TopAbs_SOLID)
    while explorer.More():
        solid = explorer.Current()  # Carries its placement (every enclosing location, composed).
        explorer.Next()
        trsf = solid.Location().Transformation()
        if abs(trsf.ScaleFactor() - 1) > 1e-12 or trsf.IsNegative():  # Scaled or mirrored: measured where it sits.
            v, c, a = mass(solid)
            box = extent(solid)
        else:
            base = solid.Located(TopLoc_Location())
            key = (definitions.Add(base), int(solid.Orientation()))
            if key not in measured:
                measured[key] = (*mass(base), extent(base))
            v, c, a, box = measured[key]
            c = c.Transformed(trsf)
            matrix = [trsf.Value(row, col) for row in range(1, 4) for col in range(1, 4)]
            if all(min(abs(value), abs(abs(value) - 1)) < 1e-12 for value in matrix):  # Quarter turns: the box moves exactly.
                points = [gp_Pnt(x, y, z).Transformed(trsf) for x in (box[0], box[3]) for y in (box[1], box[4]) for z in (box[2], box[5])]
                box = (min(p.X() for p in points), min(p.Y() for p in points), min(p.Z() for p in points),
                       max(p.X() for p in points), max(p.Y() for p in points), max(p.Z() for p in points))
            else:
                box = extent(solid)
        volume, area = volume + v, area + a
        moment = [moment[0] + v * c.X(), moment[1] + v * c.Y(), moment[2] + v * c.Z()]
        low = [min(low[i], box[i]) for i in range(3)]
        high = [max(high[i], box[i + 3]) for i in range(3)]
    if solids_only:  # The extent still takes in the faces outside any solid (surface bodies); nothing else does.
        if not TopExp_Explorer(whole, TopAbs_SOLID).More():  # Surfaces only: no volume, area or centre of mass.
            return (*extent(whole), 0.0, 0.0, None)
        faces = TopExp_Explorer(whole, TopAbs_FACE, TopAbs_SOLID)
        while faces.More():
            box = extent(faces.Current())
            faces.Next()
            low = [min(low[i], box[i]) for i in range(3)]
            high = [max(high[i], box[i + 3]) for i in range(3)]
    if abs(volume) < 1e-12:  # No volume to weigh by: the whole shape's own centre, as before.
        centre = point_list(mass(whole)[1])
    else:
        centre = [value / volume for value in moment]
    return (*low, *high, volume, area, centre)


def point_list(point):
    return [point.X(), point.Y(), point.Z()]


def topology_budget(request, reserve: float = 30, cap: float | None = None) -> float:
    """Seconds topology may use: what's left of the job's time limit minus `reserve`, and at most `cap` if given."""
    budget = request.get("timeout", 120) - reserve - (time.monotonic() - STARTED)
    return max(0.01, budget if cap is None else min(cap, budget))


def timed_topology(assembly, tessellation: str | None, request, reserve: float = 30, cap: float | None = None, why: dict | None = None,
                   remesh_unaligned: bool = False) -> str:
    """Writes topology.json within the job's time limit, never into its last `reserve` seconds nor for longer than
    `cap`: its state, "complete", "partial" (out of time, the bodies described so far) or "missing". When missing,
    `why["reason"]` says why: "time", "size" or "error" (fixed words, never the exception's text), and `why["stage"]`
    the step of write_topology it stopped in (TOPOLOGY_STAGES), when it got that far."""
    global _TOPOLOGY_STAGE, _TOPOLOGY_MISMATCH
    _TOPOLOGY_STAGE, _TOPOLOGY_MISMATCH = None, {}
    signal.signal(signal.SIGALRM, expire)
    try:
        try:
            signal.setitimer(signal.ITIMER_REAL, topology_budget(request, reserve, cap))
            return write_topology(assembly, mode=tessellation, remesh_unaligned=remesh_unaligned) or "complete"
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
    except Exception as exc:
        Path("topology.json").unlink(missing_ok=True)
        print(f"Warning: topology.json skipped (faces and edges can't be picked in the viewer; the model and its exports are unaffected): {exc!r}"[:500], file=sys.stderr)
        if why is not None:
            why["reason"] = "time" if isinstance(exc, TimeoutError) else "size" if isinstance(exc, TopologyTooLarge) else "error"
            if _TOPOLOGY_STAGE in TOPOLOGY_STAGES:
                why["stage"] = _TOPOLOGY_STAGE
            if _TOPOLOGY_MISMATCH:   # Which check each unmatched mesh failed: fixed words and counts only.
                why["mismatch"] = dict(_TOPOLOGY_MISMATCH)
        return "missing"


def topology_job(assembly, request, timings, clock):
    """Mode "topology": a succeeded build's viewer topology, with the job's whole time limit (app/derivations.py). The
    preview mesh is exported again at the build's own tessellation (`topology_of`) and the topology describes it: the
    dispatcher keeps the topology alone when that mesh has the same parts and faces, in order and in place, as the
    build's (app/worker.py faces_differ), else both, so faces line up with what the viewer shows. A mesh that doesn't
    line up with its faces is written again from them (write_topology remesh_unaligned) rather than left out."""
    import cadquery as cq
    timings["execute"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    tessellation = "preview" if request.get("topology_of") == "preview" else "full"
    used = export_preview(assembly, tessellation)
    timings["glb"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    why = {}
    state = timed_topology(assembly, topology_cache(tessellation, used), request, reserve=15, why=why, remesh_unaligned=True)
    timings["topology"] = round((time.perf_counter() - clock) * 1000)
    return {"cadquery_version": cq.__version__, "topology": {"state": state, **why}, "timings_ms": timings}


def step_job(assembly, shape, request, timings, clock):
    """Mode "step": the build's STEP file, made when something needs it (app/derivations.py kind "step": an export, a
    send to another service, a download, the inspection views, a circuit board linked into a design) instead of in every
    full build. A design's STEP keeps its structure (one named node per instance) and comes with components-step.zip,
    one STEP per component (write_component_steps), which never fails the job and stops before the last 45 s of its
    time limit; a part's is one product with its bodies' material colours (export_part_step)."""
    import cadquery as cq
    timings["execute"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    for name in ("result.step", "components-step.zip"):
        Path(name).unlink(missing_ok=True)
    # As in a full build, where an assembly's export (cadquery toCAF) had turned OCCT's automatic shape naming off before
    # the STEP was written: unnamed products keep OCCT's default name, which app/step_names.py renames after the
    # document on download (with it on, a coloured part's product was called 'SOLID').
    from OCP.XCAFDoc import XCAFDoc_ShapeTool
    XCAFDoc_ShapeTool.SetAutoNaming_s(False)
    stage("STEP export")
    component_steps = None
    if request["kind"] == "design":
        assembly.export("result.step")
        try:
            component_steps = write_component_steps(assembly, deadline=STARTED + request.get("timeout", 120) - 45)
        except Exception as exc:
            Path("components-step.zip").unlink(missing_ok=True)
            print(f"Warning: components-step.zip skipped: {exc!r}"[:500], file=sys.stderr)
    else:
        export_part_step(shape, "result.step")
    timings["step"] = round((time.perf_counter() - clock) * 1000)
    return {"cadquery_version": cq.__version__, "step": {"components": len(component_steps or [])},
            **({"component_steps": component_steps} if component_steps else {}), "timings_ms": timings}


def manufacturing_facts(result, request, timings, clock):
    """Mode "manufacturing": the facts inspect_model's checks read (steve.manufacturing → manufacturing.json), made on
    demand for a succeeded build (app/derivations.py) instead of in every full build. Same 15-second analysis budget
    as when full builds made them (facts are marked partial when it runs out), so checks report what they did."""
    import cadquery as cq
    timings["execute"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    budget = min(15.0, request.get("timeout", 120) - 10 - (time.monotonic() - STARTED))
    if budget < 2:
        raise ValueError("Not enough time was left to analyse the model for manufacturing.")
    Path("manufacturing.json").unlink(missing_ok=True)
    from steve.manufacturing import write as write_manufacturing
    manufacturing = write_manufacturing(result, budget_s=budget)
    timings["manufacturing"] = round((time.perf_counter() - clock) * 1000)
    return {"cadquery_version": cq.__version__, "manufacturing": manufacturing, "timings_ms": timings}


def drawing_job(shape, components, request, timings, clock):
    """Mode "drawing": the code's drawing sheets only (drawing.svg, drawings.zip), for the Drawing tab's edits, which
    change the sheets and not the model: no sheet-metal export, STEP, meshes or topology. Feature dimensions resolve
    against the model's persistent names, which this one run already has. Views whose projection the earlier build of
    the same model kept (steve.drawing PROJECTIONS, when the dispatcher asks for it) aren't projected again."""
    import cadquery as cq
    timings["execute"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    drawings = None
    if "steve.drawing" in sys.modules:
        stage("drawings")
        from steve.drawing import write_artifacts as drawing_artifacts
        drawings = drawing_artifacts(deadline=STARTED + request.get("timeout", 120) - 45, projections=bool(request.get("projections")))
    timings["drawings"] = round((time.perf_counter() - clock) * 1000)
    return {"cadquery_version": cq.__version__, **({"drawings": drawings} if drawings else {}), "units": "mm",
            "components": components, "solids": len(shape.Solids()), "timings_ms": timings}


def invalid_instances(assembly, most: int = 8) -> list[str]:
    """Which of a design's instances make its geometry invalid: those whose shape isn't a valid solid, and those with no
    solid at all (only faces or edges). A design's whole compound is checked first; this names the parts to fix."""
    import cadquery as cq
    found, verdicts = [], {}  # Instances of one component share its shapes: each is checked once.
    for _, child in assembly.traverse():
        obj = child.obj
        shapes = [s for s in (obj.vals() if isinstance(obj, cq.Workplane) else [obj]) if isinstance(s, cq.Shape)]
        if not shapes:
            continue
        seen = verdicts.setdefault(tuple(s.hashCode() for s in shapes), [])
        verdict = next((v for others, v in seen if all(a.isSame(b) for a, b in zip(shapes, others))), False)
        if verdict is False:
            verdict = ("has no solid, only faces or edges" if not any(s.Solids() for s in shapes) else
                       "isn't a valid solid (often tangent, coincident or self-intersecting faces)"
                       if not all(s.isValid() for s in shapes) else None)
            seen.append((shapes, verdict))
        if verdict:
            found.append(f"instance {child.name!r} {verdict}")
    return found[:most] + ([f"and {len(found) - most} more"] if len(found) > most else [])


def empty_build(request, timings, clock):
    """A part or design with nothing modelled yet (no bodies; at most sketches or empty components): a normal
    result, not an error. CadQuery can't export an empty assembly, so the preview is written as a valid empty file; no
    STEP is made (the app offers none for an empty model, app/step_files.py). The summary still lists the document's
    components, sketches and features."""
    import cadquery as cq
    if request.get("mode") == "simulation":
        raise ValueError("There is no geometry to simulate yet: model a body first.")
    if request.get("mode") == "step":
        raise ValueError("Nothing is modelled yet, so there is no STEP file.")
    timings["execute"] = round((time.perf_counter() - clock) * 1000)
    scene = json.dumps({"asset": {"version": "2.0", "generator": "STEVE (empty model)"}, "scene": 0, "scenes": [{"nodes": []}]},
                       separators=(",", ":")).encode()
    scene += b" " * (-len(scene) % 4)
    if request.get("mode") != "drawing":  # A drawing build writes its sheets only (none: nothing to draw).
        Path("preview.glb").write_bytes(struct.pack("<4sII", b"glTF", 2, 20 + len(scene)) + struct.pack("<I4s", len(scene), b"JSON") + scene)
    return {
        "cadquery_version": cq.__version__,
        "empty": True,
        "units": "mm",
        "components": 0,
        "solids": 0,
        "faces": 0,
        "bounds_mm": [0, 0, 0],
        "volume_mm3": 0,
        "surface_area_mm2": 0,
        "component_documents": {},
        "timings_ms": timings,
        **({"modeling": modeling} if (modeling := modeling_summary()) else {}),
    }


def export_part_step(shape, path: str) -> None:
    """A part's STEP: one product, as cq.exporters.export writes it, plus each body's colour (its appearance's, else its
    material's: steve.materials.body_colors) on its solid, so the inspection views (screenshots.py) and other CAD tools
    show it, and faces with a colour of their own (`model.appearance(faces=...)`: face_colors) carry it over their body's.
    A part without colours (or plain CadQuery) is written by cq.exporters.export, as before."""
    import cadquery as cq
    from steve.materials import body_colors, face_colors
    model = getattr(shape, "_steve_model", None)
    colors = body_colors(model)
    faces = face_colors(model) if model is not None else []
    if not colors and not faces:
        cq.exporters.export(shape, path)
        return
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.STEPControl import STEPControl_AsIs
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFApp import XCAFApp_Application
    from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
    document = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    XCAFApp_Application.GetApplication_s().InitDocument(document)
    shapes, tool = XCAFDoc_DocumentTool.ShapeTool_s(document.Main()), XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    label = shapes.AddShape(shape.wrapped, False)  # A simple shape, not an assembly: the part stays one product.
    for body_id, rgb in colors.items():
        body = model.bodies[body_id]
        # Colours as cq.Color holds them, as the rest of the build's (a design's instances, circuit boards); opaque.
        target = label if body.wrapped.IsSame(shape.wrapped) else shapes.AddSubShape(label, body.wrapped)
        if not target.IsNull():
            tool.SetColor(target, cq.Color(*rgb, 1).wrapped, XCAFDoc_ColorSurf)
    for face, rgb in faces:
        target = shapes.AddSubShape(label, face.wrapped)
        if not target.IsNull():
            tool.SetColor(target, cq.Color(*rgb, 1).wrapped, XCAFDoc_ColorSurf)
    writer = STEPCAFControl_Writer()
    writer.SetColorMode(True)
    writer.SetNameMode(True)
    if not writer.Transfer(document, STEPControl_AsIs) or writer.Write(path) != IFSelect_RetDone:
        raise ValueError("The STEP export failed.")


def write_component_steps(assembly, deadline: float) -> list[dict] | None:
    """components-step.zip: a STEP per local component (in its own frame, each body a named solid), per linked
    document and, for a main.py that builds its own cq.Assembly, per top-level instance; manifest.json lists them.
    Keys: `component:<id>`, `link:<alias>`, `instance:<name>`. Components that aren't hardware (`Component(...,
    hardware=False)`) have none: they aren't parts (the design's STEP still has them)."""
    import zipfile
    import cadquery as cq
    from steve.design import Component, is_hardware
    design = getattr(assembly, "_steve_design", None)
    items = []  # (key, kind, id, name, shape or assembly)
    if design is not None:
        seen = set()
        for item in design.instances:
            part = item["component"]
            if not is_hardware(part):
                continue
            if isinstance(part, Component):
                if part.id in seen or not part.bodies:
                    continue
                seen.add(part.id)
                names, used = part.__dict__.get("body_names", {}), set()
                if len(part.bodies) == 1:
                    (body,) = part.bodies.values()
                    export = cq.Assembly(body, name=part.name)
                else:
                    export = cq.Assembly(name=part.name)
                    for body_id, body in part.bodies.items():
                        label = names.get(body_id) or body_id
                        label = label if label not in used else f"{label} ({body_id})"
                        used.add(label)
                        export.add(body, name=label)
                items.append((f"component:{part.id}", "component", part.id, part.name, export))
            elif (alias := getattr(part, "alias", None)) and f"link:{alias}" not in seen:
                seen.add(f"link:{alias}")
                result = part.result
                if not isinstance(result, cq.Assembly):
                    values = result.vals() if isinstance(result, cq.Workplane) else [result]
                    result = cq.Assembly(values[0] if len(values) == 1 else cq.Compound.makeCompound(values), name=part.name)
                items.append((f"link:{alias}", "link", alias, part.name, result))
    else:
        for child in assembly.children:
            items.append((f"instance:{child.name}", "instance", child.name, child.name, child))
    if not items:
        return None
    manifest = []
    with zipfile.ZipFile("components-step.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for index, (key, kind, ident, name, export) in enumerate(items):
            if time.monotonic() > deadline:
                print(f"Warning: components-step.zip stopped after {index} of {len(items)} for time.", file=sys.stderr)
                break
            path = Path(f"_component_{index}.step")
            if isinstance(export, cq.Assembly):
                if kind == "instance":  # A child keeps its placement in the parent; export it where it sits in its own frame.
                    export = cq.Assembly(export.obj, name=export.name, color=export.color) if export.obj is not None and not export.children else export
                export.export(str(path))
            else:
                cq.exporters.export(export, str(path))
            entry = f"{kind}s/{re.sub(r'[^A-Za-z0-9_.-]+', '_', ident)}.step"
            archive.write(path, entry)
            path.unlink()
            manifest.append({"key": key, "kind": kind, "id": ident, "name": name, "file": entry})
        archive.writestr("manifest.json", json.dumps({"version": 1, "items": manifest}, indent=1))
    if not manifest:
        Path("components-step.zip").unlink(missing_ok=True)
        return None
    return manifest


# The FFF pipeline's own tessellation (manufacturing/runtime/geometry.py), so a slicer gets the same mesh.
PRINT_TESSELLATION = (0.02, 0.1)  # mm, rad
# The 3MF/STL export's resolutions (app/derivations.py MESH_RESOLUTIONS): "fine" is the print-grade mesh everything else
# reads; the coarser ones are smaller files for large curved models. Never finer than fine.
MESH_RESOLUTIONS = {"fine": PRINT_TESSELLATION, "medium": (0.05, 0.2), "coarse": (0.1, 0.35)}


def print_mesh_job(result, request, timings, clock):
    """Mode "print_mesh": bodies-mesh.zip, made on demand for a succeeded full build (app/derivations.py) by the 3MF/STL
    export, the simulation model export and Manufacture, instead of in every full build. Print-grade meshes cost more
    memory than the rest of a build on large models, and most builds are never printed; a model whose meshes can't be
    made now fails only the export that asked for them, never its build. `mesh_resolution` (MESH_RESOLUTIONS, default
    "fine"): a coarser mesh for the export, recorded in the metadata so the dispatcher files it under that resolution."""
    import cadquery as cq
    resolution = request.get("mesh_resolution") or "fine"
    if resolution not in MESH_RESOLUTIONS:
        raise ValueError(f"Unknown mesh resolution {resolution!r}.")
    timings["execute"], clock = round((time.perf_counter() - clock) * 1000), time.perf_counter()
    Path("bodies-mesh.zip").unlink(missing_ok=True)
    stage("print mesh")
    body_meshes = write_body_meshes(result, deadline=STARTED + request.get("timeout", 120) - 10, tessellation=MESH_RESOLUTIONS[resolution])
    if not body_meshes:
        raise ValueError("This model has no bodies to mesh.")
    timings["print_mesh"] = round((time.perf_counter() - clock) * 1000)
    return {"cadquery_version": cq.__version__, "body_meshes": body_meshes, "mesh_resolution": resolution, "mesher": PRINT_MESHER,
            "timings_ms": timings}


def write_body_meshes(result, deadline: float, tessellation=PRINT_TESSELLATION) -> list[dict] | None:
    """bodies-mesh.zip: a binary STL per body where it sits as modelled (the design frame, every joint at 0),
    named and keyed like the print/simulation geometry: `instance` ("part" for a part) and `body`.
    manifest.json lists them with their exact extent and `placement`, the instance's 3×4 [R|t] (mm) that put the
    body there (3MF build items carry it), its material and density, and its exact mass properties (the simulation
    model export, web/src/motion/simulationModel.ts, combines them per link)."""
    from steve.design import NOT_HARDWARE_NOTE
    from steve.materials import library
    from steve.model import SURFACE_NOTE, is_surface
    from steve.simulation import _components
    items, skipped = [], []
    for instance, model, location, plain in _components(result):
        if model is not None and getattr(model, "hardware", True) is False:  # A fluid volume or envelope: nothing to print or weigh.
            names = getattr(model, "__dict__", {}).get("body_names", {})
            skipped += [{"instance": instance, "body": body_id, "name": names.get(body_id) or body_id, "note": NOT_HARDWARE_NOTE}
                        for body_id in model.bodies]
            continue
        if model is not None:
            names = getattr(model, "__dict__", {}).get("body_names", {})
            assignments = getattr(model, "__dict__", {}).get("materials")
            bodies = []
            for body_id, body in model.bodies.items():
                if is_surface(body):  # Nothing to print or weigh; manifest.json says which were left out, and why.
                    skipped.append({"instance": instance, "body": body_id, "name": names.get(body_id) or body_id, "note": SURFACE_NOTE})
                    continue
                bodies.append((body_id, names.get(body_id) or body_id, body, assignments.of(body_id) if assignments else None))
        else:
            bodies = [(f"solid_{index + 1}", f"Solid {index + 1}", solid, None) for index, solid in enumerate(plain.Solids())]
        trsf = location.wrapped.Transformation()
        placement = [[round(trsf.Value(row, col), 12) + 0.0 for col in range(1, 5)] for row in range(1, 4)]
        for body_id, name, body, entry in bodies:
            material = entry["material"] if entry else None
            density = library().get(material, {}).get("density") if material else None
            items.append((instance, body_id, name, body.moved(location), placement, {"material": material, "density_g_cm3": density}))
    if not items:
        if any(item["note"] == SURFACE_NOTE for item in skipped):
            raise ValueError(f"This model has only surface bodies to mesh: {SURFACE_NOTE}.")
        if skipped:
            raise ValueError(f"This model has nothing to mesh: {NOT_HARDWARE_NOTE}.")
        return None
    manifest = []
    write_body_archive(items, manifest, deadline, tessellation, skipped)
    if not manifest:
        Path("bodies-mesh.zip").unlink(missing_ok=True)
        return None
    return manifest


def write_body_archive(items, manifest, deadline: float, tessellation=PRINT_TESSELLATION, skipped=()):
    """`skipped`: bodies left out (surface bodies), listed in manifest.json with the note why."""
    import struct
    import zipfile
    from steve.simulation import bounds
    with zipfile.ZipFile("bodies-mesh.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for index, (instance, body_id, name, body, placement, material) in enumerate(items):
            if time.monotonic() > deadline:
                print(f"Warning: bodies-mesh.zip stopped after {index} of {len(items)} for time.", file=sys.stderr)
                break
            path = Path(f"_body_{index}.stl")
            # export_stl meshes a private copy, dropped when it returns: a model's meshes are held one body at a time,
            # never all of them at once (instances of one body share its shape and mesh it again).
            meshed = export_stl(body, path, tessellation[0], tessellation[1])
            if not meshed:
                print(f"Warning: no mesh for {instance}:{body_id}.", file=sys.stderr)
                continue
            data = path.read_bytes()
            path.unlink()
            entry = f"bodies/{index}.stl"
            archive.writestr(entry, data)
            manifest.append({"instance": instance, "body": body_id, "name": name, "file": entry,
                             "triangles": struct.unpack_from("<I", data, 80)[0] if len(data) >= 84 else 0, "extent_mm": bounds(body),
                             "placement": placement, **material, "mass_properties": mass_properties(body)})
        archive.writestr("manifest.json", json.dumps({"version": 1, "units": "mm", "frame": "design", "pose": "as_modelled",
                                                      "linear_tessellation_mm": tessellation[0], "angular_tessellation_rad": tessellation[1],
                                                      "items": manifest, **({"skipped": list(skipped)} if skipped else {})}, indent=1))


# A planar face with more holes than this is meshed with Delabella (export_stl): OCCT's default algorithm's working
# memory on one grows faster than its hole count (measured: 50 holes 52 MB, 200 holes 347 MB, 400 holes 906 MB, 1,020
# holes 1.9 GB and 42 s), and every face below it keeps exactly the triangles it always had.
MANY_HOLES = 200
# The print mesh's algorithms (recorded with every print mesh and the slicer's geometry.json): which made what.
PRINT_MESHER = f"OCCT default (CadQuery 2.8); planar faces with over {MANY_HOLES} holes: Delabella"


def _many_holes(face, tolerance3d: float) -> bool:
    """A planar face with over MANY_HOLES holes and a real extent both ways: Delabella normalizes its points by the
    domain's two extents, and a face collapsed at kernel tolerance crashes it natively (the CadQuery fork's own guard,
    occ_impl/shapes.py)."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    if face.geomType() != "PLANE" or len(face.innerWires()) <= MANY_HOLES:
        return False
    surface = BRepAdaptor_Surface(face.wrapped, True)
    return (surface.LastUParameter() - surface.FirstUParameter() > surface.UResolution(tolerance3d)
            and surface.LastVParameter() - surface.FirstVParameter() > surface.VResolution(tolerance3d))


# Lengths (mm) and relative differences below this are noise in canonical_copy's comparisons: a B-rep built twice gives
# the same geometry up to about 1e-8 mm, and two different faces or edges differ by far more than this.
CANONICAL_TOLERANCE = 1e-6


def canonical_copy(shape):
    """A copy of shape whose B-rep is in a canonical order, for the meshes made from it. OCCT's offsets
    (shell/hollow, BRepOffsetAPI_MakeThickSolid) and tapered extrudes (LocOpe_DPrism) order their result by memory
    addresses, which change from process to process: the same part, built twice, then had the same geometry with its
    faces, the edges around each face and the direction of some edges' curves in another order, and BRepMesh, which
    follows that order, made other triangles for it (a different print mesh, so different G-code). Here:
    - every straight edge runs in one direction, decided by its geometry (_runs_backwards); one that ran the other
      way gets the same line and pcurves reversed, on the same vertices, and is used in the opposite orientation;
    - each wire starts at its smallest edge (geometric key), and keeps its order around the face;
    - each face holds its outer wire first, then its holes in geometric order;
    - each shell, solid and compound holds its faces, shells or solids in geometric order.
    Faces, edges and vertices stay shared as before (a watertight shell stays watertight), and the geometry is the
    same: only the order and the curves' parameter direction change. Keys are compared within CANONICAL_TOLERANCE, so
    numerical noise between builds can't reorder them. Not for STEP, the viewer or names: those keep the shape as built.
    The geometry an offset computes also differs a little between builds: its surfaces come out bit-identical,
    but some intersection curves 1e-10 mm apart, edge ranges 1e-8 apart, some vertices and tolerances in their last
    bits, and BRepMesh, which is that sensitive, then made other triangles. So the copy's edges are also rebuilt from
    the data that is the same in every build (_settle, _settle_lines):
    - vertices on a 1e-9 mm grid (VERTEX_GRID);
    - a B-spline edge between two analytic surfaces (plane, cylinder, cone, sphere, torus): their intersection,
      computed again from the surfaces in a geometric order (GeomInt_IntSS), with its pcurves, trimmed at the vertices;
    - a line: from its start vertex along its direction, range 0 to its length, its pcurves projected again;
    - any other edge: its range from its vertices, projected on its curve (within the curves' bounds);
    - vertex, edge and face tolerances rounded up to two significant digits.
    Each moves the geometry by less than its tolerance, and only where the edge already ends at its vertices (within
    SETTLE_GAP); an edge where a step doesn't apply cleanly keeps what it had."""
    import cadquery as cq
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    copy = BRepBuilderAPI_Copy(shape.wrapped, True, False).Shape()  # Private: the curves reversed below are its own.
    _settle(copy)
    canonical = _Canonical(copy).shape(copy)
    _settle_lines(canonical)
    return cq.Shape.cast(canonical)


def _settle_analytic():
    """The surface types whose intersections _settle computes again."""
    from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Plane, GeomAbs_Sphere, GeomAbs_Torus
    return {GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Cone, GeomAbs_Sphere, GeomAbs_Torus}


def _settle_surface_key(surface):
    """An analytic surface's type and parameters: the order two surfaces are intersected in."""
    from OCP.GeomAdaptor import GeomAdaptor_Surface
    a = GeomAdaptor_Surface(surface)
    t = int(a.GetType())
    def ax(p):
        return p.Location().Coord() + p.Direction().Coord() + p.XDirection().Coord()
    if t == 0: return (t,) + ax(a.Plane().Position())
    if t == 1: c = a.Cylinder(); return (t, c.Radius()) + ax(c.Position())
    if t == 2: c = a.Cone(); return (t, c.RefRadius(), c.SemiAngle()) + ax(c.Position())
    if t == 3: c = a.Sphere(); return (t, c.Radius()) + ax(c.Position())
    if t == 4: c = a.Torus(); return (t, c.MajorRadius(), c.MinorRadius()) + ax(c.Position())
    return (t,)


def _settle_param(curve, point, near, tol):
    """The curve's parameter at point (deterministic projection), the solution nearest `near`; None if off the curve."""
    from OCP.GeomAPI import GeomAPI_ProjectPointOnCurve
    proj = GeomAPI_ProjectPointOnCurve(point, curve)
    best = None
    for i in range(1, proj.NbPoints() + 1):
        if proj.Distance(i) > tol:
            continue
        u = proj.Parameter(i)
        if curve.IsPeriodic():
            period = curve.Period()
            u += round((near - u) / period) * period
        if best is None or abs(u - near) < abs(best - near):
            best = u
    return best


def _settle(shape, stats=None):
    """canonical_copy's rebuild of the (private) copy's vertices, edges and tolerances from the data that is
    bit-identical between builds, before its canonical order. `stats`: a Counter of what was done (for measurements)."""
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_FORWARD
    from OCP.TopExp import TopExp
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS, TopoDS_Vertex
    from OCP.Geom import Geom_Line, Geom_TrimmedCurve, Geom_BSplineCurve
    from OCP.GeomAdaptor import GeomAdaptor_Surface
    from OCP.collections import IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher as DMap
    from collections import Counter
    stats = stats if stats is not None else Counter()
    analytic = _settle_analytic()
    builder = BRep_Builder()
    _settle_vertices(shape, builder, stats)
    faces_of = DMap()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, faces_of)
    for index in range(1, faces_of.Extent() + 1):
        edge = TopoDS.Edge(faces_of.FindKey(index))
        if BRep_Tool.Degenerated_s(edge) or not edge.Location().IsIdentity():
            stats['skip: degenerate or located'] += 1; continue
        loc = TopLoc_Location()
        curve = BRep_Tool.Curve_s(edge, loc, 0.0, 0.0)
        if curve is None or not loc.IsIdentity():
            stats['skip: no curve'] += 1; continue
        faces = []
        for f in faces_of.FindFromIndex(index):
            f = TopoDS.Face(f)
            if not any(f.IsSame(g) for g in faces):
                faces.append(f)
        seam = any(BRep_Tool.IsClosed_s(edge, f) for f in faces)
        if seam or not all(f.Location().IsIdentity() for f in faces):
            stats['skip: seam or located face'] += 1; continue
        tol = BRep_Tool.Tolerance_s(edge)
        first, last = BRep_Tool.Range_s(edge)
        own = TopoDS.Edge(edge.Oriented(TopAbs_FORWARD))
        v1, v2 = TopoDS_Vertex(), TopoDS_Vertex()
        TopExp.Vertices_s(own, v1, v2)
        if v1.IsNull() or v2.IsNull():
            stats['skip: no vertices'] += 1; continue
        closed = v1.IsSame(v2)
        p1, p2 = BRep_Tool.Pnt_s(v1), BRep_Tool.Pnt_s(v2)
        reach = max(tol, BRep_Tool.Tolerance_s(v1), BRep_Tool.Tolerance_s(v2)) * 2 + 1e-9
        # 1. A trimmed line: its basis line (the same parameters), which _settle_lines rebuilds with its pcurves.
        if isinstance(curve, Geom_TrimmedCurve) and isinstance(curve.BasisCurve(), Geom_Line):
            curve = curve.BasisCurve()
            builder.UpdateEdge(edge, curve, tol)
            stats['untrimmed line'] += 1
        if not (BRep_Tool.SameParameter_s(edge) and BRep_Tool.SameRange_s(edge)):
            stats['skip: not same parameter'] += 1; continue
        # 2. Noisy approximated intersections of two analytic surfaces: computed again from the surfaces.
        surfaces = [BRep_Tool.Surface_s(f) for f in faces]
        if (isinstance(curve, Geom_BSplineCurve) and len(faces) == 2
                and all(GeomAdaptor_Surface(s).GetType() in analytic for s in surfaces)):
            rebuilt = _settle_intersection(edge, curve, first, last, faces, surfaces, p1, p2, reach, tol, stats)
            if rebuilt is not None:
                new, pcurves, t1, t2, newtol = rebuilt
                builder.UpdateEdge(edge, new, newtol)
                for f, pc in zip(faces, pcurves):
                    builder.UpdateEdge(edge, pc, f, newtol)
                builder.Range(edge, t1, t2, False)
                for v in (v1, v2):
                    if BRep_Tool.Tolerance_s(v) < newtol:
                        builder.UpdateVertex(v, newtol)
                stats['rebuilt intersection'] += 1
                continue
        if closed:  # A closed edge's range is its curve's whole period or length: nothing to project.
            stats['skip: closed'] += 1; continue
        # 3. Lines: after the canonical order (_settle_lines).
        if isinstance(curve, Geom_Line):
            continue
        # 4. Any other curve: its range from the vertices, projected, within the bounds of the curve and its pcurves.
        t1, t2 = _settle_param(curve, p1, first, reach), _settle_param(curve, p2, last, reach)
        if t1 is None or t2 is None:
            stats['skip: vertex off curve'] += 1; continue
        for bounded in [curve] + [BRep_Tool.CurveOnSurface_s(edge, f, 0.0, 0.0) for f in faces]:
            if bounded is not None and not bounded.IsPeriodic():
                t1, t2 = max(t1, bounded.FirstParameter()), min(t2, bounded.LastParameter())
        if not (t1 < t2) or curve.Value(t1).Distance(curve.Value(first)) > SETTLE_GAP or curve.Value(t2).Distance(curve.Value(last)) > SETTLE_GAP:
            stats['skip: range moved too far'] += 1; continue
        builder.Range(edge, t1, t2, False)
        stats['range from vertices'] += 1
    _settle_tolerances(shape, builder, stats)
    return stats


def _ceiled(tolerance: float) -> float:
    """tolerance rounded up to two significant digits."""
    import math
    step = 10.0 ** (math.floor(math.log10(tolerance)) - 1)
    return math.ceil(tolerance / step) * step


def _settle_tolerances(shape, builder, stats):
    """Vertex, edge and face tolerances rounded up to two significant digits: OCCT computes them from the curves
    (a vertex's from the distance of its edges' ends), so they carry the noise too; rounded up, they still cover what
    they covered."""
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_VERTEX
    from OCP.TopExp import TopExp
    from OCP.TopoDS import TopoDS
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as IMap
    for kind, cast, tol_of, update in ((TopAbs_VERTEX, TopoDS.Vertex, BRep_Tool.Tolerance_s, builder.UpdateVertex),
                                       (TopAbs_EDGE, TopoDS.Edge, BRep_Tool.Tolerance_s, builder.UpdateEdge),
                                       (TopAbs_FACE, TopoDS.Face, BRep_Tool.Tolerance_s, builder.UpdateFace)):
        found = IMap()
        TopExp.MapShapes_s(shape, kind, found)
        for i in range(1, found.Extent() + 1):
            item = cast(found.FindKey(i))
            tolerance = tol_of(item)
            if tolerance > 0:
                update(item, _ceiled(tolerance))
                stats['tolerance ceiled'] += 1


# Vertex coordinates are rounded to this grid (mm): an offset's intersections put last-bit noise into some of them.
VERTEX_GRID = 1e-9
# An edge is rebuilt only where its curve already starts and ends at its vertices within this (mm): the noise is about
# 1e-8; an edge whose vertices sit further off (a vertex tolerance covering a gap) keeps the geometry it has.
SETTLE_GAP = 1e-6


def _settle_vertices(shape, builder, stats):
    """Vertex points on the VERTEX_GRID (far below any vertex tolerance), so last-bit noise doesn't reach the edges'
    ranges and lines built from them."""
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_VERTEX
    from OCP.TopExp import TopExp
    from OCP.TopoDS import TopoDS
    from OCP.gp import gp_Pnt
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as IMap
    found = IMap()
    TopExp.MapShapes_s(shape, TopAbs_VERTEX, found)
    for i in range(1, found.Extent() + 1):
        vertex = TopoDS.Vertex(found.FindKey(i))
        if not vertex.Location().IsIdentity():
            continue
        point = BRep_Tool.Pnt_s(vertex)
        snapped = gp_Pnt(*(round(c / VERTEX_GRID) * VERTEX_GRID + 0.0 for c in (point.X(), point.Y(), point.Z())))
        builder.UpdateVertex(vertex, snapped, BRep_Tool.Tolerance_s(vertex))
        stats['vertex snapped'] += 1


def _settle_lines(shape, stats=None):
    """Every line edge of the canonical shape (each already running in the canonical direction) rebuilt from its start
    vertex (_settle_line)."""
    from collections import Counter
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.Geom import Geom_Line
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_FORWARD
    from OCP.TopExp import TopExp
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS, TopoDS_Vertex
    from OCP.collections import IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher as DMap
    stats = stats if stats is not None else Counter()
    builder = BRep_Builder()
    faces_of = DMap()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, faces_of)
    for index in range(1, faces_of.Extent() + 1):
        edge = TopoDS.Edge(faces_of.FindKey(index))
        if BRep_Tool.Degenerated_s(edge) or not edge.Location().IsIdentity():
            continue
        loc = TopLoc_Location()
        curve = BRep_Tool.Curve_s(edge, loc, 0.0, 0.0)
        if not isinstance(curve, Geom_Line) or not loc.IsIdentity():
            continue
        faces = []
        for f in faces_of.FindFromIndex(index):
            f = TopoDS.Face(f)
            if not any(f.IsSame(g) for g in faces):
                faces.append(f)
        if not (BRep_Tool.SameParameter_s(edge) and BRep_Tool.SameRange_s(edge)):
            stats['line skipped: not same parameter'] += 1
            continue
        v1, v2 = TopoDS_Vertex(), TopoDS_Vertex()
        TopExp.Vertices_s(TopoDS.Edge(edge.Oriented(TopAbs_FORWARD)), v1, v2)
        if v1.IsNull() or v2.IsNull() or v1.IsSame(v2):
            stats['line skipped: closed'] += 1
            continue
        p1, p2 = BRep_Tool.Pnt_s(v1), BRep_Tool.Pnt_s(v2)
        if (all(not BRep_Tool.IsClosed_s(edge, f) and f.Location().IsIdentity() for f in faces)
                and _settle_line(edge, curve, faces, [BRep_Tool.Surface_s(f) for f in faces], p1, p2, BRep_Tool.Tolerance_s(edge), builder)):
            stats['line from its vertices'] += 1
            continue
        # A seam or a line whose pcurves aren't lines: its range at least, from the vertices.
        o, d = curve.Position().Location(), curve.Position().Direction()
        old_first, old_last = BRep_Tool.Range_s(edge)
        first, last = ((p.X() - o.X()) * d.X() + (p.Y() - o.Y()) * d.Y() + (p.Z() - o.Z()) * d.Z() for p in (p1, p2))
        if first < last and abs(first - old_first) <= SETTLE_GAP and abs(last - old_last) <= SETTLE_GAP:
            builder.Range(edge, first, last, False)
            stats['line range from its vertices'] += 1
    return stats


def _settle_line(edge, curve, faces, surfaces, p1, p2, tol, builder) -> bool:
    """edge's line rebuilt from its start vertex p1 along its direction towards p2, range 0 to the length, and each
    face's pcurve projected from it; False (unchanged) where a pcurve doesn't come out as a 2D line."""
    from OCP.Geom import Geom_Line
    from OCP.Geom2d import Geom2d_Line, Geom2d_TrimmedCurve
    from OCP.BRep import BRep_Tool
    from OCP.GeomProjLib import GeomProjLib
    from OCP.gp import gp_Dir, gp_Pnt
    first, last = BRep_Tool.Range_s(edge)
    if curve.Value(first).Distance(p1) > SETTLE_GAP or curve.Value(last).Distance(p2) > SETTLE_GAP:
        return False
    d = curve.Position().Direction()
    x, y, z = d.X() + 0.0, d.Y() + 0.0, d.Z() + 0.0
    length = (p2.X() - p1.X()) * x + (p2.Y() - p1.Y()) * y + (p2.Z() - p1.Z()) * z
    if length < 0:
        x, y, z, length = -x + 0.0, -y + 0.0, -z + 0.0, -length
    if length <= 0:
        return False
    line = Geom_Line(gp_Pnt(p1.X() + 0.0, p1.Y() + 0.0, p1.Z() + 0.0), gp_Dir(x, y, z))
    o = curve.Position().Location()
    start = (p1.X() - o.X()) * d.X() + (p1.Y() - o.Y()) * d.Y() + (p1.Z() - o.Z()) * d.Z()  # p1 on the old line
    pcurves = []
    for face, surface in zip(faces, surfaces):
        pcurve = GeomProjLib.Curve2d_s(line, 0.0, length, surface)
        if isinstance(pcurve, Geom2d_TrimmedCurve):
            pcurve = pcurve.BasisCurve()
        if not isinstance(pcurve, Geom2d_Line):
            return False
        old = BRep_Tool.CurveOnSurface_s(edge, face, 0.0, 0.0)
        if old is None:
            return False
        pcurve = _in_period(pcurve, pcurve.Value(0.0), old.Value(start), surface)
        if pcurve is None:
            return False
        pcurves.append(pcurve)
    builder.UpdateEdge(edge, line, tol)
    for face, pcurve in zip(faces, pcurves):
        builder.UpdateEdge(edge, pcurve, face, tol)
    builder.Range(edge, 0.0, length, False)
    return True


def _in_period(pcurve, now, was, surface):
    """pcurve moved by whole periods of a periodic surface so that its point `now` lands near `was`; None if it
    still doesn't (a pcurve on another part of the surface)."""
    from OCP.gp import gp_Vec2d
    shift = [round((w - n) / period) * period if periodic else 0.0
             for w, n, periodic, period in ((was.X(), now.X(), surface.IsUPeriodic(), surface.UPeriod() if surface.IsUPeriodic() else 1.0),
                                            (was.Y(), now.Y(), surface.IsVPeriodic(), surface.VPeriod() if surface.IsVPeriodic() else 1.0))]
    if shift != [0.0, 0.0]:
        pcurve = pcurve.Translated(gp_Vec2d(shift[0], shift[1]))
        now = now.Translated(gp_Vec2d(shift[0], shift[1]))
    return pcurve if now.Distance(was) < 1e-6 else None


def _settle_intersection(edge, curve, first, last, faces, surfaces, p1, p2, reach, tol, stats):
    """A B-spline edge between two analytic surfaces computed again as their intersection (GeomInt_IntSS, surfaces in
    a geometric order): the curve and both pcurves, trimmed at the vertices. None where that doesn't give one clean
    branch close to the old edge."""
    from OCP.BRep import BRep_Tool
    from OCP.GeomInt import GeomInt_IntSS
    order = sorted(range(2), key=lambda i: _settle_surface_key(surfaces[i]))
    s1, s2 = surfaces[order[0]], surfaces[order[1]]
    inter = GeomInt_IntSS()
    inter.Perform(s1, s2, 1e-7, True, True, True)
    if not inter.IsDone():
        stats['intersection failed'] += 1; return None
    mid = curve.Value((first + last) / 2)
    for i in range(1, inter.NbLines() + 1):
        c = inter.Line(i)
        a, b, m = _settle_param(c, p1, 0.0, reach * 10), _settle_param(c, p2, 0.0, reach * 10), _settle_param(c, mid, 0.0, reach * 10)
        if a is None or b is None or m is None:
            continue
        # On a closed curve a vertex at its start is at its end too: the pair that has the edge's middle between them.
        ends = c.FirstParameter(), c.LastParameter()
        def options(u):
            near = 1e-9 * (ends[1] - ends[0])
            return [u] + ([ends[1]] if c.IsClosed() and abs(u - ends[0]) < near else []) \
                + ([ends[0]] if c.IsClosed() and abs(u - ends[1]) < near else [])
        pairs = [(x, y) for x in options(a) for y in options(b) if x != y]
        pair = next((xy for xy in pairs if xy[0] < m < xy[1]), None) or next((xy for xy in pairs if xy[1] < m < xy[0]), None)
        if pair is None:
            continue
        a, b = pair
        if not (inter.HasLineOnS1(i) and inter.HasLineOnS2(i)):
            stats['intersection without pcurves'] += 1; return None
        if curve.Value(first).Distance(p1) > SETTLE_GAP or curve.Value(last).Distance(p2) > SETTLE_GAP:
            stats['intersection: edge not at its vertices'] += 1; return None
        l1, l2 = inter.LineOnS1(i), inter.LineOnS2(i)
        if a > b:  # Reversed together, so the edge runs from p1 to p2 (deterministic, like the rest).
            c, l1, l2 = c.Reversed(), l1.Reversed(), l2.Reversed()
            a, b = c.ReversedParameter(a), c.ReversedParameter(b)
        by_face = {order[0]: l1, order[1]: l2}
        for idx in range(2):  # On a periodic surface, in the period the face's old pcurve was in.
            old = BRep_Tool.CurveOnSurface_s(edge, faces[idx], 0.0, 0.0)
            if old is None:
                return None
            shifted = _in_period(by_face[idx], by_face[idx].Value(a), old.Value(first), surfaces[idx])
            if shifted is None:
                return None
            by_face[idx] = shifted
        # The new curve against its pcurves on both surfaces and its vertices (all from the bit-identical data, so the
        # tolerance is too), and against the old curve (a check only: the old curve is the noisy one).
        dev = max(p1.Distance(c.Value(a)), p2.Distance(c.Value(b)))
        moved = 0.0
        for k in range(21):
            t = a + (b - a) * k / 20
            q = c.Value(t)
            for idx in range(2):
                uv = by_face[idx].Value(t)
                dev = max(dev, q.Distance(surfaces[idx].Value(uv.X(), uv.Y())))
            told = first + (last - first) * k / 20
            pr = _settle_param(c, curve.Value(told), t, 1.0)
            if pr is None:
                return None
            moved = max(moved, curve.Value(told).Distance(c.Value(pr)))
        if moved > max(tol, 1e-7) * 10 or dev > max(tol, 1e-7) * 10:
            stats['intersection: too far from the old edge'] += 1; return None
        return c, [by_face[0], by_face[1]], a, b, max(tol, dev * 1.5)
    stats['intersection: no matching line'] += 1
    return None


def _compare_keys(a, b) -> int:
    """-1, 0 or 1: nested tuples of ints and floats, floats equal within CANONICAL_TOLERANCE."""
    for x, y in zip(a, b):
        if isinstance(x, tuple):
            order = _compare_keys(x, y)
            if order:
                return order
        elif isinstance(x, float):
            if abs(x - y) > CANONICAL_TOLERANCE * max(1.0, abs(x), abs(y)):
                return -1 if x < y else 1
        elif x != y:
            return -1 if x < y else 1
    return 0


def _canonical_sorted(items, keys):
    from functools import cmp_to_key
    return [item for _, item in sorted(zip(keys, items), key=cmp_to_key(lambda a, b: _compare_keys(a[0], b[0])))]


def _xyz(point) -> tuple:
    return (point.X(), point.Y(), point.Z())


class _Canonical:
    """canonical_copy's rebuild of one (private) shape."""

    def __init__(self, shape):
        from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_FORWARD
        from OCP.TopExp import TopExp
        from OCP.TopLoc import TopLoc_Location
        from OCP.collections import (IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher,
                                     IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher)
        faces_of = IndexedDataMap_TopoDS_Shape_List_TopoDS_Shape_TopTools_ShapeMapHasher()
        TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, faces_of)
        # One entry per edge TShape (in its own frame), and the reversed edge to use in its place, if any.
        self.edges, self.reversed = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher(), {}
        for index in range(1, faces_of.Extent() + 1):
            edge = faces_of.FindKey(index)
            own = edge.Located(TopLoc_Location()).Oriented(TopAbs_FORWARD)
            if self.edges.Contains(own):
                continue
            key = self.edges.Add(own)
            if _runs_backwards(own):
                # The faces in the edge's own frame, where its pcurves are kept.
                frame = edge.Location().Inverted()
                self.reversed[key] = _reversed_edge(own, [face.Located(frame * face.Location()) for face in faces_of.FindFromIndex(index)])

    def edge(self, edge):
        from OCP.TopAbs import TopAbs_FORWARD, TopAbs_REVERSED
        from OCP.TopLoc import TopLoc_Location
        replacement = self.reversed.get(self.edges.FindIndex(edge.Located(TopLoc_Location()).Oriented(TopAbs_FORWARD)))
        if replacement is None:
            return edge
        flipped = {TopAbs_FORWARD: TopAbs_REVERSED, TopAbs_REVERSED: TopAbs_FORWARD}.get(edge.Orientation(), edge.Orientation())
        return replacement.Located(edge.Location()).Oriented(flipped)

    def wire(self, wire, face):
        """The wire (a child of face, as stored) with its edges in their order around the face, starting at the
        smallest; edges that don't make one loop (seen by BRepTools_WireExplorer) are sorted instead."""
        from cadquery.occ_impl.shapes import downcast
        from OCP.BRep import BRep_Builder
        from OCP.BRepTools import BRepTools_WireExplorer
        from OCP.TopAbs import TopAbs_FORWARD
        from OCP.TopLoc import TopLoc_Location
        from OCP.TopoDS import TopoDS_Wire
        loop = []
        # In the wire's own frame, so the edges come out as the wire stores them; the face seen from there.
        explorer = BRepTools_WireExplorer(downcast(wire.Located(TopLoc_Location()).Oriented(TopAbs_FORWARD)),
                                          downcast(face.Located(wire.Location().Inverted()).Oriented(TopAbs_FORWARD)))
        while explorer.More():
            loop.append(explorer.Current())
            explorer.Next()
        edges = _children(wire)
        ordered = len(loop) == len(edges)
        edges = [self.edge(edge) for edge in (loop if ordered else edges)]
        keys = [_edge_key(edge) for edge in edges]
        if ordered and edges:
            first = min(range(len(edges)), key=lambda i: _CompareKey(keys[i]))
            edges = edges[first:] + edges[:first]
        else:
            edges = _canonical_sorted(edges, keys)
        builder, new = BRep_Builder(), TopoDS_Wire()
        builder.MakeWire(new)
        for edge in edges:
            builder.Add(new, edge)
        new.Closed(wire.Closed())
        new.Location(wire.Location())
        new.Orientation(wire.Orientation())
        return new

    def face(self, face):
        """The face (as stored in its shell) with its outer wire first, then its holes in geometric order."""
        from cadquery.occ_impl.shapes import downcast
        from OCP.BRepTools import BRepTools
        from OCP.TopAbs import TopAbs_FORWARD, TopAbs_WIRE
        from OCP.TopLoc import TopLoc_Location
        own = face.Located(TopLoc_Location()).Oriented(TopAbs_FORWARD)  # Its wires as stored.
        outer = BRepTools.OuterWire_s(downcast(own))
        first, holes = [], []
        for part in _children(face):
            if part.ShapeType() != TopAbs_WIRE:
                holes.append(part)
            else:
                (first if part.IsSame(outer) else holes).append(self.wire(part, own))
        return _rebuilt(face, first + _canonical_sorted(holes, [_wire_key(w) for w in holes]))

    def shape(self, shape):
        from OCP.TopAbs import TopAbs_COMPOUND, TopAbs_COMPSOLID, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID
        kind = shape.ShapeType()
        if kind == TopAbs_FACE:
            return self.face(shape)
        if kind not in (TopAbs_SHELL, TopAbs_SOLID, TopAbs_COMPSOLID, TopAbs_COMPOUND):
            return shape  # A loose wire, edge or vertex in a compound: as it is.
        parts = [self.shape(part) for part in _children(shape)]
        return _rebuilt(shape, _canonical_sorted(parts, [_face_key(p) if p.ShapeType() == TopAbs_FACE else _solid_key(p) for p in parts]))


class _CompareKey:
    def __init__(self, key):
        self.key = key

    def __lt__(self, other):
        return _compare_keys(self.key, other.key) < 0


def _children(shape) -> list:
    """shape's direct sub-shapes, as stored (own orientation and location)."""
    from OCP.TopoDS import TopoDS_Iterator
    found, iterator = [], TopoDS_Iterator(shape, False, False)
    while iterator.More():
        found.append(iterator.Value())
        iterator.Next()
    return found


def _rebuilt(shape, parts):
    """An empty copy of shape (its surface, tolerance, location, orientation, flags) holding parts in this order. The
    builder adds a part relative to its parent's location and orientation, so they are set after."""
    from OCP.BRep import BRep_Builder
    from OCP.TopAbs import TopAbs_FORWARD
    from OCP.TopLoc import TopLoc_Location
    new = shape.EmptyCopied()
    new.Location(TopLoc_Location())
    new.Orientation(TopAbs_FORWARD)
    builder = BRep_Builder()
    for part in parts:
        builder.Add(new, part)
    new.Closed(shape.Closed())
    new.Location(shape.Location())
    new.Orientation(shape.Orientation())
    return new


def _edge_key(edge) -> tuple:
    """Curve type, then the points it starts, passes halfway and ends at, as used (orientation)."""
    from cadquery.occ_impl.shapes import downcast
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.TopAbs import TopAbs_REVERSED
    curve = BRepAdaptor_Curve(downcast(edge))
    first, last = curve.FirstParameter(), curve.LastParameter()
    start, middle, end = curve.Value(first), curve.Value((first + last) / 2), curve.Value(last)
    if edge.Orientation() == TopAbs_REVERSED:
        start, end = end, start
    return (int(curve.GetType()), _xyz(start), _xyz(middle), _xyz(end))


def _wire_key(wire) -> tuple:
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    props = GProp_GProps()
    BRepGProp.LinearProperties_s(wire, props)
    return (_xyz(props.CentreOfMass()), props.Mass(), *_box(wire))


def _face_key(face) -> tuple:
    """Surface type, centre of area, area, bounding box, orientation."""
    from cadquery.occ_impl.shapes import downcast
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, props)
    return (0, int(BRepAdaptor_Surface(downcast(face), False).GetType()), _xyz(props.CentreOfMass()), props.Mass(), *_box(face),
            int(face.Orientation()))


def _solid_key(shape) -> tuple:
    """A shell's, solid's or compound's: kind, area, centre of area, bounding box."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, props)
    return (1, int(shape.ShapeType()), props.Mass(), _xyz(props.CentreOfMass()), *_box(shape))


def _box(shape) -> tuple:
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box, False)
    return (_xyz(box.CornerMin()), _xyz(box.CornerMax())) if not box.IsVoid() else ()


def _runs_backwards(edge) -> bool:
    """Whether the edge's curve runs against the canonical direction: from its start point to its end point, the first
    coordinate that changes (by more than CANONICAL_TOLERANCE) increases. A closed edge: the first component of its
    tangent where the curve and its reverse differ is the larger. Degenerate edges and ones without a 3D curve stay."""
    from cadquery.occ_impl.shapes import downcast
    from OCP.BRep import BRep_Tool
    from OCP.gp import gp_Pnt, gp_Vec
    from OCP.TopLoc import TopLoc_Location
    edge = downcast(edge)
    if BRep_Tool.Degenerated_s(edge):
        return False
    location = TopLoc_Location()
    curve = BRep_Tool.Curve_s(edge, location, 0.0, 0.0)
    if curve is None:
        return False
    first, last = BRep_Tool.Range_s(edge)
    transform = location.Transformation()
    for a, b in zip(_xyz(curve.Value(first).Transformed(transform)), _xyz(curve.Value(last).Transformed(transform))):
        if abs(b - a) > CANONICAL_TOLERANCE:
            return b < a
    start, end = gp_Vec(), gp_Vec()
    curve.D1(first, gp_Pnt(), start)
    curve.D1(last, gp_Pnt(), end)
    if start.Magnitude() < 1e-12 or end.Magnitude() < 1e-12:
        return False
    start, end = start.Transformed(transform).Normalized(), end.Transformed(transform).Normalized().Reversed()
    for a, b in zip(_xyz(start), _xyz(end)):  # The curve's start tangent against its reverse's.
        if abs(a - b) > CANONICAL_TOLERANCE:
            return a < b
    return False


def _reversed_edge(edge, faces):
    """edge (FORWARD, in its own frame) with its curve reversed: the same points, run the other way, on the same
    vertices (swapped), with every pcurve on `faces` reversed the same way, so the curve and its pcurves still agree
    point for point. Only where that is exact, u -> -u for the curve and every pcurve (lines, and line pcurves: what
    OCCT's offsets and tapered prisms were seen to reverse): None otherwise, and the edge keeps its direction. A
    reversal that rounds (a circle's u -> 2*pi - u, a B-spline's knots) would put new noise into the very values the
    mesher compares."""
    from cadquery.occ_impl.shapes import downcast
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.TopAbs import TopAbs_FORWARD, TopAbs_REVERSED
    from OCP.TopExp import TopExp
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS_Edge, TopoDS_Vertex
    edge = downcast(edge)
    builder = BRep_Builder()
    location = TopLoc_Location()
    curve = BRep_Tool.Curve_s(edge, location, 0.0, 0.0)
    first, last = BRep_Tool.Range_s(edge)
    tolerance = BRep_Tool.Tolerance_s(edge)
    if curve.ReversedParameter(0.0) != 0.0:
        return None

    def reversed2d(pcurve):
        return pcurve.Reversed() if pcurve.ReversedParameter(0.0) == 0.0 else None

    new = TopoDS_Edge()
    builder.MakeEdge(new, curve.Reversed(), location, tolerance)
    start, end = TopoDS_Vertex(), TopoDS_Vertex()
    TopExp.Vertices_s(edge, start, end)
    builder.Add(new, end.Oriented(TopAbs_FORWARD))
    builder.Add(new, start.Oriented(TopAbs_REVERSED))
    builder.Range(new, -last, -first, True)
    seen, forward_faces = [], []
    for face in faces:
        face = downcast(face.Oriented(TopAbs_FORWARD))
        surface_location = TopLoc_Location()
        surface = BRep_Tool.Surface_s(face, surface_location)
        if any(s == surface and l.IsEqual(surface_location) for s, l in seen):
            continue  # Faces on one surface share its pcurve.
        seen.append((surface, surface_location))
        forward_faces.append(face)
        pcurve = BRep_Tool.CurveOnSurface_s(edge, face, 0.0, 0.0)
        if pcurve is None:
            continue
        p_first, p_last = BRep_Tool.Range_s(edge, surface, surface_location)
        if BRep_Tool.IsClosed_s(edge, surface, surface_location):  # A seam: its two pcurves swap places too.
            other = BRep_Tool.CurveOnSurface_s(downcast(edge.Oriented(TopAbs_REVERSED)), face, 0.0, 0.0)
            pcurves = reversed2d(other), reversed2d(pcurve)
            if pcurves[0] is None or pcurves[1] is None:
                return None
            builder.UpdateEdge(new, pcurves[0], pcurves[1], surface, surface_location, tolerance)
        else:
            reversed_pcurve = reversed2d(pcurve)
            if reversed_pcurve is None:
                return None
            builder.UpdateEdge(new, reversed_pcurve, surface, surface_location, tolerance)
        builder.Range(new, surface, surface_location, -p_last, -p_first)
    for i, one in enumerate(forward_faces):  # The continuity across the edge (BRep_Tool.Continuity), as it was.
        for two in forward_faces[i:]:
            if BRep_Tool.HasContinuity_s(edge, one, two):
                builder.Continuity(new, one, two, BRep_Tool.Continuity_s(edge, one, two))
    builder.SameParameter(new, BRep_Tool.SameParameter_s(edge))
    builder.SameRange(new, BRep_Tool.SameRange_s(edge))
    return new


def export_stl(shape, path, tolerance: float, angular_tolerance: float) -> bool:
    """A binary STL of shape meshed as CadQuery 2.8's exportStl meshed it: OCCT's default BRepMesh algorithm, absolute
    linear and angular deflection, serial, so a slicer reading the STL (the FFF pipeline, manufacturing/runtime/geometry.py)
    gets the same triangles on every CAD runtime (Steve's CadQuery fork's exportStl uses Delabella for analytic shapes).
    The one exception: a planar face with over MANY_HOLES holes is meshed with Delabella first, as the default
    algorithm's working memory on one runs to gigabytes (a 1,020-hole plate: 3.9 GB and 87 s, against 97 MB and 7.5 s).
    Its edges are then discretized for the plane, so the faces around it (the holes' walls) can get other triangles
    too, within the same deflection; the mesh stays watertight.
    Meshes canonical_copy(shape), not the shape itself: the same geometry gives the same triangles, in the same
    order, whichever order its B-rep came in. The shape is left as it was."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.IMeshTools import IMeshTools_MeshAlgoType_Delabella, IMeshTools_Parameters
    from OCP.Precision import Precision
    from OCP.StlAPI import StlAPI_Writer
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_VERTEX

    shape = canonical_copy(shape)
    tolerance3d = max(Precision.Confusion_s(), *(BRep_Tool.MaxTolerance_s(shape.wrapped, kind) for kind in (TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX)))
    for face in shape.Faces():
        if _many_holes(face, tolerance3d):
            delabella = IMeshTools_Parameters()
            delabella.Deflection, delabella.Angle, delabella.Relative, delabella.InParallel = tolerance, angular_tolerance, False, False
            delabella.MeshAlgo = IMeshTools_MeshAlgoType_Delabella
            BRepMesh_IncrementalMesh(face.wrapped, delabella)
    # Exactly CadQuery 2.8's call: a parameters object with the same four values meshes some faces differently.
    BRepMesh_IncrementalMesh(shape.wrapped, tolerance, False, angular_tolerance, False)
    writer = StlAPI_Writer()
    writer.ASCIIMode = False
    return writer.Write(shape.wrapped, str(path))


def mass_properties(body) -> dict:
    """A body's exact volume (mm³), centre of mass (mm) and inertia tensor about it at unit density (mm⁵, products of
    inertia negated, as a tensor), in the design frame. Mass is volume × density; the tensor scales the same way."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    props = volume_properties(body)
    centre, inertia = props.CentreOfMass(), props.MatrixOfInertia()
    return {"volume_mm3": round(props.Mass(), 6) + 0.0, "center_of_mass_mm": [round(v, 9) + 0.0 for v in (centre.X(), centre.Y(), centre.Z())],
            "inertia_mm5": [[round(inertia.Value(row, col), 6) + 0.0 for col in range(1, 4)] for row in range(1, 4)]}


def component_documents(assembly):
    """Placed instances of linked documents: {instance name: document id}."""
    if "steve.links" not in sys.modules:
        return {}
    from steve import links
    found = {name: links.DOCUMENTS[id(component.obj)] for name, component in assembly.traverse() if id(component.obj) in links.DOCUMENTS}
    design = getattr(assembly, "_steve_design", None)
    return {**found, **(design.documents if design else {})}


def modeling_summary():
    """Feature results of a modeling document (steve.Model); None for plain CadQuery."""
    try:
        from steve.export import summary
    except ImportError:
        return None
    try:
        return summary()
    except Exception as exc:  # A reporting problem never fails the build.
        print(f"Warning: modeling summary skipped: {exc!r}"[:300], file=sys.stderr)
        return None


_REFS, _OWNERS = {}, {}


def reference_names(shape):
    """Persistent names for a shape's faces, edges and vertices when a steve.Model (or a design's component) made it."""
    if id(shape) in _REFS:
        return _REFS[id(shape)]
    names = None
    try:
        from steve.export import names as steve_names
        names = steve_names(shape, _OWNERS.get(id(shape)))
    except ImportError:
        pass
    except TimeoutError:
        raise  # The topology budget ran out: never carry on without names.
    except Exception as exc:
        print(f"Warning: reference names skipped: {exc!r}"[:300], file=sys.stderr)
    _REFS[id(shape)] = names
    return names


# Bodies with more faces than this are described compactly: typically meshes imported as STEP, one face per triangle.
# Each face keeps its type, plane, area (from its triangles) and name; only sharp edges are kept (the smooth ones
# between facets of a curved surface are never drawn or picked); no exact surface integrals per face.
COMPACT_FACES = 2000


def job_cpus() -> int:
    """CPUs this job may use: the container's CPU quota (cgroup v2 cpu.max), else the CPUs it can run on."""
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if quota != "max":
            return max(1, int(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    return max(1, len(os.sched_getaffinity(0)))


TOPOLOGY_WORKERS = int(os.getenv("STEVE_TOPOLOGY_WORKERS", "4"))
WORKER_MEMORY = 450 * 1024 * 1024  # What one topology worker may add on top of the shared, copy-on-write parent.


def memory_headroom() -> int | None:
    """Bytes this job's container can still use (cgroup v2 memory.max - memory.current), or None if unlimited."""
    try:
        limit = Path("/sys/fs/cgroup/memory.max").read_text().strip()
        if limit == "max":
            return None
        return int(limit) - int(Path("/sys/fs/cgroup/memory.current").read_text())
    except (OSError, ValueError):
        return None


def describe_all(shapes, describe):
    """(shape id, description) for each shape, largest first. Several large bodies are described in parallel, by
    forked workers that share the loaded shapes (up to TOPOLOGY_WORKERS, and no more than the job's CPUs); small
    models stay in this process. Results arrive as they finish, so the caller keeps them if time runs out."""
    import multiprocessing
    from OCP.TopAbs import TopAbs_FACE
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher
    from OCP.TopExp import TopExp

    def size(shape):
        faces = IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher()
        TopExp.MapShapes_s(shape, TopAbs_FACE, faces)
        return faces.Extent()

    order = sorted(shapes, key=lambda key: -size(shapes[key]))
    workers = min(TOPOLOGY_WORKERS, job_cpus(), sum(1 for key in order if size(shapes[key]) > COMPACT_FACES))
    if workers >= 2:
        import gc
        gc.collect()  # Smaller parent, less for the workers to share or copy.
        headroom = memory_headroom()
        if headroom is not None:  # Never more workers than the memory left can carry, with a margin for this process.
            workers = min(workers, max(1, int((headroom - 300 * 1024 * 1024) // WORKER_MEMORY)))
    if workers < 2:
        for key in order:
            yield key, describe(shapes[key])
        return
    global _DESCRIBE
    _DESCRIBE = (shapes, describe)  # Inherited by the forked workers.
    pool = multiprocessing.get_context("fork").Pool(workers, initializer=signal.signal, initargs=(signal.SIGALRM, signal.SIG_IGN))
    try:
        for key, result in pool.imap_unordered(_describe_one, order):
            yield key, result
    finally:
        pool.terminate()
        pool.join()


_DESCRIBE = None


def _describe_one(key):
    shapes, describe = _DESCRIBE
    return key, describe(shapes[key])


def expire(*_):
    raise TimeoutError("Topology exceeded its time budget.")


# The largest topology.json, as large as the preview.glb it describes (app/kernel_protocol.py ARTIFACT_LIMITS).
TOPOLOGY_LIMIT = 256 * 1024 * 1024


class TopologyTooLarge(ValueError):
    pass


# The steps of write_topology, in order: a failure says which one it stopped in (timed_topology), never more.
TOPOLOGY_STAGES = ("read", "match", "aligned", "cache", "describe", "dump")
_TOPOLOGY_STAGE = None
# Meshes write_topology couldn't match to their faces, by the check that failed (MISMATCH_REASONS): counts only.
_TOPOLOGY_MISMATCH: dict = {}
MISMATCH_REASONS = ("count", "mode", "nodes", "bounds")

# A face's or edge's geometric details the viewer treats as optional (web/src/lib/api.ts TopologyFace/TopologyEdge).
OPTIONAL_DETAILS = frozenset({"center", "normal", "origin", "axis", "radius", "minor_radius", "half_angle", "volume", "center_of_mass"})


def finite(value):
    """`value` with no NaN or infinity, which topology.json (strict JSON) can't carry: a degenerate face's centroid or
    a sliver's radius, say. An optional detail holding one is left out; any other such number becomes 0. So one odd
    face never loses the whole model's selection."""
    if isinstance(value, float):
        return value if math.isfinite(value) else 0.0
    if isinstance(value, dict):
        return {key: finite(item) for key, item in value.items() if key not in OPTIONAL_DETAILS or not non_finite(item)}
    if isinstance(value, (list, tuple)):
        return [finite(item) for item in value]
    return value


def non_finite(value) -> bool:
    if isinstance(value, float):
        return not math.isfinite(value)
    return isinstance(value, (list, tuple)) and any(non_finite(item) for item in value)


def xyz(p):
    return [round(p.X(), 5) + 0.0, round(p.Y(), 5) + 0.0, round(p.Z(), 5) + 0.0]  # + 0.0 drops "-0.0"


def write_topology(assembly, limit=TOPOLOGY_LIMIT, preview_path='preview.glb', topology_path='topology.json', mode=None, remesh_unaligned=False):
    """Describes each preview.glb mesh's B-rep in that mesh's local coordinates, with its `placement` in the design
    (placed). Face i is glTF primitive i. With
    `remesh_unaligned` (the topology job, which publishes its own mesh), a mesh whose primitives don't line up with its
    faces is written again from them in preview.glb rather than left out."""
    import cadquery as cq
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepLib import BRepLib
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.Bnd import Bnd_Box
    from OCP.GCPnts import GCPnts_TangentialDeflection
    from OCP.GeomAbs import GeomAbs_C0
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_VERTEX
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS, TopoDS_Vertex
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher

    global _TOPOLOGY_STAGE
    _TOPOLOGY_STAGE = "read"
    data = Path(preview_path).read_bytes()
    size, chunk = struct.unpack_from("<II", data, 12)
    if data[:4] != b"glTF" or chunk != 0x4E4F534A:
        raise ValueError("Unexpected GLB layout.")
    gltf = json.loads(data[20:20 + size])
    nodes, elements, placements = gltf["nodes"], {}, {}
    at = 20 + size  # The BIN chunk, if any: buffer 0.
    binary = bytearray(data[at + 8:at + 8 + struct.unpack_from("<I", data, at)[0]]) if len(data) >= at + 8 else bytearray()

    def match(indices, expected, frame=None):
        # glTF nodes follow the assembly tree in order; "<name>_part" holds a subassembly's own shape. `frame`: where the
        # expected elements' parent sits in the design (None for the root, whose own frame is the design's).
        # A node no element is named for is skipped, never its later siblings with it. When names don't pair them (a
        # name the glTF writer spells differently, say), the node takes the next element by position, provided as many
        # nodes as elements are left: toCAF writes them in order. A wrong pair is left out, never mislabelled: its
        # faces don't line up with the mesh (aligned) and don't fill its box (remesh).
        position = 0
        for number, index in enumerate(indices):
            found = next((at for at in range(position, len(expected)) if expected[at][0] == nodes[index].get("name")), None)
            if found is None and position < len(expected) and len(indices) - number == len(expected) - position:
                found = position
            if found is None:
                continue
            _, element, part = expected[found]
            position = found
            position += 1
            # Where this element's shapes (the mesh's own coordinates) sit in the design: its parents' placements and its
            # own; a subassembly's own shape sits in the subassembly's frame.
            placed = frame if part else cq.Location() if frame is None else frame * element.loc
            if part or not element.children:
                mesh = nodes[index].get("mesh")
                if mesh is None:  # The part's mesh on a node of its own under the instance's: when there's just one.
                    below = [nodes[child]["mesh"] for child in nodes[index].get("children", []) if "mesh" in nodes[child]]
                    mesh = below[0] if len(below) == 1 else None
                if mesh is not None:
                    elements.setdefault(mesh, element)
                    placements.setdefault(mesh, []).append(placed)
            else:
                own = [(f"{element.name}_part", element, True)] if element.obj else []
                match(nodes[index].get("children", []), own + [(child.name, child, False) for child in element.children], placed)

    def triangulated_faces(shape):
        # Mirrors RWMesh_FaceIterator: each face occurrence with triangles is written as one primitive.
        explorer, faces = TopExp_Explorer(shape, TopAbs_FACE), []
        while explorer.More():
            face, location = TopoDS.Face(explorer.Current()), TopLoc_Location()
            triangulation = BRep_Tool.Triangulation_s(face, location)
            if triangulation is not None and triangulation.NbTriangles():
                faces.append((face, triangulation, location))
            explorer.Next()
        return faces

    def mismatch(primitives, faces):
        """Why a mesh's primitives don't line up with its faces (MISMATCH_REASONS), or None when they do."""
        if sum(p.get("mode", 4) == 4 for p in primitives) != len(faces):
            return "count"
        for primitive, (_, triangulation, location) in zip(primitives, faces):
            accessor, box = gltf["accessors"][primitive["attributes"]["POSITION"]], Bnd_Box()
            triangulation.MinMax(box, location.Transformation(), True)
            bounds = [box.CornerMin().X(), box.CornerMin().Y(), box.CornerMin().Z(), box.CornerMax().X(), box.CornerMax().Y(), box.CornerMax().Z()]
            if primitive.get("mode", 4) != 4:
                return "mode"
            if accessor["count"] != triangulation.NbNodes():
                return "nodes"
            if any(abs(a - b) > 1e-3 + 1e-6 * abs(b) for a, b in zip(accessor["min"] + accessor["max"], bounds)):
                return "bounds"
        return None

    def aligned(primitives, faces):
        reason = mismatch(primitives, faces)
        if reason is not None:
            _TOPOLOGY_MISMATCH[reason] = _TOPOLOGY_MISMATCH.get(reason, 0) + 1
        return reason is None

    def remesh(index, faces):
        """Writes glTF mesh `index` again from its faces' own triangulations, one primitive per face in their order
        (as RWMesh_FaceIterator does), so it lines up with them by construction. The topology job then shows this mesh
        (app/worker.py faces_differ) instead of losing the body's selection."""
        if not faces:
            return False
        old, views, accessors = gltf["meshes"][index]["primitives"], gltf.setdefault("bufferViews", []), gltf.setdefault("accessors", [])
        # Only ever a mesh of the same body in the same place: the faces fill the box the mesh filled.
        located = [p.get("attributes", {}).get("POSITION") for p in old]
        boxes = [accessors[at] for at in located if isinstance(at, int) and 0 <= at < len(accessors) and "min" in accessors[at] and "max" in accessors[at]]
        if not boxes:
            return False
        shown = [min(box["min"][k] for box in boxes) for k in range(3)] + [max(box["max"][k] for box in boxes) for k in range(3)]
        whole = Bnd_Box()
        for _, triangulation, location in faces:
            triangulation.MinMax(whole, location.Transformation(), True)
        bounds = [whole.CornerMin().X(), whole.CornerMin().Y(), whole.CornerMin().Z(), whole.CornerMax().X(), whole.CornerMax().Y(), whole.CornerMax().Z()]
        slack = 0.5 + 0.01 * math.dist(bounds[:3], bounds[3:])
        if any(abs(a - b) > slack for a, b in zip(shown, bounds)):
            return False

        def view(values, kind, target):
            payload = array(kind, values).tobytes()
            views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(payload), "target": target})
            binary.extend(payload + b"\0" * (-len(payload) % 4))
            return len(views) - 1

        primitives = []
        for number, (face, triangulation, location) in enumerate(faces):
            trsf = location.Transformation()
            flip = (face.Orientation() == TopAbs_REVERSED) != (trsf.VectorialPart().Determinant() < 0)
            positions = array("f", [c for n in range(1, triangulation.NbNodes() + 1)
                                    for p in (triangulation.Node(n).Transformed(trsf),) for c in (p.X(), p.Y(), p.Z())])
            normals, corners = [0.0] * len(positions), []
            for t in range(1, triangulation.NbTriangles() + 1):
                a, b, c = (i - 1 for i in triangulation.Triangle(t).Get())
                if flip:
                    b, c = c, b
                corners += (a, b, c)
                u = [positions[3 * b + k] - positions[3 * a + k] for k in range(3)]
                v = [positions[3 * c + k] - positions[3 * a + k] for k in range(3)]
                cross = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
                for corner in (a, b, c):
                    for k in range(3):
                        normals[3 * corner + k] += cross[k]
            for n in range(0, len(normals), 3):
                length = math.sqrt(sum(value * value for value in normals[n:n + 3]))
                normals[n:n + 3] = [value / length for value in normals[n:n + 3]] if length > 1e-30 else [0.0, 0.0, 1.0]
            low = [min(positions[k::3]) for k in range(3)]
            high = [max(positions[k::3]) for k in range(3)]
            accessors.append({"bufferView": view(positions, "f", 34962), "componentType": 5126, "count": len(positions) // 3,
                              "type": "VEC3", "min": low, "max": high})
            accessors.append({"bufferView": view(normals, "f", 34962), "componentType": 5126, "count": len(normals) // 3, "type": "VEC3"})
            accessors.append({"bufferView": view(corners, "I", 34963), "componentType": 5125, "count": len(corners), "type": "SCALAR"})
            primitive = {"attributes": {"POSITION": len(accessors) - 3, "NORMAL": len(accessors) - 2}, "indices": len(accessors) - 1, "mode": 4}
            material = (old[min(number, len(old) - 1)] if old else {}).get("material")
            if material is not None:
                primitive["material"] = material
            primitives.append(primitive)
        gltf["meshes"][index]["primitives"] = primitives
        return True

    def polyline(edge, curve, faces, detail):
        # Prefer the preview mesh's own edge nodes so lines sit exactly on triangle boundaries.
        for _, triangulation, location in faces if detail == 0 else []:
            polygon = BRep_Tool.PolygonOnTriangulation_s(edge, triangulation, location)
            if polygon is not None:
                trsf = location.Transformation()
                return [c for n in range(1, polygon.NbNodes() + 1) for c in xyz(triangulation.Node(polygon.Node(n)).Transformed(trsf))]
        if detail == 2:
            return []
        sampler = GCPnts_TangentialDeflection(curve, 0.1, 0.05) if detail == 0 else GCPnts_TangentialDeflection(curve, 0.5, 0.5)
        return [c for n in range(1, sampler.NbPoints() + 1) for c in xyz(sampler.Value(n))]

    def indices(shape, kind, index_map):
        explorer, found = TopExp_Explorer(shape, kind), {}
        while explorer.More():
            found[index_map.FindIndex(explorer.Current())] = None
            explorer.Next()
        return list(found)

    def triangles_area(triangulation, location):
        trsf, area = location.Transformation(), 0.0
        for t in range(1, triangulation.NbTriangles() + 1):
            a, b, c = (triangulation.Node(i).Transformed(trsf) for i in triangulation.Triangle(t).Get())
            ux, uy, uz = b.X() - a.X(), b.Y() - a.Y(), b.Z() - a.Z()
            vx, vy, vz = c.X() - a.X(), c.Y() - a.Y(), c.Z() - a.Z()
            area += 0.5 * ((uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2) ** 0.5
        return area

    def continuity_of(edge_ids, edges, edge_faces, edge_map, face_map, face_ids, owners, has_surfaces):
        """The Surface tab's continuity check, measured on the exact B-rep (steve.continuity): each smooth edge between
        two faces gets `continuity` [{"faces": [a, b], gap, angle, change, relative, curvature, at, samples}]; with
        surface bodies in the mesh, so does each free edge with the other body's face that continues it (a fill patch
        and the wall it closes), on both edges. Other edges (creases) are left to the viewer's mesh estimate."""
        from steve import continuity as measure_continuity
        face_of = lambda k: TopoDS.Face(face_map.FindKey(k))  # noqa: E731
        try:
            for i, at in edge_ids.items():
                item = edges[at]
                neighbours = [k for k in edge_faces.get(i, []) if k in face_ids]
                if not item["smooth"] or item["seam"] or len(neighbours) != 2:
                    continue
                found = measure_continuity.measure(TopoDS.Edge(edge_map.FindKey(i)), face_of(neighbours[0]), face_of(neighbours[1]))
                if found:
                    item["continuity"] = [{"faces": [face_ids[k] for k in neighbours], **found}]
            if not has_surfaces:
                return
            faces_of = {i: [(face_ids[k], face_of(k)) for k in edge_faces.get(i, []) if k in face_ids] for i in edge_ids}
            owner_of = {face_ids[k]: tuple(owners.get(cq.Face(face_of(k)), [])) for k in range(1, face_map.Extent() + 1) if k in face_ids}
            shapes = {i: TopoDS.Edge(edge_map.FindKey(i)) for i in edge_ids}
            for i, (own, partner, j) in measure_continuity.free_edge_partners(shapes, faces_of, owner_of).items():
                faces = dict(faces_of[i] + faces_of[j])
                found = measure_continuity.measure(shapes[i], faces[own], faces[partner])
                if found:
                    for at in (edge_ids[i], edge_ids[j]):
                        edges[at].setdefault("continuity", []).append({"faces": [own, partner], **found})
        except TimeoutError:
            raise
        except Exception as exc:  # The check is an aid: the rest of the topology never depends on it.
            print(f"Warning: exact edge continuity skipped: {type(exc).__name__}"[:300], file=sys.stderr)

    def describe(shape):
        """The mesh's topology (edge points at detail 0) and, per edge, how to redo its points at another detail."""
        faces, props = triangulated_faces(shape), GProp_GProps()
        compact = len(faces) > COMPACT_FACES
        names = reference_names(shape)
        from steve.export import face_bodies, surface_body_ids
        owners = face_bodies(_OWNERS.get(id(shape)))
        surfaces = surface_body_ids(_OWNERS.get(id(shape)))
        if not owners and _OWNERS.get(id(shape)) is None:
            # Plain CadQuery geometry (no steve model): its solids in order, named as the print meshes, simulation and
            # CAM name them (write_body_meshes, steve.simulation._components): solid_1, solid_2… So the viewer, and every
            # workspace that picks a body, sees the bodies the server addresses.
            owners = {face: [f"solid_{index + 1}"] for index, solid in enumerate(cq.Shape.cast(shape).Solids()) for face in solid.Faces()}
        face_map, edge_map, vertex_map = (IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher() for _ in range(3))
        for kind, index_map in ((TopAbs_FACE, face_map), (TopAbs_EDGE, edge_map), (TopAbs_VERTEX, vertex_map)):
            TopExp.MapShapes_s(shape, kind, index_map)
        # Map indices are 1-based and unique per sub-shape; output indices are 0-based list positions.
        face_keys = [face_map.FindIndex(face) for face, _, _ in faces]
        face_ids, face_edges, edge_faces = {}, {}, {}
        for i, key in enumerate(face_keys):
            face_ids.setdefault(key, i)
        for key in range(1, face_map.Extent() + 1):
            face_edges[key] = indices(face_map.FindKey(key), TopAbs_EDGE, edge_map)
            for e in face_edges[key]:
                edge_faces.setdefault(e, []).append(key)
        # Edges where faces meet at less than this are smooth (C1). A faceted body's facets of one curved surface meet at
        # a few degrees: like the viewer's own outlines (24°), only real creases count as edges there.
        BRepLib.EncodeRegularity_s(shape, math.radians(20) if compact else 1e-4)

        edge_ids, edges, redo = {}, [], []
        for i in range(1, edge_map.Extent() + 1):
            edge = TopoDS.Edge(edge_map.FindKey(i))
            if BRep_Tool.Degenerated_s(edge):
                continue
            neighbours = edge_faces.get(i, [])
            adjacent = [TopoDS.Face(face_map.FindKey(k)) for k in neighbours]
            seam = len(adjacent) == 1 and BRep_Tool.IsClosed_s(edge, adjacent[0])
            smooth = seam or (len(adjacent) == 2 and BRep_Tool.Continuity_s(edge, *adjacent) != GeomAbs_C0)
            if compact and smooth:
                continue  # Between facets of one curved surface: never drawn or picked.
            curve = BRepAdaptor_Curve(edge)
            BRepGProp.LinearProperties_s(edge, props)
            mesh_faces = [faces[face_ids[k]] for k in neighbours if k in face_ids]
            item = {
                "type": CURVES.get(curve.GetType().name.removeprefix("GeomAbs_"), "other"),
                "length": round(props.Mass(), 5),
                "points": polyline(edge, curve, mesh_faces, 0),
                "faces": [face_ids[k] for k in neighbours if k in face_ids],
                "smooth": smooth,
                "seam": seam,
            }
            if item["type"] == "circle":
                circle = curve.Circle()
                item.update(center=xyz(circle.Location()), radius=round(circle.Radius(), 5), normal=xyz(circle.Axis().Direction()))
            first, last = TopoDS_Vertex(), TopoDS_Vertex()
            TopExp.Vertices_s(edge, first, last)
            if not first.IsNull() and not last.IsNull():
                item["vertices"] = list(dict.fromkeys(vertex_map.FindIndex(v) - 1 for v in (first, last)))
            if names:
                item["ref"] = names[1].get(cq.Edge(edge))
            edge_ids[i] = len(edges)
            edges.append(item)
            redo.append(polyline(edge, curve, mesh_faces, 1))  # Detail 1; detail 2 drops points.
        if not compact:
            continuity_of(edge_ids, edges, edge_faces, edge_map, face_map, face_ids, owners, bool(surfaces))

        items = []
        for (face, triangulation, location), key in zip(faces, face_keys):
            surface = BRepAdaptor_Surface(face)
            kind = SURFACES.get(surface.GetType().name.removeprefix("GeomAbs_"), "other")
            if compact:  # Area from the face's own triangles: exact for flat facets, no surface integral.
                item = {"type": kind, "area": round(triangles_area(triangulation, location), 5)}
            else:
                BRepGProp.SurfaceProperties_s(face, props)
                # `center`: the area-weighted centroid of any face (a quadric's `origin` is a point on its axis).
                item = {"type": kind, "area": round(surface_area(face), 5), "center": xyz(props.CentreOfMass())}
            if item["type"] == "plane":
                position = surface.Plane().Position()
                normal = position.XDirection().Crossed(position.YDirection())
                if face.Orientation() == TopAbs_REVERSED:
                    normal.Reverse()
                origin = position.Location() if compact else props.CentreOfMass()
                item.update(normal=xyz(normal), origin=xyz(origin))
            elif item["type"] in ("cylinder", "cone", "sphere", "torus"):
                geometry = getattr(surface, item["type"].capitalize())()
                radius = geometry.RefRadius() if item["type"] == "cone" else geometry.MajorRadius() if item["type"] == "torus" else geometry.Radius()
                item.update(axis=xyz(geometry.Position().Direction()), origin=xyz(geometry.Position().Location()), radius=round(radius, 5))
                if item["type"] == "cone":
                    item["half_angle"] = round(geometry.SemiAngle(), 5)
                elif item["type"] == "torus":
                    item["minor_radius"] = round(geometry.MinorRadius(), 5)
            elif not compact:  # B-spline and other freeform faces: the outward normal at the middle of the face's UV bounds.
                u = (surface.FirstUParameter() + surface.LastUParameter()) / 2
                v = (surface.FirstVParameter() + surface.LastVParameter()) / 2
                local = BRepLProp_SLProps(surface, u, v, 1, 1e-6) if math.isfinite(u) and math.isfinite(v) else None
                if local is not None and local.IsNormalDefined():
                    normal = local.Normal()
                    if face.Orientation() == TopAbs_REVERSED:
                        normal.Reverse()
                    item["normal"] = xyz(normal)
            item["edges"] = [edge_ids[e] for e in face_edges[key] if e in edge_ids]
            if names:
                item["ref"] = names[0].get(cq.Face(face))
            item["bodies"] = owners.get(cq.Face(face), [])
            items.append(item)

        volume, area = volume_properties(shape), GProp_GProps()
        if not compact:
            BRepGProp.SurfaceProperties_s(shape, area)
        return {
            "volume": round(volume.Mass(), 5),
            "area": round(sum(face["area"] for face in items) if compact else surface_area(shape), 5),
            "center_of_mass": xyz((volume if abs(volume.Mass()) > 1e-9 or compact else area).CentreOfMass()),
            **({"compact": True} if compact else {}),
            # The mesh's surface bodies (model.fill, boundary_surface): drawn two-sided, never machined or weighed.
            **({"surface_bodies": surfaces} if surfaces else {}),
            "faces": items,
            "edges": edges,
            "vertices": [xyz(BRep_Tool.Pnt_s(TopoDS.Vertex(vertex_map.FindKey(i)))) for i in range(1, vertex_map.Extent() + 1)],
            **({"vertex_refs": [names[2].get(cq.Vertex(TopoDS.Vertex(vertex_map.FindKey(i)))) for i in range(1, vertex_map.Extent() + 1)]} if names else {}),
        }, redo

    roots = gltf["scenes"][gltf.get("scene", 0)]["nodes"]
    if not assembly.children and len(roots) == 1 and "name" not in nodes[roots[0]]:
        roots = nodes[roots[0]].get("children", [])
    _TOPOLOGY_STAGE = "match"
    match(roots, [(assembly.name, assembly, False)])
    _TOPOLOGY_STAGE = "aligned"
    shapes, matched, remeshed = {}, {}, False
    for index, element in sorted(elements.items()):
        if id(element.obj) not in shapes:
            shapes[id(element.obj)] = cq.Compound.makeCompound(element.shapes).wrapped
            _OWNERS[id(shapes[id(element.obj)])] = getattr(element.obj, "_steve_model", None)  # A design's component
        faces = triangulated_faces(shapes[id(element.obj)])
        if aligned(gltf["meshes"][index]["primitives"], faces):
            matched[index] = shapes[id(element.obj)]
        elif remesh_unaligned and remesh(index, faces):
            matched[index], remeshed = shapes[id(element.obj)], True
            print(f"Warning: glTF mesh {index} was written again from its faces, which its primitives did not match.", file=sys.stderr)
        else:
            print(f"Warning: topology.json omits glTF mesh {index}; its faces do not match its primitives, so this body's faces and edges can't be picked in the viewer; the model and its exports are unaffected.", file=sys.stderr)
    if remeshed:
        if gltf.get("buffers"):
            gltf["buffers"][0]["byteLength"] = len(binary)
        else:
            gltf["buffers"] = [{"byteLength": len(binary)}]
        text = json.dumps(gltf, separators=(",", ":")).encode()
        text += b" " * (-len(text) % 4)
        binary += b"\0" * (-len(binary) % 4)
        Path(preview_path).write_bytes(struct.pack("<4sII", b"glTF", 2, 28 + len(text) + len(binary))
                                       + struct.pack("<I4s", len(text), b"JSON") + text + struct.pack("<I4s", len(binary), b"BIN\0") + binary)
    described, redo, partial = {}, {}, False
    shapes = {id(shape): shape for shape in matched.values()}
    # Part by part: a design component unchanged since an earlier build brings its topology from the component cache
    # (steve.design), checked against its faces; the rest are described now and added to their cache entries.
    _TOPOLOGY_STAGE = "cache"
    from steve import design as steve_design
    for key, shape in list(shapes.items()):
        owner = _OWNERS.get(key)
        try:  # An unreadable or odd cache entry (one written with NaN, say) is described afresh instead.
            cached = steve_design.cached_topology(owner, mode) if mode and owner is not None else None
            if cached and len(cached["data"].get("faces", [])) == len(triangulated_faces(shape)):
                described[key], redo[key] = finite(cached["data"]), finite(cached["coarse"])
                del shapes[key]
                steve_design.reused_topology()
        except TimeoutError:
            raise
        except Exception as exc:
            print(f"Warning: a cached topology was not reused (it is described afresh): {type(exc).__name__}", file=sys.stderr)

    def describe_or_skip(shape):
        # One body the kernel can't describe (an odd surface, say) leaves its mesh out, as an unmatched mesh is, rather
        # than every other body's selection with it. Running out of time still ends the whole description. Numbers JSON
        # can't carry are cleaned here, body by body (finite), so they never fail the whole file when it's written.
        try:
            data, coarse = describe(shape)
            return finite(data), finite(coarse)
        except TimeoutError:
            raise
        except Exception as exc:
            print(f"Warning: topology.json omits a body that could not be described (its faces and edges can't be picked in the viewer; the model and its exports are unaffected): {exc!r}"[:500], file=sys.stderr)
            return None

    _TOPOLOGY_STAGE = "describe"
    try:
        for key, result in describe_all(shapes, describe_or_skip):
            if result is None:
                continue
            data, coarse = result
            described[key], redo[key] = data, coarse
            owner = _OWNERS.get(key)
            if mode and owner is not None:
                try:  # The cache is for the next build: failing to keep it never costs this one its selection.
                    steve_design.cache_topology(owner, mode, json.loads(json.dumps(data)), coarse)
                except TimeoutError:
                    raise
                except Exception as exc:
                    print(f"Warning: a topology was not cached for the next build: {type(exc).__name__}", file=sys.stderr)
    except TimeoutError:
        partial = True  # Out of time: the meshes described so far are still useful.
        print("Warning: topology.json is partial: it ran out of time, so some bodies can't be picked in the viewer; the model and its exports are unaffected.", file=sys.stderr)
    signal.setitimer(signal.ITIMER_REAL, 0)  # Writing what was described is never cut short.
    if not described:
        if partial:
            raise TimeoutError("Topology exceeded its time budget.")
        if not matched:
            _TOPOLOGY_STAGE = "aligned"  # No mesh matched its faces: nothing was there to describe.
        raise ValueError("No mesh of the model could be described.")
    _TOPOLOGY_STAGE = "dump"

    def placed(index):
        """Where mesh `index` sits in the design: `placement`, a 3×4 [R|t] (mm, steve.design._placement's form) taking
        its own coordinates (every position above) to the design's; `placements`, one per node, when several nodes
        share the mesh at different places. Added here, never to the cached per-component topology."""
        found = []
        for location in placements.get(index, []):
            trsf = location.wrapped.Transformation()
            matrix = [[round(trsf.Value(row, col), 9) + 0.0 for col in range(1, 5)] for row in range(1, 4)]
            if matrix not in found:
                found.append(matrix)
        return {"placement": found[0]} if len(found) == 1 else {"placements": found} if found else {}

    def dump(meshes):
        return json.dumps({"version": 1, "units": "mm", **({"partial": True} if partial else {}), "meshes": meshes},
                          separators=(",", ":"), allow_nan=False)

    for detail in range(3):
        if detail:  # Coarser edge points only: everything else was described once.
            for key, coarse in redo.items():
                for item, points in zip(described[key]["edges"], coarse):
                    item["points"] = points if detail == 1 else []
        meshes = {str(index): {"name": gltf["meshes"][index].get("name", ""), **described[id(shape)], **placed(index)}
                  for index, shape in matched.items() if id(shape) in described}
        text = dump(meshes)
        if len(text) <= limit:
            Path(topology_path).write_text(text)
            return "partial" if partial else "complete"
    # Too large even without edge points: the largest meshes are left out (as unmatched ones are), so every other mesh
    # stays selectable.
    sizes = {index: len(json.dumps(mesh, separators=(",", ":"), allow_nan=False)) for index, mesh in meshes.items()}
    over = len(text) - limit
    for index in sorted(sizes, key=lambda index: -sizes[index])[:-1]:
        if over <= 0:
            break
        del meshes[index]
        over -= sizes[index]
        print(f"Warning: topology.json omits glTF mesh {index}; it would exceed the size limit, so this body's faces and edges can't be picked in the viewer; the model and its exports are unaffected.", file=sys.stderr)
    text = dump(meshes)
    if len(text) <= limit:
        Path(topology_path).write_text(text)
        return "partial" if partial else "complete"
    raise TopologyTooLarge("Topology exceeds its size limit.")


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.readline())
        metadata = build(request)
        Path("result.json").write_text(json.dumps({"ok": True, "metadata": metadata}))
    except BaseException:
        error = traceback.format_exc()
        Path("result.json").write_text(json.dumps({"ok": False, "error": error[-12000:]}))
        print(error, file=sys.stderr)
        sys.exit(1)
