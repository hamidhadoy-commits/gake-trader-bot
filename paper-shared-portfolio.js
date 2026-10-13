import {captureResearchConfig,chooseResearchExit} from './paper-research.js';
import {decodeHostReferenceFeed} from './price-provider.js';
export const SHARED_PAPER_RUN='PAPER_CASH_20USD_20261014_V2';
const WSOL='So11111111111111111111111111111111111111112';
const rawOk=x=>typeof x==='string'&&/^[1-9]\d*$/.test(x)&&BigInt(x)<=18446744073709551615n;
const q=(env,sql,args=[],mode='all')=>env.DB.prepare(sql).bind(...args)[mode]();
const rows=async(env,sql,args=[]) => (await q(env,sql,args)).results||[];
const changes=x=>Number(x?.meta?.changes??0);
const safeReason=x=>typeof x==='string'&&/^[a-zA-Z0-9_:-]{1,80}$/.test(x)?x:'quote_unavailable';
export function validateSharedConfig(c){
 captureResearchConfig(c);
 for(const k of ['buy_slippage_bps','equity_trade_bps','profit_reinvest_bps','max_total_exposure_bps'])
  if(!Number.isSafeInteger(c[k])||c[k]<0||c[k]>10000)throw Error('INVALID_SHARED_CONFIG');
 if(c.sizing_mode!=='PERCENT_EQUITY'||!Number.isSafeInteger(c.max_open_positions)||c.max_open_positions<1||c.max_open_positions>3||!(c.min_trade_usd>0)||c.max_trade_usd<c.min_trade_usd)throw Error('INVALID_SHARED_CONFIG');
 return c;
}
export function sharedSizing(a,c,ps,solUsd){
 validateSharedConfig(c);
 if(!Number.isFinite(solUsd)||solUsd<=0)return {ok:false,reason:'sol_usd_unavailable'};
 const pnl=BigInt(a.realized_pnl_lamports),base=BigInt(a.initial_lamports);
 const equity=base+(pnl>=0n?pnl*BigInt(c.profit_reinvest_bps)/10000n:pnl);
 const exp=ps.reduce((s,p)=>s+BigInt(p.input_lamports)*BigInt(p.remaining_raw_amount)/BigInt(p.initial_raw_amount),0n);
 const cap=equity*BigInt(c.max_total_exposure_bps)/10000n;
 if(ps.length>=c.max_open_positions)return {ok:false,reason:'max_open_positions_reached'};
 const min=Math.floor(c.min_trade_usd/solUsd*1e9),max=Math.floor(c.max_trade_usd/solUsd*1e9);
 if(!Number.isSafeInteger(min)||min<1||!Number.isSafeInteger(max)||max<min)return {ok:false,reason:'invalid_trade_limits'};
 const target=Math.max(min,Math.min(max,Number(equity*BigInt(c.equity_trade_bps)/10000n)));
 const notional=Math.floor(Math.min(target,Math.max(0,Number(cap-exp)),Math.max(0,a.cash_lamports-c.buy_fee_lamports)));
 return notional>=min?{ok:true,notional,exposure:exp.toString(),cap:cap.toString()}:{ok:false,reason:'below_min_trade_after_risk_limits'};
}
export async function recordSharedBuy(env,a,e,c,sizing,quote,at){
 if(quote?.executable!==true||quote.inputLamports!==sizing.notional||!rawOk(quote.outRawAmount)||!Number.isInteger(quote.decimals)||quote.decimals<0||quote.decimals>18)return false;
 const acquired=(BigInt(quote.outRawAmount)*10000n/BigInt(10000+c.buy_slippage_bps)).toString();
 if(!rawOk(acquired))return false;
 const cost=sizing.notional+c.buy_fee_lamports,entry=sizing.notional/1e9/(Number(acquired)/10**quote.decimals),op=a.id+':DECISION:'+e.source_signature;
 if(!Number.isSafeInteger(cost)||!Number.isFinite(entry)||entry<=0)return false;
 
 const r=await env.DB.batch([
 env.DB.prepare(`INSERT OR IGNORE INTO paper_shared_ledger(operation_id,run_id,source_signature,event_type,account_revision,cash_delta_lamports,fee_lamports,raw_amount,quote_out_lamports,reason,checked_at)
 SELECT ?,?,?,'BUY',?, ?,?,?,?,'exact_buy_quote_modeled_haircut',?
 WHERE EXISTS(SELECT 1 FROM paper_shared_accounts WHERE id=? AND revision=? AND status='ACTIVE' AND cash_lamports>=? AND starts_at<=? AND entries_until>?)
 AND (SELECT COUNT(*) FROM paper_shared_positions WHERE run_id=? AND status='PAPER_OPEN')<?
 AND NOT EXISTS(SELECT 1 FROM paper_shared_positions WHERE run_id=? AND source_signature=?)`).bind(op,a.id,e.source_signature,a.revision,-cost,c.buy_fee_lamports,acquired,sizing.notional,at,a.id,a.revision,cost,at,at,a.id,c.max_open_positions,a.id,e.source_signature),
 env.DB.prepare(`INSERT OR IGNORE INTO paper_shared_positions(run_id,source_signature,mint,detector,confidence,initial_raw_amount,remaining_raw_amount,decimals,input_lamports,entry_cost_lamports,entry_price_sol,highest_price_sol,status,opened_at,config_json)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'PAPER_OPEN',?,?
 WHERE EXISTS(SELECT 1 FROM paper_shared_ledger WHERE operation_id=? AND account_revision=? AND event_type='BUY')
 AND EXISTS(SELECT 1 FROM paper_shared_accounts WHERE id=? AND revision=?)`).bind(a.id,e.source_signature,e.mint,e.detector,e.confidence,acquired,acquired,quote.decimals,sizing.notional,cost,entry,entry,at,JSON.stringify(c),op,a.revision,a.id,a.revision),
 env.DB.prepare(`UPDATE paper_shared_accounts SET cash_lamports=cash_lamports-?,fees_lamports=fees_lamports+?,revision=revision+1
 WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM paper_shared_ledger WHERE operation_id=? AND account_revision=?)`).bind(cost,c.buy_fee_lamports,a.id,a.revision,op,a.revision)
 ]);
 const n=r.map(changes);if(!n.every(x=>x===n[0]))throw Error('SHARED_BUY_INVARIANT');return n[0]===1;
}
export async function recordSharedSell(env,a,p,c,intent,quote,at){
 if(quote?.executable!==true||quote.rawAmount!==intent.raw||quote.decimals!==p.decimals||!Number.isSafeInteger(quote.outAmountLamports)||quote.outAmountLamports<=0)return false;
 const sold=BigInt(intent.raw),remaining=BigInt(p.remaining_raw_amount)-sold;
 if(sold<=0n||remaining<0n)throw Error('INVALID_SHARED_SELL_AMOUNT');
 const net=Number(BigInt(quote.outAmountLamports)*BigInt(10000-c.sell_slippage_bps)/10000n)-c.sell_fee_lamports;
 const unallocated=p.entry_cost_lamports-p.allocated_cost_lamports;
 const allocated=remaining===0n?unallocated:Math.min(unallocated,Number(BigInt(p.entry_cost_lamports)*sold/BigInt(p.initial_raw_amount)));
 const pnl=net-allocated,op=a.id+':SELL:'+p.source_signature+':'+p.revision+':'+intent.reason;
 if(![net,allocated,pnl].every(Number.isSafeInteger)||allocated<0)throw Error('INVALID_SHARED_ACCOUNTING');
 if(a.cash_lamports+net<0)return false;
 const r=await env.DB.batch([
 env.DB.prepare(`INSERT OR IGNORE INTO paper_shared_ledger(operation_id,run_id,source_signature,event_type,account_revision,position_revision,cash_delta_lamports,pnl_delta_lamports,fee_lamports,allocated_cost_lamports,raw_amount,quote_out_lamports,reason,checked_at)
 SELECT ?,?,?,'SELL',?,?,?,?,?,?,?,?,?,?
 WHERE EXISTS(SELECT 1 FROM paper_shared_accounts WHERE id=? AND revision=? AND status='ACTIVE' AND cash_lamports+?>=0)
 AND EXISTS(SELECT 1 FROM paper_shared_positions WHERE run_id=? AND source_signature=? AND revision=? AND remaining_raw_amount=? AND status='PAPER_OPEN')`).bind(op,a.id,p.source_signature,a.revision,p.revision,net,pnl,c.sell_fee_lamports,allocated,intent.raw,quote.outAmountLamports,intent.reason,at,a.id,a.revision,net,a.id,p.source_signature,p.revision,p.remaining_raw_amount),
 env.DB.prepare(`UPDATE paper_shared_positions SET remaining_raw_amount=?,revision=revision+1,status=?,allocated_cost_lamports=allocated_cost_lamports+?,modeled_proceeds_lamports=modeled_proceeds_lamports+?,modeled_pnl_lamports=modeled_pnl_lamports+?,
 take_profit_hit=CASE WHEN ?='TAKE_PROFIT_PARTIAL' THEN 1 ELSE take_profit_hit END,closed_at=?,close_reason=?,last_quote_out=NULL,last_quote_raw=NULL
 WHERE run_id=? AND source_signature=? AND revision=? AND remaining_raw_amount=?
 AND EXISTS(SELECT 1 FROM paper_shared_ledger WHERE operation_id=? AND account_revision=?)
 AND EXISTS(SELECT 1 FROM paper_shared_accounts WHERE id=? AND revision=?)`).bind(remaining.toString(),remaining===0n?'PAPER_CLOSED':'PAPER_OPEN',allocated,net,pnl,intent.reason,remaining===0n?at:null,remaining===0n?intent.reason:null,a.id,p.source_signature,p.revision,p.remaining_raw_amount,op,a.revision,a.id,a.revision),
 env.DB.prepare(`UPDATE paper_shared_accounts SET cash_lamports=cash_lamports+?,realized_pnl_lamports=realized_pnl_lamports+?,fees_lamports=fees_lamports+?,revision=revision+1
 WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM paper_shared_ledger WHERE operation_id=? AND account_revision=?)`).bind(net,pnl,c.sell_fee_lamports,a.id,a.revision,op,a.revision)
 ]);
 const n=r.map(changes);if(!n.every(x=>x===n[0]))throw Error('SHARED_SELL_INVARIANT');return n[0]===1;
}
async function recordSkip(env,a,e,reason,at){
 await q(env,`INSERT OR IGNORE INTO paper_shared_ledger(operation_id,run_id,source_signature,event_type,account_revision,cash_delta_lamports,reason,checked_at) VALUES(?,?,?,'SKIP',?,0,?,?)`,
 [a.id+':DECISION:'+e.source_signature,a.id,e.source_signature,a.revision,safeReason(reason),at],'run');
}
export async function runSharedPaperCycle(env,{getConfig,buyQuote,sellQuote,now=()=>Date.now(),maxQuoteUnits=4,scheduledTime=Date.now()}={}){
 let a=await q(env,'SELECT * FROM paper_shared_accounts WHERE id=?',[SHARED_PAPER_RUN],'first');
 if(!a||a.status!=='ACTIVE'||Date.parse(a.starts_at)>now())return {active:false,quoteUnitsUsed:0};
 if(Number((await getConfig(env))?.enabled)!==1)return {active:false,quoteUnitsUsed:0,paused:true};
 const accountConfig=validateSharedConfig(JSON.parse(a.config_json));
 let used=0,buys=0,sells=0,unavailable=0;
 const limit=Math.max(0,Math.min(4,Math.floor(maxQuoteUnits)));
 const ps=await rows(env,`SELECT * FROM paper_shared_positions WHERE run_id=? AND status='PAPER_OPEN'
 ORDER BY COALESCE(last_checked_at,opened_at),opened_at,source_signature LIMIT 3`,[a.id]);
 for(let p of ps){
  if(used>=limit)break;const c=validateSharedConfig(JSON.parse(p.config_json));
  const requestAt=now();used++;let quote;
  try{quote=await sellQuote({mint:p.mint,rawTokenAmount:p.remaining_raw_amount,tokenDecimals:p.decimals,wrappedSolMint:WSOL,jupiterApiKey:env.JUPITER_API_KEY||null});}catch{quote={executable:false,reason:'quote_provider_exception'};}
  const at=new Date(now()).toISOString();
  const valid=quote?.executable===true&&quote.rawAmount===p.remaining_raw_amount&&quote.decimals===p.decimals&&Number.isSafeInteger(quote.outAmountLamports)&&quote.outAmountLamports>0&&now()>=requestAt&&now()-requestAt<=30000;
  const mark=valid?quote.outAmountLamports/1e9/(Number(p.remaining_raw_amount)/10**p.decimals):null;
  const reason=valid?'quote_available':quote?.executable===true?'invalid_or_stale_exact_quote':safeReason(quote?.reason);
  await q(env,`UPDATE paper_shared_positions SET last_checked_at=?,last_quote_at=?,last_quote_raw=?,last_quote_out=?,last_quote_reason=?,highest_price_sol=MAX(highest_price_sol,?)
 WHERE run_id=? AND source_signature=? AND revision=? AND remaining_raw_amount=?`,
 [at,at,p.remaining_raw_amount,valid?quote.outAmountLamports:null,reason,mark||p.highest_price_sol,a.id,p.source_signature,p.revision,p.remaining_raw_amount],'run');
  await q(env,`INSERT OR IGNORE INTO paper_shared_ledger(operation_id,run_id,source_signature,event_type,account_revision,position_revision,cash_delta_lamports,raw_amount,quote_out_lamports,reason,checked_at)
 VALUES(?,?,?,'MARK',?,?,0,?,?,?,?)`,
 [a.id+':MARK:'+scheduledTime+':'+p.source_signature,a.id,p.source_signature,a.revision,p.revision,p.remaining_raw_amount,valid?quote.outAmountLamports:null,reason,at],'run');
  if(!valid){unavailable++;continue;}
  const intent=chooseResearchExit({...p,status:'RESEARCH_OPEN'},c,mark);if(!intent)continue;
  if(intent.raw!==p.remaining_raw_amount){
   if(used>=limit)continue;used++;const sliceStarted=now();
   try{quote=await sellQuote({mint:p.mint,rawTokenAmount:intent.raw,tokenDecimals:p.decimals,wrappedSolMint:WSOL,jupiterApiKey:env.JUPITER_API_KEY||null});}catch{quote={executable:false,reason:'quote_provider_exception'};}
   if(now()<sliceStarted||now()-sliceStarted>30000){unavailable++;continue;}
  }
  a=await q(env,'SELECT * FROM paper_shared_accounts WHERE id=?',[a.id],'first');
  if(await recordSharedSell(env,a,p,c,intent,quote,new Date(now()).toISOString()))sells++;else unavailable++;
 }
 // Admission consumes two quote units: token-decimal lookup plus the exact buy order.
 if(used+2<=limit&&now()<Date.parse(a.entries_until)){
  if(sells)a=await q(env,'SELECT * FROM paper_shared_accounts WHERE id=?',[a.id],'first');
  const candidates=await rows(env,`SELECT e.*,p.detector,p.confidence FROM paper_immediate_entry_checks e
 JOIN paper_positions p ON p.signature=e.source_signature
 WHERE e.checked_at>=? AND e.checked_at>=? AND e.checked_at<=?
 AND NOT EXISTS(SELECT 1 FROM paper_shared_ledger l WHERE l.operation_id=?||':DECISION:'||e.source_signature)
 ORDER BY e.checked_at,e.source_signature LIMIT 1`,
 [a.starts_at,new Date(now()-120000).toISOString(),new Date(now()).toISOString(),a.id]);
  const e=candidates[0];
  if(e){
   const open=await rows(env,"SELECT * FROM paper_shared_positions WHERE run_id=? AND status='PAPER_OPEN'",[a.id]);
   const feed=await q(env,'SELECT observed_at,payload_json FROM paper_reference_price_feed WHERE id=1',[],'first');
   const solUsd=decodeHostReferenceFeed(feed,[WSOL],WSOL,now()).get(WSOL)?.solUsdPrice;
   const sizing=sharedSizing(a,accountConfig,open,solUsd),at=new Date(now()).toISOString();
   if(!sizing.ok)await recordSkip(env,a,e,sizing.reason,at);
   else{
    used+=2;const started=now();let quote;
    try{quote=await buyQuote({mint:e.mint,inputLamports:sizing.notional,wrappedSolMint:WSOL,jupiterApiKey:env.JUPITER_API_KEY||null});}catch{quote={executable:false,reason:'quote_provider_exception'};}
    const fresh=now()>=started&&now()-started<=30000;
    if(fresh&&await recordSharedBuy(env,a,e,accountConfig,sizing,quote,new Date(now()).toISOString()))buys++;
    else{unavailable++;await recordSkip(env,a,e,fresh?(quote?.executable===true?'invalid_exact_buy_result':safeReason(quote?.reason)):'stale_buy_quote',new Date(now()).toISOString());}
   }
  }
 }
 const result={active:true,runId:a.id,quoteUnitsUsed:used,buys,sells,unavailable,execution:'DISABLED',realMoney:false};
 console.log({message:'SHARED PAPER CYCLE COMPLETE',scheduledTime,...result});return result;
}
