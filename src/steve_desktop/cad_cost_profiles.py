"""Versioned local timing observations for structurally comparable components."""
import ast
import copy
import hashlib
import json
import math
import marshal
import threading
import types
from functools import lru_cache
from pathlib import Path
from steve_desktop.cad_service import atomic_json
from steve.cachekeys import closure, component_key
from steve_desktop.cad_cache import code_signature, read_entry

_lock = threading.RLock()


@lru_cache(maxsize=1)
def profile_version():
    from steve_desktop import cad_kernel, cad_costs
    from steve_desktop.paths import RESOURCE_ROOT
    digest = hashlib.sha256(b'steve-cost-profile-1')
    for module in (cad_kernel, cad_costs):
        for name, function in sorted(vars(module).items()):
            if isinstance(function, types.FunctionType) and function.__module__ == module.__name__:
                digest.update(name.encode())
                digest.update(marshal.dumps(code_signature(function.__code__)))
    for path in sorted((RESOURCE_ROOT / 'vendor' / 'steve').rglob('*.py')):
        digest.update(path.read_bytes())
    return digest.hexdigest()


def context_key(document):
    values = {name: document.get(name) for name in ('links', '_imports_map', 'imports', 'materials')}
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def family_key(document, path):
    files = document.get('files', {})
    trees = {name: ast.parse(files[name]) for name in closure(files, path) if name.endswith('.py')}
    controls = set()
    assignments = []
    for tree in trees.values():
        for node in ast.walk(tree):
            if isinstance(node, (ast.For, ast.comprehension, ast.If, ast.IfExp)):
                expression = node.iter if isinstance(node, (ast.For, ast.comprehension)) else node.test
                controls.update(n.id if isinstance(n, ast.Name) else n.attr for n in ast.walk(expression)
                                if isinstance(n, (ast.Name, ast.Attribute)))
            if isinstance(node, ast.Assign):
                assignments.append(node)
    # A changed loop count or branch condition is not comparable work. Track
    # those controlling values transitively through parameter assignments.
    while True:
        previous = set(controls)
        for node in assignments:
            if any(isinstance(target, ast.Name) and target.id in controls for target in node.targets):
                controls.update(n.id for n in ast.walk(node.value) if isinstance(n, ast.Name))
        if previous == controls:
            break

    class Normalize(ast.NodeTransformer):
        def visit_Constant(self, node):
            if isinstance(node.value, (float, int)) and not isinstance(node.value, bool):
                return ast.copy_location(ast.Constant(value='numeric-parameter'), node)
            return node

        def visit_Assign(self, node):
            if any(isinstance(target, ast.Name) and target.id in controls for target in node.targets):
                return node
            return self.generic_visit(node)

        def visit_For(self, node):
            iterator = copy.deepcopy(node.iter)
            self.generic_visit(node)
            node.iter = iterator
            return node

        visit_comprehension = visit_For

        def visit_If(self, node):
            test = copy.deepcopy(node.test)
            self.generic_visit(node)
            node.test = test
            return node

        visit_IfExp = visit_If

    normalized = [(name, ast.dump(Normalize().visit(copy.deepcopy(tree)), include_attributes=False))
                  for name, tree in sorted(trees.items())]
    # Tables influence geometry and sometimes pattern counts; do not extrapolate
    # timing across a table change.
    normalized += [(name, text) for name, text in sorted(files.items()) if name.endswith('.csv')]
    return hashlib.sha256(json.dumps(normalized, separators=(',', ':')).encode()).hexdigest()


def _load(root):
    try:
        value = json.loads((Path(root) / 'cost-profiles.json').read_text(encoding='utf-8'))
        if value.get('version') == profile_version() and isinstance(value.get('entries'), dict):
            return value
    except (OSError, ValueError, TypeError):
        pass
    return {'version': profile_version(), 'entries': {}}


def record_costs(root, document, observations):
    if not observations:
        return
    with _lock:
        value = _load(root)
        for item in observations:
            path = item.get('file')
            if path not in document.get('files', {}):
                continue
            family = family_key(document, path)
            old = value['entries'].get(family, {})
            if old.get('context') != context_key(document):
                old = {}
            valid = lambda number: isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number) and number >= 0
            if not valid(item.get('geometry_seconds')) or not valid(item.get('write_seconds')):
                continue
            updated = {**old, 'geometry_seconds': item['geometry_seconds'], 'context': context_key(document),
                       'runtime_version': item.get('runtime_version'), 'cache_version': item.get('cache_version'),
                       'samples': old.get('samples', 0) + 1}
            if item.get('cache') == 'miss':
                updated['write_seconds'] = item['write_seconds']
            if valid(item.get('restore_seconds')):
                updated['restore_seconds'] = item['restore_seconds']
            # Require an actual observation of restoration rather than guessing
            # that a large BREP is cheap to reload.
            value['entries'][family] = updated
        value['entries'] = dict(list(value['entries'].items())[-4096:])
        Path(root).mkdir(parents=True, exist_ok=True)
        atomic_json(Path(root) / 'cost-profiles.json', value)


def observed_costs(root, document, paths):
    if not paths:
        return {}, []
    with _lock:
        value = _load(root)
    costs, missing = {}, []
    for path in paths:
        item = value['entries'].get(family_key(document, path), {})
        if item.get('context') != context_key(document) or not item.get('runtime_version'):
            missing.append(path)
            continue
        key = component_key(document.get('files', {}), path, item['runtime_version'])
        if read_entry(Path(root), key, item.get('cache_version')) is not None:
            continue
        missing.append(path)
        costs[path] = item
    return costs, missing
