"""Isolated real-browser acceptance check; uses Edge on Windows, Chromium on Linux.
Build cad-web first. Studio API is mocked: never opens real OAuth or touches user data.
Run with PYTHONPATH=src: python checks/check_studio_navigation.py --output <screenshots>
"""
import re
import os
from unittest.mock import Mock
import argparse
import json
import tempfile
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from steve_desktop.cad_server import LocalCadServer


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args()
    output=Path(args.output);output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='steve-navigation-ui-') as folder:
        from steve_desktop.cad_worker import WORKER
        WORKER.spares=0
        server=LocalCadServer(Path(folder)/'CAD')
        server.submit=Mock(side_effect=AssertionError('Geometry builds are outside this navigation test'))
        server.local_studio.connection.login=Mock(side_effect=AssertionError('Real OAuth forbidden in UI acceptance test'))
        doc=server.create_document({'kind':'part','code':'from steve import Model\nmodel = Model()\n','name':'Downloaded bracket'})
        state=dict(connected=False,busy=False,automatic=True,message='Connect to download your Studio projects.',error='',workspace='',workspaces=[],projects=[],copies=[],account=None)
        calls=[]
        def route(request):
            print('Studio request:',request.request.method,flush=True)
            action=request.request.url.split('/v1/local/studio',1)[1].strip('/')
            if request.request.method=='POST':
                body=request.request.post_data_json;calls.append((action,body))
                if action=='connect':
                    state.update(connected=True,account={'id':'account-test','name':'Alex Morgan','email':'alex@example.test'},workspace='personal',workspaces=[{'id':'personal','name':'Personal','allowed':True,'kind':'personal'},{'id':'team','name':'Engineering','allowed':True,'kind':'team'},{'id':'denied','name':'Restricted','allowed':False,'kind':'team'}],projects=[{'id':'bracket','name':'Mounting bracket','revision':3,'kind':'part','state':'live','folder':None}],message='Connected to Studio.')
                elif action=='disconnect':state.update(connected=False,account=None,workspace='',workspaces=[],projects=[],copies=[],message='Disconnected. Your local projects remain available.')
                elif action=='list':state.update(workspace=body.get('workspace',state['workspace']),message='Project list updated.')
                elif action=='download':state['copies']=[dict(remote_id='bracket',name='Mounting bracket',local_id=doc['id'],revision=3,status='up to date',identity=['server','account-test',state['workspace']])]
                elif action=='automatic':state['automatic']=body['enabled']
                elif action=='unlink':state['copies']=[]
                elif action=='refresh':state['message']='Downloaded projects are up to date.'
            request.fulfill(json=state)
        try:
            with sync_playwright() as playwright:
                browser=playwright.chromium.launch(channel='msedge' if os.name=='nt' else 'chromium',headless=True)
                page=browser.new_page(viewport={'width':1440,'height':1000},extra_http_headers={'X-Steve-Session':server.token})
                # Software-rendered Linux CI can take longer to present stable
                # frames during the initial CAD viewport load. Keep normal
                # Playwright actionability checks with the same bounded wait as
                # the Blender UI acceptance checks.
                page.set_default_timeout(30000)
                expect.set_options(timeout=30000)
                errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                page.on('console',lambda message:print('BROWSER:',message.type,message.text,flush=True) if message.type=='error' else None)
                page.route(re.compile(r'/v1/local/studio(?:/[^?]*)?(?:\?.*)?$'),route)
                try:
                    page.goto(server.url);page.locator('#account-menu').click()
                    expect(page.get_by_role('menuitem',name='Sign in to Steve Studio',exact=True)).to_be_visible()
                    page.screenshot(path=str(output/'account-disconnected.png'))
                    print('Open Studio projects',flush=True);page.get_by_role('menuitem',name='Studio projects…').click();print('Opened Studio projects',flush=True)
                    expect(page.get_by_text('Your Studio projects, on this machine')).to_be_visible()
                    print('Return to account menu',flush=True);page.get_by_role('button',name='Open account menu',exact=True).click();print('Returned to account menu',flush=True)
                    print('Click sign in',flush=True);page.get_by_role('menuitem',name='Sign in to Steve Studio',exact=True).click();print('Sign in clicked',flush=True)
                    page.locator('#account-menu').click()
                    expect(page.locator('#account-card')).to_contain_text('Alex Morgan')
                    expect(page.locator('#account-card')).to_contain_text('alex@example.test')
                    expect(page.get_by_role('menuitem',name='Disconnect from Steve Studio')).to_be_visible()
                    page.screenshot(path=str(output/'account-connected.png'))
                    state['profile_consent_required']=True
                    page.keyboard.press('Escape');page.locator('#account-menu').click()
                    expect(page.get_by_text('Reconnect once to share your name, verified email and picture with Steve. Your local projects stay here.')).to_be_visible()
                    state['profile_consent_required']=False
                    print('Open Studio projects',flush=True);page.get_by_role('menuitem',name='Studio projects…').click();print('Opened Studio projects',flush=True)
                    expect(page.get_by_role('button',name='Restricted · access required')).to_be_disabled()
                    page.get_by_role('searchbox',name='Find a project').fill('missing')
                    expect(page.get_by_text('No matching CAD projects in this workspace.')).to_be_visible()
                    page.get_by_role('searchbox',name='Find a project').fill('bracket')
                    page.get_by_role('checkbox',name='Mounting bracket').check()
                    page.get_by_role('button',name='Download selected').click()
                    expect(page.get_by_role('button',name='Open locally',exact=True)).to_be_visible()
                    page.get_by_role('checkbox',name='Keep downloaded projects up to date').uncheck()
                    page.get_by_role('button',name='Refresh downloaded projects',exact=True).click()
                    page.screenshot(path=str(output/'studio-projects.png'))
                    page.set_viewport_size({'width':900,'height':700})
                    page.screenshot(path=str(output/'studio-projects-narrow.png'))
                    assert page.locator('#open-dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
                    page.get_by_role('button',name='Engineering',exact=True).click()
                    expect(page.get_by_role('button',name='Download selected')).to_be_disabled()
                    page.get_by_role('button',name='Personal',exact=True).click()
                    page.get_by_role('button',name='Open locally',exact=True).click()
                    expect(page.locator('#open-dialog')).not_to_be_visible()
                    page.locator('#account-menu').click();print('Open Studio projects',flush=True);page.get_by_role('menuitem',name='Studio projects…').click();print('Opened Studio projects',flush=True)
                    page.get_by_role('button',name='Stop syncing',exact=True).click()
                    expect(page.get_by_role('button',name='Open locally',exact=True)).not_to_be_visible()
                    page.get_by_role('button',name='On this machine',exact=True).click()
                    expect(page.get_by_role('button',name='More actions for Downloaded bracket')).to_be_visible()
                    page.keyboard.press('Escape');page.locator('#account-menu').click()
                    page.get_by_role('menuitem',name='Disconnect from Steve Studio').click()
                    page.locator('#account-menu').click()
                    expect(page.locator('#account-card')).not_to_contain_text('alex@example.test')
                    expect(page.get_by_role('menuitem',name='Sign in to Steve Studio',exact=True)).to_be_visible()
                    assert doc['id'] in server.state['documents']
                    assert {a for a,b in calls}>={'connect','disconnect','list','download','automatic','unlink','refresh'}
                    assert not errors,errors
                    server.local_studio.connection.login.assert_not_called()
                except Exception:
                    import traceback
                    traceback.print_exc()
                    page.screenshot(path=str(output/'failure.png'))
                    raise
                finally:
                    page.unroute_all(behavior='ignoreErrors')
                    page.close()
                    browser.close()
            print('PASS: account identity, sign-in/disconnect, project navigation, search, permissions, download, refresh, automatic sync, workspace switch, local open, unlink, responsive layout. Mock Studio; real local CAD server/UI.',flush=True)
        except Exception:
            import traceback
            traceback.print_exc()
            raise
        finally:
            WORKER.close()
            server.close()

if __name__=='__main__':main()

