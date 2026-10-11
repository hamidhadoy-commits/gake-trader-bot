import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
// Includes actual SQLite reservation and a minute-boundary race.
import {runNetlifyFeedTrial} from './netlify-feed-trial.js';
const first=1800000000000,slots=[first,first+60000,first+120000];
function database(){const seen=new Set();return {prepare(sql){assert(sql.includes("'NETLIFY_FEED_CLAIMED'"));return {bind(id,minute,at){assert.equal(id,'NETLIFY_REFERENCE_MINUTE:'+minute);assert.equal(Math.floor(Date.parse(at)/60000)*60000,minute);return {async run(){const changes=seen.has(id)?0:1;seen.add(id);return {success:true,meta:{changes}};}};}};}};}
const accepted=async()=>({status:'PUBLISHED',feedWritten:true});
test('expired, early, late and invalid slots perform no I/O',async()=>{
 for(const [time,now,ss] of [[first,first,[]],[first-60000,first,slots],[first+180000,first+180000,slots],[first,first-1,slots],[first,first+70001,slots],[first,first,[first,first+120000,first+180000]]]){
  assert.equal((await runNetlifyFeedTrial({},time,{slots:ss,clock:()=>now,publisher:async()=>{throw Error('MUST_NOT_CALL');}})).status,'DISABLED');
 }
});
test('real cron offset publishes only approved slot and reports failed writes truthfully',async()=>{
 let calls=0;const DB=database();
 const out=await runNetlifyFeedTrial({DB},first+24000,{slots,clock:()=>first+25000,publisher:async(db,options)=>{calls++;assert.equal(db,DB);assert.equal(options.publish,true);return accepted();}});
 assert.equal(calls,1);assert.equal(out.feedWritten,true);
 const failed=await runNetlifyFeedTrial({DB:database()},first,{slots,clock:()=>first,publisher:async()=>{throw Error('private');}});
 assert.equal(failed.status,'PUBLISH_FAILED');assert.equal(failed.feedWritten,false);
});
test('240 approved wall-clock minutes bound calls; holes and post-window events are rejected',async()=>{
 const long=Array.from({length:240},(_,i)=>first+i*60000),DB=database();let count=0;
 const pub=async(db,o)=>{count++;assert.equal(o.publishUntil,long.at(-1)+60000);return accepted();};
 for(const time of [long[0],long[119],long[239]])await runNetlifyFeedTrial({DB},time+24000,{slots:long,clock:()=>time+25000,publisher:pub});
 assert.equal(count,3);
 for(const ss of [[...long,long.at(-1)+60000],[first,first+60001]])assert.equal((await runNetlifyFeedTrial({DB},first,{slots:ss,clock:()=>first,publisher:pub})).status,'DISABLED');
 assert.equal((await runNetlifyFeedTrial({DB},long.at(-1)+60000,{slots:long,clock:()=>long.at(-1)+60000,publisher:pub})).status,'DISABLED');assert.equal(count,3);
});
test('concurrent deliveries with different cron offsets reserve one global minute',async()=>{
 const DB=database();let count=0;
 const r=await Promise.all(Array.from({length:20},(_,i)=>runNetlifyFeedTrial({DB},first+20000+i,{slots,clock:()=>first+30000,publisher:async()=>{count++;return accepted();}})));
 assert.equal(count,1);assert.equal(r.filter(x=>x.status==='DUPLICATE_MINUTE_SKIPPED').length,19);
});
test('publisher failure consumes reservation and cannot trigger a retry in that minute',async()=>{
 const DB=database();let count=0,publisher=async()=>{count++;throw Error('private');};
 assert.equal((await runNetlifyFeedTrial({DB},first,{slots,clock:()=>first,publisher})).status,'PUBLISH_FAILED');
 assert.equal((await runNetlifyFeedTrial({DB},first+29000,{slots,clock:()=>first+30000,publisher})).status,'DUPLICATE_MINUTE_SKIPPED');assert.equal(count,1);
});
test('database failure or ambiguous claim fails closed without provider I/O',async()=>{
 for(const outcome of [null,{success:false},{success:true,meta:{changes:2}},{success:true,meta:{changes:undefined}}]){
  let count=0;const DB={prepare(){return {bind(){return {run:async()=>{if(outcome===null)throw Error('private');return outcome;}};}};}};
  assert.equal((await runNetlifyFeedTrial({DB},first,{slots,clock:()=>first,publisher:async()=>{count++;return accepted();}})).status,'CLAIM_FAILED');assert.equal(count,0);
 }
});
test('late adjacent scheduled minutes share wall-clock budget; post-last-minute call is disabled',async()=>{
 const DB=database();let count=0;const publisher=async()=>{count++;return accepted();};
 await runNetlifyFeedTrial({DB},first+29000,{slots,clock:()=>first+61000,publisher});
 assert.equal((await runNetlifyFeedTrial({DB},first+60000,{slots,clock:()=>first+61001,publisher})).status,'DUPLICATE_MINUTE_SKIPPED');
 assert.equal((await runNetlifyFeedTrial({DB},first+120000+29000,{slots,clock:()=>first+180000,publisher})).status,'DISABLED');assert.equal(count,1);
});
test('actual SQLite primary key enforces atomic reservation across offsets',async()=>{
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE paper_cron_queue_runs(id TEXT PRIMARY KEY,scheduled_time INTEGER,status TEXT,started_at TEXT)');
 const DB={prepare(sql){return {bind(...args){return {run(){return {success:true,meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};}};}};
 let count=0;const publisher=async()=>{count++;return accepted();};
 try{
  const results=await Promise.all([24000,29000].map(offset=>runNetlifyFeedTrial({DB},first+offset,{slots,clock:()=>first+30000,publisher})));
  assert.equal(count,1);assert.equal(results.filter(x=>x.status==='DUPLICATE_MINUTE_SKIPPED').length,1);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM paper_cron_queue_runs WHERE status='NETLIFY_FEED_CLAIMED'").get().n,1);
 }finally{sqlite.close();}
});


test('slow lookup cannot carry provider call into the next wall-clock minute',async()=>{
 let now=first+59000,fetches=0;const original=globalThis.fetch;
 globalThis.fetch=async()=>{fetches++;return {};};
 try{
  const out=await runNetlifyFeedTrial({DB:database()},first+29000,{slots,clock:()=>now,publisher:async(db,o)=>{now=first+60000;return o.fetcher('https://invalid.example');}});
  assert.equal(out.status,'PUBLISH_FAILED');assert.equal(fetches,0);
 }finally{globalThis.fetch=original;}
});

test('last-minute publisher cutoff ends at next minute and rejects an in-flight late write',async()=>{
 const {refreshNetlifyReferenceFeed}=await import('./netlify-feed-publisher.js');
 const end=slots.at(-1)+60000;let now=end-1,writes=0;
 const DB={prepare(){writes++;throw Error('NO_WRITE');}};
 const result=await runNetlifyFeedTrial({DB:database()},slots.at(-1)+29000,{slots,clock:()=>now,publisher:async(_,o)=>{
  assert.equal(o.publishUntil,end);now=end;
  return refreshNetlifyReferenceFeed(DB,{...o,probe:async()=>{throw Error('NO_PROBE');}});
 }});
 assert.equal(result.status,'PUBLICATION_WINDOW_CLOSED');assert.equal(writes,0);
});
