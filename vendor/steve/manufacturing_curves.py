"""Export explicitly selected, exact CAD curves from the pinned design build.

This separate transport leaves simulation's solid-only archive unchanged.
Unavailable selections are retained as diagnostics for the manufacturing worker.
"""
import hashlib
import io
import json
import zipfile

from .simulation import _components, bounds


def _resolve(components, reference):
    instance = '/'.join(reference['instances']) or 'part'
    matches = [item for item in components if item[0] == instance]
    if len(matches) != 1:
        raise ValueError('The selected component is missing or ambiguous.')
    _, model, location, plain = matches[0]
    if model is not None and any(f.status == 'error' for f in model.features):
        raise ValueError('The selected component has failed features.')
    if reference['kind'] == 'sketch_curve':
        sketch = model.sketches.get(reference['sketch']) if model is not None else None
        if sketch is None:
            raise ValueError('The selected sketch is missing from this component.')
        from .sketch import SketchError
        try:
            edges = sketch.world_edges(reference['entity'])
        except SketchError as error:
            raise ValueError(str(error)) from None
        import cadquery as cq
        if len(edges) != 1 or not isinstance(edges[0], cq.Edge):
            raise ValueError('The selected sketch entity is missing, degenerate, or is not one curve.')
        edge = edges[0]
        stability = 'provenance'
    else:
        from .naming import edge_names
        bodies = model.bodies if model is not None else {f'solid_{i+1}': s for i, s in enumerate(plain.Solids())}
        body = bodies.get(reference['body'])
        if body is None:
            raise ValueError('The selected edge body is missing.')
        labels = edge_names(body, model.names) if model is not None else {}
        edges = []
        for index, candidate in enumerate(body.Edges()):
            label = labels.get(candidate)
            names = [label, f'{instance}:{label}'] if label is not None else [f'{instance}:{reference["body"]}.edge({index+1})']
            if reference['names'][0] in names:
                edges.append(candidate)
        if len(edges) != 1:
            raise ValueError('The selected edge name is missing or ambiguous.')
        edge = edges[0]
        stability = 'provenance' if model is not None else 'pinned_revision_only'
    return edge.moved(location), stability


def export_curves(result, selections, filename='manufacturing-curves.zip'):
    if not isinstance(selections, list) or not 1 <= len(selections) <= 1000:
        raise ValueError('Manufacturing curve selection exceeds its bounds.')
    components = _components(result)
    manifest = dict(version=1, units='mm', coordinate_frame='design', curves=[])
    files = {}
    for source in selections:
        record = dict(source=source)
        try:
            edge, stability = _resolve(components, source['reference'])
            if not edge.isValid() or edge.Length() <= 1e-9:
                raise ValueError('The selected curve is invalid or degenerate.')
            output = io.BytesIO()
            edge.exportBrep(output)
            data = output.getvalue()
            digest = hashlib.sha256(data).hexdigest()
            name = digest + '.brep'
            files[name] = data
            record.update(file=name, sha256=digest, reference_stability=stability,
                          curve_type=edge.geomType(), bounds_mm=bounds(edge))
        except ValueError as error:
            record['error'] = str(error)[:2000]
        manifest['curves'].append(record)
    files['curves.json'] = json.dumps(manifest, sort_keys=True, allow_nan=False).encode()
    if sum(len(value) for value in files.values()) > 64 * 1024 * 1024:
        raise ValueError('Selected manufacturing curves exceed the transport bound.')
    with zipfile.ZipFile(filename, 'w') as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return dict(version=1, curves=len(selections))
