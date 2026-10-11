import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPaperReadinessEvidence as build} from './paper-readiness-analysis.mjs';
const fixture=()=>({
 metrics:{status:'COMPLETE_READ_ONLY',rowsWritten:0,rowsRead:10,finishedAt:'2026-10-11T00:00:00Z',results:{
 account:[{initial_balance_lamports:100,cash_balance_lamports:90,total_deposits_lamports:0,total_withdrawals_lamports:0,realized_pnl_lamports:0,closed_positions_count:0}],
 config:[{buy_fee_lamports:1}],mainPositions:[{entryCost:10,proceeds:0,pnl:0,remainingCost:10}],mainOpen:[{}],
 markPositions:[{status:'RESEARCH_CLOSED',n:1,entryCost:10,allocatedCost:10,modeledPnl:-6,quoteProceeds:5,modeledProceeds:4,winners:0},{status:'RESEARCH_OPEN',n:1,entryCost:20,remainingCost:20,modeledPnl:0}],
 quotePositions:[{status:'RESEARCH_CLOSED',n:1,entryCost:10,allocatedCost:10,modeledPnl:-6,quoteProceeds:5,modeledProceeds:4,winners:0}],
 markClosedDetail:[{entry_cost_lamports:10,modeled_pnl_lamports:-6}],quoteClosedDetail:[{entry_cost_lamports:10,modeled_pnl_lamports:-6}],markRecentAttempts:[{executable:0,n:2}],cron:[]}},
 cadence:{rowsWritten:0,rowsRead:2,markNoHaircut:{net:5,modeled:4,gross:6},quoteNoHaircut:{net:5,modeled:4,gross:6},markRevisit:{p50Seconds:301},quoteRevisit:{p50Seconds:324}},
 entry:{immediateResearchEra:{},immediateLast72h:{}}
});
test('keeps losing cohorts separate, open inventory unresolved and execution disabled',()=>{
 const f=fixture(),x=build(f.metrics,f.cadence,f.entry);
 assert.equal(x.mark.closedModeledReturnPct,-60);
 assert.equal(x.mark.open,1);assert.equal(x.quote.open,0);
 assert.equal(x.evidenceStatus,'NOT_READY_FOR_REAL_MONEY');assert.equal(x.realMoney,false);
 assert.equal(x.main.fullyClosedPositions,0);
});
test('rejects cash mismatch, PnL mismatch and audit writes instead of reporting success',()=>{
 for(const kind of ['cash','pnl','write','closed']){
  const f=fixture();
  if(kind==='cash')f.metrics.results.account[0].cash_balance_lamports=99;
  if(kind==='pnl')f.metrics.results.account[0].realized_pnl_lamports=1;
  if(kind==='write')f.metrics.rowsWritten=1;
  if(kind==='closed')f.metrics.results.markClosedDetail[0].modeled_pnl_lamports=5;
  assert.throws(()=>build(f.metrics,f.cadence,f.entry));
 }
});
test('positive closed result cannot authorize live trading from incomplete evidence',()=>{
 const f=fixture();
 for(const name of ['mark','quote']){
  f.metrics.results[name+'Positions'][0]={status:'RESEARCH_CLOSED',n:1,entryCost:10,allocatedCost:10,modeledPnl:10,quoteProceeds:21,modeledProceeds:20,winners:1};
  f.metrics.results[name+'ClosedDetail'][0].modeled_pnl_lamports=10;
  f.cadence[name+'NoHaircut']={net:21,modeled:20,gross:22};
 }
 const x=build(f.metrics,f.cadence,f.entry);
 assert.equal(x.evidenceStatus,'NOT_READY_FOR_REAL_MONEY');
 assert(x.reasons.includes('SIGNED_LIVE_EXECUTION_NOT_TESTED'));assert.equal(x.realMoney,false);
});
