"""Choose serial or mixed execution from observed component costs.

The estimate includes preparation, cache restoration and available hot workers.
Unknown costs stay serial. It deliberately requires a useful margin, rather than
choosing parallel for a few milliseconds of estimated improvement.
"""
import math


def choose_components(plan, missing, observations, ready_workers):
    missing = set(missing)
    dependencies = plan.get('dependencies', {})
    result = {'selected': [], 'mode': 'serial', 'reason': 'insufficient measured benefit',
              'serial_seconds': 0.0, 'parallel_seconds': 0.0}
    if not missing and not plan.get('reason'):
        result['reason'] = 'all required components are cached'
        return result
    if plan.get('reason') or ready_workers < 4:
        result['reason'] = plan.get('reason') or 'insufficient hot workers after reserving planning and final assembly'
        return result
    costs = {}
    for path in missing:
        item = observations.get(path)
        if not item or not all(isinstance(item.get(key), (int, float)) and math.isfinite(item[key]) and item[key] >= 0
                               for key in ('geometry_seconds', 'write_seconds', 'restore_seconds')):
            continue
        costs[path] = item
    if not costs:
        result['reason'] = 'no complete comparable timing observations'
        return result
    # Only measured candidates can justify extra execution. Cheap components
    # remain in the ordinary final assembly, unless a selected component needs
    # them as a prerequisite.
    candidates = {path for path, item in costs.items()
                  if item['geometry_seconds'] + item['write_seconds'] > item['restore_seconds'] + .15}
    candidates = {path for path in candidates if (set(dependencies.get(path, [])) & missing) <= costs.keys()}
    selected = set()
    # Each process handles one operation. Reserve hot workers for the cache-plan
    # job and final assembly, and never assume a discarded process can instantly
    # accept another component. Unknown cold-start costs favor serial execution.
    available = ready_workers - 2
    for path in sorted(candidates, key=lambda p: (-(costs[p]['geometry_seconds'] + costs[p]['write_seconds'] - costs[p]['restore_seconds']), p)):
        proposed = selected | {path} | (set(dependencies.get(path, [])) & missing)
        if len(proposed) <= available:
            selected = proposed
    if len(selected) < 2:
        return result
    lanes = min(ready_workers, len(selected))
    # Reserve scheduling/dispatch overhead, then estimate each dependency wave
    # with largest jobs assigned first to the least occupied worker.
    parallel = .25
    for level in plan['levels']:
        loads = [0.0] * lanes
        jobs = sorted((costs[path]['geometry_seconds'] + costs[path]['write_seconds'] + .10
                       for path in level if path in selected), reverse=True)
        for seconds in jobs:
            index = min(range(lanes), key=loads.__getitem__)
            loads[index] += seconds
        parallel += max(loads)
    parallel += sum(costs[path]['restore_seconds'] for path in selected)
    serial = sum(costs[path]['geometry_seconds'] + costs[path]['write_seconds'] for path in selected)
    result.update(serial_seconds=serial, parallel_seconds=parallel)
    # A 20% / half-second margin covers imperfect timing predictions. Assembly
    # rendering/export is shared by both paths and cancels out of this estimate.
    if serial - parallel >= max(.5, serial * .2):
        result.update(selected=sorted(selected), mode='parallel' if selected == missing else 'mixed',
                      reason='measured independent work exceeds preparation and restoration overhead')
    return result
