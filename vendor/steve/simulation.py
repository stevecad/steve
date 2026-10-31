"""Exact, named simulation geometry, exported inside the CAD sandbox.

No solver runs here. Each body is exported separately in world coordinates, with
all provenance aliases, so repeated components retain independent boundaries.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import zipfile

import cadquery as cq
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib


def bounds(shape):
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped, box, False, False)
    low, high = box.CornerMin(), box.CornerMax()
    return [*low.Coord(), *high.Coord()]


AS_MODELLED = 'as_modelled'


def _level_values(choice, prefix: str) -> dict:
    """Explicit pose values addressed to the design at `prefix` ("hinge", or "lid_link/hinge" inside a linked design)."""
    if not isinstance(choice, dict):
        return {}
    lead = prefix + '/' if prefix else ''
    return {key[len(lead):]: value for key, value in choice.items() if key.startswith(lead) and '/' not in key[len(lead):]}


def _pose_motions(design, choice, prefix: str, record: dict) -> dict:
    """Each moved instance's motion at the chosen pose, for one design level (empty: as modelled).

    A named pose or explicit values start from the code's pose (every joint and coupling at its `value=`), as the
    viewer applies them; names are joints or couplings, "<joint>.travel" a cylindrical joint's slide. The values set
    must be within every joint's limits; a joint couplings push past them is held there."""
    from .design import _effective, _follower_set, _in_mode, _instance_motions
    kinematics = design.kinematics or {}
    joints, couplings = kinematics.get('joints') or [], kinematics.get('couplings') or []
    named = choice if isinstance(choice, str) and choice != AS_MODELLED and not prefix else None
    values = _level_values(choice, prefix)
    where = f'design {prefix!r}' if prefix else 'this design'
    if named is not None:
        if named not in (kinematics.get('poses') or {}):
            known = ', '.join(sorted(design.poses)) or 'none'
            raise ValueError(f"Pose {named!r} isn't in {where} (poses: {known}).")
        values = dict(kinematics['poses'][named])
        # A pose in a mode (design.pose(..., mode=)) is within that mode's limits, and its driven joints stop there.
        mode = (kinematics.get('pose_modes') or {}).get(named)
        joints, couplings = _in_mode(joints, couplings, next((m for m in kinematics.get('modes') or [] if m.get('name') == mode), None))
    if named is None and not values:
        return {}
    by_joint, by_coupling = {j['name']: j for j in joints}, {c['name']: c for c in couplings}
    if problem := _follower_set(joints, values):  # A follower moves only through its couplings.
        raise ValueError(f"Pose value: {problem}.")
    own ={j['name']: (j['value'], j.get('slide', 0.0)) for j in joints}
    coupled = {}
    for key, value in values.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f'Pose value {key!r} must be a number, not {value!r}.')
        name, _, part = key.partition('.')
        if name in by_coupling and not part:
            coupled[name] = float(value)
        elif name in by_joint and part in ('', 'turn', 'travel'):
            if part == 'travel' and by_joint[name]['type'] != 'cylindrical':
                raise ValueError(f"Pose value {key!r}: only a cylindrical joint has a separate travel; set {name!r} itself.")
            current = own[name]
            own[name] = (current[0], float(value)) if part == 'travel' else (float(value), current[1])
        else:
            names = sorted(by_joint) + sorted(by_coupling)
            raise ValueError(f"Pose value {key!r}: {where} has no joint or coupling of that name "
                             f"({', '.join(names) or 'it has no joints'}).")
    # A joint couplings drive stops at its limits, as in the viewer; what the pose sets itself must be within them.
    live = _effective(joints, couplings, own, coupled)
    label = f'pose {named!r}' if named else 'the chosen pose'
    path = lambda name: '/'.join(filter(None, (prefix, name)))
    for joint in joints:
        value, slide = live[joint['name']]
        unit = 'mm' if joint['type'] == 'slider' else 'deg'
        for limits, current, key, current_unit in ((joint.get('limits'), own[joint['name']][0], joint['name'], unit),
                                                    (joint.get('slide_limits'), own[joint['name']][1], joint['name'] + '.travel', 'mm')):
            if limits and not limits[0] - 1e-9 <= current <= limits[1] + 1e-9:
                shown = '°' if current_unit == 'deg' else ' mm'
                raise ValueError(f"At {label}, joint {path(joint['name'])!r} is at {current:g}{shown}, outside its limits "
                                 f"{limits[0]:g}…{limits[1]:g}{shown}.")
        if abs(value) > 1e-12:
            record.setdefault('values', {})[path(joint['name'])] = round(value, 9)
            record.setdefault('units', {})[path(joint['name'])] = unit
        if joint['type'] == 'cylindrical' and abs(slide) > 1e-12:
            record.setdefault('values', {})[path(joint['name']) + '.travel'] = round(slide, 9)
            record.setdefault('units', {})[path(joint['name']) + '.travel'] = 'mm'
    record['basis'] = 'named' if named else 'values'
    if named:
        record['name'] = named
    return _instance_motions(joints, live)


