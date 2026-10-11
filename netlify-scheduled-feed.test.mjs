import test from 'node:test';
import assert from 'node:assert/strict';
import {withPaperCronQueue} from './paper-cron-queue.js';
const event={cron:'* * * * *',scheduledTime:1800000000000};
test('feed starts before a pending queue send settles',async()=>{
 let resolveSend,feedCalls=0;
 const env={PAPER_CRON_QUEUE:{send:()=>new Promise(resolve=>{resolveSend=resolve;})}};
 const worker=withPaperCronQueue({}, {feedTrial:async(e,t)=>{assert.equal(e,env);assert.equal(t,event.scheduledTime);feedCalls++;}});
 const run=worker.scheduled(event,env);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(feedCalls,1);resolveSend();await run;
});
test('feed failure cannot prevent enqueue; send failure does not prevent feed',async()=>{
 const warn=console.warn;console.warn=()=>{};
 try{
 let sent=0,called=0;
 const feedFails=withPaperCronQueue({}, {feedTrial:async()=>{throw Error('feed');}});
 await feedFails.scheduled(event,{PAPER_CRON_QUEUE:{send:async()=>{sent++;}}});
 assert.equal(sent,1);
 const sendFails=withPaperCronQueue({}, {feedTrial:async()=>{called++;}});
 await assert.rejects(sendFails.scheduled(event,{PAPER_CRON_QUEUE:{send:()=>{throw Error('queue');}}}),/queue/);
 assert.equal(called,1);
 }finally{console.warn=warn;}
});
test('late and duplicate Paper messages never invoke feed; paper claim remains once',async()=>{
 let feed=0,paper=0,acks=0;const claimed=new Set();
 const DB={prepare(sql){return {bind(id){return {async run(){if(sql.startsWith('INSERT')){const duplicate=claimed.has(id);claimed.add(id);return {meta:{changes:duplicate?0:1}};}return {meta:{changes:1}};}}}};}};
 const worker=withPaperCronQueue({async scheduled(){paper++;}},{canary:async()=>{},feedTrial:async()=>{feed++;}});
 const message=()=>({body:{kind:'GAKE_PAPER_CRON_V1',...event},ack(){acks++;}});
 await worker.queue({messages:[message(),message()]},{DB},{});
 assert.equal(feed,0);assert.equal(paper,1);assert.equal(acks,2);
});
test('invalid schedule does not call feed or send',async()=>{
 let calls=0;const worker=withPaperCronQueue({}, {feedTrial:async()=>{calls++;}});
 await assert.rejects(worker.scheduled({...event,cron:'wrong'},{PAPER_CRON_QUEUE:{send:async()=>{calls++;}}}),/Invalid/);
 assert.equal(calls,0);
});
