import {loadResearchObservationCandidates,observationTrialActive,OBSERVATION_SCHEDULER_VERSION} from './paper-observation-scheduler.mjs';
const RUN = "EXACT_ENTRY_EXIT_CYCLE_V1";
const WSOL = "So11111111111111111111111111111111111111112";
const rawValid = value => typeof value === "string" && /^[1-9]\d*$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
const int = value => Number.isSafeInteger(value) && value >= 0;
const query = async (env, sql, values = [], mode = "all") =>
  env.DB.prepare(sql).bind(...values)[mode]();

export function captureResearchConfig(config) {
  const keys = ["buy_fee_lamports","sell_fee_lamports","sell_slippage_bps","stop_loss_bps",
    "take_profit_enabled","take_profit_bps","take_profit_sell_bps",
    "trailing_stop_enabled","trailing_stop_bps"];
  const snapshot = Object.fromEntries(keys.map(k => [k, Number(config?.[k])]));
  if (!Object.values(snapshot).every(int) ||
      ["sell_slippage_bps","stop_loss_bps","take_profit_sell_bps","trailing_stop_bps"]
        .some(k => snapshot[k] > 10000) ||
      ![0,1].includes(snapshot.take_profit_enabled) ||
      ![0,1].includes(snapshot.trailing_stop_enabled)) {
    throw Error("Invalid research configuration");
  }
  return snapshot;
}

export function chooseResearchExit(position, config, mark) {
  if (position?.status !== "RESEARCH_OPEN" || !Number.isFinite(mark) || mark <= 0 ||
      !rawValid(position.remaining_raw_amount)) return null;
  const entry = Number(position.entry_price_sol);
  const high = Math.max(entry, Number(position.highest_price_sol), mark);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(high)) return null;
  if (mark <= entry * (1 - config.stop_loss_bps / 10000)) {
    return {reason:"STOP_LOSS", raw:position.remaining_raw_amount};
  }
  if (config.take_profit_enabled === 1 && !Number(position.take_profit_hit) &&
      config.take_profit_sell_bps > 0 && mark >= entry * (1 + config.take_profit_bps / 10000)) {
    const amount = BigInt(position.initial_raw_amount) * BigInt(config.take_profit_sell_bps) / 10000n;
    const remaining = BigInt(position.remaining_raw_amount);
    const sold = amount < remaining ? amount : remaining;
    if (sold > 0n) return {reason:"TAKE_PROFIT_PARTIAL", raw:sold.toString()};
  }
  if (config.trailing_stop_enabled === 1 && config.trailing_stop_bps > 0 &&
      mark <= high * (1 - config.trailing_stop_bps / 10000)) {
    return {reason:"TRAILING_STOP", raw:position.remaining_raw_amount};
  }
  return null;
}

