import {captureResearchConfig,chooseResearchExit} from './paper-research.js';
const RUN = "QUOTE_TRIGGER_EXIT_CYCLE_V1";
const WSOL = "So11111111111111111111111111111111111111112";
const rawValid = value => typeof value === "string" && /^[1-9]\d*$/.test(value) && BigInt(value)<=18446744073709551615n;
const query = async (env,sql,values=[],mode="all") => env.DB.prepare(sql).bind(...values)[mode]();

export async function admitQuoteResearchEntries(env, config, nowMs) {
  const now = new Date(nowMs).toISOString();
  await query(env, "INSERT OR IGNORE INTO paper_quote_research_runs(id,started_at,scope) VALUES (?,?,?)",
    [RUN,now,"QUOTE_TRIGGER_POSITIONS_NO_SHARED_CASH_OR_PORTFOLIO_LIMITS"], "run");
  const run = await query(env,"SELECT * FROM paper_quote_research_runs WHERE id=?",[RUN],"first");
  const snapshot = captureResearchConfig(config);
  const rows = await query(env,`
    SELECT e.* FROM paper_immediate_entry_checks e
    LEFT JOIN paper_quote_research_positions p ON p.source_signature=e.source_signature
    WHERE p.source_signature IS NULL AND e.buy_executable=1
      AND e.checked_at>=? AND e.checked_at>=? AND e.checked_at<=?
    ORDER BY e.checked_at ASC LIMIT 20
  `,[run.started_at,new Date(nowMs-120000).toISOString(),now]);
  let admitted = 0;
  for (const e of rows.results || []) {
    if (!rawValid(e.buy_out_raw_amount) || !Number.isInteger(e.buy_token_decimals) ||
        e.buy_token_decimals < 0 || e.buy_token_decimals > 18 ||
        !Number.isSafeInteger(e.target_copy_lamports) || e.target_copy_lamports <= 0) continue;
    const tokens = Number(e.buy_out_raw_amount) / 10 ** e.buy_token_decimals;
    const price = e.target_copy_lamports / 1e9 / tokens;
    const cost = e.target_copy_lamports + snapshot.buy_fee_lamports;
    if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(cost)) continue;
    const r = await query(env,`
      INSERT OR IGNORE INTO paper_quote_research_positions (
        source_signature,run_id,mint,entry_checked_at,admitted_at,
        initial_raw_amount,remaining_raw_amount,decimals,input_lamports,
        entry_cost_lamports,entry_price_sol,config_json,config_captured_at,highest_price_sol
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `,[e.source_signature,RUN,e.mint,e.checked_at,now,
      e.buy_out_raw_amount,e.buy_out_raw_amount,e.buy_token_decimals,e.target_copy_lamports,
      cost,price,JSON.stringify(snapshot),now,price],"run");
    admitted += Number(r?.meta?.changes || 0);
  }
  return admitted;
}

