import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('./price-provider.js',import.meta.url),'utf8');
const provider=await import('data:text/javascript;base64,'+Buffer.from(
  source.replace('const PRICE_FETCH_TIMEOUT_MS = 7000;', 'const PRICE_FETCH_TIMEOUT_MS = 30;')
  +'\nexport {fetchWithTimeout};').toString('base64'));
const realFetch=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=realFetch;});

test('deadline rejects when headers never arrive even if fetch ignores abort',async()=>{
  let signal;
  globalThis.fetch=async(_,options)=>{signal=options.signal;return new Promise(()=>{});};
  await assert.rejects(provider.fetchWithTimeout('mock:',{},30),{name:'TimeoutError'});
  assert.equal(signal.aborted,true);
});

test('deadline stays active after headers when response body stalls',async()=>{
  let signal;
  globalThis.fetch=async(_,options)=>{
    signal=options.signal;
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}));
  };
  await assert.rejects(provider.fetchWithTimeout('mock:',{},30),{name:'TimeoutError'});
  assert.equal(signal.aborted,true);
});

test('successful body retains JSON and transport headers',async()=>{
  let signal;
  globalThis.fetch=async(_,options)=>{signal=options.signal;return Response.json({price:2},{headers:{age:'4','cf-cache-status':'HIT'}});};
  const response=await provider.fetchWithTimeout('mock:',{},30);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('age'),'4');
  assert.equal(response.headers.get('cf-cache-status'),'HIT');
  assert.deepEqual(await response.json(),{price:2});
  await new Promise(resolve=>setTimeout(resolve,45));
  assert.equal(signal.aborted,false,'completed request clears deadline');
});

test('HTTP errors retain status and readable body for existing no-route handling',async()=>{
  globalThis.fetch=async()=>new Response('Failed to get quotes',{status:400,headers:{'retry-after':'2'}});
  const response=await provider.fetchWithTimeout('mock:',{},30);
  assert.equal(response.ok,false);assert.equal(response.status,400);
  assert.equal(await response.text(),'Failed to get quotes');
  assert.equal(response.headers.get('retry-after'),'2');
});

test('a stalled CoinGecko body permits the existing DEX fallback',async()=>{
  const calls=[];
  globalThis.fetch=async url=>{
    calls.push(String(url));
    if(String(url).includes('coingecko')) return new Response(new ReadableStream({start(){}}));
    return Response.json([{chainId:'solana',baseToken:{address:'A'},quoteToken:{address:'So11111111111111111111111111111111111111112'},priceNative:'0.02',liquidity:{usd:1000}}]);
  };
  const prices=await provider.fetchPaperExitSolPrices(['A'],{coingeckoApiKey:'test'});
  assert.equal(prices.get('A').priceSOLPerToken,0.02);
  assert.equal(calls.length,3);
});

test('empty HTTP 204 response remains valid',async()=>{
  globalThis.fetch=async()=>new Response(null,{status:204});
  const response=await provider.fetchWithTimeout('mock:',{},30);
  assert.equal(response.status,204);assert.equal(await response.text(),'');
});
