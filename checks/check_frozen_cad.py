from pathlib import Path
import os,sys,unittest
from types import SimpleNamespace
from unittest.mock import patch
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root))
from tests.test_hot_worker import HotWorkerTests
from steve_desktop.cad_worker import WORKER
with patch('steve_desktop.cad_worker.sys',SimpleNamespace(executable=str(Path(sys.argv[1]).resolve()),frozen=True)):
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(HotWorkerTests))
WORKER.close()
raise SystemExit(not result.wasSuccessful())
