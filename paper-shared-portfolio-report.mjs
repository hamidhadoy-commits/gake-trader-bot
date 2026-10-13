export function buildSharedPaperReport(snapshot,{maxQuoteAgeMs=90000}={}) {
 if(snapshot.rowsWritten!==0||snapshot.execution!=='DISABLED'||snapshot.realMoney!==false)throw Error('READ_ONLY_PAPER_REQUIRED');
 const a=snapshot.account,now=Date.parse(snapshot.at);
 if(!a||!Number.isFinite(now))throw Error('INVALID_SHARED_SNAPSHOT');
 let cash=0n,pnl=0n,fees=0n,peak=BigInt(a.initial_lamports),maxDrawdownBps=0,unknownEvents=0;
 const held=new Map(),marks=new Map();
 const sequence={INITIAL:0,BUY:1,MARK:2,SELL:3,SKIP:4};
 const ledger=snapshot.ledger.slice().sort((x,y)=>Date.parse(x.checked_at)-Date.parse(y.checked_at)||x.account_revision-y.account_revision||sequence[x.event_type]-sequence[y.event_type]||x.operation_id.localeCompare(y.operation_id));
 const positions=new Map(snapshot.positions.map(p=>[p.source_signature,p]));
 function equity(at){let value=cash;for(const [sig,raw] of held){const m=marks.get(sig),p=positions.get(sig);
  if(!m||m.raw!==raw||m.out===null||at-m.at<0||at-m.at>maxQuoteAgeMs)return null;
  const c=JSON.parse(p.config_json);value+=BigInt(m.out)*BigInt(10000-c.sell_slippage_bps)/10000n-BigInt(c.sell_fee_lamports);
 }return value;}
 for(const e of ledger){
  if(!Number.isSafeInteger(e.cash_delta_lamports)||!Number.isSafeInteger(e.pnl_delta_lamports)||!Number.isSafeInteger(e.fee_lamports))throw Error('INVALID_LEDGER');
  cash+=BigInt(e.cash_delta_lamports);pnl+=BigInt(e.pnl_delta_lamports);fees+=BigInt(e.fee_lamports);
  if(cash<0n)throw Error('NEGATIVE_SHARED_CASH');
  if(e.event_type==='BUY'){if(held.has(e.source_signature)||!positions.has(e.source_signature))throw Error('DUPLICATE_SHARED_BUY');held.set(e.source_signature,e.raw_amount);}
  if(e.event_type==='SELL'){const raw=held.get(e.source_signature);if(!raw)throw Error('SELL_WITHOUT_POSITION');const remain=BigInt(raw)-BigInt(e.raw_amount);if(remain<0n)throw Error('OVERSOLD_POSITION');if(remain===0n)held.delete(e.source_signature);else held.set(e.source_signature,remain.toString());marks.delete(e.source_signature);}
  if(e.event_type==='MARK'&&held.has(e.source_signature))marks.set(e.source_signature,{raw:e.raw_amount,out:e.quote_out_lamports,at:Date.parse(e.checked_at)});
  const value=equity(Date.parse(e.checked_at));if(value===null){unknownEvents++;continue;}
  if(value>peak)peak=value;
  if(peak>0n)maxDrawdownBps=Math.max(maxDrawdownBps,Number((peak-value)*10000n/peak));
 }
 if(cash!==BigInt(a.cash_lamports)||pnl!==BigInt(a.realized_pnl_lamports)||fees!==BigInt(a.fees_lamports))throw Error('SHARED_ACCOUNT_RECONCILIATION_FAILED');
 for(const p of snapshot.positions){const expected=p.status==='PAPER_OPEN'?p.remaining_raw_amount:undefined;if(held.get(p.source_signature)!==expected)throw Error('SHARED_QUANTITY_RECONCILIATION_FAILED');}
 const eq=equity(now),solUsd=snapshot.solUsd;
 return {at:snapshot.at,runId:a.id,status:a.status,startsAt:a.starts_at,entriesUntil:a.entries_until,initialUSD:a.initial_usd,initialSOL:a.initial_lamports/1e9,
 cashSOL:Number(cash)/1e9,realizedModeledPnlSOL:Number(pnl)/1e9,feesSOL:Number(fees)/1e9,
 openPositions:held.size,closedPositions:snapshot.positions.filter(p=>p.status==='PAPER_CLOSED').length,
 quoteEstimatedEquitySOL:eq===null?null:Number(eq)/1e9,
 quoteEstimatedTotalPnlSOL:eq===null?null:Number(eq-BigInt(a.initial_lamports))/1e9,
 equityUSD:eq===null||!(solUsd>0)?null:Number(eq)/1e9*solUsd,
 observedPeakEquitySOL:Number(peak)/1e9,observedMaxDrawdownBps:maxDrawdownBps,unknownValuationEvents:unknownEvents,
 drawdownScope:'OBSERVED_EXACT_QUOTE_SNAPSHOTS_NOT_GUARANTEED_MAXIMUM',reconciled:true,profitabilityEstablished:false,
 execution:'DISABLED',realMoney:false};
}
