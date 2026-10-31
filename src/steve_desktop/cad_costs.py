"""Observe component construction/cache costs without changing Studio results."""
import os
import time
from functools import wraps
from pathlib import Path


def install_timing():
    from steve.design import Component
    if getattr(Component, '_steve_local_timing', False):
        return
    original_init = Component.__init__
    original_save = Component.save_to_cache

    @wraps(original_init)
    def initialize(component, *args, **kwargs):
        started = time.perf_counter()
        original_init(component, *args, **kwargs)
        component._steve_local_restore_seconds = time.perf_counter() - started if component.cache == 'hit' else None
        component._steve_local_write_seconds = 0.0

    @wraps(original_save)
    def save(component):
        started = time.perf_counter()
        try:
            return original_save(component)
        finally:
            component._steve_local_write_seconds += time.perf_counter() - started

    Component.__init__ = initialize
    Component.save_to_cache = save
    Component._steve_local_timing = True


def component_costs():
    from steve import design
    records = []
    for component in design._COMPONENTS:
        if not component.file or not component._key or not component._cacheable:
            continue
        size = 0
        for variable in ('STEVE_COMPONENT_CACHE_OUT', 'STEVE_COMPONENT_CACHE'):
            root = os.environ.get(variable)
            if root:
                try:
                    size = (Path(root) / (component._key + '.json')).stat().st_size
                    break
                except OSError:
                    pass
        records.append({'file': component.file, 'key': component._key, 'cache': component.cache,
                        'geometry_seconds': sum(feature.ms for feature in component.features) / 1000,
                        'write_seconds': getattr(component, '_steve_local_write_seconds', 0.0),
                        'restore_seconds': getattr(component, '_steve_local_restore_seconds', None),
                        'cache_bytes': size, 'runtime_version': os.environ.get('STEVE_RUNTIME_VERSION'),
                        'cache_version': design.CACHE_VERSION})
    return records
