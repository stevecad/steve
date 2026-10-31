import io
import os
import threading
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from steve_desktop.blender_runtime import probe, PACKAGES, install, environment
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
            with patch('steve_desktop.blender_runtime.urllib.request.urlopen',return_value=response):
                with self.assertRaisesRegex(ValueError,'SHA-256'):
                    install(Path(folder),threading.Event(),lambda message:None)
            self.assertEqual(list(Path(folder).iterdir()),[])

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


if __name__=='__main__':unittest.main()
