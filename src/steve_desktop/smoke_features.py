"""Offline checks for the packaged capability stack; writes only in the given temp folder."""
import os
from pathlib import Path
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.messages import ModelResponse, ToolCallPart, TextPart
from steve_desktop.agent_features import memory_store
from steve_desktop.runtime import chat
from steve_desktop.service import Service
from steve_desktop.vault import Vault


def check_webview(window):
    """Wait for the shipped React application, rather than just grabbing an empty widget."""
    from PySide6.QtCore import QEventLoop, QTimer
    loop = QEventLoop()
    ready = False
    def loaded(value):
        nonlocal ready
        if value:
            ready = True
            loop.quit()
    def poll():
        window.cad_panel.page.runJavaScript(
            "document.readyState === 'complete' && !!document.querySelector('#root > *')", loaded)
    timer = QTimer()
    timer.timeout.connect(poll)
    timer.start(100)
    timeout = QTimer()
    timeout.setSingleShot(True)
    timeout.timeout.connect(loop.quit)
    timeout.start(30000)
    window.show()
    loop.exec()
    timer.stop()
    timeout.stop()
    assert ready, 'The packaged CAD frontend did not render within 30 seconds.'


async def check_features(folder):
    check_sketch_solver()
    root = Path(folder)
    skill = root / 'skills' / 'smoke'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text('---\nname: smoke\ndescription: A test skill.\n---\nCheck your work.\n', encoding='utf-8')
    steps = [
        ('write_file', {'path': 'check.txt', 'content': 'first\nsecond\n'}),
        ('read_file', {'path': 'check.txt', 'offset': 1, 'limit': 1}),
        ('edit_file', {'path': 'check.txt', 'old_text': 'second', 'new_text': 'updated'}),
        ('run_command', {'command': "Write-Output 'smoke-ok'" if os.name == 'nt' else "printf 'smoke-ok'"}),
        ('load_capability', {'id': 'smoke'}),
        ('load_capability', {'id': 'steve-drawings'}),
        ('write_memory', {'content': 'Smoke check complete.'}),
    ]
    index = 0
    async def model(messages, info):
        nonlocal index
        if index < len(steps):
            name, args = steps[index]
            index += 1
            assert name in [tool.name for tool in info.function_tools]
            return ModelResponse(parts=[ToolCallPart(name, args, tool_call_id=str(index))])
        assert 'smoke-ok' in str(messages)
        assert 'Check your work.' in str(messages)
        assert 'Steve execution rules' in str(messages)
        return ModelResponse(parts=[TextPart('ok')])
    async def approve(*args):
        return True
    output, _ = await chat(Service(Vault(root / 'auth.dpapi')).source, 'offline-test', 'Test', [],
        {'workspace': str(root), '_data_dir': str(root), 'skill_libraries': [str(root / 'skills')], 'memory_enabled': True},
        approve, lambda _: None, model_override=FunctionModel(model))
    assert output == 'ok'
    assert (root / 'check.txt').read_text() == 'first\nupdated\n'
    entry = await memory_store(root).read('steve/main/MEMORY.md', max_chars=1000)
    assert entry and 'Smoke check complete.' in entry.content


def check_sketch_solver():
    # Force a real constraint solve; unconstrained sketch geometry skips Node.
    from steve_desktop.cad_document import VENDOR
    from steve.sketch import Sketch
    import steve_sketch
    sketch = Sketch('package-check', None)
    sketch.line('line', (0, 0), (10, 2))
    sketch.fix('line.start', at=(0, 0))
    sketch.horizontal('line')
    sketch.length('line', 20)
    try:
        assert sketch.solve().status == 'ok'
        end = sketch.entities['line']['end']
        assert abs(end[0] - 20) < 1e-6 and abs(end[1]) < 1e-6
    finally:
        steve_sketch.close()
