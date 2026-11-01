import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from steve_desktop.cad_service import rename_when_released


class RenameWhenReleasedTests(unittest.TestCase):
    def test_waits_for_windows_to_release_the_folder(self):
        with tempfile.TemporaryDirectory() as root:
            source, destination = Path(root) / 'build-a', Path(root) / 'revision-a'
            source.mkdir()
            real, calls = Path.rename, []

            def rename(self, target):
                calls.append(target)
                if len(calls) < 3:
                    raise PermissionError(32, 'The process cannot access the file because it is being used by another process')
                return real(self, target)

            with patch.object(Path, 'rename', rename), patch('steve_desktop.cad_service.time.sleep'):
                rename_when_released(source, destination)
            self.assertEqual(len(calls), 3)
            self.assertTrue(destination.is_dir())
            self.assertFalse(source.exists())

    def test_gives_up_when_the_folder_stays_locked(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'build-a'
            source.mkdir()

            def rename(self, target):
                raise PermissionError(32, 'locked')

            with patch.object(Path, 'rename', rename), patch('steve_desktop.cad_service.time.sleep'):
                with self.assertRaises(PermissionError):
                    rename_when_released(source, Path(root) / 'revision-a', attempts=3)
            self.assertTrue(source.is_dir())


if __name__ == '__main__':
    unittest.main()
