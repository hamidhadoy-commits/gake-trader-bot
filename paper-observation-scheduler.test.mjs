import test from 'node:test';
import assert from 'node:assert/strict';
import {selectResearchObservationCandidates as select,observationCapacity} from './paper-observation-scheduler.mjs';
const now=Date.parse('2026-10-11T12:00:00Z');
const p=(id,age,last=now-300000)=>({source_signature:id,status:'RESEARCH_OPEN',admitted_at:new Date(now-age).toISOString(),last_checked_at:new Date(last).toISOString()});
test('recent positions receive reserved slots without starving the old rotation',()=>{
  const rows=Array.from({length:20},(_,i)=>p('old'+i,3600000,now-600000+i));
  rows.push(p('youngA',10000,now-60000),p('youngB',20000,now-60000));
  const oldSeen=new Set();
  for(let t=0;t<10;t++){
    const selected=select(rows,now+t*60000);
    assert.equal(selected.length,4);
    assert.deepEqual(selected.slice(0,2).map(p=>p.source_signature).sort(),['youngA','youngB']);
    for(const x of selected){if(x.source_signature.startsWith('old'))oldSeen.add(x.source_signature);x.last_checked_at=new Date(now+t*60000).toISOString();}
  }
  assert.equal(oldSeen.size,20);
});
test('no young arrivals retains full fair capacity and never mutates the input',()=>{
  const rows=Array.from({length:20},(_,i)=>p('old'+i,3600000,now-600000+i));const before=JSON.stringify(rows);
  assert.deepEqual(select(rows,now).map(x=>x.source_signature),['old0','old1','old2','old3']);
  assert.equal(JSON.stringify(rows),before);
});
test('expiry, invalid clocks, closed positions, duplicates and strict budgets',()=>{
 const recent=p('young',10000);const old=p('old',3600000,now-600000);
 assert.equal(select([old,recent],now+16*60000)[0].source_signature,'old');
 assert.equal(select([old,old,{...recent,status:'RESEARCH_CLOSED'},p('future',-1),{...p('bad',10),last_checked_at:'invalid'}],now).length,1);
 assert.throws(()=>select([],now,{limit:4,recentSlots:4}));
});
test('capacity exposes old-position tradeoff and TP quote limitation',()=>{
 assert.deepEqual(observationCapacity({openPositions:22,recentPositions:2}),{
 baselineRotationSeconds:360,recentRotationUpperSeconds:60,remainingRotationUpperSeconds:600,
 caveat:'Planning bound only: assumes complete candidate set, stable arrivals and one successful observation per slot. TP slice quotes, provider delays and queue failures can lengthen it.'});
 assert.equal(observationCapacity({openPositions:20}).baselineRotationSeconds,300);
});