def _components(result, prefix='', location=None, pose=None, choice=None):
    from .links import LinkedInstance
    location = cq.Location() if location is None else location
    pose = {} if pose is None else pose
    design = getattr(result, '_steve_design', None)
    if design is not None:
        if design.errors:
            raise ValueError('Simulation geometry contains design errors: ' + '; '.join(design.errors))
        # Joints never change geometry (docs/MOTION.md). By default instances are simulated where they are modelled,
        # every joint at 0 ("zero is the artifact as written"), naming the joints the viewer opens elsewhere; a study
        # can instead choose a named pose or joint values, and each moved instance is placed there.
        for joint in design.joints:
            name = '/'.join(filter(None, (prefix, joint['name'])))
            pose.setdefault('joints', []).append(name)
            if joint.get('value') or joint.get('slide'):
                pose.setdefault('displayed', {})[name] = {'value': joint['value'], 'slide': joint.get('slide', 0.0)}
        for coupling in getattr(design, 'couplings', []):
            if coupling.get('value'):
                pose.setdefault('displayed', {})['/'.join(filter(None, (prefix, coupling['name'])))] = {'value': coupling['value']}
        pose.setdefault('_levels', set()).add(prefix)
        motions = _pose_motions(design, choice, prefix, pose)
        components = []
        for item in design.instances:
            name = '/'.join(filter(None, (prefix, item['name'])))
            motion = motions.get(item['name'])
            placement = location * (cq.Location(motion) * item['location'] if motion is not None else item['location'])
            component = item['component']
            if isinstance(component, LinkedInstance):
                components.extend(_components(component.result, name, placement, pose, choice))
            else:
                components.append((name, component, placement, None))
        return components
    model = getattr(result, '_steve_model', None)
    if model is not None:
        return [(prefix or 'part', model, location, None)]
    if isinstance(result, cq.Assembly):
        components = []
        placement = location * result.loc
        if result.obj is not None:
            components.extend(_components(result.obj, prefix or 'part', placement))
        for child in result.children:
            name = '/'.join(filter(None, (prefix, child.name)))
            components.extend(_components(child, name, placement))
        return components
    if isinstance(result, cq.Workplane):
        values = result.vals()
        result = cq.Compound.makeCompound(values)
    if isinstance(result, cq.Shape):
        return [(prefix or 'part', None, location, result)]
    raise ValueError('Simulation geometry requires a STEVE Design, Model, or solid part.')


