import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePriceResponseMetadata,fetchPaperExitSolPrices} from './price-provider.js';

test('response metadata only captures allowlisted headers and distinguishes transport age',()=>{
  const response={status:200,headers:new Headers({
    age:'17',date:'Sun, 04 Oct 2026 18:00:00 GMT',
    'cache-control':'public, max-age=30','cf-cache-status':'HIT',
    authorization:'private','set-cookie':'private','x-cg-demo-api-key':'private',
  })};
  const m=capturePriceResponseMetadata(response,1000,1200);
  assert.deepEqual(m,{
    requestStartedAt:'1970-01-01T00:00:01.000Z',responseReceivedAt:'1970-01-01T00:00:01.200Z',
    httpStatus:200,responseAgeSeconds:17,httpDate:'2026-10-04T18:00:00.000Z',
    cacheControl:'public, max-age=30',cacheStatus:'HIT',
  });
  assert.ok(!JSON.stringify(m).includes('private'));
});
test('missing or malformed metadata remains unknown instead of fresh',()=>{
  for(const age of ['','-1','2.5','NaN','999999999999999999999']){
    const m=capturePriceResponseMetadata({status:200,headers:new Headers({age,date:'invalid'})},NaN,-1);
    assert.equal(m.responseAgeSeconds,null);assert.equal(m.httpDate,null);
    assert.equal(m.requestStartedAt,null);assert.equal(m.responseReceivedAt,null);
  }
  const m=capturePriceResponseMetadata({status:200},1000,1200);
  assert.equal(m.responseAgeSeconds,null);assert.equal(m.cacheStatus,null);
  assert.equal(capturePriceResponseMetadata({headers:new Headers({'age':'0'})},0,0).responseAgeSeconds,0);
});
test('text metadata is bounded',()=>{
  const m=capturePriceResponseMetadata({headers:new Headers({'cache-control':'x'.repeat(1000)})},0,0);
  assert.equal(m.cacheControl.length,256);
});
test('CoinGecko price preserves metadata without adding fallback or changing price',async()=>{
  const original=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push({url:String(url),method:options.method});
    return new Response(JSON.stringify({data:{attributes:{token_prices:{token:'2',sol:'100'}}}}),
      {status:200,headers:{age:'12',date:'Sun, 04 Oct 2026 18:00:00 GMT','cf-cache-status':'HIT'}});
  };
  try{
    const prices=await fetchPaperExitSolPrices(['token'],{wrappedSolMint:'sol',coingeckoApiKey:'test',jupiterApiKey:'test'});
    assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
    const info=prices.get('token');
    assert.equal(info.priceSOLPerToken,0.02);assert.equal(info.source,'COINGECKO_MARK_USD_RATIO');
    assert.equal(info.responseMetadata.responseAgeSeconds,12);
    assert.equal(info.responseMetadata.cacheStatus,'HIT');
    assert.ok(info.responseMetadata.requestStartedAt<=info.responseMetadata.responseReceivedAt);
  }finally{globalThis.fetch=original;}
});