export async function recordQuoteResearchExit(env, position, config, intent, quote, markInfo, startedAt, checkedAt) {
  const exact = quote?.rawAmount === intent.raw && quote?.decimals === position.decimals;
  const success = quote?.executable === true && exact &&
    Number.isSafeInteger(quote.outAmountLamports) && quote.outAmountLamports > 0;
  const reason = quote?.executable === true && !success
    ? "invalid_exact_quote_result" : quote?.reason || "quote_unavailable";
  await query(env,`
    INSERT INTO paper_quote_research_exit_attempts (
      source_signature,position_revision,exit_reason,input_raw_amount,mark_price_sol,mark_source,
      quote_started_at,checked_at,executable,reason,http_status,quoted_out_lamports,router
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `,[position.source_signature,position.revision,intent.reason,intent.raw,markInfo.priceSOLPerToken,
    markInfo.source || "UNKNOWN",startedAt,checkedAt,success?1:0,reason,quote?.status ?? null,
    success?quote.outAmountLamports:null,quote?.router || null],"run");
  if (!success) return {inserted:false,reason};
  const initial = BigInt(position.initial_raw_amount);
  const before = BigInt(position.remaining_raw_amount);
  const sold = BigInt(intent.raw);
  if (sold <= 0n || sold > before) throw Error("Invalid research exit amount");
  const remaining = (before-sold).toString();
  const closed = remaining === "0";
  const out = quote.outAmountLamports;
  const postHaircut = Number(BigInt(out) * BigInt(10000-config.sell_slippage_bps) / 10000n);
  const haircut = out-postHaircut;
  const quoteNet = out-config.sell_fee_lamports;
  const modeledNet = postHaircut-config.sell_fee_lamports;
  const unallocated = position.entry_cost_lamports-position.allocated_cost_lamports;
  const allocated = closed ? unallocated :
    Math.min(unallocated,Number(BigInt(position.entry_cost_lamports)*sold/initial));
  const pnl = modeledNet-allocated;
  if (![quoteNet,modeledNet,allocated,pnl].every(Number.isSafeInteger) || allocated<0) {
    throw Error("Invalid research accounting");
  }
  const op = RUN+":"+position.source_signature+":"+position.revision+":"+intent.reason;
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO paper_quote_research_exits (
        operation_id,source_signature,position_revision,exit_reason,sold_raw_amount,remaining_raw_amount,
        quoted_out_lamports,sell_haircut_bps,haircut_lamports,sell_fee_lamports,quote_net_lamports,
        modeled_net_lamports,allocated_entry_cost_lamports,modeled_pnl_lamports,
        quote_started_at,checked_at,router
      ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM paper_quote_research_positions
        WHERE source_signature=? AND revision=? AND remaining_raw_amount=? AND status='RESEARCH_OPEN')
    `).bind(op,position.source_signature,position.revision,intent.reason,intent.raw,remaining,
      out,config.sell_slippage_bps,haircut,config.sell_fee_lamports,quoteNet,
      modeledNet,allocated,pnl,startedAt,checkedAt,quote.router || null,
      position.source_signature,position.revision,position.remaining_raw_amount),
    env.DB.prepare(`
      UPDATE paper_quote_research_positions SET remaining_raw_amount=?,revision=revision+1,
        take_profit_hit=CASE WHEN ?=1 THEN 1 ELSE take_profit_hit END,
        status=?,allocated_cost_lamports=allocated_cost_lamports+?,
        quote_proceeds_lamports=quote_proceeds_lamports+?,
        modeled_proceeds_lamports=modeled_proceeds_lamports+?,
        modeled_pnl_lamports=modeled_pnl_lamports+?,closed_at=?,close_reason=?
      WHERE source_signature=? AND revision=? AND remaining_raw_amount=? AND status='RESEARCH_OPEN'
        AND EXISTS (SELECT 1 FROM paper_quote_research_exits WHERE operation_id=?)
    `).bind(remaining,intent.reason==="TAKE_PROFIT_PARTIAL"?1:0,
      closed?"RESEARCH_CLOSED":"RESEARCH_OPEN",allocated,quoteNet,modeledNet,pnl,
      closed?checkedAt:null,closed?intent.reason:null,
      position.source_signature,position.revision,position.remaining_raw_amount,op),
  ]);
  const insert = Number(results[0]?.meta?.changes || 0);
  const update = Number(results[1]?.meta?.changes || 0);
  if (insert !== update) throw Error("Research accounting invariant failed");
  return {inserted:insert===1,reason:insert?"research_exit_recorded":"stale_or_duplicate",operationId:op};
}

export async function runQuoteResearchExitCycle(env, {
  getConfig, sellQuote, now=()=>Date.now(), maxQuotes=2,
}={}) {
  const activeConfig=await getConfig(env);
  if(Number(activeConfig?.enabled)!==1) return {paused:true,admitted:0,quotes:0,exits:0};
  const admitted=await admitQuoteResearchEntries(env,activeConfig,now());
  const limit=Math.max(0,Math.min(4,Math.floor(Number(maxQuotes)||0)));
  if(!limit) return {admitted,quotes:0,exits:0,unavailable:0};
  const rows=await query(env,`SELECT * FROM paper_quote_research_positions
    WHERE status='RESEARCH_OPEN'
    ORDER BY (last_checked_at IS NOT NULL),last_checked_at,admitted_at,source_signature LIMIT ?`,[limit]);
  let quotes=0,exits=0,unavailable=0;
  for(const p of rows.results||[]) {
    if(quotes>=limit) break;
    const config=captureResearchConfig(JSON.parse(p.config_json));
    let high=Number(p.highest_price_sol);
    async function obtain(raw,kind) {
      const startedMs=now(),startedAt=new Date(startedMs).toISOString();
      quotes++;
      let quoted;
      try {
        quoted=await sellQuote({mint:p.mint,rawTokenAmount:raw,tokenDecimals:p.decimals,
          wrappedSolMint:WSOL,jupiterApiKey:env?.JUPITER_API_KEY||null});
      } catch {
        quoted={executable:false,reason:'quote_provider_exception'};
      }
      const completedMs=now(),checkedAt=new Date(completedMs).toISOString();
      const exact=quoted?.rawAmount===raw && quoted?.decimals===p.decimals;
      const fresh=completedMs>=startedMs && completedMs-startedMs<=30000;
      let valid=quoted?.executable===true && exact && fresh &&
        Number.isSafeInteger(quoted.outAmountLamports)&&quoted.outAmountLamports>0;
      const price=valid ? quoted.outAmountLamports/1e9/(Number(raw)/10**p.decimals) : null;
      valid=valid && Number.isFinite(price)&&price>0;
      const reason=quoted?.executable===true&&!valid
        ? !fresh?'stale_quote':'invalid_exact_quote_result' : quoted?.reason||'quote_unavailable';
      if(!valid) unavailable++;
      return {quote:valid?quoted:{...quoted,executable:false,reason},valid,price:valid?price:null,
        raw,kind,reason,startedAt,checkedAt};
    }
    async function observe(o,planned) {
      await query(env,`INSERT INTO paper_quote_research_observations (
        source_signature,position_revision,request_kind,input_raw_amount,token_decimals,
        quote_started_at,checked_at,executable,reason,http_status,out_lamports,
        price_sol,highest_price_sol,planned_exit_reason,quotes_remaining
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [p.source_signature,p.revision,o.kind,o.raw,p.decimals,o.startedAt,o.checkedAt,
        o.valid?1:0,o.reason,o.quote?.status??null,o.valid?o.quote.outAmountLamports:null,
        o.price,high,planned,limit-quotes],'run');
    }
    const mark=await obtain(p.remaining_raw_amount,'REMAINING_MARK');
    if(mark.valid) high=Math.max(high,mark.price);
    await query(env,`UPDATE paper_quote_research_positions SET last_checked_at=?,
      highest_price_sol=MAX(highest_price_sol,?),last_mark_price_sol=?,last_mark_source=?
      WHERE source_signature=? AND status='RESEARCH_OPEN' AND revision=? AND remaining_raw_amount=?`,
      [mark.checkedAt,high,mark.price,mark.valid?'JUPITER_EXACT_REMAINING_QUOTE':null,
        p.source_signature,p.revision,p.remaining_raw_amount],'run');
    const current=await query(env,'SELECT * FROM paper_quote_research_positions WHERE source_signature=?',
      [p.source_signature],'first');
    if(!current || current.status!=='RESEARCH_OPEN' || current.revision!==p.revision ||
        current.remaining_raw_amount!==p.remaining_raw_amount) {
      await observe(mark,'STALE_POSITION');continue;
    }
    const intent=mark.valid?chooseResearchExit(current,config,mark.price):null;
    const needsSlice=intent?.reason==='TAKE_PROFIT_PARTIAL'&&intent.raw!==p.remaining_raw_amount;
    await observe(mark,intent?(needsSlice&&quotes>=limit?'TP_QUOTE_BUDGET_EXHAUSTED':intent.reason):null);
    if(!intent) continue;
    const info={priceSOLPerToken:mark.price,source:'JUPITER_EXACT_REMAINING_QUOTE'};
    let execution=mark;
    if(needsSlice) {
      if(quotes>=limit) continue;
      execution=await obtain(intent.raw,'TAKE_PROFIT_SLICE');
      await observe(execution,intent.reason);
    }
    const result=await recordQuoteResearchExit(env,current,config,intent,execution.quote,
      info,execution.startedAt,execution.checkedAt);
    if(result.inserted) exits++;
  }
  const result={admitted,quotes,exits,unavailable,execution:'DISABLED',realMoney:false};
  console.log({message:'QUOTE RESEARCH EXIT CYCLE COMPLETE',...result});
  return result;
}
