import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Diagnostic replay only: price is a full-size SELL quote proxy, not the live mark feed.
// Never invent partial/remainder fills or realized PnL from a full-position quote.
const source=readFileSync(new URL('./worker.js',import.meta.url),'utf8');
const thresholds=source.slice(source.indexOf('function buildPaperExitThresholds('),
  source.indexOf('async function getPaperExitAccountingState('));
const decisions=source.slice(source.indexOf('async function processPaperExitPosition('),
  source.indexOf('async function getPendingPaperEntryRouteCheck('));
const data=JSON.parse(readFileSync(process.argv[2],'utf8'));
const rows=data[0]?.results || data.rows || data;
const bySignature=new Map();
for(const row of rows) {
  if(!bySignature.has(row.source_signature)) bySignature.set(row.source_signature,{entry:row,exits:[]});
  if(row.age_bucket && row.executable===1) bySignature.get(row.source_signature).exits.push(row);
}
const config={
  stop_loss_bps:1500,take_profit_enabled:1,take_profit_bps:4000,
  take_profit_sell_bps:3000,trailing_stop_enabled:1,trailing_stop_bps:2000,
  sell_slippage_bps:1500,sell_fee_lamports:2000000,
};
const results=[];
for(const [signature,{entry,exits}] of bySignature) {
  if(entry.entry_at<'2026-10-04T15:02:00' || entry.entry_at>'2026-10-04T15:45:00') continue;
  if(new Set(exits.map(x=>x.age_bucket)).size!==4) continue;
  const tokens=Number(entry.buy_out_raw_amount)/10**entry.buy_token_decimals;
  const entryPrice=entry.target_copy_lamports/1e9/tokens;
  const position={source_signature:signature,mint:entry.mint,status:'PAPER_OPEN',
    simulated_entry_price_sol_per_token:entryPrice,highest_price_sol_per_token:entryPrice,
    simulated_token_amount:tokens,remaining_token_amount:tokens,take_profit_hit:0};
  let first=null;
  const ctx=vm.createContext({
    console:{log(){}},BPS_DENOMINATOR:10000,clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),
    refreshPaperPositionHigh:async(_env,_sig,p)=>{position.highest_price_sol_per_token=Math.max(position.highest_price_sol_per_token,p);},
    getPaperExitPosition:async()=>position,
    getPaperExitExecutableQuote:async args=>{first={reason:args.exitReason,requestedTokenAmount:args.tokenAmount};return null;},
    executePaperCopyExit:async()=>{throw Error('Replay must never invent an exit fill');},
  });
  vm.runInContext(thresholds+'\n'+decisions,ctx);
  for(const quote of exits.sort((a,b)=>a.age_seconds-b.age_seconds)) {
    const proxyPrice=quote.out_lamports/1e9/tokens;
    await ctx.processPaperExitPosition({},position,config,{priceSOLPerToken:proxyPrice,source:'FULL_POSITION_SELL_QUOTE_PROXY'});
    if(first){first.ageSeconds=quote.age_seconds;first.bucket=quote.age_bucket;break;}
  }
  results.push({signature,mint:entry.mint,firstObservedExitIntent:first,
    priceBasis:'FULL_POSITION_SELL_QUOTE_PROXY',fillSimulated:false,pnlCalculated:false});
}
const counts={};
for(const r of results){const key=r.firstObservedExitIntent?.reason||'NO_OBSERVED_TRIGGER';counts[key]=(counts[key]||0)+1;}
console.log(JSON.stringify({mode:'DIAGNOSTIC_TRIGGER_ONLY',sourceCutoff:'2026-10-04T16:00:00Z',
  configBasis:'Verified live config Oct 4; not historical per-entry snapshot',
  counts,results,execution:'DISABLED',realMoney:false},null,2));
