import test from 'node:test';
import assert from 'node:assert/strict';
import {withPaperCronQueue} from './paper-cron-queue.js';
function setup(fail=false){const claims=new Set(),updates=[],seen=[];let failDb=false;
 const DB={prepare(sql){return {bind(...args){return {async run(){if(failDb)throw Error('D1 unavailable');if(sql.startsWith('INSERT')){const exists=claims.has(args[0]);claims.add(args[0]);return {meta:{changes:exists?0:1}};}updates.push(args);return {meta:{changes:1}};}}}}}};
 const fetch=()=>new Response('unchanged');
 const w=withPaperCronQueue({fetch,async scheduled(c,e,ctx){seen.push({c,e,ctx});if(fail)throw Error('pipeline failed')}});
 return {w,DB,seen,claims,updates,fetch,setDbFail(x){failDb=x}};}
const body={kind:'GAKE_PAPER_CRON_V1',cron:'* * * * *',scheduledTime:1791496800000};
function msg(b=body){return {body:b,acks:0,ack(){this.acks++}}}
test('HTTP handler stays exactly the same function',()=>{const s=setup();assert.equal(s.w.fetch,s.fetch)});
test('producer enqueues once without running business pipeline',async()=>{const s=setup(),out=[];await s.w.scheduled(body,{PAPER_CRON_QUEUE:{async send(b){out.push(b)}}});assert.deepEqual(out,[body]);assert.equal(s.seen.length,0)});
test('producer fails for missing binding or invalid event',async()=>{const s=setup();await assert.rejects(s.w.scheduled(body,{}));await assert.rejects(s.w.scheduled({...body,cron:'other'},{PAPER_CRON_QUEUE:{send(){throw Error('should not send')}}}));assert.equal(s.seen.length,0)});
test('duplicate delivery cannot execute business twice',async()=>{const s=setup(),a=msg(),b=msg(),env={DB:s.DB},ctx={};await s.w.queue({messages:[a,b]},env,ctx);assert.equal(s.seen.length,1);assert.deepEqual(s.seen[0].c,{cron:body.cron,scheduledTime:body.scheduledTime});assert.equal(s.seen[0].e,env);assert.equal(s.seen[0].ctx,ctx);assert.equal(a.acks,1);assert.equal(b.acks,1);assert.equal(s.updates.length,1)});
test('invalid message is acknowledged without claim or business write',async()=>{const s=setup(),a=msg({...body,kind:'WRONG'});await s.w.queue({messages:[a]},{DB:s.DB},{});assert.equal(a.acks,1);assert.equal(s.claims.size,0);assert.equal(s.seen.length,0)});
test('failed partial cycle is not replayed and next minute still runs',async()=>{const s=setup(true),a=msg();await assert.rejects(s.w.queue({messages:[a]},{DB:s.DB},{}),/pipeline failed/);assert.equal(a.acks,1);const dup=msg();await s.w.queue({messages:[dup]},{DB:s.DB},{});assert.equal(s.seen.length,1);const next=msg({...body,scheduledTime:body.scheduledTime+60000});await assert.rejects(s.w.queue({messages:[next]},{DB:s.DB},{}));assert.equal(s.seen.length,2)});
test('failure before claim leaves message unacknowledged and permits retry',async()=>{const s=setup(),a=msg();s.setDbFail(true);await assert.rejects(s.w.queue({messages:[a]},{DB:s.DB},{}));assert.equal(a.acks,0);assert.equal(s.seen.length,0);s.setDbFail(false);await s.w.queue({messages:[a]},{DB:s.DB},{});assert.equal(a.acks,1);assert.equal(s.seen.length,1)});
