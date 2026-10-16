const ms=x=>{const n=Date.parse(x);if(!Number.isFinite(n))throw Error('INVALID_TIMESTAMP');return n;};
const raw=x=>{if(typeof x!=='string'||!/^\d+$/.test(x))throw Error('INVALID_RAW');return BigInt(x);};
const money=x=>{if(!Number.isSafeInteger(x))throw Error('INVALID_LAMPORTS');return BigInt(x);};
const sum=(xs,fn)=>xs.reduce((s,x)=>s+fn(x),0n);
export function evaluatePosition(p,observations,exits,asOf,hours,{maxDelayMs=45*60000}={}){
 const at=ms(asOf),admitted=ms(p.admitted_at),deadline=admitted+hours*3600000;
 if(!Number.isFinite(hours)||hours<=0||!Number.isFinite(maxDelayMs)||maxDelayMs<0)throw Error('INVALID_HORIZON');
 const initial=raw(p.initial_raw_amount),cost=money(p.entry_cost_lamports),c=typeof p.config_json==='string'?JSON.parse(p.config_json):p.config_json;
 if(!Number.isSafeInteger(c.sell_slippage_bps)||c.sell_slippage_bps<0||c.sell_slippage_bps>10000)throw Error('INVALID_HAIRCUT');
 const fee=money(c.sell_fee_lamports);
 const es=exits.filter(e=>e.source_signature===p.source_signature&&ms(e.checked_at)<=at).sort((a,b)=>a.position_revision-b.position_revision);
 const totalSold=sum(es,e=>raw(e.sold_raw_amount));if(totalSold>initial)throw Error('BASELINE_OVERSOLD');
 const baselineClosed=totalSold===initial,baselinePnl=baselineClosed?sum(es,e=>money(e.modeled_net_lamports))-cost:null;
 const closedAt=baselineClosed?Math.max(...es.map(e=>ms(e.checked_at))):null;
 const out={sourceSignature:p.source_signature,mint:p.mint,admittedAt:p.admitted_at,horizonHours:hours,baselineClosed,baselinePnlLamports:baselinePnl?.toString()??null,entryCostLamports:cost.toString(),deadline:new Date(deadline).toISOString()};
 const known=(status,pnl,extra={})=>({...out,status,pnlLamports:pnl.toString(),deltaVsClosedBaselineLamports:baselinePnl===null?null:(pnl-baselinePnl).toString(),...extra});
 if(deadline>at)return {...out,status:'NOT_MATURED'};
 if(baselineClosed&&closedAt<=deadline)return known('BASELINE_CLOSED_BEFORE_DEADLINE',baselinePnl);
 const obs=observations.filter(o=>o.source_signature===p.source_signature&&o.request_kind==='REMAINING_MARK'&&ms(o.quote_started_at)>=deadline&&ms(o.checked_at)<=at&&ms(o.checked_at)<=deadline+maxDelayMs).sort((a,b)=>ms(a.checked_at)-ms(b.checked_at)||a.id-b.id)[0];
 if(!obs)return {...out,status:at<deadline+maxDelayMs?'OBSERVATION_WINDOW_PENDING':'NO_OBSERVATION_IN_WINDOW'};
 // Baseline exits before this recorded opportunity are retained, never reopened.
 if(baselineClosed&&closedAt<ms(obs.quote_started_at))return known('BASELINE_CLOSED_BEFORE_OBSERVATION',baselinePnl);
 const timing={quoteAt:obs.checked_at,delayMinutes:(ms(obs.checked_at)-deadline)/60000,observationId:obs.id,reason:obs.reason};
 if(obs.planned_exit_reason==='STALE_POSITION')return {...out,status:'STALE_POSITION_OBSERVATION',...timing};
 if(ms(obs.checked_at)<ms(obs.quote_started_at)||ms(obs.checked_at)-ms(obs.quote_started_at)>30000)return {...out,status:'INVALID_QUOTE_AGE',...timing};
 const prior=es.filter(e=>e.position_revision<obs.position_revision);
 if(prior.some(e=>ms(e.checked_at)>ms(obs.quote_started_at)))return {...out,status:'INCONSISTENT_EXIT_TIMELINE',...timing};
 const remaining=initial-sum(prior,e=>raw(e.sold_raw_amount));
 if(remaining<=0n||remaining!==raw(obs.input_raw_amount)||obs.token_decimals!==p.decimals)return {...out,status:'QUANTITY_MISMATCH',...timing};
 const priorProceeds=sum(prior,e=>money(e.modeled_net_lamports));
 if(obs.executable!==1||!Number.isSafeInteger(obs.out_lamports)||obs.out_lamports<=0)return {...out,status:'QUOTE_UNAVAILABLE',priorProceedsLamports:priorProceeds.toString(),...timing};
 const finalNet=money(obs.out_lamports)*BigInt(10000-c.sell_slippage_bps)/10000n-fee;
 return known('HYPOTHETICAL_FULL_EXIT_AT_OBSERVATION',priorProceeds+finalNet-cost,{priorExitCount:prior.length,remainingRaw:remaining.toString(),priorProceedsLamports:priorProceeds.toString(),finalNetLamports:finalNet.toString(),...timing});
}
export function summarize(rows){
 const counts={};for(const r of rows)counts[r.status]=(counts[r.status]??0)+1;
 const mature=rows.filter(r=>r.status!=='NOT_MATURED'&&r.status!=='OBSERVATION_WINDOW_PENDING'),known=mature.filter(r=>r.pnlLamports!==undefined),paired=known.filter(r=>r.baselinePnlLamports!==null),forced=known.filter(r=>r.status==='HYPOTHETICAL_FULL_EXIT_AT_OBSERVATION');
 const sumField=(xs,key)=>sum(xs,r=>BigInt(r[key])).toString();
 const ds=forced.map(r=>r.delayMinutes).sort((a,b)=>a-b);
 return {positions:rows.length,mature:mature.length,known:known.length,unknown:mature.length-known.length,counts,knownSubsetCostLamports:sumField(known,'entryCostLamports'),knownSubsetPnlLamports:sumField(known,'pnlLamports'),knownPositive:known.filter(r=>BigInt(r.pnlLamports)>0n).length,pairedClosedBaselineCount:paired.length,pairedBaselinePnlLamports:sumField(paired,'baselinePnlLamports'),pairedScenarioPnlLamports:sumField(paired,'pnlLamports'),pairedDeltaLamports:sumField(paired,'deltaVsClosedBaselineLamports'),forcedExitCount:forced.length,forcedDelayMinutes:{min:ds[0]??null,median:ds.length?ds[Math.floor(ds.length/2)]:null,max:ds.at(-1)??null}};
}
export function compareRows(left,right){
 const by=new Map(right.map(r=>[r.sourceSignature,r])),eligible=r=>r.status!=='NOT_MATURED'&&r.status!=='OBSERVATION_WINDOW_PENDING';
 const pairs=left.filter(eligible).map(l=>[l,by.get(l.sourceSignature)]).filter(([,r])=>r&&eligible(r));
 const known=pairs.filter(([l,r])=>l.pnlLamports!==undefined&&r.pnlLamports!==undefined);
 const leftPnl=sum(known,([l])=>BigInt(l.pnlLamports)),rightPnl=sum(known,([,r])=>BigInt(r.pnlLamports));
 return {commonEligible:pairs.length,bothKnown:known.length,unresolvedPairs:pairs.length-known.length,leftKnownRightUnknown:pairs.filter(([l,r])=>l.pnlLamports!==undefined&&r.pnlLamports===undefined).length,leftPnlLamports:leftPnl.toString(),rightPnlLamports:rightPnl.toString(),leftMinusRightLamports:(leftPnl-rightPnl).toString()};
}
export function analyze(dataset,{horizons=[1,6,12,24],maxDelaysMinutes=[10,45],splitAt='2026-10-13T22:02:00.000Z'}={}){
 const scenarios=[];for(const maxDelayMinutes of maxDelaysMinutes)for(const hours of horizons){
 const rows=dataset.positions.filter(p=>ms(p.admitted_at)<=ms(dataset.asOf)).map(p=>evaluatePosition(p,dataset.observations,dataset.exits,dataset.asOf,hours,{maxDelayMs:maxDelayMinutes*60000}));
 scenarios.push({hours,maxDelayMinutes,all:summarize(rows),earlier:summarize(rows.filter(r=>ms(r.admittedAt)<ms(splitAt))),later:summarize(rows.filter(r=>ms(r.admittedAt)>=ms(splitAt))),rows});
 }
 const comparisons=[];for(const maxDelayMinutes of maxDelaysMinutes)for(const hours of horizons.filter(h=>h!==1)){const left=scenarios.find(s=>s.hours===1&&s.maxDelayMinutes===maxDelayMinutes),right=scenarios.find(s=>s.hours===hours&&s.maxDelayMinutes===maxDelayMinutes);if(left)comparisons.push({leftHours:1,rightHours:hours,maxDelayMinutes,all:compareRows(left.rows,right.rows),later:compareRows(left.rows.filter(r=>ms(r.admittedAt)>=ms(splitAt)),right.rows.filter(r=>ms(r.admittedAt)>=ms(splitAt)))});}
 return {asOf:dataset.asOf,splitAt,comparisons,scope:'RETROSPECTIVE_INDEPENDENT_BOOK_OVERLAY_NOT_SHARED_PORTFOLIO_RETURN_NOT_BLIND_HOLDOUT',method:'First post-deadline recorded remaining-quantity observation, preserving prior baseline exits; missing or failed quotes stay unknown',scenarios};
}
