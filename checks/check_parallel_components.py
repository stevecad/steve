from pathlib import Path
import json,tempfile,time,threading,copy,concurrent.futures,argparse
from steve_desktop.cad_parallel import prepare_components
from steve_desktop.cad_worker import WORKER
from steve_desktop.cad_service import CadProject
parser=argparse.ArgumentParser();parser.add_argument('--evidence',type=Path,required=True);out=parser.parse_args().evidence;out.mkdir(parents=True,exist_ok=True)
def part(name,width):
 return f'from steve import Component\n{name}=Component("{name}")\nfor i in range(16):\n {name}.box("block_"+str(i),{width},12,8,at=(0,i*20,0),op="new")\n'
doc={'name':'Parallel dependency fixture','kind':'design','code':'from steve import Design\nfrom components.left import left\nfrom components.right import right\nfrom components.top import top\ndesign=Design()\ndesign.add(left)\ndesign.add(right,at=(40,0,0))\ndesign.add(top,at=(80,0,0))\nresult=design.result()\n','files':{'components/left.py':part('left',10),'components/right.py':part('right',15),'components/top.py':'from steve import Component\nfrom components.left import left\ntop=Component("top")\ntop.add("copy",left.shape(),op="new")\n'},'links':{}}
try:
 WORKER.warm()
 deadline=time.monotonic()+30
 while WORKER.status()['ready']<4 and time.monotonic()<deadline:time.sleep(.05)
 with tempfile.TemporaryDirectory(prefix='steve-parallel-check-') as td:
  folder=Path(td);cache=folder/'cache';cancel=threading.Event()
  report=prepare_components(doc,folder/'preparation',cache,cancel,WORKER)
  print(json.dumps(report),flush=True)
  assert report['reason'] is None,report
  assert len(report['jobs'])==3,report
  jobs={job['path']:job for job in report['jobs']}
  a,b=jobs['components/left.py'],jobs['components/right.py']
  assert max(a['execution_started_at'],b['execution_started_at'])<min(a['execution_finished_at'],b['execution_finished_at']),'Independent CAD execution did not overlap'
  assert jobs['components/top.py']['execution_started_at']>=a['execution_finished_at']
  assert len({j['worker_pid'] for j in report['jobs']})==3
  warm=prepare_components(doc,folder/'warm',cache,cancel,WORKER)
  assert len(warm['cached'])==3 and not warm['jobs'],warm
  serial=CadProject.create(folder/'serial');parallel=CadProject.create(folder/'parallel');parallel.cache_folder=cache
  before=time.monotonic();s=serial.build(doc);serial_seconds=time.monotonic()-before
  before=time.monotonic();p=parallel.build(doc);parallel_seconds=time.monotonic()-before
  for key in ('volume','area','size','bounds','solids'):
   assert s[key]==p[key],(key,s[key],p[key])
  assert s['upstream']['instances']==p['upstream']['instances']
  def semantic(value):
   if isinstance(value,dict):return {k:semantic(v) for k,v in value.items() if k not in ('cache','ms')}
   if isinstance(value,list):return [semantic(v) for v in value]
   return value
  for name in s['upstream']['components']:
   left=semantic(s['upstream']['components'][name])
   right=semantic(p['upstream']['components'][name])
   assert left==right,(name,{key:(left.get(key),right.get(key)) for key in set(left)|set(right) if left.get(key)!=right.get(key)})
  assert s['faces']==p['faces'] and s['edges']==p['edges']
  def references(value,path=''):
   if isinstance(value,dict):
    result={path:value['ref']} if value.get('ref') else {}
    for key,item in value.items():result.update(references(item,path+'/'+key))
    return result
   if isinstance(value,list):
    result={}
    for index,item in enumerate(value):result.update(references(item,path+'/'+str(index)))
    return result
   return {}
  serial_refs=references(json.loads((serial.revision_folder(s['revision'])/'topology.json').read_text()))
  parallel_refs=references(json.loads((parallel.revision_folder(p['revision'])/'topology.json').read_text()))
  assert serial_refs and serial_refs==parallel_refs,'Persistent viewer references changed'
  import cadquery as cq
  for project,result in ((serial,s),(parallel,p)):
   exported=project.export('STEP',result['revision'])
   shape=cq.importers.importStep(exported['path']).val()
   assert len(shape.Solids())==s['solids']
   assert abs(shape.Volume()-s['volume'])<1e-5
  edited=copy.deepcopy(doc);edited['files']['components/left.py']=part('left',11)
  invalidated=prepare_components(edited,folder/'changed',cache,cancel,WORKER)
  assert set(j['path'] for j in invalidated['jobs'])=={'components/left.py','components/top.py'},invalidated
  assert invalidated['cached']==['components/right.py']
  broken=copy.deepcopy(doc);broken['files']['components/left.py']=part('left','1/0')
  failed=prepare_components(broken,folder/'failed',cache,cancel,WORKER)
  assert failed['reason'] and 'Serial fallback' in failed['reason'],failed
  assert parallel.current()['id']==p['revision']
  recovery=prepare_components(doc,folder/'recovery',cache,cancel,WORKER)
  assert recovery['reason'] is None
  heavy=copy.deepcopy(doc)
  for name in ('left','right'):heavy['files']['components/'+name+'.py']=part(name,10).replace('range(16)','range(100000)')
  with concurrent.futures.ThreadPoolExecutor(1) as executor:
   task=executor.submit(prepare_components,heavy,folder/'cancel',cache,cancel,WORKER)
   deadline=time.monotonic()+30
   while WORKER.status()['active']<2 and not task.done() and time.monotonic()<deadline:time.sleep(.02)
   assert WORKER.status()['active']>=2,'Fanout did not start'
   cancel.set()
   try:task.result(timeout=10)
   except ValueError as error:assert 'cancelled' in str(error)
   else:raise AssertionError('Cancellation was ignored')
  assert WORKER.status()['active']==0
  report.update(warm_cache=warm,geometry_identical=True,assembly_structure_identical=True,face_edge_references_identical=True,persistent_viewer_references_checked=len(serial_refs),step_export_geometry_verified=True,dependency_invalidation=invalidated,cancellation_stops_fanout=True,failure_falls_back_without_changing_saved_revision=True,serial_seconds=serial_seconds,cached_assembly_seconds=parallel_seconds,solids=s['solids'])
  (out/'verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
  print('Parallel preparation and serial geometry parity passed.',flush=True)
finally:WORKER.close()
