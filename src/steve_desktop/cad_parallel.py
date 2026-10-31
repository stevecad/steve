"""Prepare independent component cache entries using the shared worker budget."""
import json
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from steve_desktop.cad_dependencies import component_plan


class _Stop:
    def __init__(self, parent):
        self.parent = parent
        self.local = threading.Event()

    def is_set(self):
        return self.local.is_set() or bool(self.parent and self.parent.is_set())


def prepare_components(document, folder, cache_root, cancel, pool, progress=None, selected=None):
    """No parent worker is leased here; every task acquires its own budget slot.

    Failed speculative preparation falls back to ordinary Studio execution. A
    user's cancellation is propagated instead. Studio remains the authority for
    source errors and final assembly creation.
    """
    plan = component_plan(document)
    if selected is not None:
        chosen = set(selected)
        plan['levels'] = [[path for path in level if path in chosen] for level in plan['levels']]
        plan['levels'] = [level for level in plan['levels'] if level]
    report = {'levels': plan['levels'], 'reason': plan['reason'], 'jobs': [], 'cached': []}
    if not any(len(level) > 1 for level in plan['levels']) or pool.budget.capacity < 2:
        report['reason'] = report['reason'] or 'no independent component fanout'
        return report
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    stopped = _Stop(cancel)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='component-preparation-', dir=folder) as scratch:
        scratch = Path(scratch)
        paths = [path for level in plan['levels'] for path in level]
        payload = json.dumps(document, ensure_ascii=False)
        (scratch / 'document.json').write_text(payload, encoding='utf-8')
        (scratch / 'paths.json').write_text(json.dumps(paths), encoding='utf-8')
        try:
            pool.execute(['component-plan', scratch, cache_root], stopped)
            missing = set(json.loads((scratch / 'component-plan.json').read_text(encoding='utf-8'))['missing'])
            report['cached'] = [path for path in paths if path not in missing]
            if progress:
                progress(len(report['cached']), len(paths))

            def run(path):
                job = scratch / path.replace('/', '_').replace('.', '_')
                job.mkdir()
                (job / 'document.json').write_text(payload, encoding='utf-8')
                before = time.monotonic() - started
                result = pool.execute(['component', job, cache_root, path], stopped)
                timing = json.loads((job / 'component-result.json').read_text(encoding='utf-8'))
                return {'path': path, 'started_seconds': before,
                        'finished_seconds': time.monotonic() - started,
                        'worker_pid': result['worker_pid'],
                        'execution_started_at': timing['started_at'], 'execution_finished_at': timing['finished_at']}

            with ThreadPoolExecutor(max_workers=min(len(paths), pool.budget.capacity), thread_name_prefix='cad-component') as executor:
                for level in plan['levels']:
                    futures = [executor.submit(run, path) for path in level if path in missing]
                    try:
                        for future in as_completed(futures):
                            report['jobs'].append(future.result())
                            if progress:
                                progress(len(report['cached']) + len(report['jobs']), len(paths))
                    except Exception:
                        stopped.local.set()
                        for future in futures:
                            future.cancel()
                        raise
            if stopped.is_set():
                raise ValueError('Build cancelled.')
        except Exception as exc:
            if cancel and cancel.is_set():
                raise ValueError('Build cancelled.') from exc
            report['reason'] = 'Serial fallback after component preparation: ' + str(exc)
    report['seconds'] = time.monotonic() - started
    return report
