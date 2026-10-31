"""Validated local storage for Studio's unchanged component/topology cache format."""
import hashlib
import json
import os
import marshal
import re
import sys
import types
import uuid
from contextlib import contextmanager
from pathlib import Path

KEY = re.compile(r'[0-9a-f]{64}')


def code_signature(code):
    return (code.co_code, code.co_names, code.co_varnames,
            tuple(code_signature(value) if isinstance(value, types.CodeType) else value for value in code.co_consts))


def runtime_version(document):
    from steve import design
    import OCP
    digest = hashlib.sha256(design._runtime_hash().encode())
    digest.update(str(OCP.__version__).encode())
    # Imported assets, pinned links and custom material definitions are inputs
    # beyond a component's own source dependency closure.
    inputs = {name: document.get(name) for name in ('links', '_imports_map', 'imports', 'materials')}
    digest.update(json.dumps(inputs, sort_keys=True, separators=(',', ':')).encode())
    # Match source and frozen builds; invalidate after an adapter implementation
    # changes, without depending on source files being present beside the EXE.
    from steve_desktop import cad_kernel
    for module in (sys.modules[__name__], cad_kernel):
        for name, function in sorted(vars(module).items()):
            if isinstance(function, types.FunctionType) and function.__module__ == module.__name__:
                function = getattr(function, '__wrapped__', function)
                digest.update(name.encode())
                digest.update(marshal.dumps(code_signature(function.__code__)))
    return digest.hexdigest()


def read_entry(root, key, version):
    if not KEY.fullmatch(key):
        return None
    try:
        data = (root / (key + '.json')).read_bytes()
        expected = (root / (key + '.sha256')).read_text(encoding='ascii').strip()
        if hashlib.sha256(data).hexdigest() != expected:
            return None
        record = json.loads(data)
        return record if isinstance(record, dict) and record.get('version') == version else None
    except (OSError, ValueError, RecursionError):
        return None


def publish(out, root, version):
    root.mkdir(parents=True, exist_ok=True)
    for source in out.glob('*.json'):
        if not KEY.fullmatch(source.stem):
            continue
        data = source.read_bytes()
        record = json.loads(data)
        if not isinstance(record, dict) or record.get('version') != version:
            continue
        checksum = hashlib.sha256(data).hexdigest()
        pending = root / ('.' + uuid.uuid4().hex)
        pending_digest = pending.with_suffix('.sha256')
        try:
            pending.write_bytes(data)
            pending_digest.write_text(checksum, encoding='ascii')
            pending.replace(root / source.name)
            pending_digest.replace(root / (source.stem + '.sha256'))
        finally:
            pending.unlink(missing_ok=True)
            pending_digest.unlink(missing_ok=True)


@contextmanager
def component_cache(folder, cache_root, document):
    """Each worker writes privately; publish only after its CAD operation succeeds.

    Concurrent publishers may replace the same immutable-key record. A reader
    caught between payload/checksum replacements treats it as a cache miss.
    """
    if cache_root is None:
        yield
        return
    from steve import design
    root = Path(cache_root).resolve()
    out = Path(folder).resolve() / 'component-cache-out'
    out.mkdir(exist_ok=True)
    names = ('STEVE_COMPONENT_CACHE', 'STEVE_COMPONENT_CACHE_OUT', 'STEVE_RUNTIME_VERSION')
    previous = {name: os.environ.get(name) for name in names}
    old_read = design._cache_read
    try:
        os.environ.update(STEVE_COMPONENT_CACHE=str(root), STEVE_COMPONENT_CACHE_OUT=str(out),
                          STEVE_RUNTIME_VERSION=runtime_version(document))
        design._cache_read = lambda key: read_entry(root, key, design.CACHE_VERSION)
        yield
        try:
            publish(out, root, design.CACHE_VERSION)
        except (OSError, ValueError, RecursionError) as exc:
            # Cache storage failure must not turn valid CAD into a failed build.
            print(f'Component cache was not published: {exc}', flush=True)
    finally:
        design._cache_read = old_read
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        # These are disposable files produced in this exact job directory.
        try:
            for path in out.iterdir():
                if path.is_file() and (KEY.fullmatch(path.stem) or path.name.startswith('.')):
                    path.unlink(missing_ok=True)
            if not any(out.iterdir()):
                out.rmdir()
        except OSError:
            pass  # A cleanup failure cannot discard an otherwise valid model.
