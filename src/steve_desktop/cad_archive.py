"""Portable local CAD archives. Source and pinned links retain Studio's document schema."""
import asyncio
import ast
import base64
import copy
import hashlib
import io
import json
import re
import time
import zipfile
from pathlib import PurePosixPath

from fastapi import HTTPException, Request
from fastapi.responses import Response
from steve_desktop.cad_document import validate
from steve_desktop.cad_live import source
from steve_desktop.cad_image_normalize import normalize
from steve_desktop.cad_materials import MaterialBody, _checked as checked_material
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()

FORMAT = 'steve.project'
MANIFEST = 'steve-project.json'
MAX_ARCHIVE = 200 * 1024**2
MAX_EXPANDED = 512 * 1024**2
IMAGE = re.compile(r'img_[0-9a-f]{12}')
STEP = re.compile(r'[0-9a-f]{64}')
MATERIAL = re.compile(r'my:[a-z0-9][a-z0-9-]{0,62}')
MATERIAL_REFERENCE = re.compile(r'(?<![\w:-])my:[a-z0-9][a-z0-9-]{0,62}(?![\w-])')
sha = lambda data: hashlib.sha256(data).hexdigest()


def safe_path(name):
    if not isinstance(name, str) or not name or '\\' in name or ':' in name or '\x00' in name:
        raise ValueError('Invalid archive path.')
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or str(path) != name:
        raise ValueError('Archive paths must stay inside the project.')
    return name


def source_files(doc):
    return [('code', doc['code']), *((name, text) for name, text in doc.get('files', {}).items() if name.endswith('.py'))]


def analyze(doc):
    trees=[]
    for key,text in source_files(doc):
        try:trees.append((key,text,ast.parse(text)))
        except SyntaxError:pass
    constants={};ambiguous=set()
    def literal(node):
        if isinstance(node,ast.Constant) and isinstance(node.value,str):return node.value
        if isinstance(node,ast.Name):return constants.get(node.id)
        if isinstance(node,ast.BinOp) and isinstance(node.op,ast.Add):
            a,b=literal(node.left),literal(node.right)
            return a+b if a is not None and b is not None else None
        return None
    assignments=[n for _,_,tree in trees for n in tree.body if isinstance(n,ast.Assign)]
    for _ in range(len(assignments)+1):
        changed=False
        for n in assignments:
            value=literal(n.value)
            if value is not None:
                for target in n.targets:
                    if isinstance(target,ast.Name) and target.id not in ambiguous and constants.get(target.id)!=value:
                        if target.id in constants:
                            ambiguous.add(target.id);constants.pop(target.id)
                        else:constants[target.id]=value
                        changed=True
        if not changed:break
    return trees,literal


def references(documents):
    images,steps,materials=set(),set(),set()
    for doc in documents:
        trees,literal=analyze(doc)
        parsed={key:tree for key,_,tree in trees}
        for key,text in source_files(doc):
            tree=parsed.get(key)
            values=[n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str)] if tree else [text]
            for value in values:
                images.update(IMAGE.findall(value))
                steps.update(re.findall(r'(?<![a-zA-Z0-9])[0-9a-f]{64}(?![a-zA-Z0-9])',value))
                materials.update(MATERIAL_REFERENCE.findall(value))
        for _,_,tree in trees:
            for call in (n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr in ('decal','import_step','material')):
                kind=call.func.attr
                key={'decal':'image','import_step':'source','material':'material'}[kind]
                position=0 if kind=='material' else 1
                expr=next((k.value for k in call.keywords if k.arg==key),call.args[position] if len(call.args)>position else None)
                value=literal(expr)
                if value is None:
                    raise ValueError(f'Cannot bundle a runtime-generated {key} reference. Use a fixed ID or a named string constant, or download source only.')
                if kind=='material':
                    if value.startswith('my:'):
                        if not MATERIAL.fullmatch(value):raise ValueError('Invalid custom material reference.')
                        materials.add(value)
                else:
                    if not (IMAGE if kind=='decal' else STEP).fullmatch(value):
                        raise ValueError(f'Cannot bundle a runtime-generated {key} reference. Use a fixed ID or a named string constant, or download source only.')
                    (images if kind=='decal' else steps).add(value)
    return images,steps,materials


