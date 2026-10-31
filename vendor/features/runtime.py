"""Geometry and feature-history entry point inside the CAD sandbox.

`run_request()` is the build callable: the geometry kernel (runtime/kernel.py) calls it in a
fresh forked child per job, in that job's scratch directory. `python -m app.features.runtime`
keeps the one-shot form (request JSON on stdin, result.json in the working directory).
"""
import json
import hashlib
import math
from pathlib import Path
import os
import re
import sys
import time
import traceback

# The CAD runtime this process builds with: the image's own (/opt/cad), or the checkout's in the test suites
# (STEVE_RUNTIME_DIR=runtime), so a test exercises this commit's runtime, not production's.
sys.path.insert(0, os.environ.get("STEVE_RUNTIME_DIR") or "/opt/cad")
import run
from run import build as cad_build
from app.features.model import analyze, instrument, FeatureError
from app.features import trace

# Records the result for feature capture. Without `result`, run.build() raises its readable error.
FINISH = "\nif 'result' in globals():\n    from app.features.trace import take_result as __ft_finish\n    __ft_finish(result)\n"
STARTED = time.monotonic()
ARTIFACTS = ("result.step", "preview.glb", "topology.json", "manufacturing.json", "sheet-metal.json", "sheet-metal.zip", "sheet-metal-flat.glb", "sheet-metal-flat-topology.json", "drawing.svg", "drawings.zip", "view-isometric.png", "view-top.png", "view-front.png", "view-right.png", "picture.png")


VIEWS = ('isometric', 'top', 'front', 'right')
VIEW_SOURCE = re.compile(r"[0-9a-f]{64}\.step")
CONTOUR_SOURCE = re.compile(r"[0-9a-f]{64}\.contour")
MESH_SOURCE = re.compile(r"[0-9a-f]{64}\.glb")


def view_record(available, error=None, deferred=False):
    return {'available': available, 'width': 800, 'height': 640, 'projection': 'orthographic', 'source': 'exported STEP',
            'error': error, **({'deferred': True} if deferred else {})}


def deferred_views(metadata):
    """Full builds no longer render inspection views: inspect_model asks for them when it looks (mode "views",
    app/derivations.py). They took two thirds of a full build and most builds are never looked at."""
    if metadata.get('empty'):
        metadata['inspection_views'] = view_record([], 'Nothing is modelled yet.')
    else:
        metadata['inspection_views'] = view_record([], deferred=True)


