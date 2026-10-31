"""Exercise chat against a real Qt viewport and CAD kernel, with offline AI replies.

Run with the desktop Python environment after building cad-web:
    python checks/check_chat_geometry.py
Uses an isolated profile; never opens a user's documents or account.
"""
import asyncio
import copy
import json
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from steve_desktop.desktop_graphics import configure_graphics
configure_graphics()
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication
from steve_desktop.app import Window
from steve_desktop.cad_document import bracket
from steve_desktop.service import ModelChoice, Service
from steve_desktop.vault import Vault
from steve_desktop import chat_ui

app = QApplication([])
calls = []
observations = []


async def fake_chat(source, model, prompt, history, settings, approve, activity, delta):
    calls.append({'prompt': prompt, 'context': copy.deepcopy(server.context)})
    delta('Checked without changing CAD.'); await asyncio.sleep(.05)
    return 'Checked without changing CAD.', []


chat_ui.chat = fake_chat
temp = tempfile.TemporaryDirectory(prefix='steve-chat-check-')
window = Window(Service(Vault(Path(temp.name) / 'auth.dpapi')))
server = window.cad_panel.server
window.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
window.setWindowTitle('Steve — Chat geometry regression verification')
window.resize(1440, 900)
window.show_result([ModelChoice(slug='test', display_name='Offline verification', visibility='list')])
window.show()


def pump(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        app.processEvents(); time.sleep(.01)


def js(code):
    results = []
    window.cad_panel.page.runJavaScript(code, results.append)
    end = time.monotonic() + 8
    while not results and time.monotonic() < end:
        app.processEvents(); time.sleep(.01)
    assert results, 'JavaScript callback timed out'
    return results[0]


def wait(predicate, label, timeout=40):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        pump(.05)
    raise AssertionError(f'Timed out: {label}')


def draft(text):
    js("(()=>{const e=document.getElementById('chat-message');"
       "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,"
       + json.dumps(text) + ");e.dispatchEvent(new Event('input',{bubbles:true}));})()")
    pump(.08)


def check_send(label, method='click'):
    wait(lambda: js("!!document.getElementById('chat-message') && !document.getElementById('chat-message').disabled"), 'composer enabled')
    count = len(calls)
    builds = set(server.state['builds'])
    documents = copy.deepcopy(server.state['documents'])
    before = js("(()=>{const s=steve.store.getState();window.__chatModel=steve.viewer.model;return JSON.stringify({build:s.displayed.id,version:s.modelVersion,doc:s.doc});})()")
    draft(label)
    wait(lambda: js("!document.getElementById('send-chat').disabled"), 'send enabled')
    if method == 'click':
        js("document.getElementById('send-chat').click()")
    else:
        modifier = 'metaKey' if method == 'cmd' else 'ctrlKey'
        js("document.getElementById('chat-message').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',"
           + modifier + ":true,bubbles:true,cancelable:true}))")
    wait(lambda: len(calls) == count + 1, 'one assistant request')
    wait(lambda: not window.chat_panel.busy, 'assistant finishes')
    pump(1.5)  # Includes the 700 ms live-build debounce and streamed reply handling.
    after = js("(()=>{const s=steve.store.getState();return JSON.stringify({build:s.displayed.id,version:s.modelVersion,doc:s.doc});})()")
    assert set(server.state['builds']) == builds, f'{label}: submitting chat created a CAD build'
    assert server.state['documents'] == documents, f'{label}: submitting chat saved/revised a document'
    assert after == before, f'{label}: document or displayed geometry changed'
    assert js('steve.viewer.model === window.__chatModel'), f'{label}: viewport model was reloaded'
    assert len(calls) == count + 1, f'{label}: duplicate message'
    observations.append({'case': label, 'extra_builds': 0, 'viewport_preserved': True})
    print(json.dumps(observations[-1]), flush=True)


try:
    wait(lambda: js("!!window.steve && !!document.querySelector('canvas')"), 'workspace startup')
    window.show_desktop('steve')
    pump(1)
    doc = bracket()
    js("steve.store.setState(s=>({liveBuild:false,doc:{...s.doc,..." + json.dumps(doc)
       + ",open:true,saved:null,savedSnapshot:null}}));void steve.actions.updateModel()")
    wait(lambda: js("!!steve.store.getState().displayed && !steve.store.getState().busy && !!steve.viewer.model"), 'initial bracket build')
    assert len(server.state['builds']) == 1
    check_send('Unsaved preview: Send button')
    check_send('Unsaved preview: Ctrl+Enter', 'ctrl')

    saved = server.create_document({**doc, 'preview_build_id': js('steve.store.getState().displayed.id')})
    js("steve.store.setState(s=>({doc:{...s.doc,saved:" + json.dumps(saved) + ",savedSnapshot:JSON.stringify({name:s.doc.name,kind:s.doc.kind,code:s.doc.code,files:'[]',links:'[]',preview:s.displayed.id})}}))")
    check_send('Saved preview: Ctrl+Enter', 'ctrl')
    check_send('Saved preview: Cmd+Enter', 'cmd')
    check_send('Saved preview: Send button')

    # Hold a periodic context write containing the old draft. A send must wait
    # for it, then publish the new draft before starting the assistant request.
    js("""window.__fetch = window.fetch;
      window.__heldContext = false;
      window.fetch = async (...args) => {
        if (args[0] === '/v1/local/context' && args[1]?.method === 'POST' && !window.__heldContext) {
          window.__heldContext = true;
          await new Promise(resolve => window.__releaseContext = resolve);
        }
        return window.__fetch(...args);
      };""")
    wait(lambda: js('window.__heldContext'), 'periodic context write in flight')
    new_code = doc['code'] + '\n# Draft must reach Steve without building or saving.\n'
    js('steve.actions.setCode(' + json.dumps(new_code) + ')')
    js('setTimeout(() => window.__releaseContext(), 600)')
    check_send('Edited draft: fresh context despite in-flight sync', 'ctrl')
    assert calls[-1]['context']['document']['code'] == new_code, 'Assistant received stale source'
    js('window.fetch = window.__fetch')

    # The global shortcut still works outside the composer.
    builds = len(server.state['builds'])
    js("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}))")
    wait(lambda: len(server.state['builds']) == builds + 1, 'explicit Update model')
    wait(lambda: js('!steve.store.getState().busy'), 'explicit update finishes')
    assert js('steve.store.getState().displayed.code') == new_code
    observations.append({'case': 'Explicit Ctrl+Enter outside composer', 'extra_builds': 1})

    # Live builds still react to real source changes.
    builds = len(server.state['builds'])
    js('steve.store.setState({liveBuild:true});steve.actions.setCode(' + json.dumps(new_code.replace('width = 80', 'width = 90')) + ')')
    wait(lambda: len(server.state['builds']) == builds + 1, 'live update for changed source')
    wait(lambda: js('!steve.store.getState().busy'), 'live update finishes')
    check_send('Live build enabled: unchanged geometry', 'ctrl')
    print(json.dumps({'passed': True, 'messages': len(calls), 'builds': len(server.state['builds']), 'cases': observations}, indent=2), flush=True)
finally:
    window.close()
    pump(.5)
    temp.cleanup()
