from pathlib import Path
import copy,json,tempfile,time,math,argparse
from steve_desktop.cad_server import LocalCadServer
from steve_desktop.cad_worker import WORKER
parser=argparse.ArgumentParser();parser.add_argument('--evidence',type=Path,required=True);out=parser.parse_args().evidence;out.mkdir(parents=True,exist_ok=True)
def document(heavy):
 files={}
 for name in ('left','right'):
  files['components/'+name+'.py']=f'from steve import Component\nwidth=100\n{name}=Component("{name}")\n{name}.box("body",width,100,10)\n'
  if heavy:files['components/'+name+'.py']+=f'for i in range(60):\n {name}.hole("hole_"+str(i),on="body.top",diameter=3,points=[(-36+(i%10)*8,-20+(i//10)*8)],depth=10)\n'
 return {'name':'Measured '+('heavy' if heavy else 'small'),'kind':'design','files':files,'links':{},'code':'from steve import Design\nfrom components.left import left\nfrom components.right import right\ndesign=Design()\ndesign.add(left)\ndesign.add(right,at=(150,0,0))\nresult=design.result()\n'}
def build(server,doc):
 started=time.monotonic()
 with server.lock:entry=server.submit(doc)
 deadline=started+180
 while entry['status'] not in ('succeeded','failed') and time.monotonic()<deadline:time.sleep(.05)
 assert entry['status']=='succeeded',entry.get('error')
 elapsed=time.monotonic()-started
 report={'seconds':elapsed,'strategy':entry['component_strategy'],'preparation':entry['component_preparation'],'costs':entry['metadata'].get('local_component_costs',[])}
 print(json.dumps(report),flush=True)
 return report,server.build_folder(entry['id'])[1].inspect()
reports={}
try:
 with tempfile.TemporaryDirectory(prefix='steve-adaptive-check-') as td:
  for heavy in (False,True):
   label='heavy' if heavy else 'small';server=LocalCadServer(Path(td)/label)
   try:
    deadline=time.monotonic()+40
    while WORKER.status()['ready']<WORKER.spares and time.monotonic()<deadline:time.sleep(.05)
    doc=document(heavy);cold,first=build(server,doc);cached,second=build(server,doc)
    assert cold['strategy']['mode']=='serial'
    assert cached['strategy']['mode']=='serial'
    assert math.isclose(first['volume'],second['volume'],rel_tol=1e-12,abs_tol=1e-9),(first['volume'],second['volume'])
    edited=copy.deepcopy(doc)
    for path in edited['files']:edited['files'][path]=edited['files'][path].replace('width=100','width=110')
    result,geometry=build(server,edited)
    expected=220000-(120*math.pi*1.5**2*10 if heavy else 0)
    assert math.isclose(geometry['volume'],expected,rel_tol=1e-9),(geometry['volume'],expected)
    assert result['strategy']['mode']==('parallel' if heavy else 'serial'),result['strategy']
    reports[label]={'cold':cold,'cached':cached,'edited':result,'volume_verified':True}
    if heavy:
     from steve_desktop.cad_service import CadProject
     mixed=copy.deepcopy(edited)
     for path in mixed['files']:mixed['files'][path]=mixed['files'][path].replace('width=110','width=120')
     mixed['files']['components/cheap.py']='from steve import Component\ncheap=Component("cheap")\ncheap.box("body",7,8,9)\n'
     mixed['code']=mixed['code'].replace('result=design.result()', 'from components.cheap import cheap\ndesign.add(cheap,at=(300,0,0))\nresult=design.result()')
     mixed_report,mixed_geometry=build(server,mixed)
     assert mixed_report['strategy']['mode']=='mixed',mixed_report['strategy']
     assert mixed_report['strategy']['selected']==['components/left.py','components/right.py']
     assert len(mixed_report['preparation']['jobs'])==2
     reference=CadProject.create(Path(td)/'serial-reference')
     started=time.monotonic();serial_geometry=reference.build(mixed);serial_seconds=time.monotonic()-started
     for key in ('volume','area'):
      assert math.isclose(mixed_geometry[key],serial_geometry[key],rel_tol=1e-12,abs_tol=1e-9),key
     assert mixed_geometry['size']==serial_geometry['size']
     assert mixed_geometry['solids']==serial_geometry['solids']==3
     reports['mixed']={'automatic':mixed_report,'serial_same_source_seconds':serial_seconds,'speedup':serial_seconds/mixed_report['seconds'],'same_source_geometry_verified':True}

    (out/'verification.json').write_text(json.dumps(reports,indent=2),encoding='utf-8')
   finally:server.close()
 print('Automatic serial and parallel selection passed.',flush=True)
finally:WORKER.close()
