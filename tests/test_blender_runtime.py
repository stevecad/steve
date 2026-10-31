import hashlib
import io
import os
import tarfile
import threading
import tempfile
import unittest
import zipfile
from pathlib import Path, PosixPath
from types import SimpleNamespace
from unittest.mock import patch

from steve_desktop.blender_runtime import probe, PACKAGES, install, environment, discover
from steve_desktop.cad_document import validate
from steve_desktop.local_blender import BlenderResult


class BlenderRuntimeTests(unittest.TestCase):
    def test_probe_compatible_version_and_reject_other_executables(self):
        with tempfile.TemporaryDirectory() as folder:
            executable=Path(folder)/'blender'
            executable.write_bytes(b'fixture')
            with patch('steve_desktop.blender_runtime.subprocess.run') as run:
                run.return_value=SimpleNamespace(returncode=0,stdout='Blender 4.5.9\nBuild date')
                self.assertEqual(probe(executable)['version'],'4.5.9')
                self.assertEqual(run.call_args.args[0],[str(executable.resolve()),'--version'])
                for version in ('Blender 3.6.0','Blender 5.0.0','Not Blender'):
                    run.return_value=SimpleNamespace(returncode=0,stdout=version)
                    with self.assertRaises(ValueError):probe(executable)

    def test_bad_download_is_rejected_and_staging_cleaned(self):
        with tempfile.TemporaryDirectory() as folder:
            response=io.BytesIO(b'not the official executable')
            response.headers={'Content-Length':str(len(response.getvalue()))}
            # Pin a packaged platform. Darwin has no archive, so an unmocked Mac host
            # raises before the download is hashed.
            with patch('steve_desktop.blender_runtime.platform.system',return_value='Linux'), \
                 patch('steve_desktop.blender_runtime.platform.machine',return_value='x86_64'), \
                 patch('steve_desktop.blender_runtime.urllib.request.urlopen',return_value=response) as opened:
                with self.assertRaisesRegex(ValueError,'SHA-256'):
                    install(Path(folder),threading.Event(),lambda message:None)
                self.assertIn('linux-x64', opened.call_args.args[0])
            self.assertEqual(list(Path(folder).iterdir()),[])

    def _response(self, payload):
        response = io.BytesIO(payload)
        response.headers = {'Content-Length': str(len(payload))}
        return response

    def test_oversized_download_is_rejected_before_hashing(self):
        # A zero Content-Length must not bypass the byte cap.
        response = self._response(b'x' * 32)
        response.headers = {'Content-Length': '0'}
        with tempfile.TemporaryDirectory() as folder:
            with patch('steve_desktop.blender_runtime.MAX_DOWNLOAD', 8), \
                 patch('steve_desktop.blender_runtime.urllib.request.urlopen', return_value=response):
                with self.assertRaisesRegex(ValueError, 'size limit'):
                    install(Path(folder), threading.Event(), lambda message: None)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_symlink_and_traversal_entries_are_rejected(self):
        def zipped(name, data, mode=0):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as archive:
                info = zipfile.ZipInfo(name)
                if mode:
                    info.external_attr = mode << 16
                archive.writestr(info, data)
            return buffer.getvalue()

        cases = (
            zipped('escape-link', b'/tmp/outside', 0o120777),
            zipped('../escape', b'bad'),
            zipped('blender/../../escape', b'bad'),
        )
        for payload in cases:
            digest = hashlib.sha256(payload).hexdigest()
            with self.subTest(payload=payload[:24]):
                with tempfile.TemporaryDirectory() as folder:
                    with patch('steve_desktop.blender_runtime.platform.system', return_value='Windows'), \
                         patch('steve_desktop.blender_runtime.platform.machine', return_value='AMD64'), \
                         patch.dict('steve_desktop.blender_runtime.PACKAGES', {('Windows', 'AMD64'): ('windows-x64.zip', digest)}), \
                         patch('steve_desktop.blender_runtime.urllib.request.urlopen', return_value=self._response(payload)):
                        with self.assertRaisesRegex(ValueError, 'Unsafe'):
                            install(Path(folder), threading.Event(), lambda message: None)
                    self.assertEqual(list(Path(folder).iterdir()), [])

    def test_tar_expansion_is_bounded(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:xz') as archive:
            payload = b'x' * 64
            info = tarfile.TarInfo('padding')
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
        data = buffer.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as folder:
            with patch('steve_desktop.blender_runtime.platform.system', return_value='Linux'), \
                 patch('steve_desktop.blender_runtime.platform.machine', return_value='x86_64'), \
                 patch('steve_desktop.blender_runtime.MAX_UNPACKED', 16), \
                 patch.dict('steve_desktop.blender_runtime.PACKAGES', {('Linux', 'x86_64'): ('linux-x64.tar.xz', digest)}), \
                 patch('steve_desktop.blender_runtime.urllib.request.urlopen', return_value=self._response(data)):
                with self.assertRaisesRegex(ValueError, 'expands too far'):
                    install(Path(folder), threading.Event(), lambda message: None)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_frozen_external_runtime_uses_original_library_environment(self):
        with patch.dict(os.environ,{'LD_LIBRARY_PATH':'/frozen','LD_LIBRARY_PATH_ORIG':'/system','PYTHONHOME':'/frozen','PYTHONPATH':'/frozen'}):
            result=environment()
            self.assertEqual(result['LD_LIBRARY_PATH'],'/system')
            self.assertNotIn('PYTHONHOME',result)
            self.assertNotIn('PYTHONPATH',result)
            self.assertEqual(os.environ['LD_LIBRARY_PATH'],'/frozen')

    def test_windows_and_linux_packages_are_pinned(self):
        for platform in (('Windows','AMD64'),('Windows','ARM64'),('Linux','x86_64')):
            filename,digest=PACKAGES[platform]
            self.assertEqual(len(digest),64)
            self.assertTrue(filename.endswith(('.zip','.tar.xz')))

    def test_blender_source_keeps_file_traversal_validation(self):
        document={'kind':'blender','name':'Scene','code':'import bpy','files':{},'links':{}}
        self.assertEqual(validate(document)['kind'],'blender')
        with self.assertRaises(ValueError):validate({**document,'files':{'../outside.py':'bad'}})

    def test_inspection_and_exports_require_existing_artifacts(self):
        with tempfile.TemporaryDirectory() as folder:
            result=BlenderResult(folder,{'object_details':{'Cube':{'type':'MESH'}}})
            self.assertEqual(result.inspect('Cube'),{'object':{'type':'MESH'}})
            with self.assertRaises(ValueError):result.inspect('Missing')
            with self.assertRaises(ValueError):result.export('STEP')
            with self.assertRaises(ValueError):result.export('BLEND')
            (Path(folder)/'result.blend').write_bytes(b'BLENDER')
            self.assertTrue(Path(result.export('BLEND')['path']).is_file())

    def _candidates(self, root, system, probe_fn, name='posix', home=None, environ=None, configured='', path_type=None):
        """Run discover with platform and filesystem checks mocked. Returns (result, probed paths)."""
        seen=[]
        def record(path):
            seen.append(str(path))
            return probe_fn(str(path))
        env={'STEVE_BLENDER':''}
        if environ:env.update(environ)
        # Python 3.13 refuses to construct WindowsPath when os.name is nt on Linux.
        # The Windows branch still runs; PosixPath stands in for the filesystem.
        path_type=path_type or Path
        with patch('steve_desktop.blender_runtime.platform.system',return_value=system), \
             patch('steve_desktop.blender_runtime.os.name',name), \
             patch('steve_desktop.blender_runtime.shutil.which',return_value=None), \
             patch('steve_desktop.blender_runtime.Path',path_type), \
             patch('steve_desktop.blender_runtime.Path.home',return_value=home or Path('/Users/cad')), \
             patch('steve_desktop.blender_runtime.probe',side_effect=record), \
             patch.dict(os.environ,env):
            return discover(root,configured), seen

    def test_darwin_discover_probes_system_then_user_blender_app(self):
        home=Path('/Users/cad')
        system=str(Path('/Applications/Blender.app')/'Contents'/'MacOS'/'Blender')
        user=str(home/'Applications'/'Blender.app'/'Contents'/'MacOS'/'Blender')
        accepted={'path':user,'version':'4.5.9','build':'user'}
        def fake_probe(path):
            if path==user:return accepted
            raise ValueError('not blender')
        with tempfile.TemporaryDirectory() as folder:
            found,seen=self._candidates(Path(folder),'Darwin',fake_probe,home=home)
        self.assertEqual(found,accepted)
        self.assertEqual(seen,[system,user])

    def test_darwin_discover_stops_at_the_system_blender_app(self):
        home=Path('/Users/cad')
        system=str(Path('/Applications/Blender.app')/'Contents'/'MacOS'/'Blender')
        accepted={'path':system,'version':'4.5.9','build':'system'}
        def fake_probe(path):
            if path==system:return accepted
            raise ValueError('not blender')
        with tempfile.TemporaryDirectory() as folder:
            found,seen=self._candidates(Path(folder),'Darwin',fake_probe,home=home)
        self.assertEqual(found,accepted)
        self.assertEqual(seen,[system])

    def test_darwin_discover_returns_none_when_no_app_is_blender_4_5(self):
        home=Path('/Users/cad')
        system=str(Path('/Applications/Blender.app')/'Contents'/'MacOS'/'Blender')
        user=str(home/'Applications'/'Blender.app'/'Contents'/'MacOS'/'Blender')
        def reject(path):
            raise ValueError('not blender')
        with tempfile.TemporaryDirectory() as folder:
            found,seen=self._candidates(Path(folder),'Darwin',reject,home=home)
        self.assertIsNone(found)
        self.assertEqual(seen,[system,user])

    def test_linux_discover_keeps_distro_executables(self):
        def reject(path):
            raise ValueError('not blender')
        with tempfile.TemporaryDirectory() as folder:
            found,seen=self._candidates(Path(folder),'Linux',reject)
        self.assertIsNone(found)
        self.assertEqual(seen,['/usr/bin/blender','/snap/bin/blender'])

    def test_windows_discover_keeps_program_files_layout(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            executable=root/'Program Files'/'Blender Foundation'/'Blender 4.5'/'blender.exe'
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b'fixture')
            accepted={'path':str(executable),'version':'4.5.9','build':'win'}
            def fake_probe(path):
                # os.name is nt for this call, so pathlib.Path would be a WindowsPath and miss the file.
                self.assertTrue(PosixPath(path).is_file())
                return accepted
            found,seen=self._candidates(root/'runtime','Windows',fake_probe,name='nt',environ={'PROGRAMFILES':str(root/'Program Files')},path_type=PosixPath)
        self.assertEqual(found,accepted)
        self.assertEqual(seen,[str(executable)])

    def test_darwin_automatic_install_stays_unavailable(self):
        self.assertNotIn(('Darwin','arm64'),PACKAGES)
        with tempfile.TemporaryDirectory() as folder, \
             patch('steve_desktop.blender_runtime.platform.system',return_value='Darwin'), \
             patch('steve_desktop.blender_runtime.platform.machine',return_value='arm64'), \
             patch('steve_desktop.blender_runtime.urllib.request.urlopen') as opened:
            with self.assertRaisesRegex(ValueError,'manually'):
                install(Path(folder),threading.Event(),lambda message:None)
            opened.assert_not_called()


if __name__=='__main__':unittest.main()
