"""Manufacturing artifacts derived from the exact model, never viewport meshes."""
from __future__ import annotations

import copy
import csv
import hashlib
import json
import os
from pathlib import Path
import tempfile
import zipfile

import cadquery as cq
from OCP.GCPnts import GCPnts_QuasiUniformDeflection

from .geometry import fail, plane
from ..reporting import surface_area

# Placed sheet bodies (copies × sheets) one build develops; past it the report is invalid, the model still builds.
MAX_SHEET_INSTANCES = 256


def components(result, prefix='', location=None, source=None, errors=()):
    """Walk native and revision-pinned linked components, preserving instance paths."""
    from ..links import LinkedInstance
    location = cq.Location() if location is None else location
    design = getattr(result, '_steve_design', None)
    if design is not None:
        errors = [*errors, *design.errors]
        for item in design.instances:
            identity = '/'.join(filter(None, (prefix, item['name'])))
            component = item['component']
            placed = location * item['location']
            if isinstance(component, LinkedInstance):
                pin = {key: component.source.get(key) for key in ('document_id', 'revision')}
                yield from components(component.result, identity, placed, pin, errors)
            else:
                yield identity, component, placed, source, errors
        return
    model = getattr(result, '_steve_model', None)
    if model is not None:
        yield prefix or 'part', model, location, source, errors
    elif isinstance(result, cq.Assembly):
        placed = location * result.loc
        if result.obj is not None:
            yield from components(result.obj, prefix or 'part', placed, source, errors)
        for child in result.children:
            yield from components(child, '/'.join(filter(None, (prefix, child.name))), placed, source, errors)


def xy(vector):
    return [float(vector.x), float(vector.y)]


def curve(edge):
    kind = edge.geomType()
    if kind == 'LINE':
        return dict(type='line', start=xy(edge.startPoint()), end=xy(edge.endPoint()))
    if kind == 'CIRCLE':
        return dict(type='circle' if edge.IsClosed() else 'arc', center=xy(edge.arcCenter()),
                    radius_mm=edge.radius(), start=xy(edge.startPoint()), end=xy(edge.endPoint()),
                    midpoint=xy(edge.positionAt(.5)), length_mm=edge.Length())
    discretizer = GCPnts_QuasiUniformDeflection(edge._geomAdaptor(), .02)
    if not discretizer.IsDone() or discretizer.NbPoints() > 20000:
        fail('A flat outline curve exceeded the display approximation budget.')
    return dict(type='polyline', display_only=True, tolerance_mm=.02,
                points=[[discretizer.Value(i).X(), discretizer.Value(i).Y()] for i in range(1, discretizer.NbPoints()+1)])


def pattern(sheet):
    face = sheet.flat_face()
    box = face.BoundingBox()
    loops = [dict(hole=False, segments=[curve(e) for e in face.outerWire().Edges()])]
    loops += [dict(hole=True, segments=[curve(e) for e in wire.Edges()]) for wire in face.innerWires()]
    bends = []
    for bend in sheet.bends:
        for index, segment in enumerate(sheet.bend_line(bend)):  # The drawing's flat view dimensions to these too.
            a, b = segment.startPoint(), segment.endPoint()
            bends.append(dict(id=bend['id'], kind=bend.get('kind','bend'), segment=index, start=xy(a), end=xy(b), direction='up' if bend['angle_deg'] > 0 else 'down',
                              angle_deg=abs(bend['angle_deg']), radius_mm=bend['radius_mm'], allowance_mm=bend['allowance_mm']))
    forms=[]
    from .geometry import place
    for form in sheet.forms:
        location=sheet.panels[form.panel].flat
        forms.append(dict(id=form.id,kind=form.tool['kind'],direction=form.direction,flat_treatment=form.treatment,
                          center=xy(plane(location).toWorldCoords((*form.at,0))),
                          marks=[curve(e) for mark in form.marks for e in place(mark,location).Edges()]))
    return face, dict(bounds_mm=[box.xmin, box.ymin, box.xmax, box.ymax], area_mm2=surface_area(face),
                      perimeter_mm=sum(w.Length() for w in face.Wires()), outlines=loops, bends=bends,forms=forms)