def remap_materials(documents,mapping):
    """Change conflicting material IDs in copies, preserving source formatting and Unicode.

    Resolved concatenations or named constants in material calls become a fixed
    ID only when remapped. Literal references elsewhere are replaced as well.
    """
    mapping={old:new for old,new in mapping.items() if old!=new}
    if not mapping:return
    for doc in documents:
        trees,literal=analyze(doc)
        replacements={}
        for key,text,tree in trees:
            lines=text.encode('utf-8').splitlines(keepends=True)
            offsets=[0]
            for line in lines:offsets.append(offsets[-1]+len(line))
            edits=[]
            for call in (n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='material'):
                expr=next((k.value for k in call.keywords if k.arg=='material'),call.args[0] if call.args else None)
                value=literal(expr)
                if value in mapping:
                    edits.append((offsets[expr.lineno-1]+expr.col_offset,offsets[expr.end_lineno-1]+expr.end_col_offset,repr(mapping[value]).encode('utf-8')))
            raw=text.encode('utf-8')
            for start,end,value in sorted(edits,reverse=True):raw=raw[:start]+value+raw[end:]
            replacements[key]=raw.decode('utf-8')
        for key,text in source_files(doc):
            text=MATERIAL_REFERENCE.sub(lambda m:mapping.get(m.group(),m.group()),replacements.get(key,text))
            if key=='code':doc['code']=text
            else:doc['files'][key]=text


def material_fields(record):
    return checked_material(MaterialBody.model_validate(record))


def material_plan(server,assets):
    """Reuse equal definitions; conflicting IDs receive stable imported copies."""
    incoming={entry['id']:entry['material'] for entry,_ in assets if entry['kind']=='material'}
    existing=server.state.get('materials',{})
    planned={};mapping={}
    def same(identifier,fields):
        record=planned.get(identifier) or existing.get(identifier)
        if record is None:return False
        try:return material_fields(record)==fields
        except (ValueError,HTTPException):return False
    for identifier,fields in sorted(incoming.items()):
        target=identifier
        if target in existing and not same(target,fields):
            salt=0
            while True:
                token=sha((json.dumps(fields,sort_keys=True,ensure_ascii=False)+str(salt)).encode('utf-8'))[:40]
                target='my:archive-'+token
                if target not in incoming and (target not in existing and target not in planned or same(target,fields)):break
                salt+=1
        mapping[identifier]=target
        if target not in existing:planned[target]={**fields,'id':target,'updated_at':now()}
    return mapping,planned


def collect(server, document, identifier=None, revision=None):
    documents, seen = [], set()
    def visit(doc, key):
        if key in seen:
            return
        if len(documents) >= 100:
            raise ValueError('An archive supports a root and up to 99 pinned linked documents.')
        seen.add(key)
        if not isinstance(doc,dict) or not isinstance(doc.get('links',{}),dict):raise ValueError('Invalid project document.')
        row = {**copy.deepcopy(source(validate(doc))), 'document_id': key[0], 'revision': key[1]}
        row['studio_origin'] = copy.deepcopy(doc.get('studio_origin') or server.state['documents'].get(key[0],{}).get('studio_origin'))
        documents.append(row)
        for alias, ref in row['links'].items():
            linked = server.revision(ref['document_id'], ref['revision'])
            row['links'][alias] = {**ref, 'revision': linked['revision']}
            visit(linked, (linked['id'], linked['revision']))
    visit(document, (identifier or 'archive-root', revision or 1))
    return documents


