"""Local Git connections and Studio-compatible CAD source transfer."""
import asyncio
import base64
import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import tempfile
import uuid
from urllib.parse import urlsplit
from fastapi import HTTPException
from steve_desktop.cad_document import validate
from steve_desktop.cad_live import source
from steve_desktop.vault import Vault
from steve_desktop.host_environment import host_environment


class LocalGit:
    def __init__(self, server):
        self.server=server
        self.vault=Vault(server.folder.parent/'git-connections.dpapi')
        self.config=self.vault.load()
        self.lock=threading.Lock()
        self.root=server.folder.parent/'repositories'
        self.root.mkdir(exist_ok=True)
        app=server.app
        @app.get('/v1/local/git')
        def status(): return self.status()
        @app.post('/v1/local/git/connect')
        async def connect(body:dict): return await asyncio.to_thread(self.connect,body)
        @app.post('/v1/local/git/{identifier}/{action}')
        async def act(identifier:str,action:str,body:dict):
            return await asyncio.to_thread(self.action,identifier,action,body)

    def status(self):
        return {'available':bool(shutil.which('git')), 'repositories':[
            {k:v for k,v in item.items() if k!='token'} for item in self.config.values()]}

    def git(self, item, *args, check=True):
        env=dict(host_environment(),GIT_TERMINAL_PROMPT='0',GCM_INTERACTIVE='never')
        if item.get('token'):
            auth=base64.b64encode((item.get('username','oauth2')+':'+item['token']).encode()).decode()
            env.update(GIT_CONFIG_COUNT='1',GIT_CONFIG_KEY_0='http.extraHeader',GIT_CONFIG_VALUE_0='Authorization: Basic '+auth)
        # File-backed output cannot wait for EOF on a pipe accidentally inherited
        # by a simultaneously warming Windows CAD process.
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            result=subprocess.run(['git','-c','core.hooksPath='+os.devnull,'-c','protocol.file.allow=never',
                                   '-c','http.followRedirects=false','-c','commit.gpgSign=false',*args],cwd=item['path'],env=env,
                                  stdout=out,stderr=err,stdin=subprocess.DEVNULL,timeout=180,
                                  creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            out.seek(0);err.seek(0)
            result.stdout=out.read().decode('utf-8',errors='replace')
            result.stderr=err.read().decode('utf-8',errors='replace')
        if check and result.returncode:
            # Git errors can echo remote output; never include an access token.
            message=(result.stderr or result.stdout)[-2000:]
            if item.get('token'): message=message.replace(item['token'],'[redacted]').replace(auth,'[redacted]')
            raise ValueError(message.strip() or 'Git command failed')
        return result

    def connect(self, body):
        if not self.lock.acquire(blocking=False): raise ValueError('Another Git operation is running')
        try:
            url=body.get('url','').strip(); parsed=urlsplit(url)
            if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError('Use an HTTPS repository URL without embedded credentials.')
            branch=body.get('branch','main').strip()
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,199}',branch) or '..' in branch:
                raise ValueError('Invalid branch name')
            identifier=str(uuid.uuid4()); path=self.root/identifier;path.mkdir()
            username=body.get('username','oauth2')
            if not isinstance(username,str) or not username or ':' in username or '\n' in username:raise ValueError('Invalid Git username')
            item={'id':identifier,'url':url,'branch':branch,'path':str(path),'username':username,'token':body.get('token',''), 'message':'Connected'}
            self.git(item,'init','-b',branch)
            self.git(item,'remote','add','origin',url)
            self.git(item,'fetch','origin')
            if self.git(item,'show-ref','--verify','refs/remotes/origin/'+branch,check=False).returncode==0:
                self.git(item,'checkout','-B',branch,'origin/'+branch)
            self.config[identifier]=item;self.vault.save(self.config)
            return self.status()
        finally: self.lock.release()

    def action(self, identifier, action, body):
        if not self.lock.acquire(blocking=False): raise ValueError('Another Git operation is running')
        try:
            item=self.config.get(identifier)
            if item is None: raise ValueError('Repository not found')
            if action=='disconnect':
                del self.config[identifier];self.vault.save(self.config);return self.status()
            if action=='pull':
                self.git(item,'fetch','origin')
                self.git(item,'merge','--ff-only','origin/'+item['branch'])
                item['message']='Fetched source. Import as copies to open it in Steve; existing CAD work is preserved.'
            elif action=='import':
                item['message']=self.import_sources(item)
            elif action=='push':
                message=str(body.get('message','Update CAD source')).strip()
                if not message or len(message)>200: raise ValueError('Use a commit message of 1–200 characters')
                paths=self.export_sources(item)
                self.git(item,'add','--',*paths)
                if self.git(item,'diff','--cached','--quiet',check=False).returncode:
                    self.git(item,'-c','user.name=Steve','-c','user.email=steve@localhost','commit','-m',message)
                self.git(item,'push','-u','origin','HEAD:refs/heads/'+item['branch'])
                item['message']='Source committed and pushed. No force push was used.'
            elif action=='status':
                item['message']=self.git(item,'status','--short','--branch').stdout.strip()
            else: raise ValueError('Unknown repository action')
            self.vault.save(self.config);return self.status()
        finally:self.lock.release()

    @staticmethod
    def safe_file(root, relative):
        target=root/relative
        if '.git' in Path(relative).parts or not target.resolve().is_relative_to(root.resolve()) or any(p.is_symlink() for p in [target,*target.parents] if p!=root.parent):
            raise ValueError('Repository source path escapes its document folder')
        return target

    def export_sources(self,item):
        with self.server.lock:
            docs=copy.deepcopy(self.server.state['documents'])
            current=self.server.context.get('document')
            current_id=self.server.context.get('document_id')
            if current and (not current_id or source(docs.get(current_id,{}))!=source(current)):
                raise ValueError('Save the open CAD document before pushing source.')
        if not docs: raise ValueError('There are no saved CAD documents to export')
        root=Path(item['path'])
        paths=[]
        for identifier,doc in docs.items():
            folder=self.safe_file(root,identifier);folder.mkdir(exist_ok=True)
            links={alias:{'path':ref['document_id'],**({'component':ref['component']} if ref.get('component') else {})}
                   for alias,ref in doc.get('links',{}).items()}
            meta={'steve':1,'id':identifier,'kind':doc['kind'],'name':doc['name'],'links':links}
            files={'main.py':doc['code'],'steve.json':json.dumps(meta,indent=2),**doc.get('files',{})}
            for name,text in files.items():
                path=self.safe_file(folder,name);path.parent.mkdir(parents=True,exist_ok=True)
                paths.append(path.relative_to(root).as_posix())
                if path.suffix.lower() in ('.png','.jpg','.jpeg','.webp'):path.write_bytes(base64.b64decode(text,validate=True))
                else:path.write_text(text,encoding='utf-8')
        for old in item.get('owned_files',[]):
            if old not in paths:
                path=self.safe_file(root,old)
                if path.is_file():path.unlink()
                paths.append(old)
        item['owned_files']=[p for p in paths if (root/p).is_file()]
        return paths

    def import_sources(self,item):
        root=Path(item['path']); docs=[]; paths={}
        for meta_path in root.rglob('steve.json'):
            if '.git' in meta_path.relative_to(root).parts:continue
            self.safe_file(root,meta_path.relative_to(root))
            if len(docs)>=100:raise ValueError('Import at most 100 CAD documents at once')
            meta=json.loads(meta_path.read_text(encoding='utf-8'))
            if meta.get('kind') not in ('part','design'):continue
            folder=meta_path.parent; key=folder.relative_to(root).as_posix();paths[key]=len(docs)
            files={}
            for file in folder.rglob('*'):
                if not file.is_file() or file.name in ('main.py','steve.json') or '.git' in file.parts:continue
                if any((parent/'steve.json').exists() for parent in file.parents if parent!=folder and parent.is_relative_to(folder)):continue
                if file.suffix.lower() not in ('.py','.json','.csv','.png','.jpg','.jpeg','.webp','.svg'):continue
                self.safe_file(folder,file.relative_to(folder))
                if file.stat().st_size>2_000_000:raise ValueError('Source file exceeds 2 MB')
                files[file.relative_to(folder).as_posix()]=base64.b64encode(file.read_bytes()).decode() if file.suffix.lower() in ('.png','.jpg','.jpeg','.webp') else file.read_text(encoding='utf-8')
            main=self.safe_file(folder,'main.py')
            doc={'document_id':key,'revision':1,'kind':meta['kind'],'name':meta.get('name',folder.name),
                 'code':main.read_text(encoding='utf-8'),'files':files,'links':meta.get('links',{})}
            validate(doc);docs.append(doc)
        if not docs:raise ValueError('No Studio-format CAD source found (steve.json and main.py)')
        for doc in docs:
            for alias,ref in list(doc['links'].items()):
                path=ref.get('path','.')
                if path not in paths:raise ValueError('A linked document is missing from this repository: '+path)
                doc['links'][alias]={'document_id':path,'revision':1,**({'component':ref['component']} if ref.get('component') else {})}
        result=self.server.project.import_package(docs)
        return f"Imported {result['imported']} CAD documents as new local copies. Open them from File → Open."
