import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./price-provider.js',import.meta.url),'utf8');
const SOL='So11111111111111111111111111111111111111112';
let id=0;
async function fixture(run){
 const saved={fetch:globalThis.fetch,now:Date.now,log:console.log,warn:console.warn};
 let now=1800000000000;const calls=[],logs=[];
 Date.now=()=>now;console.log=console.warn=x=>logs.push(x);
 const p=await import('data:text/javascript;base64,'+Buffer.from(source+'\n// fresh '+(++id)).toString('base64'));
 try{await run({p,calls,logs,setNow:x=>{now=x},now:()=>now,
   mock:f=>{globalThis.fetch=async(u,o)=>{calls.push({url:String(u),options:o});return f(String(u),o)};}})}
 finally{globalThis.fetch=saved.fetch;Date.now=saved.now;console.log=saved.log;console.warn=saved.warn;}
}
const price=x=>Response.json({data:{attributes:{token_prices:x}}});
test('429 recovers missing marks using public API without leaking demo credentials',()=>fixture(async f=>{
 f.mock((u,o)=>{
  if(u.includes('coingecko'))return Response.json({error:'Monthly credit limit reached SECRET_KEY'},{status:429});
  assert.ok(u.includes('geckoterminal'));assert.equal(o.headers['x-cg-demo-api-key'],undefined);
  return price({[SOL]:100,A:2});
 });
 const marks=await f.p.fetchPaperExitSolPrices(['A'],{coingeckoApiKey:'SECRET_KEY'});
 assert.equal(marks.get('A').priceSOLPerToken,.02);
 assert.equal(marks.get('A').source,'GECKOTERMINAL_MARK_USD_RATIO');
 assert.equal(marks.get('A').responseMetadata.httpStatus,200);
 assert.equal(f.calls.length,2);assert.ok(!JSON.stringify(f.logs).includes('SECRET_KEY'));
 assert.equal(f.logs.find(x=>x.status===429).reason,'monthly_credit_limit');
 f.setNow(f.now()+60000);
 await f.p.fetchPaperExitSolPrices(['A'],{coingeckoApiKey:'SECRET_KEY'});
 assert.equal(f.calls.filter(x=>x.url.includes('coingecko')).length,1);
 f.setNow(f.now()+3600000);
 await f.p.fetchPaperExitSolPrices(['A'],{coingeckoApiKey:'SECRET_KEY'});
 assert.equal(f.calls.filter(x=>x.url.includes('coingecko')).length,2);
}));
test('public endpoint batches at most 30 addresses and rejects absent SOL or invalid token price',()=>fixture(async f=>{
 const mints=Array.from({length:60},(_,i)=>'T'+i);
 f.mock(u=>{
  if(u.includes('dexscreener'))return Response.json([]);
  const ids=u.split('/').at(-1).split(',');assert.ok(ids.length<=30);assert.ok(ids.includes(SOL));
  return price({[SOL]:100,...Object.fromEntries(ids.filter(x=>x!==SOL).map(x=>[x,2]))});
 });
 const p=await f.p.fetchPaperExitSolPrices(mints);assert.equal(p.size,60);assert.equal(f.calls.length,3);
 f.mock(u=>u.includes('geckoterminal')?price({A:2}):Response.json([]));
 assert.equal((await f.p.fetchPaperExitSolPrices(['A'])).size,0);
 f.mock(u=>u.includes('geckoterminal')?price({[SOL]:100,A:-2,B:'NaN',C:0}):Response.json([]));
 assert.equal((await f.p.fetchPaperExitSolPrices(['A','B','C'])).size,0);
}));
test('both providers rate-limited honor Retry-After and still permit other fallbacks',()=>fixture(async f=>{
 f.mock(u=>u.includes('dexscreener')?Response.json([{chainId:'solana',baseToken:{address:'A'},quoteToken:{address:SOL},priceNative:'0.03',liquidity:{usd:1}}]):new Response('Too many requests',{status:429,headers:{'retry-after':'120'}}));
 assert.equal((await f.p.fetchPaperExitSolPrices(['A'],{coingeckoApiKey:'test'})).get('A').priceSOLPerToken,.03);
 f.setNow(f.now()+60000);
 await f.p.fetchPaperExitSolPrices(['A'],{coingeckoApiKey:'test'});
 assert.equal(f.calls.filter(x=>!x.url.includes('dexscreener')).length,2);
 f.setNow(f.now()+60001);
 await f.p.fetchPaperExitSolPrices(['A'],{coingeckoApiKey:'test'});
 assert.equal(f.calls.filter(x=>!x.url.includes('dexscreener')).length,4);
}));
test('HTTP-date Retry-After suppresses requests until its deadline',()=>fixture(async f=>{
 const deadline=f.now()+180000;
 f.mock(u=>u.includes('dexscreener')?Response.json([]):new Response('limited',{status:429,headers:{'retry-after':new Date(deadline).toUTCString()}}));
 await f.p.fetchPaperExitSolPrices(['A']);f.setNow(deadline-1);await f.p.fetchPaperExitSolPrices(['A']);
 assert.equal(f.calls.filter(x=>x.url.includes('geckoterminal')).length,1);
 f.setNow(deadline);await f.p.fetchPaperExitSolPrices(['A']);
 assert.equal(f.calls.filter(x=>x.url.includes('geckoterminal')).length,2);
}));
test('partial primary quotes are retained; public fallback only requests missing mints',()=>fixture(async f=>{
 f.mock(u=>{
  if(u.includes('coingecko'))return price({[SOL]:100,A:2});
  assert.ok(!u.split('/').at(-1).split(',').includes('A'));
  return price({[SOL]:100,A:999,B:3});
 });
 const p=await f.p.fetchPaperExitSolPrices(['A','B'],{coingeckoApiKey:'test'});
 assert.equal(p.get('A').source,'COINGECKO_MARK_USD_RATIO');assert.equal(p.get('A').priceSOLPerToken,.02);
 assert.equal(p.get('B').priceSOLPerToken,.03);assert.equal(f.calls.length,2);
}));
