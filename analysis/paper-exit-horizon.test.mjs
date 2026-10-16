import test from 'node:test';import assert from 'node:assert/strict';import {evaluatePosition,summarize,compareRows} from './paper-exit-horizon.mjs';
const t=h=>new Date(Date.parse('2026-01-01T00:00:00Z')+h*3600000).toISOString();
const p={source_signature:'sig',mint:'mint',admitted_at:t(0),initial_raw_amount:'1000',entry_cost_lamports:100000000,decimals:6,config_json:{sell_slippage_bps:1500,sell_fee_lamports:2000000}};
const obs=(extra={})=>({id:1,source_signature:'sig',request_kind:'REMAINING_MARK',position_revision:0,input_raw_amount:'1000',token_decimals:6,quote_started_at:t(6.1),checked_at:t(6.1),executable:1,reason:'quote_available',out_lamports:120000000,...extra});
const exit=(extra={})=>({source_signature:'sig',position_revision:0,sold_raw_amount:'300',modeled_net_lamports:40000000,checked_at:t(2),...extra});
test('retains prior partial proceeds, applies full-exit haircut/fee and charges whole entry cost once',()=>{
 const r=evaluatePosition(p,[obs({position_revision:1,input_raw_amount:'700',out_lamports:80000000})],[exit()],t(30),6);
 assert.equal(r.pnlLamports,'6000000');assert.equal(r.priorExitCount,1);
});
test('first failed quote remains unknown despite later successful price',()=>{
 const r=evaluatePosition(p,[obs({executable:0,out_lamports:null,reason:'no_route'}),obs({id:2,quote_started_at:t(6.2),checked_at:t(6.2)})],[],t(30),6);
 assert.equal(r.status,'QUOTE_UNAVAILABLE');assert.equal(r.pnlLamports,undefined);
});
test('not matured positions are excluded from resolved and unknown economic results',()=>{
 const r=evaluatePosition(p,[],[],t(4),6);assert.equal(r.status,'NOT_MATURED');assert.equal(summarize([r]).unknown,0);
});
test('baseline already closed is retained instead of reopening a losing trade',()=>{
 const r=evaluatePosition(p,[],[exit({sold_raw_amount:'1000',modeled_net_lamports:60000000})],t(30),6);
 assert.equal(r.pnlLamports,'-40000000');assert.equal(r.deltaVsClosedBaselineLamports,'0');
});
test('pre-deadline started quotes are not reused',()=>{
 const r=evaluatePosition(p,[obs({quote_started_at:t(5.99),checked_at:t(6)})],[],t(30),6);assert.equal(r.status,'NO_OBSERVATION_IN_WINDOW');
});
test('out-of-window and post-as-of observations remain missing',()=>{
 assert.equal(evaluatePosition(p,[obs({quote_started_at:t(7),checked_at:t(7)})],[],t(30),6).status,'NO_OBSERVATION_IN_WINDOW');
 assert.equal(evaluatePosition(p,[obs()],[],t(6.05),6).status,'OBSERVATION_WINDOW_PENDING');
});
test('wrong remaining quantity and wrong decimals do not create a price-scaled quote',()=>{
 assert.equal(evaluatePosition(p,[obs({input_raw_amount:'999'})],[],t(30),6).status,'QUANTITY_MISMATCH');
 assert.equal(evaluatePosition(p,[obs({token_decimals:9})],[],t(30),6).status,'QUANTITY_MISMATCH');
});
test('quote age beyond 30s is rejected',()=>{
 assert.equal(evaluatePosition(p,[obs({checked_at:new Date(Date.parse(t(6.1))+31000).toISOString()})],[],t(30),6).status,'INVALID_QUOTE_AGE');
});
test('same-revision baseline sell using the observed quote is not double counted',()=>{
 const r=evaluatePosition(p,[obs()],[exit({checked_at:t(6.1),sold_raw_amount:'1000',modeled_net_lamports:100000000})],t(30),6);
 assert.equal(r.pnlLamports,'0');assert.equal(r.priorExitCount,0);
});
test('missing observations stay unknown; summaries identify the known subset',()=>{
 const a=evaluatePosition(p,[],[],t(30),6),b=evaluatePosition(p,[obs()],[],t(30),6);
 const s=summarize([a,b]);assert.equal(s.known,1);assert.equal(s.unknown,1);assert.equal(s.knownSubsetCostLamports,'100000000');assert.equal(s.knownSubsetPnlLamports,'0');
});

test('stale-position observations cannot justify a hypothetical exit',()=>{
 assert.equal(evaluatePosition(p,[obs({planned_exit_reason:'STALE_POSITION'})],[],t(30),6).status,'STALE_POSITION_OBSERVATION');
});

test('scenario comparison uses only identical eligible members with both outcomes known',()=>{
 const row=(sourceSignature,pnlLamports)=>({sourceSignature,pnlLamports,status:'HYPOTHETICAL_FULL_EXIT_AT_OBSERVATION'});
 const r=compareRows([row('common','10'),row('left-only','100')],[row('common','8'),row('right-only','200')]);
 assert.equal(r.bothKnown,1);assert.equal(r.leftMinusRightLamports,'2');assert.equal(r.leftPnlLamports,'10');
});
test('scenario comparison reports unknown counterparts instead of treating them as zero',()=>{
 const r=compareRows([{sourceSignature:'x',pnlLamports:'10',status:'HYPOTHETICAL_FULL_EXIT_AT_OBSERVATION'}],[{sourceSignature:'x',status:'QUOTE_UNAVAILABLE'}]);
 assert.equal(r.bothKnown,0);assert.equal(r.unresolvedPairs,1);assert.equal(r.leftKnownRightUnknown,1);assert.equal(r.leftMinusRightLamports,'0');
});
