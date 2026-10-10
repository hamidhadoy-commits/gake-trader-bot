import test from 'node:test';
import assert from 'node:assert/strict';
import {withPaperCronQueue} from './paper-cron-queue.js';
test('read-only canary runs once per claim and cannot stop paper or alter HTTP',async()=>{
 const claimed=new Set(),calls=[],fetch=()=>new Response('same');
 const DB={prepare(sql){return {bind(id){return {async run(){if(sql.startsWith('INSERT')){const exists=claimed.has(id);claimed.add(id);return {meta:{changes:exists?0:1}};}return {meta:{changes:1}};}}}};}};
 const saved=console.warn;console.warn=()=>{};
 try{
 const worker=withPaperCronQueue({fetch,async scheduled(){calls.push('paper');}},{canary:async()=>{calls.push('canary');throw Error('simulated');}});
 const body={kind:'GAKE_PAPER_CRON_V1',cron:'* * * * *',scheduledTime:1800000000000};
 let acks=0;const message=()=>({body,ack(){acks++;}});
 await worker.queue({messages:[message(),message()]},{DB},{});
 assert.equal(worker.fetch,fetch);assert.deepEqual(calls,['canary','paper']);assert.equal(acks,2);
 }finally{console.warn=saved;}
});
