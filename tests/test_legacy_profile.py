import sqlite3
from contextlib import closing
import tempfile
import unittest
from pathlib import Path
from steve_desktop.legacy_profile import migrate_profile
from steve_desktop.vault import Vault

class LegacyProfileTests(unittest.TestCase):
    def test_prior_profile_credentials_documents_memory_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);old=root/'SteveLocal';old.mkdir()
            Vault(old/'credentials.dpapi').save({'test':'encrypted'})
            (old/'cad').mkdir();(old/'cad/catalog.json').write_text('{"documents":{}}')
            with closing(sqlite3.connect(old/'memory.sqlite3')) as db, db:
                db.execute('CREATE TABLE memory_files(path TEXT PRIMARY KEY, content TEXT)')
                db.execute('INSERT INTO memory_files VALUES (?,?)',('stevelocal/main/MEMORY.md','Keep this note'))
            target=migrate_profile(root)
            self.assertEqual(target,root/'Steve/CAD')
            self.assertEqual(Vault(target/'credentials.dpapi').load(),{'test':'encrypted'})
            self.assertEqual((target/'cad/catalog.json').read_bytes(),(old/'cad/catalog.json').read_bytes())
            with closing(sqlite3.connect(target/'memory.sqlite3')) as db, db:
                self.assertEqual(db.execute('SELECT path,content FROM memory_files').fetchone(),('steve/main/MEMORY.md','Keep this note'))
            self.assertTrue(old.is_dir())
            self.assertEqual(migrate_profile(root),target)
