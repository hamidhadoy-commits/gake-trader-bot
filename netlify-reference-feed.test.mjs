import test from 'node:test';
import assert from 'node:assert/strict';
import {probeNetlifyReferenceFeed,runNetlifyReferenceCanary,NETLIFY_REFERENCE_URL,SOL} from './netlify-reference-feed.js';
const A='1td9rcn2YTw1pEJH1JvatDH8qPHBTte3aPDG29zpump',B='2TrHJ8XjgwnJ9shozBT5AAZUUgufR6JbnZZDVtFRpump',now=1800000000000;
const db=(mints=[A,B])=>({prepare(sql){assert.match(sql,/^SELECT DISTINCT mint/);return {async all(){return {success:true,results:mints.map(mint=>({mint}))};}};}});
const body=()=>({status:'TRANSPORT_ACCEPTED',productionConnected:false,attempts:1,requested:2,observedAt:new Date(now-1000).toISOString(),tokenPrices:{[SOL]:100,[A]:2,unrequested:999},responseMetadata:{httpStatus:200,requestStartedAt:new Date(now-1500).toISOString(),responseReceivedAt:new Date(now-1000).toISOString(),responseAgeSeconds:0}});
test('one fixed public POST, no secrets, partial coverage and production gate',async()=>{
 let calls=0;
 const r=await probeNetlifyReferenceFeed(db(),{clock:()=>now,fetcher:async(url,opts)=>{calls++;assert.equal(url,NETLIFY_REFERENCE_URL);assert.equal(opts.redirect,'error');assert.deepEqual(opts.headers,{'content-type':'application/json'});assert.deepEqual(JSON.parse(opts.body),{mints:[A,B]});return Response.json(body());}});
 assert.equal(calls,1);assert.equal(r.status,'ACCEPTED');assert.equal(r.priced,1);assert.deepEqual(r.missing,[B]);assert.equal(JSON.parse(r.row.payload_json).tokenPrices.unrequested,undefined);
});
test('bad batches and read failures send no request',async()=>{
 for(const mints of [[],['bad'],Array.from({length:30},(_,i)=>A.slice(0,-2)+(i+11))]){
 const r=await probeNetlifyReferenceFeed(db(mints),{fetcher:()=>{throw Error('MUST_NOT_FETCH');}});
 assert.notEqual(r.status,'REQUEST_FAILED');
 }
 const r=await probeNetlifyReferenceFeed({prepare(){throw Error('private error');}});assert.equal(r.status,'REQUEST_FAILED');assert.equal(r.failureStage,'MINT_READ');assert.equal(JSON.stringify(r).includes('private error'),false);
});
test('HTTP errors, rate limits and malformed bodies never retry or write',async()=>{
 for(const response of [new Response('',{status:429}),new Response('',{status:502}),new Response('{'),new Response('x'.repeat(65537))]){
 let calls=0;const r=await probeNetlifyReferenceFeed(db(),{fetcher:async()=>{calls++;return response;}});assert.equal(calls,1);assert.equal(r.status,'REQUEST_FAILED');assert.ok(r.failureStage);
 }
});
test('stale source, future timestamp, mismatched receipt, cache+transit age and SOL rejected',async()=>{
 for(const mutate of [b=>b.observedAt=new Date(now-91000).toISOString(),b=>{b.observedAt=b.responseMetadata.responseReceivedAt=new Date(now+5001).toISOString();},b=>b.responseMetadata.responseAgeSeconds=90,b=>b.responseMetadata.responseReceivedAt=new Date(now).toISOString(),b=>b.tokenPrices[SOL]=0,b=>b.tokenPrices[SOL]='100']){
 const b=body();mutate(b);const r=await probeNetlifyReferenceFeed(db(),{clock:()=>now,fetcher:async()=>Response.json(b)});assert.equal(r.status,'FRESHNESS_REJECTED');
 }
});
test('lying accepted envelope rejected',async()=>{
 for(const change of [{status:'TRANSPORT_REJECTED'},{attempts:2},{productionConnected:true},{requested:3}]){
 const r=await probeNetlifyReferenceFeed(db(),{clock:()=>now,fetcher:async()=>Response.json({...body(),...change})});assert.equal(r.status,'TRANSPORT_REJECTED');
 }
});
test('deadline covers never-ending response body',async()=>{
 let aborted=false;
 const r=await probeNetlifyReferenceFeed(db(),{timeoutMs:10,fetcher:async(_,opts)=>{opts.signal.addEventListener('abort',()=>{aborted=true;});return new Response(new ReadableStream({start(){}}));}});
 assert.equal(r.status,'REQUEST_FAILED');assert.equal(aborted,true);
});
test('canary disabled outside exact slots, on delay, or oversized slot set',async()=>{
 let calls=0;const probe=()=>{calls++;throw Error('MUST_NOT_RUN');};
 for(const opts of [{slots:[]},{slots:[now],clock:()=>now-1},{slots:[now],clock:()=>now+70001},{slots:[now,now+1,now+2,now+3]}]){
 assert.equal((await runNetlifyReferenceCanary({},now,{clock:()=>now,probe,...opts})).status,'DISABLED');
 }assert.equal(calls,0);
});
test('canary cannot write feed and probe failure never escapes',async()=>{
 const log=console.log,warn=console.warn;console.log=console.warn=()=>{};
 try{let count=0;const r=await runNetlifyReferenceCanary({DB:{}},now,{slots:[now],clock:()=>now,probe:async()=>{count++;return {status:'ACCEPTED',requested:2,priced:1};}});assert.equal(count,1);assert.equal(r.feedWritten,false);
 assert.equal((await runNetlifyReferenceCanary({},now,{slots:[now],clock:()=>now,probe:()=>{throw Error('secret');}})).status,'CANARY_FAILED');
 }finally{console.log=log;console.warn=warn;}
});
test('actual cron timestamp can have a seconds offset within the selected minute',async()=>{
 const saved=console.log;console.log=()=>{};
 try{
 let calls=0;const scheduledTime=now+24000;
 const r=await runNetlifyReferenceCanary({},scheduledTime,{slots:[now],clock:()=>scheduledTime+1000,probe:async()=>{calls++;return {status:'ACCEPTED'};}});
 assert.equal(calls,1);assert.equal(r.status,'ACCEPTED');
 }finally{console.log=saved;}
});
