import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const original=await readFile(new URL('./price-provider.js',import.meta.url),'utf8');let run=0;
async function fresh(){return import('data:text/javascript;base64,'+Buffer.from(original+'\nexport {coinGeckoRetryAfterMs,classifyCoinGeckoError,fetchCoinGeckoMarkSolPrices};\n//run'+(++run)).toString('base64'));}
const saved={fetch:globalThis.fetch,now:Date.now,log:console.log,warn:console.warn};
test.afterEach(()=>{globalThis.fetch=saved.fetch;Date.now=saved.now;console.log=saved.log;console.warn=saved.warn});
const SOL='So11111111111111111111111111111111111111112';
test('Retry-After seconds/date are honoured; invalid and unreasonable headers rejected',async()=>{
 const m=await fresh(),now=1800000000000;const delay=x=>m.coinGeckoRetryAfterMs(new Response('',{status:429,headers:{'retry-after':x}}),now);
 assert.equal(delay('7200'),7200000);assert.equal(delay(new Date(now+120000).toUTCString()),120000);
 for(const x of ['bad','-1','0','86401'])assert.equal(delay(x),0);
});
test('safe classification retains numeric code but never response text',async()=>{
 const m=await fresh();assert.deepEqual(m.classifyCoinGeckoError(JSON.stringify({status:{error_code:429,error_message:'Monthly credits exceeded SECRET_TOKEN'}})),{reason:'monthly_quota',errorCode:429});
 assert.deepEqual(m.classifyCoinGeckoError('invalid'),{reason:'unclassified',errorCode:null});
 assert.equal(m.classifyCoinGeckoError(JSON.stringify({error:'Rate limit exceeded'})).reason,'rate_limit');
});
test('429 skips repeated requests; host fallback continues; expiry probes and success restores primary',async()=>{
 const m=await fresh();let clock=1800000000000,cg=0,reads=0;const logs=[];Date.now=()=>clock;console.log=console.warn=x=>logs.push(x);
 globalThis.fetch=async()=>{cg++;return cg===1?Response.json({error:'Rate limit exceeded SECRET_TOKEN'},{status:429}):Response.json({data:{attributes:{token_prices:{[SOL]:100,A:1}}}})};
 const db={prepare(){return {async first(){reads++;return {observed_at:new Date(clock).toISOString(),payload_json:JSON.stringify({schemaVersion:1,provider:'GECKOTERMINAL_PUBLIC',wrappedSolMint:SOL,tokenPrices:{[SOL]:100,A:2},responseMetadata:{httpStatus:200,requestStartedAt:new Date(clock-100).toISOString(),responseReceivedAt:new Date(clock).toISOString(),responseAgeSeconds:null}})}}}}};
 let p=await m.fetchPaperExitSolPrices(['A'],{coingeckoApiKey:'test',referenceDb:db});assert.equal(p.get('A').source,'GECKOTERMINAL_HOST_MARK_USD_RATIO');
 clock+=1000;p=await m.fetchPaperExitSolPrices(['A'],{coingeckoApiKey:'test',referenceDb:db});assert.equal(cg,1);assert.equal(reads,2);
 clock+=60000;p=await m.fetchPaperExitSolPrices(['A'],{coingeckoApiKey:'test',referenceDb:db});assert.equal(cg,2);assert.equal(p.get('A').source,'COINGECKO_MARK_USD_RATIO');assert.equal(p.get('A').priceSOLPerToken,.01);assert.equal(reads,2);
 assert.equal(JSON.stringify(logs).includes('SECRET_TOKEN'),false);assert(logs.some(x=>x.remainingMs>0));
});
test('repeated 429 increases bounded delay and successful HTTP resets it',async()=>{
 const m=await fresh();let clock=1800000000000,calls=0,success=false;const delays=[];Date.now=()=>clock;console.log=()=>{};console.warn=x=>{if(x.cooldownMs)delays.push(x.cooldownMs)};
 globalThis.fetch=async()=>{calls++;return success?Response.json({data:{attributes:{token_prices:{[SOL]:100,A:1}}}}):Response.json({error:'rate limit'},{status:429})};
 for(const delay of [60000,120000,240000,300000]){await m.fetchCoinGeckoMarkSolPrices(['A'],SOL,'test');clock+=delay-1;await m.fetchCoinGeckoMarkSolPrices(['A'],SOL,'test');clock+=1;}
 assert.deepEqual(delays,[60000,120000,240000,300000]);assert.equal(calls,4);
 success=true;assert.equal((await m.fetchCoinGeckoMarkSolPrices(['A'],SOL,'test')).size,1);success=false;await m.fetchCoinGeckoMarkSolPrices(['A'],SOL,'test');assert.equal(delays.at(-1),60000);
});
test('long Retry-After prevents premature requests beyond normal exponential cap',async()=>{
 const m=await fresh();let clock=1800000000000,calls=0;Date.now=()=>clock;console.log=console.warn=()=>{};globalThis.fetch=async()=>{calls++;return new Response('rate limit',{status:429,headers:{'retry-after':'3600'}})};
 await m.fetchCoinGeckoMarkSolPrices(['A'],SOL,'test');clock+=300001;await m.fetchCoinGeckoMarkSolPrices(['A'],SOL,'test');assert.equal(calls,1);clock+=3300000;await m.fetchCoinGeckoMarkSolPrices(['A'],SOL,'test');assert.equal(calls,2);
});
test('cooldown does not accept stale host data and continues to DEX',async()=>{
 const m=await fresh();let clock=1800000000000,cg=0,dex=0;Date.now=()=>clock;console.log=console.warn=()=>{};
 globalThis.fetch=async u=>{if(String(u).includes('coingecko')){cg++;return new Response('rate limit',{status:429})}dex++;return Response.json([{chainId:'solana',baseToken:{address:'A'},quoteToken:{address:SOL},priceNative:'0.04',liquidity:{usd:1}}])};
 const db={prepare(){return {async first(){return {observed_at:new Date(clock-100000).toISOString(),payload_json:'{}'}}}}};
 for(let i=0;i<2;i++){const p=await m.fetchPaperExitSolPrices(['A'],{coingeckoApiKey:'test',referenceDb:db});assert.equal(p.get('A').source,'DEXSCREENER_SOL_QUOTE');clock+=1000}
 assert.equal(cg,1);assert.equal(dex,2);
});
test('non-429 errors do not enter cooldown or log error response bodies',async()=>{
 const m=await fresh();let calls=0;const logs=[];console.log=console.warn=x=>logs.push(x);globalThis.fetch=async()=>{calls++;return Response.json({error:'SECRET_TOKEN forbidden'},{status:403})};
 await m.fetchCoinGeckoMarkSolPrices(['A'],SOL,'test');await m.fetchCoinGeckoMarkSolPrices(['A'],SOL,'test');assert.equal(calls,2);assert.equal(JSON.stringify(logs).includes('SECRET_TOKEN'),false);
});
