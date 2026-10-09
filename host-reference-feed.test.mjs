import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeHostReferenceFeed,fetchHostReferenceSolPrices,fetchPaperExitSolPrices} from './price-provider.js';
const now=1800000000000,SOL='So11111111111111111111111111111111111111112';
function row(age=1000){const completed=now-age;return {observed_at:new Date(completed).toISOString(),payload_json:JSON.stringify({schemaVersion:1,provider:'GECKOTERMINAL_PUBLIC',wrappedSolMint:SOL,tokenPrices:{[SOL]:100,A:2,B:3},responseMetadata:{httpStatus:200,requestStartedAt:new Date(completed-500).toISOString(),responseReceivedAt:new Date(completed).toISOString(),responseAgeSeconds:null}})}}
function edit(r,f){const x=JSON.parse(r.payload_json);f(x);r.payload_json=JSON.stringify(x);return r}
test('trusted fresh transport yields only requested prices with distinct provenance',()=>{
 const p=decodeHostReferenceFeed(row(),['A','A','C'],SOL,now);assert.equal(p.size,1);assert.equal(p.get('A').priceSOLPerToken,.02);assert.equal(p.get('A').source,'GECKOTERMINAL_HOST_MARK_USD_RATIO');assert.equal(p.get('A').responseMetadata.httpStatus,200);
});
test('expired, future, inconsistent and cache-aged timestamps are rejected',()=>{
 for(const r of [row(90001),row(-5001),edit(row(),x=>x.responseMetadata.requestStartedAt=new Date(now-90001).toISOString()),edit(row(),x=>x.responseMetadata.responseReceivedAt=new Date(now).toISOString()),edit(row(),x=>x.responseMetadata.responseAgeSeconds=90),edit(row(),x=>x.responseMetadata.responseAgeSeconds=-1)])assert.equal(decodeHostReferenceFeed(r,['A'],SOL,now).size,0);
});
test('incorrect provider, schema, status, mint and invalid payload are rejected',()=>{
 for(const r of [null,{payload_json:'invalid'},edit(row(),x=>x.provider='OTHER'),edit(row(),x=>x.schemaVersion=2),edit(row(),x=>x.responseMetadata.httpStatus=429),edit(row(),x=>x.wrappedSolMint='wrong'),{...row(),payload_json:' '.repeat(65537)}])assert.equal(decodeHostReferenceFeed(r,['A'],SOL,now).size,0);
});
test('invalid SOL or token prices never invent values',()=>{
 for(const v of [0,-1,'NaN',null])assert.equal(decodeHostReferenceFeed(edit(row(),x=>x.tokenPrices[SOL]=v),['A'],SOL,now).size,0);
 const p=decodeHostReferenceFeed(edit(row(),x=>{x.tokenPrices.A=0;x.tokenPrices.B=-1}),['A','B'],SOL,now);assert.equal(p.size,0);
});
test('missing binding/table safely permits existing providers',async()=>{
 assert.equal((await fetchHostReferenceSolPrices(null,['A'],SOL)).size,0);
 const warn=console.warn;console.warn=()=>{};try{assert.equal((await fetchHostReferenceSolPrices({prepare(){throw Error('missing table')}},['A'],SOL)).size,0)}finally{console.warn=warn}
});
test('host fallback recovers missing primary prices and preserves successful primary marks',async()=>{
 const saved={fetch:globalThis.fetch,now:Date.now,log:console.log,warn:console.warn};const calls=[];let reads=0;
 try{
 Date.now=()=>now;console.log=console.warn=()=>{};
 globalThis.fetch=async u=>{calls.push(String(u));assert.ok(String(u).includes('coingecko'));return Response.json({data:{attributes:{token_prices:{[SOL]:100,A:1}}}})};
 const db={prepare(sql){assert.ok(sql.includes('WHERE id=1'));return {async first(){reads++;return row()}}}};
 const p=await fetchPaperExitSolPrices(['A','B'],{coingeckoApiKey:'test',referenceDb:db});
 assert.equal(p.get('A').priceSOLPerToken,.01);assert.equal(p.get('A').source,'COINGECKO_MARK_USD_RATIO');assert.equal(p.get('B').priceSOLPerToken,.03);assert.equal(calls.length,1);assert.equal(reads,1);
 }finally{Object.assign(globalThis,{fetch:saved.fetch});Date.now=saved.now;console.log=saved.log;console.warn=saved.warn}
});
test('expired host feed continues to DEX instead of returning old prices',async()=>{
 const saved={fetch:globalThis.fetch,now:Date.now,log:console.log,warn:console.warn};
 try{Date.now=()=>now;console.log=console.warn=()=>{};globalThis.fetch=async()=>Response.json([{chainId:'solana',baseToken:{address:'A'},quoteToken:{address:SOL},priceNative:'0.04',liquidity:{usd:1}}]);const p=await fetchPaperExitSolPrices(['A'],{referenceDb:{prepare(){return {async first(){return row(100000)}}}}});assert.equal(p.get('A').priceSOLPerToken,.04);assert.equal(p.get('A').source,'DEXSCREENER_SOL_QUOTE')}
 finally{globalThis.fetch=saved.fetch;Date.now=saved.now;console.log=saved.log;console.warn=saved.warn}
});
