"""Subprocess CAD kernel: Studio Python runtime, exact BRep and upstream display mesh."""

from steve_desktop.paths import RESOURCE_ROOT
import json
import sys
from pathlib import Path
from steve_desktop.cad_document import validate


def native_meshing():
    """Parallelize native meshing within this job's share of the CPU budget.

    Modeling booleans retain Studio's serial policy for reproducible geometry.
    The shared process supervisor still enforces the aggregate CPU ceiling.
    """
    import os
    import cadquery as cq
    from cadquery.occ_impl.shapes import _mesh
    from OCP.OSD import OSD_ThreadPool, OSD_Parallel
    threads = max(1, min(os.cpu_count() or 1, int(os.environ.get('STEVE_LOCAL_THREADS', max(1, (os.cpu_count() or 1)*80//100)))))
    OSD_Parallel.SetUseOcctThreads_s(True)
    OSD_ThreadPool.DefaultPool_s().Init(threads)
    def mesh(shape, tolerance, angularTolerance=.1):
        _mesh(shape.wrapped, tolerance, True, angularTolerance, parallel=threads > 1)
    cq.Shape.mesh = mesh
    return threads


def local_runtime(runtime):
    """Local CAD ends on completion/cancellation, without SaaS job time budgets."""
    threads = native_meshing()
    # Upstream disarms POSIX alarms even outside timed_topology. Windows has no
    # setitimer; the parent process owns cancellation on every platform.
    import os
    # Upstream's topology/check parallelism uses POSIX fork with inherited OCP
    # objects. Enable the allocated CPUs where supported; Windows cannot fork.
    runtime.TOPOLOGY_WORKERS = 1 if os.name == 'nt' else threads
    runtime.job_cpus = lambda: 1 if os.name == 'nt' else threads
    # Use Studio's PDF faces on every host, independent of installed OS fonts.
    os.environ['STEVE_PDF_FONTS'] = str(RESOURCE_ROOT / 'pdf-fonts')
    if os.name == 'nt':
        runtime.signal.setitimer = lambda *args: None
        runtime.signal.ITIMER_REAL = 0
    runtime.check_deadline = lambda request: float('inf')
    runtime.timed_topology = lambda assembly, tessellation, request, **kwargs: runtime.write_topology(assembly, mode=tessellation) or 'complete'
    import steve.design as design_runtime
    # These checks otherwise fork timed SaaS children (unsupported on Windows).
    # Run their exact operations in this cancellable, disposable CAD process.
    design_runtime._workers = lambda: 1 if os.name == 'nt' else threads
    design_runtime._bounded = lambda work, a, b, deadline: work(a, b)
    from steve_desktop.cad_costs import install_timing
    install_timing()


def build(document, folder):
    import cadquery as cq
    import os
    import upstream_runtime
    validate(document)
    folder = Path(folder).resolve()
    os.chdir(folder)
    upstream_runtime.enable_old_ocp_names()
    if document.get('_imports_dir'):
        from steve import imports
        imports.register(document.get('_imports_map', {}), document['_imports_dir'])
    local_runtime(upstream_runtime)
    # Retain the result of upstream's one source execution for local BREP/export
    # and inspection. Model creation, validation and metadata remain upstream.
    import builtins
    namespace = {}
    def capture(code, globals):
        builtins.exec(code, globals)
        namespace.update(globals)
    upstream_runtime.exec = capture
    request = {**document, 'timeout': float('inf'), 'mode': 'full' if document.get('mode') == 'drawing' else document.get('mode', 'preview')}
    report = upstream_runtime.build(request)
    from steve_desktop.cad_costs import component_costs
    report['local_component_costs'] = component_costs()
    result = namespace.get('result')
    if getattr(result, '_steve_empty', False):
        metadata = {'valid': True, 'empty': True, 'units': 'mm', 'volume': 0, 'area': 0, 'solids': 0,
                    'center': [0, 0, 0], 'bounds': [0, 0, 0, 0, 0, 0], 'size': [0, 0, 0],
                    'features': [], 'faces': [], 'edges': [], 'upstream': report.get('modeling')}
        (folder / 'geometry.json').write_text(json.dumps(metadata), encoding='utf-8')
        (folder / 'studio-metadata.json').write_text(json.dumps(report), encoding='utf-8')
        (folder / 'topology.json').write_text('{"version":1,"units":"mm","meshes":{}}', encoding='utf-8')
        return metadata
    assembly = result if isinstance(result, cq.Assembly) else None
    if assembly is not None:
        shape = assembly.toCompound()
    elif isinstance(result, cq.Workplane):
        shape = cq.Compound.makeCompound(result.vals()) if len(result.vals()) > 1 else result.val()
    elif isinstance(result, cq.Shape):
        shape = result
    else:
        raise ValueError('Assign a CadQuery shape or assembly to result.')
    if not shape.isValid():
        raise ValueError('The build produced invalid geometry.')
    model = namespace.get('model') or namespace.get('design')
    summary = model.summary() if model is not None and hasattr(model, 'summary') else {}
    refs = model.refs(shape) if model is not None and hasattr(model, 'refs') else {}
    feature_info = summary.get('features', [])
    if assembly is not None:
        assembly.export(str(folder / 'assembly.step'))
    shape.exportBrep(str(folder / 'model.brep'))
    # Exact inspection metadata. The Studio viewer uses preview.glb/topology.json;
    # do not tessellate a second mesh or sample polylines for the retired Qt view.
    faces, edges = [], []
    from steve.reporting import surface_area
    for index, face in enumerate(shape.Faces()):
        item = {'id': f'face:{index}', 'reference': refs.get('faces', {}).get(face), 'type': face.geomType(), 'area': surface_area(face),
                'center': face.Center().toTuple()}
        if face.geomType() == 'PLANE':
            item['normal'] = face.normalAt().toTuple()
        faces.append(item)
    for index, edge in enumerate(shape.Edges()):
        item = {'id': f'edge:{index}', 'reference': refs.get('edges', {}).get(edge), 'type': edge.geomType(), 'length': edge.Length(),
                'center': edge.Center().toTuple()}
        if edge.geomType() == 'CIRCLE':
            item['radius'] = edge.radius()
        edges.append(item)
    from steve.simulation import bounds as exact_bounds
    box = exact_bounds(shape)
    bounds = shape.BoundingBox()
    metadata = {'valid': True, 'units': 'mm', 'volume': report['volume_mm3'], 'area': report['surface_area_mm2'],
                'solids': len(shape.Solids()), 'center': report['center_of_mass_mm'],
                'bounds': [box[0], box[3], box[1], box[4], box[2], box[5]], 'upstream': summary,
                'size': [box[3]-box[0], box[4]-box[1], box[5]-box[2]], 'features': feature_info,
                'faces': faces, 'edges': edges}
    (folder / 'geometry.json').write_text(json.dumps(metadata), encoding='utf-8')
    report['cadquery_source'] = {'url': 'https://github.com/10-X-eng/cadquery', 'commit': '6a8cf4fb3edfc2da1575a3885a896da8b7924c75'}
    report.update(ocp_version='8.0.1.1.0', occt_version='8.0.1')
    from steve.reporting import face_area
    report['local_area_cache'] = face_area.cache_info()
    if document.get('mode') == 'full' and shape.Solids():
        import time
        report['body_meshes'] = upstream_runtime.write_body_meshes(result, float('inf'))
        if assembly is not None:
            report['component_steps'] = upstream_runtime.write_component_steps(assembly, float('inf'))
    (folder / 'studio-metadata.json').write_text(json.dumps(report), encoding='utf-8')
    return metadata


def export(folder, destination, kind):
    import cadquery as cq
    from cadquery import occ_compat
    occ_compat.enable()
    if kind == 'STEP' and (Path(folder) / 'assembly.step').exists():
        import shutil
        shutil.copyfile(Path(folder) / 'assembly.step', destination)
        return
    shape = cq.Shape.importBrep(str(Path(folder) / 'model.brep'))
    cq.exporters.export(shape, str(destination), exportType=kind)


def prepare_component(document, folder, path):
    """Populate Studio's component cache without meshing or exporting an assembly."""
    import importlib
    import os
    import upstream_runtime
    from steve import design
    os.chdir(folder)
    upstream_runtime.enable_old_ocp_names()
    local_runtime(upstream_runtime)
    if document.get('_imports_dir'):
        from steve import imports
        imports.register(document.get('_imports_map', {}), document['_imports_dir'])
    from steve.cachekeys import closure
    files = document.get('files', {})
    required = set(closure(files, path))
    # Only this dependency closure is imported in an isolated component job.
    # Keep shared table/image inputs; avoid rewriting every unrelated source file
    # for every component in a large assembly. The outer cache context still uses
    # the complete original document when computing its runtime/input version.
    local_files = {name: text for name, text in files.items() if name in required or not name.endswith('.py')}
    upstream_runtime._prepare({**document, 'files': local_files})
    importlib.import_module(path[:-3].replace('/', '.'))
    found = []
    for component in design._COMPONENTS:
        if component.file == path:
            shape = component.shape()
            if shape is not None and not shape.isValid():
                raise ValueError('Component preparation produced invalid geometry: ' + path)
            if not component._cacheable or not component._key:
                raise ValueError('Component is not independently cacheable: ' + path)
            component.save_to_cache()
            found.append(component.id)
    if len(found) != 1:
        raise ValueError('Expected one cacheable component in ' + path)
    return found


def serve(directory):
    import gc
    import importlib
    import os
    import time
    import cadquery
    from cadquery import occ_compat
    occ_compat.enable()
    import upstream_runtime
    import steve
    folder = Path(directory).resolve()
    base_path = list(sys.path)
    environment = dict(os.environ)
    original_cwd = Path.cwd()
    original_stdout, original_stderr = sys.stdout, sys.stderr
    (folder / 'ready').write_text(str(os.getpid()))
    while True:
        request = folder / 'request.json'
        if not request.exists():
            time.sleep(.01)
            continue
        try:
            payload = json.loads(request.read_text(encoding='utf-8'))
            request.unlink()
        except PermissionError:
            time.sleep(.01)
            continue
        args = payload['args']
        os.environ['STEVE_LOCAL_THREADS'] = str(max(1, min(os.cpu_count() or 1, int(payload.get('native_threads', 1)))))
        os.environ['STEVE_AREA_CACHE_WORKERS'] = str(max(0, int(payload.get('cache_workers', 0))))
        job_root = Path(args[2]).parent if args[0] == 'inspect-import' else Path(args[1])
        started = time.monotonic()
        code = main(args)
        error_file = job_root / 'worker-error.txt'
        error = error_file.read_text(encoding='utf-8') if error_file.exists() else ''
        # The pool retires this process after its operation. Publish completed
        # work before legacy reuse cleanup so callers do not wait for garbage
        # collection of an interpreter they will immediately discard.
        response = folder / (payload['id'] + '.json')
        temporary = response.with_suffix('.tmp')
        temporary.write_text(json.dumps({'code': code, 'error': error, 'seconds': time.monotonic()-started}), encoding='utf-8')
        temporary.replace(response)
        # Retain loaded CAD binaries and numerical libraries, reset document runtime
        # registries and user modules. Each job still has its own source namespace.
        sys.stdout, sys.stderr = original_stdout, original_stderr
        os.chdir(original_cwd)
        sys.path[:] = base_path
        os.environ.clear()
        os.environ.update(environment)
        for name, module in list(sys.modules.items()):
            filename = getattr(module, '__file__', None)
            local = False
            if filename:
                try: local = Path(filename).resolve().is_relative_to(job_root.resolve())
                except (ValueError, OSError): pass
            if name == 'steve' or name.startswith('steve.') or name == 'upstream_runtime' or local:
                sys.modules.pop(name, None)
        importlib.invalidate_caches()
        gc.collect()


def main(args):
    try:
        if args[0] == 'serve':
            serve(args[1])
        elif args[0] == 'build':
            folder = Path(args[1])
            document = json.loads((folder / 'document.json').read_text(encoding='utf-8'))
            from steve_desktop.cad_cache import component_cache
            with component_cache(folder, args[2] if len(args) > 2 else None, document):
                build(document, folder)
        elif args[0] == 'component-plan':
            folder = Path(args[1]).resolve()
            document = json.loads((folder / 'document.json').read_text(encoding='utf-8'))
            paths = json.loads((folder / 'paths.json').read_text(encoding='utf-8'))
            from steve_desktop.cad_cache import runtime_version, read_entry
            from steve.cachekeys import component_key
            from steve.design import CACHE_VERSION
            version = runtime_version(document)
            keys = {path: component_key(document.get('files', {}), path, version) for path in paths}
            missing = [path for path, key in keys.items() if not key or read_entry(Path(args[2]), key, CACHE_VERSION) is None]
            (folder / 'component-plan.json').write_text(json.dumps({'missing': missing, 'keys': keys}), encoding='utf-8')
        elif args[0] == 'component':
            import time
            folder = Path(args[1]).resolve()
            document = json.loads((folder / 'document.json').read_text(encoding='utf-8'))
            from steve_desktop.cad_cache import component_cache
            started = time.time()
            with component_cache(folder, args[2], document):
                found = prepare_component(document, folder, args[3])
                from steve_desktop.cad_costs import component_costs
                costs = component_costs()
            (folder / 'component-result.json').write_text(json.dumps({'components': found, 'costs': costs, 'started_at': started, 'finished_at': time.time()}), encoding='utf-8')
        elif args[0] == 'derive':
            import os
            import upstream_runtime
            folder = Path(args[1]).resolve()
            os.chdir(folder)
            document = json.loads((folder / 'document.json').read_text(encoding='utf-8'))
            upstream_runtime.enable_old_ocp_names()
            from steve import imports
            if document.get('_imports_dir'):
                imports.register(document.get('_imports_map', {}), document['_imports_dir'])
            local_runtime(upstream_runtime)
            from steve_desktop.cad_cache import component_cache
            with component_cache(folder, args[2] if len(args) > 2 else None, document):
                report = upstream_runtime.build({**document, 'timeout': float('inf')})
            (folder / 'derivation.json').write_text(json.dumps(report), encoding='utf-8')
        elif args[0] == 'export':
            export(args[1], args[2], args[3])
        elif args[0] == 'inspect-import':
            import cadquery as cq
            from cadquery import occ_compat
            occ_compat.enable()
            from steve import imports
            from steve.simulation import bounds
            path = Path(args[1])
            ref = path.stem
            imports.register({ref: ref}, path.parent)
            solids = imports.solids(ref)
            if not solids:
                raise ValueError('No solids in this file.')
            shape = cq.Compound.makeCompound([solid for solid, _ in solids])
            box = bounds(shape)
            report = {'solids': len(solids), 'faces': len(shape.Faces()), 'solid_names': [name for _, name in solids],
                      'bounds_mm': [box[3]-box[0], box[4]-box[1], box[5]-box[2]], 'volume_mm3': shape.Volume(), 'format': imports.kind(ref)}
            Path(args[2]).write_text(json.dumps(report), encoding='utf-8')
        return 0
    except Exception as exc:
        # Windowed executables may not have inherited console streams. Keep the
        # diagnostic beside this job so the parent can always display it.
        if len(args) > 1:
            folder = Path(args[2]).parent if args[0] == 'inspect-import' else Path(args[1])
            if folder.is_dir():
                (folder / 'worker-error.txt').write_text(str(exc)[-4000:], encoding='utf-8')
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
