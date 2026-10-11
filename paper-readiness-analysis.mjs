import assert from 'node:assert/strict';
const sum=(rows,key)=>rows.reduce((n,r)=>n+Number(r[key]??0),0);
const pct=(n,d)=>d>0?100*n/d:null;
export function buildPaperReadinessEvidence(metrics,cadence,entrySummary){
 assert.equal(metrics.status,'COMPLETE_READ_ONLY','Incomplete audit');
 assert.equal(metrics.rowsWritten,0,'Audit mutated database');
 assert.equal(cadence.rowsWritten,0,'Cadence audit mutated database');
 const r=metrics.results,account=r.account[0];
 const expectedCash=account.initial_balance_lamports+account.total_deposits_lamports-account.total_withdrawals_lamports-sum(r.mainPositions,'entryCost')+sum(r.mainPositions,'proceeds');
 assert.equal(account.cash_balance_lamports,expectedCash,'Main cash does not reconcile');
 assert.equal(account.realized_pnl_lamports,sum(r.mainPositions,'pnl'),'Main PnL does not reconcile');
 function cohort(rows,detail,exits,capturedConfigs){
  const closed=rows.filter(p=>p.status==='RESEARCH_CLOSED'),open=rows.filter(p=>p.status==='RESEARCH_OPEN');
  const cost=sum(closed,'entryCost'),pnl=sum(closed,'modeledPnl');
  assert.equal(sum(closed,'n'),detail.length,'Closed population mismatch');
  assert.equal(pnl,sum(detail,'modeled_pnl_lamports'),'Closed PnL mismatch');
  assert.equal(sum(closed,'allocatedCost'),cost,'Closed cost incompletely allocated');
  assert.equal(sum(closed,'quoteProceeds'),exits.net,'Quoted proceeds mismatch');
  assert.equal(sum(closed,'modeledProceeds'),exits.modeled,'Modeled proceeds mismatch');
  const feeValues=[...new Set((capturedConfigs??[]).map(x=>JSON.parse(x.config_json).buy_fee_lamports))];
  const knownFee=feeValues.length===1&&Number.isSafeInteger(feeValues[0])&&feeValues[0]>=0;
  const input=knownFee?cost-detail.length*feeValues[0]:null;
  return {closed:detail.length,open:sum(open,'n'),closedWinners:sum(closed,'winners'),
   closedCostSOL:cost/1e9,closedModeledPnlSOL:pnl/1e9,closedModeledReturnPct:pct(pnl,cost),
   quoteNetNoHaircutReturnPct:pct(exits.net-cost,cost),
   zeroFeesNoHaircutQuotedReturnPct:input===null?null:pct(exits.gross-input,input),
   openRemainingCostSOL:sum(open,'remainingCost')/1e9,
   openAllocatedModeledPnlSOL:sum(open,'modeledPnl')/1e9,
   scope:'Independent research cohort; not a shared-cash portfolio; open marks not included in closed return'};
 }
 const mark=cohort(r.markPositions,r.markClosedDetail,cadence.markNoHaircut,r.markConfig);
 const quote=cohort(r.quotePositions,r.quoteClosedDetail,cadence.quoteNoHaircut,r.quoteConfig);
 const reasons=[];
 if(mark.closedModeledPnlSOL<0||quote.closedModeledPnlSOL<0)reasons.push('NEGATIVE_CLOSED_RESEARCH_RESULTS');
 if(cadence.markRevisit.p50Seconds>90||cadence.quoteRevisit.p50Seconds>90)reasons.push('POSITION_REVISIT_SLOWER_THAN_FEED_FRESHNESS_WINDOW');
 if(r.mainOpen.length)reasons.push('MAIN_OPEN_POSITIONS_HAVE_NO_VERIFIED_CURRENT_LIQUIDATION_VALUE');
 reasons.push('SIGNED_LIVE_EXECUTION_NOT_TESTED','CURRENT_NETLIFY_BILLED_USAGE_NOT_VERIFIED','RECOVERY_REMAINS_LAPTOP_DEPENDENT');
 return {at:metrics.finishedAt,execution:'DISABLED',realMoney:false,
  evidenceStatus:'NOT_READY_FOR_REAL_MONEY',reasons,
  main:{cashSOL:account.cash_balance_lamports/1e9,partialRealizedPaperPnlSOL:account.realized_pnl_lamports/1e9,fullyClosedPositions:account.closed_positions_count,openPositions:r.mainOpen.length,remainingCostSOL:sum(r.mainPositions,'remainingCost')/1e9,cashReconciled:true},
  mark,quote,entry:entrySummary.immediateResearchEra,entryLast72h:entrySummary.immediateLast72h,
  cadence:{markRevisit:cadence.markRevisit,quoteRevisit:cadence.quoteRevisit,detectionToAdmissionMs:cadence.detectionToAdmissionMs,entryQuoteToAdmissionMs:cadence.entryQuoteToAdmissionMs},
  recentExitQuotes:{sampleSize:sum(r.markRecentAttempts,'n'),unavailable:sum(r.markRecentAttempts.filter(x=>!x.executable),'n'),note:'Repeated attempts, not independent trades'},
  cron:r.cron,rowsRead:metrics.rowsRead+cadence.rowsRead,riskHash:metrics.riskHash,
  limitations:['Closed-only results exclude open unrealized PnL; cohorts must not be summed as one portfolio.','Quotes and modeled proceeds are not signed, landed fills.','Finite historical samples do not establish future profitability.','Detection-to-quote time excludes upstream latency before detected_at.','Fresh central feed does not imply frequent per-position exit evaluation.']};
}
