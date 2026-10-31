"""Read-only production acceptance. Uses Steve's own OAuth/sync code.

Run with a dedicated profile, never the user's working profile. The browser consent
is completed by the person. No remote documents are created, edited or built.
"""
import argparse
import json
import time
from pathlib import Path

from steve_desktop.cad_server import LocalCadServer


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--profile',type=Path,required=True)
    parser.add_argument('--evidence',type=Path,required=True)
    parser.add_argument('--search',action='append',default=[])
    parser.add_argument('--build',action='store_true')
    args=parser.parse_args()
    args.profile.mkdir(parents=True,exist_ok=True);args.evidence.mkdir(parents=True,exist_ok=True)
    server=LocalCadServer(args.profile/'cad')
    sync=server.local_studio
    report={'production':True,'remote_operations':'read-only','projects':[]}
    def save():
        (args.evidence/'live-verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    try:
        if not sync.connection.session.get('refresh_token'):
            sync.connection.login(lambda message:print(message,flush=True))
        places=sync.connection.workspaces()
        report['account_identity_received']=bool(places['account'])
        sync.connection.session['expires_at']=0
        renewed=sync.connection.workspaces()
        report['refresh_preserved_account']=renewed['account']==places['account']
        assert report['refresh_preserved_account'], 'Renewal changed the account identity'
        workspace=places['current']
        rows=sync.list_projects(workspace)
        report['listed_projects']=len(rows)
        chosen=[row for row in rows if row.get('state')=='live' and any(term.lower() in row['name'].lower() for term in args.search)]
        missing=[term for term in args.search if not any(term.lower() in row['name'].lower() for row in chosen)]
        if not chosen or missing:
            raise RuntimeError('Acceptance projects were not found: '+', '.join(missing or args.search))
        sync.notify=lambda message:print(message,flush=True)
        for row in chosen:
            result={'name':row['name'],'remote_id':row['id']}
            report['projects'].append(result)
            print('Downloading '+row['name'],flush=True)
            try:
                sync.download(workspace,row)
                record=server.state['studio_sync'][sync.key(workspace,row['id'])]
                result.update(downloaded=True,local_id=record['local_id'],snapshot=record['snapshot'],revision=record['revision'],runtime=record.get('runtime'))
                before=len(server.state['documents'])
                sync.download(workspace,row)
                result['unchanged_refresh_no_import']=len(server.state['documents'])==before
            except ValueError as exc:
                result.update(downloaded=False,error=str(exc))
            save()
        # Prove builds do not require an authenticated Studio connection.
        report['disconnect']=sync.connection.disconnect()
        report['credentials_removed']=not sync.connection.vault.load()
        save()
        if args.build:
            for result in report['projects']:
                if not result.get('downloaded'):continue
                print('Building locally: '+result['name'],flush=True)
                doc=server.state['documents'][result['local_id']]
                started=time.monotonic();entry=server.submit(doc)
                while entry['status'] in ('queued','running'):
                    time.sleep(5)
                    print(f'Local build: {entry["status"]}, {round(time.monotonic()-started)} seconds',flush=True)
                result['build_seconds']=round(time.monotonic()-started,2)
                result['build_status']=entry['status']
                if entry['status']=='succeeded':
                    project=server.build_folder(entry['id'])[1]
                    geometry=project.inspect()
                    result['geometry']={k:geometry.get(k) for k in ('valid','solids','volume','size','center')}
                    result['step_export']=project.export('STEP',project.current()['id'])
                else:result['build_error']=entry.get('error')
                save()
        report['passed']=all(result.get('downloaded') and result.get('unchanged_refresh_no_import')
            and (not args.build or (result.get('build_status')=='succeeded'
                and result.get('geometry',{}).get('valid') is True
                and result.get('step_export',{}).get('bytes',0)>0)) for result in report['projects'])
        save()
        if not report['passed']:
            raise RuntimeError('Production acceptance failed; inspect the evidence.')
        print('Production acceptance passed.',flush=True)
    except Exception:
        report['passed']=False
        save()
        raise
    finally:
        server.close()


if __name__=='__main__':main()
