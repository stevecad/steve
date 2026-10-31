"""Finish pending local builds from a production-sync report without signing in."""
import argparse
import json
import time
from pathlib import Path
from steve_desktop.cad_server import LocalCadServer

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--profile',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    report=json.loads(args.report.read_text(encoding='utf-8'))
    server=LocalCadServer(args.profile/'cad')
    def save():args.report.write_text(json.dumps(report,indent=2),encoding='utf-8')
    try:
        assert not server.local_studio.connection.vault.load(), 'Offline acceptance requires disconnected credentials'
        for result in report['projects']:
            # Preserve completed evidence, including failures; never rerun them silently.
            if not result.get('downloaded') or result.get('build_status'):continue
            print('Building locally: '+result['name'],flush=True)
            started=time.monotonic()
            entry=server.submit(server.state['documents'][result['local_id']])
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
        report['offline_checks_finished']=True
        report['passed']=all(r.get('downloaded') and r.get('unchanged_refresh_no_import')
            and r.get('build_status')=='succeeded' and r.get('geometry',{}).get('valid') is True
            and r.get('step_export',{}).get('bytes',0)>0 for r in report['projects'])
        save()
        if not report['passed']:raise RuntimeError('Some model builds failed; the original failures remain in the report.')
    finally:server.close()

if __name__=='__main__':main()