def visibility_names(value, label):
    """A views job's `show` or `hide`: instance names or patterns (inspect_model), at most 2000 of up to 200 characters."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 2000 or any(not isinstance(name, str) or not 0 < len(name) <= 200 for name in value):
        raise ValueError(f'A views job\'s {label} must be a list of instance names.')
    return value


def motion_request(value):
    """A views job's `motion` (inspect_model's pose, animation or explode moment, app/worker.py posed_motion): ({"pose":
    name}, {"animation": name, "t": seconds} or {"explode": name, "t": seconds}, the build's kinematics reduced to what
    placing needs). Anything else is refused."""
    def number(item):
        return isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(item)

    def name(item):
        return isinstance(item, str) and 0 < len(item) <= 200

    def values(item):
        return isinstance(item, dict) and len(item) <= 2000 and all(name(k) and number(v) for k, v in item.items())

    def vector(item):
        return isinstance(item, list) and len(item) == 3 and all(number(v) for v in item)
    def path(item):   # An instance, or a linked design's instance by path ("gearbox/housing").
        return isinstance(item, str) and 0 < len(item) <= 600 and item.count('/') <= 8
    refused = ValueError('A views job\'s motion must name a pose, or an animation or explode and a time, with the build\'s joints.')
    if not isinstance(value, dict) or not isinstance(value.get('kinematics'), dict):
        raise refused
    kinematics = value['kinematics']
    joints, couplings = kinematics.get('joints') or [], kinematics.get('couplings') or []
    if not isinstance(joints, list) or not isinstance(couplings, list) or len(joints) > 2000 or len(couplings) > 2000:
        raise refused
    if not all(isinstance(j, dict) and name(j.get('name')) and name(j.get('parent')) and name(j.get('child'))
               and j.get('type') in ('rigid', 'revolute', 'slider', 'cylindrical') and vector(j.get('origin')) and vector(j.get('axis'))
               and number(j.get('value')) and number(j.get('slide', 0.0)) for j in joints):
        raise refused
    if not all(isinstance(c, dict) and name(c.get('name')) and number(c.get('value')) and values(c.get('gears')) for c in couplings):
        raise refused

    def span(item):   # A joint's limits: None, or (min, max).
        return item is None or (isinstance(item, list) and len(item) == 2 and all(number(v) for v in item))
    if not all(span(j.get('limits')) and span(j.get('slide_limits')) and (j.get('driven_by') is None or (
            isinstance(j['driven_by'], list) and len(j['driven_by']) <= 2000 and all(name(c) for c in j['driven_by']))) for j in joints):
        raise refused
    # A joint its couplings drive stops at its limits (steve.design._effective), as the build and the viewer place it.
    placing = {'joints': [{key: j[key] for key in ('name', 'type', 'parent', 'child', 'origin', 'axis', 'value')} | {'slide': j.get('slide', 0.0)}
                          | ({'limits': j.get('limits'), 'slide_limits': j.get('slide_limits'), 'driven_by': j['driven_by']} if j.get('driven_by') else {})
                          for j in joints],
               'couplings': [{key: c[key] for key in ('name', 'value', 'gears')} for c in couplings]}
    if set(value) == {'pose', 'kinematics'} and name(value['pose']):
        poses = kinematics.get('poses')
        if not isinstance(poses, dict) or len(poses) > 1 or not all(name(k) and values(v) for k, v in poses.items()):
            raise refused
        return {'pose': value['pose']}, {**placing, 'poses': poses}
    if set(value) == {'animation', 't', 'kinematics'} and name(value['animation']) and number(value['t']) and value['t'] >= 0:
        animations = kinematics.get('animations')
        if not isinstance(animations, list) or len(animations) > 1 or not all(
                isinstance(a, dict) and name(a.get('name')) and a.get('easing') in ('linear', 'ease') and isinstance(a.get('keys'), list)
                and 0 < len(a['keys']) <= 10000 and all(isinstance(k, dict) and number(k.get('time')) and values(k.get('values')) for k in a['keys'])
                for a in animations):
            raise refused
        return {'animation': value['animation'], 't': float(value['t'])}, {
            **placing, 'animations': [{'name': a['name'], 'easing': a['easing'], 'keys': [{'time': k['time'], 'values': k['values']} for k in a['keys']]}
                                      for a in animations]}
    if set(value) == {'explode', 't', 'kinematics'} and name(value['explode']) and number(value['t']) and value['t'] >= 0:
        explodes = kinematics.get('explodes')
        if not isinstance(explodes, list) or len(explodes) != 1 or not all(
                isinstance(e, dict) and name(e.get('name')) and e.get('easing') in ('linear', 'ease') and isinstance(e.get('steps'), list)
                and 0 < len(e['steps']) <= 500 and all(
                    isinstance(s, dict) and number(s.get('start')) and number(s.get('duration')) and s['duration'] >= 0
                    and isinstance(s.get('moves'), dict) and len(s['moves']) <= 2000
                    and all(path(k) and vector(v) for k, v in s['moves'].items()) for s in e['steps'])
                for e in explodes):
            raise refused
        return {'explode': value['explode'], 't': float(value['t'])}, {
            **placing, 'explodes': [{'name': e['name'], 'easing': e['easing'],
                                     'steps': [{'start': s['start'], 'duration': s['duration'], 'moves': s['moves']} for s in e['steps']]}
                                    for e in explodes]}
    raise refused


def render_views(request):
    """Mode "views": the four inspection views of a full build's STEP (sent as an input), rendered in this job's process
    (CadQuery is already loaded here) from one scene. A renderer crash ends only this job. With `show` or `hide`
    (app/derivations.py variant) only the instances they leave are drawn, in the `views` asked for, and the metadata
    says what was drawn (`drawn`: instances and extent). With `motion` the design is drawn in that pose, animation or
    explode moment (steve.design.posed_motions) and the metadata says so (`posed`: what was asked and the values it set).
    With `contour_source` (inspect_model's result) it draws a simulation result's contour instead (render_contour)."""
    if request.get('contour_source') is not None:
        return render_contour(request)
    if request.get('mesh_source') is not None:
        return render_picture(request)
    name = request.get('view_source')
    if not isinstance(name, str) or not VIEW_SOURCE.fullmatch(name) or not (Path('imports') / name).is_file():
        raise ValueError('A views job needs the build\'s STEP as its input.')
    show, hide = visibility_names(request.get('show'), 'show'), visibility_names(request.get('hide'), 'hide')
    posed = motions = None
    if request.get('motion') is not None:
        asked, kinematics = motion_request(request['motion'])
        from steve.design import posed_motions
        motions, values = posed_motions(kinematics, **asked)
        posed = {**asked, 'values': {target: round(value, 6) for target, value in sorted(values.items())}}
        if 'explode' in asked:   # Where each part it moves is then, from where it's built (mm).
            from steve.explodes import offsets
            posed['moved'] = {path: [round(v, 3) + 0.0 for v in offset] for path, offset in
                              sorted(offsets(kinematics['explodes'][0], asked['t']).items())}
    views = request.get('views', list(VIEWS))
    if not isinstance(views, list) or not views or any(view not in VIEWS for view in views):
        raise ValueError(f'A views job\'s views are some of {", ".join(VIEWS)}.')
    for view in VIEWS:
        Path(f'view-{view}.png').unlink(missing_ok=True)
    clock = time.monotonic()
    from steve import progress
    progress.stage('views')
    import screenshots
    drawn = screenshots.main(str(Path('imports') / name), show=show, hide=hide, views=views, motions=motions)
    available = [view for view in VIEWS if Path(f'view-{view}.png').is_file()]
    return {'inspection_views': view_record(available, None if available else 'The renderer produced no views.'),
            **({'drawn': drawn} if drawn is not None else {}), **({'posed': posed} if posed is not None else {}),
            'timings_ms': {'views': round((time.monotonic() - clock) * 1000)}}


def render_picture(request):
    """A views job's link-preview picture (app/derivations.py kind "picture"): picture.png, one isometric view drawn from
    the build's meshes (the input named `mesh_source`, its sha256 checked), never from a STEP export."""
    name = request.get('mesh_source')
    path = Path('imports') / name if isinstance(name, str) and MESH_SOURCE.fullmatch(name) else None
    if path is None or not path.is_file():
        raise ValueError('A picture job needs the build\'s meshes as its input.')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
    if digest.hexdigest() != name.removesuffix('.glb'):
        raise ValueError('The meshes arrived changed.')
    Path('picture.png').unlink(missing_ok=True)
    clock = time.monotonic()
    from steve import progress
    progress.stage('views')
    import screenshots
    screenshots.picture(path)
    return {'picture': Path('picture.png').is_file(), 'timings_ms': {'views': round((time.monotonic() - clock) * 1000)}}


def render_contour(request):
    """A views job's simulation result contour (app/result_views.py, app/features/contour.py): one view of the field in
    the input named `contour_source` (its sha256, checked), and in `drawn` what it shows (regions, extent, the numbers)."""
    name = request.get('contour_source')
    path = Path('imports') / name if isinstance(name, str) and CONTOUR_SOURCE.fullmatch(name) else None
    if path is None or not path.is_file():
        raise ValueError('A contour job needs the result as its input.')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
    if digest.hexdigest() != name.removesuffix('.contour'):
        raise ValueError('The result input arrived changed.')
    views = request.get('views')
    if not isinstance(views, list) or len(views) != 1 or views[0] not in VIEWS:
        raise ValueError(f'A contour job draws one of {", ".join(VIEWS)}.')
    Path(f'view-{views[0]}.png').unlink(missing_ok=True)
    clock = time.monotonic()
    from steve import progress
    progress.stage('views')
    from app.features import contour
    drawn = contour.main(str(path), views[0])
    available = [views[0]] if Path(f'view-{views[0]}.png').is_file() else []
    return {'inspection_views': view_record(available, None if available else 'The renderer produced no contour.'),
            'drawn': drawn, 'timings_ms': {'views': round((time.monotonic() - clock) * 1000)}}


def safe_metrics(shape):
    """The history check's measurements of a shape, or None when the kernel can't measure it (a null shape)."""
    try:
        return trace.metrics(shape)
    except Exception:
        return None


RESTORED = "This build reused the part's geometry from an earlier build of the same geometry (only its looks changed), so it ran once and wasn't compared with a second run."


def offered_geometry() -> bool:
    """Whether this build was sent an earlier build's geometry for the part (steve.model part_record; the kernel puts
    it in STEVE_PART_CACHE)."""
    folder = os.environ.get("STEVE_PART_CACHE")
    return bool(folder) and Path(folder).is_dir() and any(Path(folder).glob("*.json"))


def restored(result) -> bool:
    """Whether the part's own model behind `result` was restored from that geometry rather than built."""
    try:
        from steve.model import part_restored
    except ImportError:
        return False
    return part_restored(getattr(result, "_steve_model", None))


def build(request):
    if request["kind"] != "part":
        return cad_build(request)
    plan = analyze(request["code"])
    if plan.status != "supported":
        from app.features.recorder import Recorder
        trace.reset(None)
        offered = offered_geometry()
        if not offered:
            first = cad_build({**request, "code": request["code"] + FINISH, "_final": False})
            if first.get("empty"):  # Nothing modelled yet: no geometry to record or compare.
                return first
            original = trace.final_shape
        with Recorder(request["code"]) as recorder:
            metadata = cad_build({**request, "code": request["code"] + FINISH})
        if offered and restored(trace.final_result):
            # The part's geometry came from an earlier build of the same geometry code (only its looks changed): it ran
            # once, so there is no second run to check this one against.
            equivalence = {'passed': False, 'message': RESTORED,
                           'original': None, 'instrumented': safe_metrics(trace.final_shape)}
            metadata["feature_tree"] = recorder.public(trace.final_result, equivalence)
            if equivalence["instrumented"]:
                metadata["bounds_mm"] = equivalence["instrumented"]["bounds_mm"]
            return metadata
        if offered:  # It couldn't restore, so it built: the uninstrumented run to check it against comes second.
            if metadata.get("empty"):
                return metadata
            shape, result = trace.final_shape, trace.final_result
            cad_build({**request, "code": request["code"] + FINISH, "_final": False})
            original, trace.final_shape, trace.final_result = trace.final_shape, shape, result
        run.stage("history check")
        try:
            equivalence = trace.compare(original, trace.final_shape)
        except FeatureError as error:
            # Stateful/random user code may produce different valid solids on
            # replay. Keep the generated model, but never label its history verified.
            recorder.gap('unverified_replay', 'Repeated execution produced different geometry; captured history is unverified.')
            equivalence = {'passed': False, 'message': str(error),
                           'original': safe_metrics(original), 'instrumented': safe_metrics(trace.final_shape)}
        except Exception:
            # The kernel failed inside the check itself (e.g. a null shape after a failed feature): the model is
            # still built, its history just isn't verified. The message names the check, never the geometry.
            recorder.gap('unverified_replay', 'The history check could not compare the two executions; captured history is unverified.')
            equivalence = {'passed': False, 'message': 'The history check could not compare the two executions.',
                           'original': safe_metrics(original), 'instrumented': safe_metrics(trace.final_shape)}
        metadata["feature_tree"] = recorder.public(trace.final_result, equivalence)
        if equivalence["instrumented"]:
            metadata["bounds_mm"] = equivalence["instrumented"]["bounds_mm"]
        return metadata
    trace.reset(plan)
    first = cad_build({**request, "code": request["code"] + FINISH, "_final": False})
    if first.get("empty"):
        return first
    original = trace.final_shape
    metadata = cad_build({**request, "code": instrument(plan) + FINISH})
    run.stage("history check")
    equivalence = trace.compare(original, trace.final_shape)
    if len(trace.events) != len(plan.features):
        raise ValueError("Not every supported source feature executed.")
    tree = plan.public()
    tree["execution_verified"] = True
    for feature, event in zip(tree["features"], trace.events):
        feature["executed"] = True
        feature["execution"] = event
    tree["equivalence"] = equivalence
    metadata["feature_tree"] = tree
    metadata["bounds_mm"] = equivalence["instrumented"]["bounds_mm"]
    return metadata


def run_request(request, started=None):
    """Runs one build in the current directory; returns its metadata and the artifact files it wrote.

    mode "full" (default): execute (twice with captured feature history for parts), GLB and topology; the STEP export,
    inspection views, manufacturing facts and print meshes are deferred. mode "step": execute once and write the STEP
    export (result.step; a design's components-step.zip too) only. mode "preview": execute once; coarse GLB, topology and metadata only.
    mode "drawing": execute once and draw the code's sheets only (drawing.svg, drawings.zip; the Drawing tab's edits). mode "views": the four inspection views of a full build's STEP (with `mesh_source`, the link-preview picture from its meshes). mode "manufacturing": execute once and write the
    manufacturing facts only. mode "topology": execute once and describe the viewer topology with the whole time limit
    (the build's preview mesh again, at its tessellation `topology_of`). mode "print_mesh": execute once and write the
    print-grade meshes (bodies-mesh.zip) only. `started` is the job's time.monotonic() start; time budgets count from it.
    """
    global STARTED
    STARTED = run.STARTED = time.monotonic() if started is None else started
    source = {key: request.get(key) for key in ('kind','code','files','links','imports')}
    request = {**request, '_source_sha256': hashlib.sha256(json.dumps(source, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
    mode = request.get("mode", "full")
    engine = run.engine_info()  # Read before the design's code runs, so nothing it does can change what the credits link.
    if request.get("kind") == "cam":
        # A CAM program builds its program as data (runtime/run.py cam_build); running it is the server's.
        if mode not in {"preview", "full"}:
            raise ValueError(f"A CAM program has no {mode} build: it builds the program, not geometry.")
        metadata = run.cam_build(request)
        metadata.setdefault("timings_ms", {})["total"] = round((time.monotonic() - STARTED) * 1000)
        return {"metadata": metadata, "artifacts": {}}
    if request.get("kind") == "shop":
        # A shop builds library records, not geometry (runtime/run.py shop_build): the same in every mode it is sent.
        if mode not in {"preview", "full"}:
            raise ValueError(f"A shop has no {mode} build: it builds manufacturing library records, not geometry.")
        metadata = run.shop_build(request)
        metadata.setdefault("timings_ms", {})["total"] = round((time.monotonic() - STARTED) * 1000)
        return {"metadata": metadata, "artifacts": {}}
    if mode in {"preview", "drawing", "simulation", "manufacturing", "topology", "print_mesh", "step"}:
        metadata = cad_build(request)
    elif mode == "full":
        metadata = build(request)
        deferred_views(metadata)
    elif mode == "views":
        metadata = render_views(request)
    else:
        raise ValueError(f"Unknown build mode {mode!r}.")
    if "cadquery_version" in metadata:
        metadata.update(engine)
    timings = metadata.setdefault("timings_ms", {})
    if mode != "views":  # views run no design code
        timings.update(run.compat_uses(request))
    timings["total"] = round((time.monotonic() - STARTED) * 1000)
    return {"metadata": metadata, "artifacts": {name: str(Path(name).resolve()) for name in ARTIFACTS if Path(name).is_file()}}


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.readline())
        metadata = run_request(request, started=STARTED)["metadata"]
        Path("result.json").write_text(json.dumps({"ok": True, "metadata": metadata}))
    except BaseException:
        error = traceback.format_exc()
        Path("result.json").write_text(json.dumps({"ok": False, "error": error[-12000:]}))
        print(error, file=sys.stderr)
        sys.exit(1)