def create_archive(server, document, identifier=None, revision=None):
    with server.lock:
        docs = collect(server, document, identifier, revision)
        images, steps, materials = references(docs)
        entries, rows, assets = {}, [], []
        def add(path, data):
            safe_path(path)
            if path in entries or path == MANIFEST:
                raise ValueError(f'Archive path conflicts with project metadata: {path}')
            entries[path] = data
            return {'path': path, 'sha256': sha(data)}
        for i, doc in enumerate(docs):
            directory = '' if i == 0 else f'linked/{i:03d}/'
            main = 'main.py' if doc['kind'] == 'design' else 'model.py'
            row = {k: doc[k] for k in ('name', 'kind', 'document_id', 'revision', 'links', 'studio_origin')}
            row['code'] = add(directory + main, doc['code'].encode('utf-8'))
            row['files'] = {}
            for name, content in doc['files'].items():
                safe_path(name)
                binary = name.lower().endswith(('.png', '.jpg', '.jpeg'))
                raw = base64.b64decode(content, validate=True) if binary else content.encode('utf-8')
                row['files'][name] = {**add(directory + name, raw), 'encoding': 'base64' if binary else 'utf-8'}
            rows.append(row)
        for image_id in sorted(images):
            item = server.state.get('decal_images', {}).get(image_id)
            path = server.folder/'decal-images'/(image_id+'.image')
            if not item or not path.is_file():
                raise ValueError(f'Missing decal image {image_id}. Restore it before exporting this project.')
            raw = path.read_bytes()
            if 'img_'+sha(raw)[:12] != image_id:
                raise ValueError(f'Decal image {image_id} failed its content check.')
            ext = {'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp'}[item['media_type']]
            assets.append({**add(f'assets/decals/{image_id}.{ext}', raw), 'kind':'decal', 'id':image_id, 'name':item['name']})
        for step_id in sorted(steps):
            path = server.folder/'imports'/(step_id+'.step')
            if not path.is_file():
                raise ValueError(f'Missing imported STEP {step_id}. Restore it before exporting this project.')
            raw = path.read_bytes()
            if sha(raw) != step_id:
                raise ValueError(f'Imported STEP {step_id} failed its content check.')
            item = server.state.get('imports', {}).get(step_id, {})
            assets.append({**add(f'assets/imports/{step_id}.step', raw), 'kind':'step', 'id':step_id, 'name':item.get('filename','import.step')})
        for material_id in sorted(materials):
            item=server.state.get('materials',{}).get(material_id)
            if item is None:raise ValueError(f'Missing custom material {material_id}. Restore it before exporting this project.')
            fields=material_fields(item)
            raw=json.dumps(fields,sort_keys=True,ensure_ascii=False).encode('utf-8')
            assets.append({**add(f'assets/materials/{material_id[3:]}.json',raw),'kind':'material','id':material_id,'name':fields['name']})
    manifest = {'format':FORMAT, 'version':2, 'documents':rows, 'assets':assets}
    entries[MANIFEST] = json.dumps(manifest,ensure_ascii=False,indent=2).encode('utf-8')
    if sum(map(len, entries.values())) > MAX_EXPANDED:
        raise ValueError('Project archive exceeds 512 MB of uncompressed files.')
    out = io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():z.writestr(name,data)
    data=out.getvalue()
    if len(data)>MAX_ARCHIVE:raise ValueError('Project archive exceeds the 200 MB transfer size. Split it into smaller projects before exporting.')
    return data


def read_archive(raw):
    if len(raw)>MAX_ARCHIVE:
        raise ValueError('Project archive must be at most 200 MB.')
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        infos=z.infolist();names=[i.filename for i in infos]
        if len(names)>21000 or len(names)!=len(set(names)) or sum(i.file_size for i in infos)>MAX_EXPANDED:
            raise ValueError('Archive contains duplicate entries or too many files/bytes.')
        for name in names:safe_path(name)
        if MANIFEST not in names:
            raise ValueError('This ZIP has no Steve project manifest. Use Export → Project archive. Studio source-only exports do not include linked documents or imported assets.')
        if z.getinfo(MANIFEST).file_size>8*1024**2:raise ValueError('Project manifest is too large.')
        manifest=json.loads(z.read(MANIFEST))
        from steve_desktop.legacy_profile import ARCHIVE_FORMATS
        if not isinstance(manifest,dict) or manifest.get('format') not in ARCHIVE_FORMATS or manifest.get('version') not in (1,2):
            raise ValueError('Unsupported Steve project archive version.')
        if not isinstance(manifest.get('documents'),list) or not 1<=len(manifest['documents'])<=100 or not isinstance(manifest.get('assets'),list):
            raise ValueError('Archive must contain 1–100 CAD documents and an asset list.')
        def take(ref):
            path=safe_path(ref['path'])
            data=z.read(path)
            if sha(data)!=ref['sha256']:raise ValueError(f'Archive checksum failed: {path}')
            return data
        docs=[]
        for row in manifest['documents']:
            if not isinstance(row,dict) or not isinstance(row.get('files'),dict) or not isinstance(row.get('links'),dict):
                raise ValueError('Invalid archived document.')
            if not isinstance(row.get('document_id'),str) or not row['document_id'] or type(row.get('revision')) is not int or row['revision']<1:
                raise ValueError('Invalid archived document identity.')
            doc={k:row[k] for k in ('name','kind','document_id','revision','links')}
            doc['studio_origin']=row.get('studio_origin')
            doc['code']=take(row['code']).decode('utf-8')
            doc['files']={safe_path(k):(base64.b64encode(take(v)).decode('ascii') if v['encoding']=='base64' else take(v).decode('utf-8')) for k,v in row['files'].items()}
            validate(doc);docs.append(doc)
        if not docs or len(docs)>100:raise ValueError('Archive must contain 1–100 CAD documents.')
        keys={(d['document_id'],d['revision']) for d in docs}
        if len(keys)!=len(docs):raise ValueError('Duplicate document revisions in archive.')
        for doc in docs:
            for alias, ref in doc['links'].items():
                if not isinstance(alias,str) or not isinstance(ref,dict) or (ref['document_id'],ref['revision']) not in keys:
                    raise ValueError('Archive is missing a pinned linked document.')
        assets=[];found_images=set();found_steps=set();found_materials=set()
        for entry in manifest['assets']:
            data=take(entry);kind=entry['kind'];identifier=entry['id']
            if kind=='decal':
                if not IMAGE.fullmatch(identifier) or identifier!='img_'+sha(data)[:12] or identifier in found_images:
                    raise ValueError('Invalid or duplicate decal image identity.')
                _,media,width,height,thumb=normalize(data)
                from PIL import Image
                with Image.open(io.BytesIO(data)) as image:
                    if image.format not in ('PNG','JPEG','WEBP'):raise ValueError('Unsupported decal image format.')
                    media={'PNG':'image/png','JPEG':'image/jpeg','WEBP':'image/webp'}[image.format]
                    width,height=image.size
                    if max(width,height)>2048:raise ValueError('Archived decals must be normalized to at most 2048 pixels per side.')
                found_images.add(identifier)
                entry={**entry,'media_type':media,'width':width,'height':height,'thumbnail':thumb}
            elif kind=='step':
                if not STEP.fullmatch(identifier) or identifier!=sha(data) or identifier in found_steps:
                    raise ValueError('Invalid or duplicate STEP identity.')
                found_steps.add(identifier)
            elif kind=='material':
                if not MATERIAL.fullmatch(identifier) or identifier in found_materials:
                    raise ValueError('Invalid or duplicate custom material identity.')
                fields=material_fields(json.loads(data))
                entry={**entry,'material':fields}
                found_materials.add(identifier)
            else:raise ValueError('Unsupported archive asset type.')
            assets.append((entry,data))
        need_images,need_steps,need_materials=references(docs)
        if not need_images<=found_images or not need_steps<=found_steps:
            raise ValueError('Archive is missing referenced decal images or imported STEP files.')
        if not need_materials<=found_materials:
            raise ValueError('Archive is missing custom material definitions. Export it again from a Steve version that includes materials.')
        return docs,assets


