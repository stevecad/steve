"""Signed update feeds from dl.stevecad.studio; download in background, apply after exit."""

from steve_desktop.paths import RESOURCE_ROOT
import hashlib
import json
import os
import platform
import ssl
from pathlib import Path
import shutil
import sys
import threading
import uuid
import zipfile
from urllib.parse import urlsplit
import httpx
from packaging.version import Version
from steve_desktop.vault import Vault
from steve_desktop.update_manifest import channel_trust, public_key_list, verify_manifest, verify_stored

VERSION='0.4.3'
DOWNLOAD_PAGE='https://dl.stevecad.studio/'


def update_platform():
    if platform.machine().lower() not in ('x86_64', 'amd64'):
        return None
    return {'win32':'windows-x64', 'linux':'linux-x64'}.get(sys.platform)


def supports_portable_updates():
    return update_platform() is not None


def shipped_channel():
    path = RESOURCE_ROOT / 'assets/update-channel.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}


def default_channel(target_platform=None):
    """The shipped feed, keys and download host for this (or the given) platform."""
    return channel_trust(shipped_channel(), {}, target_platform or update_platform())


def update_settings(saved):
    """Only automatic/apply preferences and an administrator-provisioned managed override persist; older keys are dropped."""
    result={key:saved[key] for key in ('automatic','apply_requested') if key in saved}
    override=saved.get('override')
    if isinstance(override,dict) and override.get('source') and override.get('public_keys'):
        result['override']={'source':override['source'],'public_keys':list(override['public_keys'])}
    return result


def trust(config, target_platform=None):
    return channel_trust(shipped_channel(), config, target_platform or update_platform())


def stored_manifest(manifest, profile, target_platform):
    """Re-verify a staged/installed manifest with the profile's trust roots (no expiry check)."""
    return verify_stored(manifest, shipped_channel(), update_settings(Vault(Path(profile)/'updates.dpapi').load()), target_platform)


def update_tls_context():
    import certifi
    context=ssl.create_default_context(cafile=certifi.where())
    # Include the user's/system's CA configuration for managed networks while
    # retaining bundled public roots. Proxy environment variables stay disabled.
    context.load_default_certs()
    return context


def extract_package(archive, destination):
    with zipfile.ZipFile(archive) as z:
        if sum(i.file_size for i in z.infolist())>8_000_000_000:raise ValueError('Update package is too large')
        for item in z.infolist():
            name=item.filename.replace('\\','/')
            target=destination/name
            if not name.startswith('Steve/') or ':' in name or not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError('Unsafe path in update package')
            if (item.external_attr>>16)&0o170000==0o120000:raise ValueError('Update package cannot contain symlinks')
        z.extractall(destination)
    if not (destination/'Steve/Steve.exe').is_file():raise ValueError('Update is missing Steve.exe')
    return destination/'Steve'