def dxf(sheet, path, include_forms=False):
    face, data = pattern(sheet)
    drawing = cq.exporters.DxfDocument(doc_units=4)  # DXF millimetres.
    drawing.add_layer('CUT', color=7)
    drawing.add_layer('BEND_UP', color=1)
    drawing.add_layer('BEND_DOWN', color=5)
    drawing.add_layer('ROLL', color=3)
    drawing.add_shape(cq.Workplane('XY').newObject([face]), 'CUT')
    for bend in data['bends']:
        a, b = (*bend['start'], 0), (*bend['end'], 0)
        drawing.msp.add_line(a, b, dxfattribs={'layer': 'ROLL' if bend['kind']=='roll' else 'BEND_' + bend['direction'].upper()})
    if include_forms and sheet.forms:
        from .geometry import place
        drawing.add_layer('FORM_UP',color=6)
        drawing.add_layer('FORM_DOWN',color=4)
        drawing.add_layer('FORM_CENTER',color=2)
        for form in sheet.forms:
            location=sheet.panels[form.panel].flat
            for mark in form.marks:
                placed=place(mark,location)
                if isinstance(placed,cq.Edge) and placed.geomType()=='LINE':
                    drawing.msp.add_line(placed.startPoint().toTuple(),placed.endPoint().toTuple(),dxfattribs={'layer':'FORM_'+form.direction.upper()})
                else:
                    drawing.add_shape(cq.Workplane('XY').newObject([placed]),'FORM_'+form.direction.upper())
            center=plane(location).toWorldCoords((*form.at,0))
            for axis in [(1,0,0),(0,1,0)]:
                u=cq.Vector(*axis)*min(1,sheet.rules.thickness/2)
                drawing.msp.add_line((center-u).toTuple(),(center+u).toTuple(),dxfattribs={'layer':'FORM_CENTER'})
    drawing.document.saveas(str(path))
    return data


