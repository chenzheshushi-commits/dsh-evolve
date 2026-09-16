import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecallDiag, classifyScript } from '../../lib/diag.js';
import { MemoryStore } from '../../lib/store.js';

function makeStore(events) {
  const r = { id:'m1', content:'reverse proxy timeout recovery', kind:'lesson', tags:[], scope:'project', importance:2,
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), accessedAt:'', accessCount:0, injectionCount:0,
    observationCount:1, reinforcedAt:'', expiresAt:'', crystallizedAt:'', sourceContext:'', forgottenAt:'', pinned:false };
  const m = new Map([[r.id,r]]);
  const table = { entries:()=>m.entries(), get:async k=>m.get(k), put:async(k,v)=>m.set(k,v), delete:async k=>m.delete(k), get size(){return m.size} };
  return new MemoryStore(table,{config:{recallLimit:5,recencyHalfLifeDays:90},onRecallDiag:e=>events.push(e)});
}

test('diag is irreversible and contains no raw query field',()=>{
  const q='查 UPS timeout Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  const d=buildRecallDiag(q,{hits:2,ms:3.5,path:'fused',source:'manual'});
  assert.equal(d.event,'recall'); assert.equal(d.queryHash.length,64); assert.equal(d.queryLen,q.length);
  assert.ok(d.tokenCount>0); assert.equal(d.scriptClass,'mixed-cjk-latin'); assert.equal(d.hits,2); assert.equal(d.ms,3.5);
  assert.ok(!JSON.stringify(d).includes(q)); assert.equal('query' in d,false); assert.equal('rawQuery' in d,false);
});

test('script classifier is stable',()=>{
  assert.equal(classifyScript('苹果'),'cjk'); assert.equal(classifyScript('timeout 504'),'latin');
  assert.equal(classifyScript('苹果 timeout'),'mixed-cjk-latin'); assert.equal(classifyScript(''),'empty');
});

test('one recall throat covers manual and injection sources',async()=>{
  const events=[];const store=makeStore(events);
  await store.recall('reverse proxy timeout',5,{touch:true,source:'manual'});
  await store.recall('reverse proxy timeout',5,{touch:false,source:'injection'});
  assert.deepEqual(events.map(e=>e.source),['manual','injection']);
  assert.ok(events.every(e=>e.hits===1)); assert.ok(events.every(e=>!('query' in e)));
  assert.equal(events[0].queryHash,events[1].queryHash,'same query gets stable hash');
});

test('diagnostic sink failure never breaks recall',async()=>{
  const store=makeStore([]);store.onRecallDiag=()=>{throw new Error('audit disk failed')};
  const hits=await store.recall('reverse proxy timeout',5,{touch:false});
  assert.equal(hits.length,1);
});
