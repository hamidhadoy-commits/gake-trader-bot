import test from 'node:test';
import assert from 'node:assert/strict';
import {runNetlifyFeedTrial} from './netlify-feed-trial.js';
const first=1800000000000,slots=[first,first+60000,first+120000];
test('expired, early, late and invalid slots perform no I/O',async()=>{
 for(const [time,now,ss] of [[first,first,[]],[first-60000,first,slots],[first+180000,first+180000,slots],[first,first-1,slots],[first,first+70001,slots],[first,first,[first,first+120000,first+180000]]]){
  assert.equal((await runNetlifyFeedTrial({},time,{slots:ss,clock:()=>now,publisher:async()=>{throw Error('MUST_NOT_CALL');}})).status,'DISABLED');
 }
});
test('real cron offset publishes only approved slot and reports failed writes truthfully',async()=>{
 let calls=0;const DB={};
 const out=await runNetlifyFeedTrial({DB},first+24000,{slots,clock:()=>first+25000,publisher:async(db,options)=>{calls++;assert.equal(db,DB);assert.equal(options.publish,true);return {status:'PUBLISHED',feedWritten:true};}});
 assert.equal(calls,1);assert.equal(out.feedWritten,true);
 const failed=await runNetlifyFeedTrial({DB},first,{slots,clock:()=>first,publisher:async()=>{throw Error('private');}});
 assert.equal(failed.status,'PUBLISH_FAILED');assert.equal(failed.feedWritten,false);
});

test('long trial caps requests at 240 and rejects holes and post-window events',async()=>{
 const long=Array.from({length:240},(_,i)=>first+i*60000);let count=0;
 const pub=async(db,o)=>{count++;assert.equal(o.publishUntil,long.at(-1)+90000);return {status:'PUBLISHED',feedWritten:true};};
 for(const time of [long[0],long[119],long[239]])await runNetlifyFeedTrial({},time+24000,{slots:long,clock:()=>time+25000,publisher:pub});
 assert.equal(count,3);
 for(const ss of [[...long,long.at(-1)+60000],[first,first+60001]])assert.equal((await runNetlifyFeedTrial({},first,{slots:ss,clock:()=>first,publisher:pub})).status,'DISABLED');
 assert.equal((await runNetlifyFeedTrial({},long.at(-1)+60000,{slots:long,clock:()=>long.at(-1)+60000,publisher:pub})).status,'DISABLED');assert.equal(count,3);
});