def write_artifacts(result, full=False, source_sha256=None, viewer=None):
    # Full feature recording can execute source twice in the same job directory.
    for filename in ('sheet-metal.json', 'sheet-metal.zip', 'sheet-metal-flat.glb', 'sheet-metal-flat-topology.json'):
        Path(filename).unlink(missing_ok=True)
    entries, records = [], []
    flat_assembly = cq.Assembly(name='sheet-metal-flat')
    cursor = 0.0
    for instance, model, location, source, design_errors in components(result):
        if len(entries) > MAX_SHEET_INSTANCES:
            break
        for identity, sheet in model.__dict__.get('_sheet_metal', {}).items():
            entry = dict(id=f'{instance}:{identity}', instance=instance, component=getattr(model, 'id', None),
                         source=source, placement=location.toTuple(), **sheet.report())
            assignments = model.__dict__.get('materials')
            entry['material'] = assignments.of(identity) if assignments else None
            entry['diagnostics'] = []
            if len(entries) == MAX_SHEET_INSTANCES:
                # One invalid row says why; the model's geometry still builds and shows.
                message = f'Sheet-metal output is limited to {MAX_SHEET_INSTANCES} body instances per build.'
                entry.update(status='invalid', error=message)
                entry['diagnostics'].append(dict(code='SM_TOO_MANY_INSTANCES',severity='error',feature=None,entity=identity,
                                                 limit=MAX_SHEET_INSTANCES,message=message))
                entries.append(entry)
                break
            try:
                model._sheet(identity)
                _, flat = pattern(sheet)
                entry['flat'] = flat
                for feature in model.features:
                    if feature.status=='error':
                        detail=feature.detail.get('diagnostic')
                        entry['diagnostics'].append(detail or dict(code='SM_FEATURE_FAILED',severity='error',feature=feature.id,
                                                                  entity=feature.body,message=feature.error))
                entry['diagnostics'].extend(dict(code='SM_DESIGN_FAILED',severity='error',feature=None,entity=None,message=str(error)) for error in design_errors)
                if entry['diagnostics']:
                    fail('Repair failed features before manufacturing export: ' + '; '.join(f"{d.get('feature') or identity}: {d['message']}" for d in entry['diagnostics']))
                entry.update(status='ready', flat=flat)
                nominal=[f.id for f in sheet.forms if f.treatment!='developed_lance']
                if nominal:
                    entry['diagnostics'].append(dict(code='SM_FORM_NOMINAL_BLANK',severity='info',feature=None,entity=identity,
                        forms=nominal,message='Pressed forms use declared nominal blanks and process marks. Material draw-in, thinning and springback are not predicted.'))
                stem = hashlib.sha256(entry['id'].encode()).hexdigest()
                entry['dxf'] = stem + '.dxf'
                entry['bend_table'] = stem + '.bends.csv'
                entry['drawing'] = stem + '.svg'
                if sheet.forms:
                    entry['form_table']=stem+'.forms.csv'
                    entry['form_dxf']=stem+'.forming.dxf'
                records.append((sheet, entry))
                if viewer is not None:
                    flat_sheet = sheet.clone()
                    flat_sheet.fixed = flat_sheet.root
                    if flat_sheet.panels:
                        flat_sheet.panels[flat_sheet.root].folded = copy.deepcopy(flat_sheet.panels[flat_sheet.root].flat)
                    else:
                        flat_sheet.reference = [[0,0,0],[1,0,0],[0,0,1]]
                    shape, names = flat_sheet.build(flat=True)
                    owner = copy.copy(model)
                    owner.bodies, owner.names = {identity:shape}, names
                    shape._steve_model = owner
                    bounds = flat['bounds_mm']
                    offset = [cursor-bounds[0],-bounds[1],0]
                    entry.update(flat_node=stem, flat_display_translation_mm=offset)
                    flat_assembly.add(shape,name=stem,loc=cq.Location(tuple(offset)),color=cq.Color(.39,.72,.65))
                    cursor += bounds[2]-bounds[0]+20
            except Exception as error:
                entry.update(status='invalid', error=str(error))
                if not entry['diagnostics']:
                    entry['diagnostics'].append(getattr(error,'sheet_diagnostic',None) or
                                                dict(code='SM_EXPORT_INVALID',severity='error',feature=None,entity=identity,message=str(error)))
            entries.append(entry)
    if not entries:
        return None
    valid = all(entry['status'] == 'ready' for entry in entries)
    if valid and viewer is not None:
        viewer(flat_assembly)
    from ..design import _runtime_hash
    manifest = dict(version=1, units='mm', coordinate_frame='component_material_plane', source_sha256=source_sha256,
                    conventions=dict(angle='signed_deflection_from_flat_degrees',k_factor='neutral_distance_from_inside_divided_by_thickness',
                                     bend_line='midpoint_of_developed_allowance'),
                    manufacturing_validation=dict(status='not_assessed',
                        reason='Geometry and development are validated; shop tooling, material limits and secondary processes are not qualified.'),
                    runtime=os.getenv('STEVE_RUNTIME_VERSION') or 'cadquery-'+cq.__version__+'+'+_runtime_hash(),
                    status='ready' if valid else 'invalid', bodies=entries)
    content = json.dumps(manifest, allow_nan=False, sort_keys=True, separators=(',', ':'))
    if len(content.encode()) > 16*1024*1024:
        fail('Sheet-metal metadata exceeded the 16 MiB artifact limit.')
    Path('sheet-metal.json').write_text(content)
    if full and valid:
        with tempfile.TemporaryDirectory(prefix='sheet-metal-') as directory:
            folder = Path(directory)
            for sheet, entry in records:
                dxf(sheet, folder/entry['dxf'])
                with (folder/entry['bend_table']).open('w',newline='') as output:
                    fields = ['id','kind','angle_deg','radius_mm','k_factor','allowance_mm','allowance_method','width_mm','straight_length_mm']
                    writer = csv.DictWriter(output, fieldnames=fields, extrasaction='ignore')
                    writer.writeheader()
                    writer.writerows(sheet.bends)
                (folder/entry['drawing']).write_text(cq.exporters.getSVG(sheet.flat_face(),opts={'projectionDir':(0,0,1),'showAxes':False,'showHidden':False}))
                if sheet.forms:
                    dxf(sheet,folder/entry['form_dxf'],include_forms=True)
                    with (folder/entry['form_table']).open('w',newline='') as output:
                        fields=['id','panel','kind','name','source','x_mm','y_mm','rotation_deg','direction','flat_treatment','tool_parameters','resolved']
                        writer=csv.DictWriter(output,fieldnames=fields);writer.writeheader()
                        for form in sheet.forms:
                            writer.writerow(dict(id=form.id,panel=form.panel,kind=form.tool['kind'],name=form.tool['name'],source=form.tool['source'],
                                x_mm=form.at[0],y_mm=form.at[1],rotation_deg=form.angle,direction=form.direction,flat_treatment=form.treatment,
                                tool_parameters=json.dumps(form.tool['parameters'],sort_keys=True),resolved=json.dumps(form.resolved,sort_keys=True)))
            (folder/'manifest.json').write_text(content)
            with zipfile.ZipFile('sheet-metal.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                for file in sorted(folder.iterdir()):
                    if file.stat().st_size > 16*1024*1024:
                        fail('A sheet-metal export exceeded the per-part limit.')
                    info = zipfile.ZipInfo(file.name, date_time=(1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, file.read_bytes())
        if Path('sheet-metal.zip').stat().st_size > 64*1024*1024:
            fail('Sheet-metal exports exceeded the 64 MiB artifact limit.')
    return dict(version=1, status=manifest['status'], bodies=len(entries), archive=full and valid, viewer=valid and viewer is not None,
                summary=[dict(id=e['id'],status=e['status'],thickness_mm=e['rules']['thickness'],bend_count=len(e['bends']),form_count=len(e['forms']),rip_count=len(e['rips']),
                              **({'bounds_mm':e['flat']['bounds_mm'],'area_mm2':e['flat']['area_mm2']} if 'flat' in e else {}),
                              **({'error':e['error']} if e['status']=='invalid' else {})) for e in entries])
