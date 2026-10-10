import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshNetlifyReferenceFeed} from './netlify-feed-publisher.js';
import {SOL} from './netlify-reference-feed.js';
const now=1800000000000,A='1td9rcn2YTw1pEJH1JvatDH8qPHBTte3aPDG29zpump';
function candidate(){return {status:'ACCEPTED',requested:2,row:{observed_at:new Date(now-1000).toISOString(),payload_json:JSON.stringify({schemaVersion:1,provider:'GECKOTERMINAL_PUBLIC',wrappedSolMint:SOL,tokenPrices:{[SOL]:100,[A]:2},responseMetadata:{httpStatus:200,requestStartedAt:new Date(now-1500).toISOString(),responseReceivedAt:new Date(now-1000).toISOString(),responseAgeSeconds:0}})}};}
test('default and non-boolean publish flags never write',async()=>{
 for(const publish of [undefined,false,'true',1]){
 const db={prepare(){throw Error('MUST_NOT_WRITE');}};
 const r=await refreshNetlifyReferenceFeed(db,{publish,clock:()=>now,probe:async()=>candidate()});assert.equal(r.status,'READY_READ_ONLY');assert.equal(r.feedWritten,false);
 }
});
test('expired by time of write, missing tokens and failed probe preserve existing feed',async()=>{
 for(const probe of [async()=>({...candidate(),status:'REQUEST_FAILED'}),async()=>{const c=candidate(),p=JSON.parse(c.row.payload_json);delete p.tokenPrices[A];c.row.payload_json=JSON.stringify(p);return c;},async()=>candidate()]){
 const db={prepare(){throw Error('MUST_NOT_WRITE');}};
 const r=await refreshNetlifyReferenceFeed(db,{publish:true,clock:()=>now+90001,probe});assert.equal(r.feedWritten,false);assert.notEqual(r.status,'PUBLISH_FAILED');
 }
});
test('explicit publication uses timestamp guarded atomic existing-table upsert',async()=>{
 let call=0;const c=candidate();
 const db={prepare(sql){call++;assert.match(sql,/WHERE excluded.observed_at>paper_reference_price_feed.observed_at$/);return {bind(...args){assert.deepEqual(args,[c.row.observed_at,c.row.payload_json]);return {async run(){return {success:true,meta:{changes:1}};}};}};}};
 const r=await refreshNetlifyReferenceFeed(db,{publish:true,clock:()=>now,probe:async()=>c});assert.equal(call,1);assert.equal(r.status,'PUBLISHED');assert.equal(r.feedWritten,true);
});
test('newer existing snapshot or D1 failure cannot be reported as published',async()=>{
 for(const write of [{success:true,meta:{changes:0}},{success:false},{error:true}]){
 const db={prepare(){return {bind(){return {async run(){if(write.error)throw Error('private');return write;}};}};}};
 const r=await refreshNetlifyReferenceFeed(db,{publish:true,clock:()=>now,probe:async()=>candidate()});assert.equal(r.feedWritten,false);assert.notEqual(r.status,'PUBLISHED');
 }
});
