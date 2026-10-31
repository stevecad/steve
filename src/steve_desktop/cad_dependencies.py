"""Conservative dependency planning for isolated Studio component preparation.

This is an optimization eligibility check, not a Python security sandbox. Source
outside the supported declarative subset must keep its ordinary serial behavior.
"""
import ast
from steve_desktop.cad_document import validate
from steve.cachekeys import closure


BUILTINS = {'range', 'enumerate', 'zip', 'len', 'abs', 'min', 'max', 'round',
            'float', 'int', 'str', 'tuple', 'list', 'dict', 'sorted', 'sum'}
METHODS = {
    'box', 'cylinder', 'cone', 'sphere', 'torus', 'sketch', 'rect', 'circle',
    'line', 'arc', 'polyline', 'polygon', 'spline', 'ellipse', 'slot', 'point',
    'extrude', 'revolve', 'sweep', 'loft', 'hole', 'fillet', 'chamfer', 'shell',
    'draft', 'add', 'cut', 'union', 'intersect', 'mirror', 'rotate', 'translate',
    'pattern', 'linear_pattern', 'circular_pattern', 'face', 'edge', 'vertex',
    'ref', 'shape', 'result', 'material', 'appearance', 'decal', 'plane',
    'sheet_base', 'sheet_flange', 'sheet_bend', 'sheet_cut', 'sheet_rip',
    'sheet_hem', 'sheet_jog', 'sheet_tab', 'sheet_corner', 'sheet_relief',
    'sheet_contour', 'sheet_form', 'constraint', 'dimension', 'add_component',
}
MATH = {'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'hypot',
        'radians', 'degrees', 'floor', 'ceil', 'fabs', 'pow', 'pi', 'tau', 'e'}


def _inspect(path, files):
    tree = ast.parse(files[path])
    constructors, math_names, math_modules = set(), set(), set()
    component_constructors = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level or any(a.name == '*' for a in node.names):
                raise ValueError('relative or wildcard import')
            module = node.module or ''
            base = module.replace('.', '/')
            local = base + '.py' in files or any(base + '/' + a.name + '.py' in files for a in node.names)
            if module == 'steve':
                if any(a.name not in {'Component', 'Design', 'Model', 'SheetMetalRule'} for a in node.names):
                    raise ValueError('non-declarative runtime import')
                constructors.update(a.asname or a.name for a in node.names)
                component_constructors.update(a.asname or a.name for a in node.names if a.name == 'Component')
            elif module == 'math':
                if any(a.name not in MATH for a in node.names):
                    raise ValueError('unsupported math import')
                math_names.update(a.asname or a.name for a in node.names)
            elif not local:
                raise ValueError('external or missing dependency: ' + module)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == 'math':
                    math_modules.add(alias.asname or alias.name)
                elif alias.name.replace('.', '/') + '.py' not in files:
                    raise ValueError('external or missing dependency: ' + alias.name)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef,
                               ast.Lambda, ast.Global, ast.Nonlocal, ast.While,
                               ast.Try, ast.Delete, ast.Await, ast.Yield)):
            raise ValueError('runtime-dependent Python')
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith('_') or not isinstance(node.ctx, ast.Load):
                raise ValueError('attribute mutation or introspection')
        elif isinstance(node, ast.Subscript) and not isinstance(node.ctx, ast.Load):
            raise ValueError('shared data mutation')
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        call = node.func
        if isinstance(call, ast.Name) and call.id in BUILTINS | constructors | math_names:
            continue
        if isinstance(call, ast.Attribute):
            if call.attr in METHODS:
                continue
            if isinstance(call.value, ast.Name) and call.value.id in math_modules and call.attr in MATH:
                continue
        raise ValueError('runtime-dependent call')
    components = [node for node in tree.body if isinstance(node, ast.Assign)
                  and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                  and node.value.func.id in component_constructors]
    if len(components) > 1:
        # Studio's file-based cache represents a single Component per file.
        raise ValueError('multiple components in one file')
    return bool(components)


def component_plan(document):
    """Return dependency levels; unsupported source gets an explicit serial reason."""
    validate(document)
    if document['kind'] != 'design':
        return {'levels': [], 'reason': 'not an assembly'}
    files = {**document.get('files', {}), 'model.py': document['code']}
    reachable = closure(files, 'model.py')
    candidates = set()
    try:
        for path in reachable:
            if path.endswith('.py') and _inspect(path, files):
                if path == 'model.py':
                    raise ValueError('inline component')
                candidates.add(path)
    except (SyntaxError, ValueError) as exc:
        return {'levels': [], 'reason': str(exc)}
    dependencies = {path: (set(closure(files, path)) & candidates) - {path} for path in candidates}
    pending, levels = set(candidates), []
    while pending:
        ready = sorted(path for path in pending if not dependencies[path] & pending)
        if not ready:
            return {'levels': [], 'reason': 'cyclic component dependencies'}
        levels.append(ready)
        pending.difference_update(ready)
    return {'levels': levels, 'reason': None, 'dependencies': {k: sorted(v) for k, v in sorted(dependencies.items())}}