export async function admitResearchEntries(env, config, nowMs) {
  const now = new Date(nowMs).toISOString();
  await query(env, "INSERT OR IGNORE INTO paper_research_runs(id,started_at,scope) VALUES (?,?,?)",
    [RUN,now,"INDEPENDENT_QUOTED_POSITIONS_NO_SHARED_CASH_OR_PORTFOLIO_LIMITS"], "run");
  const run = await query(env,"SELECT * FROM paper_research_runs WHERE id=?",[RUN],"first");
  const snapshot = captureResearchConfig(config);
  const rows = await query(env,`
    SELECT e.* FROM paper_immediate_entry_checks e
    LEFT JOIN paper_research_positions p ON p.source_signature=e.source_signature
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
      INSERT OR IGNORE INTO paper_research_positions (
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

export async function recordResearchExit(env, position, config, intent, quote, markInfo, startedAt, checkedAt) {
  const exact = quote?.rawAmount === intent.raw && quote?.decimals === position.decimals;
  const success = quote?.executable === true && exact &&
    Number.isSafeInteger(quote.outAmountLamports) && quote.outAmountLamports > 0;
  const reason = quote?.executable === true && !success
    ? "invalid_exact_quote_result" : quote?.reason || "quote_unavailable";
  await query(env,`
    INSERT INTO paper_research_exit_attempts (
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
      INSERT OR IGNORE INTO paper_research_exits (
        operation_id,source_signature,position_revision,exit_reason,sold_raw_amount,remaining_raw_amount,
        quoted_out_lamports,sell_haircut_bps,haircut_lamports,sell_fee_lamports,quote_net_lamports,
        modeled_net_lamports,allocated_entry_cost_lamports,modeled_pnl_lamports,
        quote_started_at,checked_at,router
      ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM paper_research_positions
        WHERE source_signature=? AND revision=? AND remaining_raw_amount=? AND status='RESEARCH_OPEN')
    `).bind(op,position.source_signature,position.revision,intent.reason,intent.raw,remaining,
      out,config.sell_slippage_bps,haircut,config.sell_fee_lamports,quoteNet,
      modeledNet,allocated,pnl,startedAt,checkedAt,quote.router || null,
      position.source_signature,position.revision,position.remaining_raw_amount),
    env.DB.prepare(`
      UPDATE paper_research_positions SET remaining_raw_amount=?,revision=revision+1,
        take_profit_hit=CASE WHEN ?=1 THEN 1 ELSE take_profit_hit END,
        status=?,allocated_cost_lamports=allocated_cost_lamports+?,
        quote_proceeds_lamports=quote_proceeds_lamports+?,
        modeled_proceeds_lamports=modeled_proceeds_lamports+?,
        modeled_pnl_lamports=modeled_pnl_lamports+?,closed_at=?,close_reason=?
      WHERE source_signature=? AND revision=? AND remaining_raw_amount=? AND status='RESEARCH_OPEN'
        AND EXISTS (SELECT 1 FROM paper_research_exits WHERE operation_id=?)
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

export async function runResearchExitCycle(env, {
  getConfig, priceFeed, sellQuote, now=()=>Date.now(),
  maxMarks=8, maxQuotes=4, observationTrial=null,
}={}) {
  const activeConfig = await getConfig(env);
  if (Number(activeConfig?.enabled) !== 1) {
    return {admitted:0,marked:0,quotes:0,exits:0,missingPrices:0,paused:true};
  }
  observationTrialActive(observationTrial,now()); // Reject invalid trial windows before admission writes.
  const admitted = await admitResearchEntries(env,activeConfig,now());
  const markLimit = Math.max(1,Math.min(8,Math.floor(Number(maxMarks)||1)));
  const quoteLimit = Math.max(0,Math.min(4,Math.floor(Number(maxQuotes)||0)));
  const selection = await loadResearchObservationCandidates(env,now(),markLimit,observationTrial);
  const positions=selection.positions;
  if (!positions.length) return {admitted,marked:0,quotes:0,exits:0,missingPrices:0};
  const feedStartedAt = new Date(now()).toISOString();
  const prices = await priceFeed(positions.map(p=>p.mint),{
    wrappedSolMint:WSOL,coingeckoApiKey:env?.COINGECKO_API_KEY || null,
    jupiterApiKey:env?.JUPITER_API_KEY || null,
  });
  const feedCompletedAt = new Date(now()).toISOString();
  let quotes=0,exits=0,missingPrices=0;
  for(const p of positions) {
    const info=prices.get(p.mint);
    const mark=Number(info?.priceSOLPerToken);
    const valid=Number.isFinite(mark)&&mark>0;
    await query(env,`
      UPDATE paper_research_positions SET last_checked_at=?,
        highest_price_sol=MAX(highest_price_sol,?),last_mark_price_sol=?,last_mark_source=?
      WHERE source_signature=? AND status='RESEARCH_OPEN'
    `,[new Date(now()).toISOString(),valid?mark:p.highest_price_sol,
      valid?mark:null,valid?(info.source || "UNKNOWN"):null,p.source_signature],"run");
    let current=await query(env,"SELECT * FROM paper_research_positions WHERE source_signature=?",[p.source_signature],"first");
    const config=captureResearchConfig(JSON.parse(current.config_json));
    const planned = valid ? chooseResearchExit(current,config,mark) : null;
    const observationAt = new Date(now()).toISOString();
    try {
      await query(env,`
      INSERT INTO paper_research_marks (
        source_signature,position_revision,feed_started_at,feed_completed_at,checked_at,
        mark_price_sol,mark_source,highest_price_sol,planned_exit_reason,
        quote_budget_available,observation_reason
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `,[p.source_signature,current.revision,feedStartedAt,feedCompletedAt,observationAt,
      valid?mark:null,valid?(info.source || "UNKNOWN"):null,current.highest_price_sol,
      planned?.reason || null,quotes<quoteLimit?1:0,
      !valid?"MISSING_PRICE":!planned?"NO_TRIGGER":quotes<quoteLimit?"ELIGIBLE":"QUOTE_BUDGET_EXHAUSTED"],"run");
      await query(env,`
        INSERT OR IGNORE INTO paper_research_feed_metadata (
          source_signature,position_revision,checked_at,mark_source,response_metadata_json
        ) VALUES (?,?,?,?,?)
      `,[p.source_signature,current.revision,observationAt,valid?(info.source || "UNKNOWN"):null,
        selection.active ? JSON.stringify({responseMetadata:valid ? info.responseMetadata ?? null : null,observationScheduler:{version:OBSERVATION_SCHEDULER_VERSION,startsAtMs:observationTrial.startsAtMs,endsAtMs:observationTrial.endsAtMs,recentWindowMs:900000,reservedSlots:Math.min(2,Math.floor(markLimit/2))}}) : valid && info.responseMetadata ? JSON.stringify(info.responseMetadata) : null],"run");
    } catch (error) {
      console.error({message:"RESEARCH MARK HISTORY ERROR",sourceSignature:p.source_signature,
        error:String(error),execution:"DISABLED",realMoney:false});
    }
    if(!valid){missingPrices++;continue;}
    // At most TP then remainder in the same tick, subject to the shared quote budget.
    for(let sequence=0;sequence<2 && quotes<quoteLimit;sequence++) {
      const intent=chooseResearchExit(current,config,mark);
      if(!intent) break;
      const startedAt=new Date(now()).toISOString();
      quotes++;
      let quote;
      try {
        quote=await sellQuote({mint:current.mint,rawTokenAmount:intent.raw,
          tokenDecimals:current.decimals,wrappedSolMint:WSOL,jupiterApiKey:env?.JUPITER_API_KEY || null});
      }catch(error){quote={executable:false,reason:"quote_exception"};}
      const r=await recordResearchExit(env,current,config,intent,quote,info,startedAt,new Date(now()).toISOString());
      if(!r.inserted) break;
      exits++;
      console.log({message:"RESEARCH PAPER EXIT",operationId:r.operationId,
        sourceSignature:current.source_signature,exitReason:intent.reason,
        rawTokenAmount:intent.raw,execution:"DISABLED",realMoney:false,
        scope:"INDEPENDENT_POSITION_RESEARCH_NOT_PORTFOLIO_PNL"});
      current=await query(env,"SELECT * FROM paper_research_positions WHERE source_signature=?",[p.source_signature],"first");
      if(current.status!=="RESEARCH_OPEN") break;
    }
  }
  const summary={admitted,marked:positions.length,quotes,exits,missingPrices,...(selection.active?{observationScheduler:OBSERVATION_SCHEDULER_VERSION}:{})};
  console.log({message:"RESEARCH EXIT CYCLE COMPLETE",...summary,execution:"DISABLED",realMoney:false});
  return summary;
}
