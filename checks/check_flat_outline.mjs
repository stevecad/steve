import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
const source=fs.readFileSync(path.join(root,'cad-web/src/workspaces/sheetmetal/FlatView.tsx'),'utf8');
const code=source.slice(source.indexOf('const near'),source.indexOf('const PAD'));
const loop=new Function(stripTypeScriptTypes(code)+';return loop;')();
const edge=(a,b)=>({type:'line',start:a,end:b});
const edges=[edge([0,0],[80,0]),edge([80,0],[80,50]),edge([80,50],[0,50]),edge([0,50],[0,0])];
function perm(a){return a.length ? a.flatMap((x,i)=>perm(a.filter((_,j)=>j!==i)).map(b=>[x,...b])):[[]]}
let count=0;
for(const order of perm(edges))for(let mask=0;mask<16;mask++){
 const input=order.map((e,i)=>mask&(1<<i)?{...e,start:e.end,end:e.start}:e);
 const points=loop(input);assert.equal(points.length,5);assert.deepEqual(points[0],points.at(-1));
 const area=Math.abs(points.slice(1).reduce((sum,b,i)=>{const a=points[i];return sum+a[0]*b[1]-b[0]*a[1]},0)/2);
 assert.equal(area,4000);count++;
}
assert.deepEqual(loop([edge([0,0],[1,0]),edge([4,4],[5,5])]),[]);
console.log(`${count} edge-order/orientation cases and disconnected-edge handling passed`);
