import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as THREE from 'three';
import { parallelMidplane, planeLine, parsePlanes, insertPlane, removePlane, isReferenced, nextPlaneName } from '../src/lib/construction.ts';

const v=(x,y,z)=>new THREE.Vector3(x,y,z);
const declaration=planeLine('plane_1',v(0,0,10),v(0,0,1),'offset 10 mm from origin XY');
const syntax=(code)=>{
  const run=spawnSync(process.env.STEVE_TEST_PYTHON,['-c','import ast,sys; ast.parse(sys.stdin.read())'],{input:code,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
};

test('midplanes bisect signed separation for opposing, reversed and oblique normals',()=>{
  for(const normal of [v(0,0,1),v(1,0,0),v(1,2,3).normalize()]) {
    for(const gap of [-20,0,17]) for(const orientation of [-1,1]) {
      const a=v(10,-25,4),tangent=v(-normal.y,normal.x,0).multiplyScalar(100);
      const b=a.clone().add(tangent).addScaledVector(normal,gap);
      const result=parallelMidplane(a,normal,b,normal.clone().multiplyScalar(orientation));
      assert.ok(!('error' in result));
      const distanceA=result.origin.clone().sub(a).dot(normal);
      const distanceB=result.origin.clone().sub(b).dot(normal);
      assert.ok(Math.abs(distanceA-gap/2)<1e-10);
      assert.ok(Math.abs(distanceB+gap/2)<1e-10);
      assert.ok(Math.abs(result.gap-Math.abs(gap))<1e-10);
    }
  }
});
test('nonparallel and zero normals are rejected',()=>{
  assert.ok('error' in parallelMidplane(v(0,0,0),v(0,0,1),v(0,0,20),v(0,1,0)));
  assert.ok('error' in parallelMidplane(v(0,0,0),v(0,0,1),v(0,0,20),v(0,Math.sin(Math.PI/1800),Math.cos(Math.PI/1800))));
  assert.ok('error' in parallelMidplane(v(0,0,0),v(0,0,0),v(0,0,20),v(0,0,1)));
  assert.ok(!('error' in parallelMidplane(v(0,0,0),v(0,0,1),v(0,0,20),v(.000005,0,1))));
});
test('construction comments and locations survive writing and parsing',()=>{
  const code=insertPlane('import cadquery as cq\nresult=cq.Workplane("XY")\n',declaration);
  syntax(code);
  const planes=parsePlanes(code);assert.equal(planes.length,1);
  assert.equal(planes[0].comment,'offset 10 mm from origin XY');
  assert.deepEqual(planes[0].origin.toArray(),[0,0,10]);
  assert.ok(!removePlane(code,planes[0]).includes('plane_1 ='));
  assert.equal(nextPlaneName(code),'plane_2');
});
test('insertion supplies cq and respects multiline imports, future imports and module documentation',()=>{
  const sources=[
    'from steve import Model\nmodel=Model()\n',
    '# coding: utf-8\n"""Design notes.\nfrom sample import example\n"""\nfrom __future__ import annotations\nfrom steve import (\n Model,\n Sketch,\n) # symbols\nmodel=Model()\n',
    '# comment\n"""Notes without imports."""\nanswer=42\n',
    'from steve import \\\n Model\nmodel=Model()\n',
  ];
  for(const original of sources) {
    const code=insertPlane(original,declaration);syntax(code);
    assert.equal((code.match(/^import cadquery as cq$/gm)||[]).length,1);
    assert.equal(parsePlanes(code).length,1);
  }
});
test('docstrings and local definitions do not create phantom construction planes',()=>{
  const code=`"""\n${declaration}\n"""\ndef local():\n    ${declaration}\n${declaration}\n`;
  assert.equal(parsePlanes(code).length,1);
  assert.equal(parsePlanes(code)[0].line,6);
});
test('delete is guarded by actual Python references, not notes or string literals',()=>{
  const code=declaration+'\n# plane_1 is a reference plane\nnote="plane_1"\n';
  assert.equal(isReferenced(code,'plane_1'),false);
  assert.equal(isReferenced(code+'result=cq.Workplane(plane_1)\n','plane_1'),true);
  assert.equal(isReferenced(code+'label=f"{plane_1}"\n','plane_1'),true);
});
