import asyncio
import os
import tempfile
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel
from steve_desktop.runtime import chat
from steve_desktop.service import Service
from steve_desktop.vault import Vault
from steve_desktop.agent_features import PortableFiles, WindowsCommands, memory_store, Skills, skill_library_paths


class FeatureTests(unittest.TestCase):
    def run_steps(self, directory, steps, *, settings=None, allow=True):
        outputs = []
        counter = 0
        async def model(messages, info):
            nonlocal counter
            self.last_instructions = info.instructions
            self.last_messages = messages
            self.last_model_settings = info.model_settings
            outputs.extend(part.content for part in messages[-1].parts if isinstance(part, ToolReturnPart))
            if counter < len(steps):
                name, arguments = steps[counter]
                counter += 1
                self.assertIn(name, [tool.name for tool in info.function_tools])
                return ModelResponse(parts=[ToolCallPart(name, arguments, tool_call_id=str(counter))])
            return ModelResponse(parts=[TextPart('Done')])
        approval = AsyncMock(return_value=allow)
        source = Service(Vault(Path(directory) / 'auth.dpapi')).source
        asyncio.run(chat(source, 'test', 'Test', [],
            {'workspace': directory, '_data_dir': directory, **(settings or {})},
            approval, lambda text: None, model_override=FunctionModel(model)))
        return outputs, approval

    def test_upstream_files_paging_edit_without_approval(self):
        with tempfile.TemporaryDirectory() as folder:
            output, approval = self.run_steps(folder, [
                ('write_file', {'path': 'notes.txt', 'content': 'one\ntwo\nthree\n'}),
                ('read_file', {'path': 'notes.txt', 'offset': 1, 'limit': 1}),
                ('edit_file', {'path': 'notes.txt', 'old_text': 'two', 'new_text': 'second'}),
            ])
            self.assertEqual(Path(folder, 'notes.txt').read_text(), 'one\nsecond\nthree\n')
            self.assertIn('two', str(output[1]))
            self.assertNotIn('three', str(output[1]))
            approval.assert_not_awaited()

    def test_edit_ignores_retired_approval_callback(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'notes.txt'
            path.write_text('original')
            self.run_steps(folder, [('edit_file', {'path': 'notes.txt', 'old_text': 'original', 'new_text': 'changed'})], allow=False)
            self.assertEqual(path.read_text(), 'changed')

    def test_portable_files_reject_escape(self):
        with tempfile.TemporaryDirectory() as folder:
            backend = PortableFiles(folder)
            for path in ('/../outside', 'C:/Windows/test', '/C:/Windows/test', '/foo\\bar'):
                with self.assertRaises((ValueError, PermissionError)):
                    backend.path(path)

    def test_memory_persists_and_is_reused(self):
        with tempfile.TemporaryDirectory() as folder:
            _, approval = self.run_steps(folder, [('write_memory', {'content': 'Favorite color: green.'})], settings={'memory_enabled': True})
            approval.assert_not_awaited()
            store = memory_store(folder)
            paths = asyncio.run(store.list_paths(limit=100))
            self.assertEqual(paths, ['steve/main/MEMORY.md'])
            entry = asyncio.run(store.read(paths[0], max_chars=1000))
            self.assertIn('green', entry.content)
            output, _ = self.run_steps(folder, [('read_memory', {'file': 'MEMORY.md'})], settings={'memory_enabled': True})
            self.assertIn('green', str(output))

    def test_upstream_skill_discovery_and_loading(self):
        with tempfile.TemporaryDirectory() as folder:
            library = Path(folder) / 'skills'
            skill = library / 'review'
            skill.mkdir(parents=True)
            (skill / 'SKILL.md').write_text('---\nname: review\ndescription: Review code carefully.\n---\nLook for boundary conditions.\n')
            catalog = asyncio.run(Skills('/', workspace=PortableFiles(library)).load())
            self.assertEqual([skill.name for skill in catalog.skills], ['review'])
            outputs, _ = self.run_steps(folder, [('load_capability', {'id': 'review'})], settings={'skill_libraries': [str(library)]})
            self.assertIn('boundary conditions', str(self.last_messages))

    def test_prompt_and_effort_reach_the_model(self):
        with tempfile.TemporaryDirectory() as folder:
            self.run_steps(folder, [], settings={'system_prompt': 'Use concise answers.', 'reasoning_effort': 'high'})
            self.assertIn('Use concise answers.', self.last_instructions)
            self.assertEqual(self.last_model_settings['openai_reasoning_effort'], 'high')

    def test_bundled_cad_skills_discover_and_load_without_configuration(self):
        library = skill_library_paths({})[0]
        catalog = asyncio.run(Skills('/', workspace=PortableFiles(library)).load())
        expected = {'steve-designs', 'steve-drawings', 'steve-materials', 'steve-motion',
                    'steve-sheet-metal', 'steve-standard-parts', 'steve-step-import', 'steve-surfaces', 'steve-blender'}
        self.assertEqual({skill.name for skill in catalog.skills}, expected)
        self.assertFalse(catalog.skipped)
        self.assertEqual(skill_library_paths({'skill_libraries': [library]}), [library])
        with tempfile.TemporaryDirectory() as folder:
            self.run_steps(folder, [('load_capability', {'id': 'steve-drawings'})])
            self.assertIn('Steve execution rules', str(self.last_messages))
            self.assertIn('cad_build', str(self.last_messages))
            self.assertIn('steve-drawings', self.last_instructions)

    @unittest.skipUnless(os.name == 'nt', 'Windows process adapter')
    def test_windows_script_and_timeout(self):
        with tempfile.TemporaryDirectory() as folder:
            runner = WindowsCommands(folder)
            result = asyncio.run(runner.run_command("Write-Output 'native-powerShell'; Set-Content -LiteralPath 'created.txt' -Value 'done'"))
            self.assertIn('native-powerShell', result)
            self.assertTrue(Path(folder, 'created.txt').exists())
            result = asyncio.run(runner.run_command('Start-Sleep -Seconds 20', timeout_seconds=.3))
            self.assertIn('Timed out', result)

    @unittest.skipUnless(os.name == 'nt', 'Windows process adapter')
    def test_enabled_script_runs_without_approval(self):
        with tempfile.TemporaryDirectory() as folder:
            self.run_steps(folder, [('run_command', {'command': "Set-Content -LiteralPath 'bad.txt' -Value 'bad'"})], allow=False)
            self.assertTrue(Path(folder, 'bad.txt').exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows process adapter')
    def test_script_cancellation_kills_descendants(self):
        with tempfile.TemporaryDirectory() as folder:
            child = Path(folder) / 'child.py'
            child.write_text("import time\nfrom pathlib import Path\ntime.sleep(2)\nPath('escaped.txt').write_text('bad')\n")
            executable = sys.executable.replace("'", "''")
            script_path = str(child).replace("'", "''")
            command = f"Start-Process -FilePath '{executable}' -ArgumentList '\"{script_path}\"' -WindowStyle Hidden; Write-Output 'started'; Start-Sleep -Seconds 20"
            async def check():
                task = asyncio.create_task(WindowsCommands(folder).run_command(command))
                await asyncio.sleep(.8)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                await asyncio.sleep(2)
            asyncio.run(check())
            self.assertFalse(Path(folder, 'escaped.txt').exists())
