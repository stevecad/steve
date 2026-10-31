"""Real local Blender + built UI acceptance; dev-only Playwright, isolated profile."""
import argparse
import os
import tempfile
import time
from pathlib import Path
from unittest.mock import Mock, patch

from playwright.sync_api import sync_playwright, expect
from steve_desktop.cad_server import LocalCadServer
from steve_desktop.cad_worker import WORKER
from check_local_blender import SCENE


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    # Headless Linux software rendering can take more than Playwright's 5-second assertion default.
    expect.set_options(timeout=30000)
    WORKER.spares=0
    with tempfile.TemporaryDirectory(prefix='steve-blender-ui-') as directory:
        server=LocalCadServer(Path(directory)/'CAD')
        server.local_studio.connection.login=Mock(side_effect=AssertionError('OAuth forbidden in Blender UI test'))
        try:
            assert server.local_blender.runtime
            body={'kind':'blender','name':'Product presentation','code':SCENE,'files':{},'links':{}}
            entry=server.submit(body)
            while entry['status'] in ('queued','running'):time.sleep(.1)
            assert entry['status']=='succeeded',entry.get('error')
            server.create_document({**body,'preview_build_id':entry['id']})
            with sync_playwright() as playwright:
                browser=playwright.chromium.launch(channel='msedge' if os.name=='nt' else 'chromium',headless=True)
                page=browser.new_page(accept_downloads=True,viewport={'width':1440,'height':1000},extra_http_headers={'X-Steve-Session':server.token})
                page.set_default_timeout(15000)
                errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                page.on('response',lambda response:print('Artifact response',response.status,response.url,flush=True) if '/artifacts/' in response.url else None)
                try:
                    page.goto(server.url)
                    expect(page.locator('#download')).to_have_attribute('data-format','blend')
                    expect(page.locator('#selection-type')).to_have_text('Blender scene')
                    expect(page.locator('#download')).not_to_have_attribute('aria-disabled','true',timeout=30000)
                    page.screenshot(path=str(args.output/'scene.png'))
                    page.keyboard.press('Control+e')
                    editor=page.locator('.cm-content').first
                    expect(editor).to_be_visible()
                    editor.fill(SCENE.replace('size=20','size=25'))
                    page.keyboard.press('Control+Enter')
                    expect(page.locator('#download')).not_to_have_attribute('aria-disabled','true',timeout=30000)
                    page.keyboard.press('Control+e')
                    page.locator('#export-menu').click()
                    page.get_by_role('menuitem',name='Render scene').click()
                    page.get_by_role('button',name='Render camera',exact=True).click()
                    expect(page.get_by_role('img',name='Rendered camera view')).to_be_visible(timeout=60000)
                    page.wait_for_function("document.querySelector('img[alt=\"Rendered camera view\"]')?.naturalWidth > 0")
                    page.screenshot(path=str(args.output/'camera-render.png'))
                    # Browser automation lacks Qt's authenticated download interceptor.
                    # Actual native downloads are covered by check_blender_desktop_downloads.py.
                    response=page.request.get(server.url+page.get_by_role('link',name='Save PNG',exact=True).get_attribute('href'))
                    assert response.ok
                    (args.output/'camera.png').write_bytes(response.body())
                    page.get_by_role('button',name='Render inspection views & animation').click()
                    expect(page.get_by_role('link',name='Save animation',exact=True)).to_be_visible(timeout=60000)
                    response=page.request.get(server.url+page.get_by_role('link',name='Save Blender file',exact=True).get_attribute('href'))
                    assert response.ok
                    (args.output/'scene.blend').write_bytes(response.body())
                    assert (args.output/'scene.blend').read_bytes()[:7]==b'BLENDER'
                    page.set_viewport_size({'width':1000,'height':760})
                    page.screenshot(path=str(args.output/'renders-narrow.png'))
                    page.keyboard.press('Escape')
                    page.keyboard.press('Control+,')
                    page.get_by_role('button',name='Blender',exact=True).click()
                    expect(page.get_by_text('Blender 4.5.9 is available.')).to_be_visible()
                    page.screenshot(path=str(args.output/'settings.png'))
                    page.keyboard.press('Escape')
                    page.get_by_role('button',name='File',exact=True).click()
                    with page.expect_response(lambda response:response.request.method=='POST' and response.url.endswith('/v1/builds')):
                        page.get_by_role('menuitem',name='New Blender scene',exact=True).click()
                    expect(page.locator('[data-command="blender.open"]')).to_be_visible()
                    expect(page.locator('#download')).not_to_have_attribute('aria-disabled','true',timeout=30000)
                    before_save=set(server.state['builds'])
                    with page.expect_response(lambda response:response.request.method=='POST' and '/v1/documents' in response.url):
                        page.keyboard.press('Control+s')
                    expect(page.get_by_role('status').filter(has_text='Saved').first).to_be_visible()
                    assert set(server.state['builds'])==before_save,'Saving must not launch renders'
                    assert any(d['kind']=='blender' and d['name']=='Untitled blender' for d in server.state['documents'].values())
                    page.screenshot(path=str(args.output/'new-scene.png'))
                    server.local_studio.connection.login.assert_not_called()
                    assert not errors,errors
                    print('PASS: real Blender scene preview, source edit/build, camera render, inspection renders, animation availability, PNG/.blend download links, setup settings and responsive layout.',flush=True)
                except Exception:
                    import traceback
                    traceback.print_exc()
                    page.screenshot(path=str(args.output/'failure.png'))
                    raise
                finally:
                    page.close();browser.close()
        finally:
            server.close();WORKER.close()


if __name__=='__main__':main()