def restore_archive(server, raw):
    docs,assets=read_archive(raw)  # Validate the entire archive before changing the local catalog.
    with server.lock:
        before=copy.deepcopy(server.state)
        for entry,data in assets:
            if entry['kind']=='decal':
                path=server.folder/'decal-images'/(entry['id']+'.image')
                if path.exists() and sha(path.read_bytes())!=sha(data):raise ValueError('A decal image ID conflicts with an existing local image.')
        mapping,planned=material_plan(server,assets)
        remap_materials(docs,mapping)
        try:
            server.state.setdefault('materials',{}).update(planned)
            imports=[]
            for entry,data in assets:
                identifier=entry['id']
                if entry['kind']=='step':
                    imports.append(server.register_import(PurePosixPath(entry['name']).name,data))
                elif entry['kind']=='decal':
                    if identifier in server.state.get('decal_images',{}):continue
                    folder=server.folder/'decal-images';folder.mkdir(exist_ok=True)
                    for suffix,contents in [('.image',data),('.webp',entry['thumbnail'])]:
                        target=folder/(identifier+suffix);pending=target.with_suffix('.pending');pending.write_bytes(contents);pending.replace(target)
                    server.state.setdefault('decal_images',{})[identifier]={
                        'id':identifier,'name':str(entry['name'])[:200], 'media_type':entry['media_type'],
                        'width':entry['width'],'height':entry['height'],'size':len(data),
                        'url':f'/v1/decal-images/{identifier}','thumbnail_url':f'/v1/decal-images/{identifier}/thumbnail'}
            for imported in imports:
                while imported['status']=='validating':time.sleep(.05)
                if imported['status']!='ready':raise ValueError('Archived STEP could not be read: '+str(imported.get('error') or imported['filename']))
            result=server.project.import_package(docs,from_studio=False)
            result['assets']=len(assets)
            result['materials']=len(mapping)
            result['remapped_materials']=sum(old!=new for old,new in mapping.items())
            result['message']='Project imported locally. Source, pinned links and assets restored.'
            return result
        except Exception:
            server.state=before;server.save();raise


def install(server):
    @server.app.post('/v1/local/project-archive')
    async def export(request: Request):
        try:
            body=await request.json()
            data=await asyncio.to_thread(create_archive,server,body['document'],body.get('document_id'),body.get('revision'))
            return Response(data,media_type='application/zip')
        except (ValueError,KeyError,TypeError) as exc:raise HTTPException(422,str(exc)) from None

    @server.app.post('/v1/local/import-project',status_code=201)
    async def upload(request: Request):
        raw=bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw)>MAX_ARCHIVE:raise HTTPException(413,'Project archive must be at most 200 MB.')
        try:return await asyncio.to_thread(restore_archive,server,bytes(raw))
        except (ValueError,KeyError,TypeError,zipfile.BadZipFile,RuntimeError,NotImplementedError) as exc:
            raise HTTPException(422,str(exc)) from None
