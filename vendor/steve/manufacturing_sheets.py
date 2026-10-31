"""Exact selected flat faces for CAM, separate from simulation's solid archive."""
import hashlib
import io
import json
import math
from pathlib import Path
import zipfile

from .sheetmetal.export import components
from .simulation import bounds
from .reporting import surface_area


def placement(location):
    import cadquery as cq
    matrix=cq.Matrix(location.wrapped.Transformation())
    origin=cq.Vector().transform(matrix)
    axes=[cq.Vector(*axis).transform(matrix)-origin for axis in ((1,0,0),(0,1,0),(0,0,1))]
    return dict(origin_mm=origin.toTuple(),**dict(zip(('x','y','z'),(a.toTuple() for a in axes))))


def export_sheets(result,selections,*,root_source,frozen_sha256,filename='sheet-cutting-geometry.zip'):
    """Export only through-cut boundaries, without bending/forming annotations.

    Faces stay in each sheet's developed XY frame. Assembly placements describe
    the folded component; applying them to the developed face would be incorrect.
    Every selected body must be current and valid before any archive is written.
    """
    target=Path(filename);target.unlink(missing_ok=True)
    if not isinstance(selections,list) or not 1<=len(selections)<=128:
        raise ValueError('Select between 1 and 128 sheet-metal body instances.')
    available=list(components(result));records=[];files={};seen=set()
    for reference in selections:
        if reference.get('kind')!='body' or reference.get('names'):
            raise ValueError('Sheet cutting requires a complete sheet-metal body selection.')
        instance='/'.join(reference.get('instances',())) or 'part'
        identity=(instance,reference['body'])
        if identity in seen:raise ValueError('A sheet body instance was selected more than once.')
        seen.add(identity)
        matches=[item for item in available if item[0]==instance]
        if len(matches)!=1:raise ValueError('Selected sheet component is missing or ambiguous: '+instance)
        _,model,location,source,design_errors=matches[0]
        failures=[str(e) for e in design_errors]+[f'{f.id}: {f.error}' for f in model.features if f.status=='error']
        if failures:raise ValueError('Repair failed features before cutting: '+'; '.join(failures)[:2000])
        sheet=model._sheet(reference['body'])  # Reject unsupported solid edits/stale developments.
        face=sheet.flat_face();box=bounds(face)
        if (not face.isValid() or face.geomType()!='PLANE' or face.Area()<=0
            or not all(math.isfinite(v) and abs(v)<=1e6 for v in box)
            or max(abs(box[i]) for i in (2,5))>1e-6 or abs(face.normalAt().z)<1-1e-9):
            raise ValueError('The developed sheet must be one valid finite face in its XY plane.')
        buffer=io.BytesIO();face.exportBrep(buffer);data=buffer.getvalue()
        digest=hashlib.sha256(data).hexdigest();name=digest+'.brep';files[name]=data
        nominal=[f.id for f in sheet.forms if f.treatment!='developed_lance']
        records.append(dict(reference=reference,file=name,sha256=digest,bytes=len(data),
            component_source=source or root_source,component_to_design=placement(location),
            thickness_mm=sheet.rules.thickness,area_mm2=surface_area(face),bounds_mm=box,
            nominal_forms=nominal,reference_stability='provenance',
            flat_basis='developed_sheet_xy',annotations='excluded'))
    manifest=dict(version=1,units='mm',root_source=root_source,frozen_sha256=frozen_sha256,parts=records)
    files['sheets.json']=json.dumps(manifest,sort_keys=True,allow_nan=False,separators=(',',':')).encode()
    if len(files['sheets.json'])>4*1024*1024 or sum(map(len,files.values()))>64*1024*1024:
        raise ValueError('Selected flat geometry exceeds its transport bound.')
    with zipfile.ZipFile(target,'w') as archive:
        for name,data in sorted(files.items()):
            info=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
            archive.writestr(info,data)
    return dict(version=1,parts=len(records),units='mm')