class LocalUpdates:
    def __init__(self,server):
        self.server=server
        self.root=server.folder.parent/'updates';self.root.mkdir(exist_ok=True)
        self.vault=Vault(server.folder.parent/'updates.dpapi')
        self.platform=update_platform()
        saved=self.vault.load()
        self.config={'automatic':supports_portable_updates(),**update_settings(saved)}
        if saved and saved!=self.config:
            # Older releases saved a GitHub feed, its key and a release token: none apply now.
            self.vault.save(self.config)
        self.busy=False;self.message='Steve checks for updates automatically.' if self.trust().get('source') else 'No update source configured.';self.pending=None;self.apply_requested=False
        self.restart_requested=False
        self.linux_pending=None
        self.update_error=False
        if self.platform == 'windows-x64':
            from steve_desktop.windows_updates import pending
            try:
                self.pending=pending(server.folder.parent)
                if self.pending:self.message='An update is ready. ' + ('It will install after you close Steve.' if self.config.get('automatic',True) or self.config.get('apply_requested',False) else 'Choose Install on next exit to apply it.')
            except Exception as exc:
                self.message='The staged update could not be verified. '+str(exc)
                self.update_error=True
                Vault(server.folder.parent/'windows-update.dpapi').path.unlink(missing_ok=True)
            report=self.root/'last-update.json'
            if report.is_file():
                try:
                    result=json.loads(report.read_text(encoding='utf-8-sig'))
                    if result.get('status') in ('failed','deferred'):
                        self.message='The previous update was not installed. '+result.get('error','')
                        self.update_error=True
                except (OSError,ValueError):
                    self.message='The previous update report could not be read.'
        if self.platform == 'linux-x64':
            from steve_desktop.linux_updates import state_vault, verify_bundle, prune_bundles
            state={};pending=None
            try:
                state=state_vault(server.folder.parent).load()
                pending=state.get('pending')
                if pending and Version(pending['manifest']['version']) > Version(VERSION):
                    self.linux_pending=pending
                    self.pending=verify_bundle(server.folder.parent,pending)
                    self.message=f"Steve {pending['manifest']['version']} is ready to install after you close Steve."
                try:prune_bundles(server.folder.parent)
                except OSError:pass
                report=self.root/'last-update.json'
                if report.is_file():
                    result=json.loads(report.read_text())
                    if result.get('status') in ('failed','rolled-back'):
                        self.message='The previous update could not start. Your working version was retained. '+result.get('error','')
            except Exception as exc:
                self.pending=None;self.linux_pending=None
                if pending:
                    state.pop('pending',None)
                    state['failed']=list(dict.fromkeys([*state.get('failed',[]),pending['manifest']['sha256']]))[-8:]
                    state_vault(server.folder.parent).save(state)
                self.message='Stored update state could not be opened. '+str(exc)
        if not supports_portable_updates():
            self.message='Download a new release to update Steve. Your projects and settings are kept separately.'
        self.lock=threading.Lock();self.closed=threading.Event()
        app=server.app
        @app.get('/v1/local/updates')
        def status():return self.status()
        @app.put('/v1/local/updates')
        def settings(body:dict):
            # Only the automatic-update preference. The feed and its keys are never changed from the app or its API
            # (2026-10-31): a "paste this feed and key" scam would install the attacker's code. A managed deployment's
            # override is provisioned in updates.dpapi by whoever administers the machine (update_settings keeps it).
            if self.busy:raise ValueError('Wait for the current update check to finish')
            if set(body)-{'automatic'}:raise ValueError('Unknown update setting')
            if type(body.get('automatic')) is not bool:raise ValueError('Automatic updates must be on or off')
            self.config=dict(self.config,automatic=body['automatic']);self.vault.save(self.config)
            return self.status()
        @app.post('/v1/local/updates/check')
        async def check():
            threading.Thread(target=self.check,daemon=True,name='Steve update check').start()
            return self.status()
        @app.post('/v1/local/updates/install')
        def install():
            if not supports_portable_updates():raise ValueError('Download a new release to update Steve on this platform.')
            if self.pending is None:raise ValueError('Check for an update first')
            self.apply_requested=True
            if self.platform=='windows-x64':
                self.config['apply_requested']=True
                self.vault.save(self.config)
            self.message='Update will install after you close Steve.'
            return self.status()
        @app.post('/v1/local/updates/restart')
        def restart():
            # Same session/origin protection as every local route (LocalCadServer's middleware). Closing goes through
            # the window's normal close: an unsaved chat draft is kept and a running request finishes first. The
            # restart flag stays set, so a deferred close still installs and reopens once Steve does close.
            if not self.can_apply():raise ValueError('Restart and update is available in packaged Steve.')
            if self.pending is None or (self.platform=='linux-x64' and not self.linux_pending):
                raise ValueError('No update is ready to install.')
            actions=getattr(self.server,'desktop_actions',None)
            if actions is None:raise ValueError('Close Steve to install the update.')
            if self.platform=='windows-x64' and Path(sys.executable).resolve().parent.name!='Steve':
                raise ValueError('Update ready; the installed application folder must be named Steve.')
            self.apply_requested=True;self.restart_requested=True
            if self.platform=='windows-x64':
                self.config['apply_requested']=True
                self.vault.save(self.config)
            self.message='Steve will install the update and open again as soon as it closes.'
            actions.put('close')
            return self.status()
        self.thread=threading.Thread(target=self.background,daemon=True,name='Steve updates');self.thread.start()

    def status(self):
        current=self.trust()
        return {'version':VERSION,'source':current.get('source',''),'public_keys':current.get('public_keys',[]),
                'override':bool(current.get('override')),
                'automatic':self.config.get('automatic',True),
                'busy':self.busy,'message':self.message,'ready':self.pending is not None,'update_error':self.update_error,
                'can_apply':self.can_apply(),
                'supports_updates':supports_portable_updates(),
                'download_url':DOWNLOAD_PAGE}

    def can_apply(self):
        return bool(getattr(sys,'frozen',False) and supports_portable_updates())

    def trust(self):
        try:return trust(self.config,self.platform)
        except ValueError:return {'source':'','public_keys':[],'host':'','override':True}

    def background(self):
        if not getattr(sys, 'frozen', False) or not supports_portable_updates() or '--smoke-test' in sys.argv:return
        while not self.closed.wait(10):
            if self.config.get('automatic',True) and self.trust().get('source'):
                self.check()
            if self.closed.wait(6*60*60):return

    def check(self):
        if not supports_portable_updates():return
        if not self.lock.acquire(blocking=False):return
        self.busy=True
        staging=None
        try:
            if self.pending is not None:return
            self.message='Checking for updates…'
            current=self.trust()
            source,keys,host=current['source'],current['public_keys'],current['host']
            if not source or not keys:raise ValueError('Configure an update feed and its signing public key first.')
            headers={'Accept':'application/json'}
            with httpx.Client(timeout=60,follow_redirects=False,trust_env=False,verify=update_tls_context()) as client:
                r=client.get(source,headers=headers);r.raise_for_status()
                if len(r.content)>65536:raise ValueError('Update manifest is too large')
                manifest=r.json()
                verified=verify_manifest(manifest,keys,expected_platform=self.platform,host=host)
                if Version(verified['version'])<=Version(VERSION):
                    self.update_error=False
                    (self.root/'last-update.json').unlink(missing_ok=True)
                    self.message='Steve is up to date.'
                    return
                if self.platform=='linux-x64':
                    from steve_desktop.linux_updates import state_vault
                    if verified['sha256'] in state_vault(self.server.folder.parent).load().get('failed',[]):
                        self.message='This update failed startup checks. Steve will keep your working version and wait for a corrected release.'
                        return
                new=verified['version'];self.message=f'Downloading Steve {new}…'
                staging=self.root/str(uuid.uuid4());staging.mkdir()
                archive=staging/('update.tar.gz' if self.platform=='linux-x64' else 'update.zip');digest=hashlib.sha256();size=0
                with client.stream('GET',verified['url'],headers={'Accept':'application/octet-stream'}) as response:
                    response.raise_for_status()
                    total=int(response.headers.get('content-length') or 0);shown=-1
                    with archive.open('wb') as out:
                        for chunk in response.iter_bytes():
                            if self.closed.is_set():raise ValueError('Update download cancelled on exit')
                            size+=len(chunk)
                            if size>4_000_000_000:raise ValueError('Update download is too large')
                            digest.update(chunk);out.write(chunk)
                            mb=size//1048576
                            if mb!=shown:   # the settings page reads this every 2 s: the person sees the download move
                                shown=mb;self.message=f'Downloading Steve {new}: {mb} of {total//1048576} MB' if total else f'Downloading Steve {new}: {mb} MB'
                self.message=f'Preparing Steve {new}…'
                if digest.hexdigest()!=verified['sha256']:raise ValueError('Update checksum does not match signed manifest')
                if self.platform=='linux-x64':
                    from steve_desktop.linux_updates import stage_bundle,executable
                    self.linux_pending=stage_bundle(self.server.folder.parent,archive,manifest,keys,host)
                    package=executable(self.server.folder.parent,self.linux_pending)
                else:
                    package=extract_package(archive,staging)
                    if (package/'uninstall').exists():raise ValueError('Update must not contain installer records')
                    from steve_desktop.windows_updates import remember
                    remember(self.server.folder.parent,package,manifest)
                archive.unlink()
                if self.platform=='linux-x64':staging.rmdir()
                self.pending=package
                self.update_error=False
                (self.root/'last-update.json').unlink(missing_ok=True)
                self.message=f"Steve {verified['version']} is ready. " + ('It will install after you close Steve.' if self.config.get('automatic',True) else 'Choose Install on next exit to apply it.')
        except httpx.HTTPStatusError as exc:
            self.update_error=True
            self.message=f'Update server returned HTTP {exc.response.status_code}; Steve will try again automatically.'
            if staging and staging.resolve().parent==self.root.resolve() and staging.exists():
                shutil.rmtree(staging)
        except Exception as exc:
            self.update_error=True
            self.message='Update check failed: '+(str(exc) or type(exc).__name__)
            if staging and staging.resolve().parent==self.root.resolve() and staging.exists():
                shutil.rmtree(staging)
        finally:self.busy=False;self.lock.release()

    def close(self):
        self.closed.set()
        if not self.pending or not (self.config.get('automatic',True) or self.apply_requested) or not getattr(sys,'frozen',False):return
        if self.platform=='linux-x64' and self.linux_pending:
            from steve_desktop.linux_updates import schedule_activation
            try:
                if self.restart_requested:
                    from steve_desktop.linux_updates import stable_launcher
                    schedule_activation(self.server.folder.parent,self.linux_pending,restart=stable_launcher())
                else:
                    schedule_activation(self.server.folder.parent,self.linux_pending)
            except Exception as exc:
                from steve_desktop.linux_updates import write_report
                write_report(self.server.folder.parent,status='failed',error=str(exc))
            return
        if os.name!='nt':return
        installed=Path(sys.executable).resolve().parent
        if installed.name!='Steve':
            self.message='Update ready; the installed application folder must be named Steve.';return
        from steve_desktop.windows_updates import launch, pending
        try:
            candidate=pending(self.server.folder.parent)
            if candidate:
                if self.restart_requested:launch(self.server.folder.parent,candidate,restart=True)
                else:launch(self.server.folder.parent,candidate)
        except Exception as exc:
            (self.root/'last-update.json').write_text(json.dumps({'status':'failed','error':str(exc)}),encoding='utf-8')
