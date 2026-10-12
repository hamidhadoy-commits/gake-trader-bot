// Offline Paper analysis. Historical quote availability never means an executed trade.
export function analyzeSellability(snapshot) {
 if(snapshot?.rowsWritten!==0||snapshot.execution!=='DISABLED'||snapshot.realMoney!==false)throw Error('READ_ONLY_PAPER_SNAPSHOT_REQUIRED');
 const cutoff=Date.parse(snapshot.cutoff);if(!Number.isFinite(cutoff))throw Error('INVALID_CUTOFF');
 const result={at:snapshot.at,cutoff:snapshot.cutoff,scope:'INDEPENDENT_RESEARCH_NOT_SHARED_PORTFOLIO',groups:{},profitabilityEstablished:false};
 for(const [label,g] of Object.entries(snapshot.groups)){
  const positions=new Map();for(const p of g.positions){
   if(positions.has(p.source_signature)||!Number.isFinite(Date.parse(p.admitted_at)))throw Error('INVALID_POSITION');
   for(const k of ['entry_cost_lamports','allocated_cost_lamports','modeled_pnl_lamports'])if(!Number.isSafeInteger(p[k]))throw Error('INVALID_ACCOUNTING');
   if(p.allocated_cost_lamports<0||p.allocated_cost_lamports>p.entry_cost_lamports)throw Error('INVALID_ACCOUNTING');
   positions.set(p.source_signature,p);
  }
  const byPosition=new Map();const ids=new Set();
  for(const a of g.attempts){
   if(ids.has(a.id)||!positions.has(a.source_signature)||![0,1].includes(a.executable))throw Error('INVALID_ATTEMPT');
   ids.add(a.id);const list=byPosition.get(a.source_signature)||[];list.push(a);byPosition.set(a.source_signature,list);
  }
  const cohorts={};
  for(const [name,newer] of [['older',false],['newer',true]]){
   const ps=[...positions.values()].filter(p=>(Date.parse(p.admitted_at)>=cutoff)===newer);
   const attempts=ps.flatMap(p=>byPosition.get(p.source_signature)||[]);
   const open=ps.filter(p=>p.status==='RESEARCH_OPEN'),closed=ps.filter(p=>p.status==='RESEARCH_CLOSED');
   const latest=ps.map(p=>{const a=(byPosition.get(p.source_signature)||[]).slice().sort((a,b)=>b.id-a.id)[0];return {sourceSignature:p.source_signature,mint:p.mint,status:p.status,admittedAt:p.admitted_at,lastAttempt:a?{checkedAt:a.checked_at,reason:a.reason,executable:a.executable,rawAmount:a.input_raw_amount,matchesRemainingAmount:a.input_raw_amount===p.remaining_raw_amount}:null};});
   const sum=(rows,k)=>rows.reduce((v,p)=>v+BigInt(p[k]),0n).toString();
   cohorts[name]={positions:ps.length,open:open.length,closed:closed.length,positionsWithAttempt:latest.filter(x=>x.lastAttempt).length,
    positionsWithAnyAvailableQuote:ps.filter(p=>(byPosition.get(p.source_signature)||[]).some(a=>a.executable===1)).length,
    positionsWithLatestUnavailableQuote:latest.filter(p=>p.lastAttempt?.executable===0).length,
    attempts:attempts.length,noRouteAttempts:attempts.filter(a=>a.reason==='no_route').length,positionsWithNoRoute:ps.filter(p=>(byPosition.get(p.source_signature)||[]).some(a=>a.reason==='no_route')).length,availableQuoteAttempts:attempts.filter(a=>a.executable===1).length,
    reasons:Object.fromEntries([...new Set(attempts.map(a=>a.reason))].map(reason=>[reason,attempts.filter(a=>a.reason===reason).length])),
    openAllocatedPnlLamports:sum(open,'modeled_pnl_lamports'),closedPnlLamports:sum(closed,'modeled_pnl_lamports'),
    remainingOpenCostLamports:open.reduce((v,p)=>v+BigInt(p.entry_cost_lamports)-BigInt(p.allocated_cost_lamports),0n).toString(),
    breakEvenRemainingNetLamports:(open.reduce((v,p)=>v+BigInt(p.entry_cost_lamports)-BigInt(p.allocated_cost_lamports)-BigInt(p.modeled_pnl_lamports),0n)).toString(),
    openLiquidationValue:null,totalCohortPnl:null,latest};
  }
  result.groups[label]={attemptSampleLimit:g.attemptSampleLimit,sampleCapped:g.attempts.length>=g.attemptSampleLimit,...cohorts};
 }
 return result;
}