def export_bundle(result, destination: Path, instances=(), pose=None):
    """Write a directory consumed by the mesher; never infer a reference across revisions.

    `pose`: None or "as_modelled" (every joint at 0), a pose named in the design, or {"joint": value, ...}."""
    from .tool_frames import named_references
    from .model import SURFACE_NOTE, is_surface
    destination.mkdir(parents=True, exist_ok=True)
    if pose is not None and not isinstance(pose, (str, dict)):
        raise ValueError(f'A simulation pose is a pose name or joint values, not {pose!r}.')
    pose = None if pose in (AS_MODELLED, {}) else pose
    record = {}
    components = _components(result, pose=record, choice=pose)
    levels = record.pop('_levels', set())
    if pose is not None and not levels:
        raise ValueError(f'Pose {pose!r} applies to a design with joints; this geometry is a part.')
    if isinstance(pose, dict):
        strays = sorted(key for key in pose if key.rpartition('/')[0] not in levels)
        if strays:
            raise ValueError(f"Pose values {', '.join(map(repr, strays))} address no design here (linked designs: "
                             f"{', '.join(sorted(level for level in levels if level)) or 'none'}).")
    if pose is not None and 'basis' not in record:
        raise ValueError(f'Pose {pose!r} moves nothing in this design.')
    requested = set(instances)
    missing = requested - {item[0] for item in components}
    if missing:
        raise ValueError(f'Simulation instances are missing: {sorted(missing)}')
    manifest = {'version': 1, 'units': 'mm', 'coordinate_frame': 'design',
                'cadquery_version': cq.__version__, 'bodies': []}
    for instance, model, location, plain in components:
        if requested and instance not in requested:
            continue
        if model is not None:
            errors = [f'{f.id}: {f.error}' for f in model.features if f.status == 'error']
            if errors:
                raise ValueError('Simulation geometry contains failed features: ' + '; '.join(errors))
            bodies, aliases, own = model.bodies, model.names.faces, model.names.unique()
            summary = model.summary()['bodies']
        else:
            bodies = {f'solid_{i+1}': solid for i, solid in enumerate(plain.Solids())}
            aliases, own, summary = {}, {}, {}
        for body_id, body in bodies.items():
            if model is not None and is_surface(body):  # No volume to mesh: listed as left out, with the note why.
                manifest.setdefault('skipped', []).append({'id': f'{instance}:{body_id}', 'note': SURFACE_NOTE})
                continue
            if not body.isValid() or len(body.Solids()) != 1 or body.Volume() <= 0:
                raise ValueError(f'Simulation body {instance}:{body_id} is not one valid solid.')
            world = body.moved(location)
            identity = f'{instance}:{body_id}'
            filename = hashlib.sha256(identity.encode()).hexdigest() + '.brep'
            # BREP preserves OCCT topology; the exported signatures independently
            # verify boundary identity after Gmsh imports it. Ambiguities fail closed.
            world.exportBrep(str(destination / filename))
            faces, stability = [], 'provenance' if model is not None else 'pinned_revision_only'
            for index, face in enumerate(body.Faces()):
                names = [f'{instance}:{name}' for name, group in aliases.items() if face in group]
                # An unnamed face is only a free surface: boundaries resolve by name, so one
                # it can't take fails as reference_missing, never by guessing a face.
                if not names:
                    names, stability = [f'{identity}.face({index+1})'], 'pinned_revision_only'
                elif (unique := f'{instance}:{own[face]}') not in names:
                    names.insert(0, unique)  # One piece of a split face: its own name first, the shared ones after.
                placed = face.moved(location)
                faces.append({'ref': names[0], 'aliases': names,
                              'center_mm': list(placed.Center().toTuple()),
                              'area_mm2': placed.Area(), 'bounds_mm': bounds(placed)})
            # Retain edge names before instance placement. Reconstructing their
            # repeated-adjacency indices after a rotation could reorder them.
            from .naming import edge_names
            labels = edge_names(body, model.names) if model is not None else {}
            edges = []
            for index, edge in enumerate(body.Edges()):
                label = labels.get(edge)
                names = [f'{instance}:{label}', label] if label is not None else [f'{identity}.edge({index+1})']
                placed = edge.moved(location)
                edges.append({'ref': names[0], 'aliases': names,
                              'curve_type': placed.geomType(), 'length_mm': placed.Length(),
                              'center_mm': list(placed.Center().toTuple()), 'bounds_mm': bounds(placed),
                              'endpoints_mm': [list(p.toTuple()) for p in (placed.startPoint(), placed.endPoint())]})
            manifest['bodies'].append({'id': identity, 'instance': instance,
                'component': getattr(model, 'id', None), 'body': body_id, 'file': filename,
                'reference_stability': stability,
                'material': summary.get(body_id, {}).get('material'),
                'volume_mm3': world.Volume(), 'bounds_mm': bounds(world), 'faces': faces, 'edges': edges,
                'frame_references': named_references(model,body,location)})
    if not manifest['bodies']:
        raise ValueError(f'Simulation selection contains no solid bodies: {SURFACE_NOTE}.' if manifest.get('skipped')
                         else 'Simulation selection contains no bodies.')
    if record:
        manifest['pose'] = {'basis': AS_MODELLED, **record}
    (destination / 'geometry.json').write_text(json.dumps(manifest, sort_keys=True, allow_nan=False))
    return manifest


def export_archive(result, filename='simulation-geometry.zip', instances=(), pose=None):
    with tempfile.TemporaryDirectory(prefix='simulation-') as directory:
        folder = Path(directory)
        manifest = export_bundle(result, folder, instances, pose)
        with zipfile.ZipFile(filename, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
            for path in sorted(folder.iterdir()):
                # Fixed timestamps make the archive reproducible for identical BREP bytes.
                info = zipfile.ZipInfo(path.name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes())
    return {'version': 1, 'bodies': len(manifest['bodies']), 'units': 'mm', **({'pose': manifest['pose']} if 'pose' in manifest else {})}
