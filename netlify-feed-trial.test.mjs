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
