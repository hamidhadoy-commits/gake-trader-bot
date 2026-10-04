const WSOL = "So11111111111111111111111111111111111111112";

export function exactExitBucket(ageSeconds) {
  if (ageSeconds >= 60 && ageSeconds < 180) return "M1";
  if (ageSeconds >= 180 && ageSeconds < 300) return "M3";
  if (ageSeconds >= 300 && ageSeconds < 600) return "M5";
  if (ageSeconds >= 600 && ageSeconds < 900) return "M10";
  return null;
}

export async function runExactEntryExitObservationBatch(env, {
  getConfig, sellQuote, databaseOperation, limit = 4,
  now = () => Date.now(),
} = {}) {
  const currentMs = now();
  const result = await databaseOperation("get_due_exact_entry_exit_checks", () =>
    env.DB.prepare(`
      SELECT e.source_signature, e.mint, e.checked_at,
             e.buy_out_raw_amount, e.buy_token_decimals,
             e.target_copy_lamports,
             MAX(CASE WHEN x.definitive = 1 AND x.age_bucket = 'M1' THEN 1 ELSE 0 END) AS has_m1,
             MAX(CASE WHEN x.definitive = 1 AND x.age_bucket = 'M3' THEN 1 ELSE 0 END) AS has_m3,
             MAX(CASE WHEN x.definitive = 1 AND x.age_bucket = 'M5' THEN 1 ELSE 0 END) AS has_m5,
             MAX(CASE WHEN x.definitive = 1 AND x.age_bucket = 'M10' THEN 1 ELSE 0 END) AS has_m10,
             MAX(x.checked_at) AS last_attempt_at
      FROM paper_immediate_entry_checks e
      LEFT JOIN paper_exact_entry_exit_checks x ON x.source_signature = e.source_signature
      WHERE e.buy_executable = 1 AND e.checked_at > ? AND e.checked_at <= ?
      GROUP BY e.source_signature
      ORDER BY e.checked_at ASC LIMIT 100
    `).bind(new Date(currentMs - 900000).toISOString(),
             new Date(currentMs - 60000).toISOString()).all());
  const due = (result?.results || []).filter(row => {
    const age = (currentMs - Date.parse(row.checked_at)) / 1000;
    const bucket = exactExitBucket(age);
    const sinceAttempt = (currentMs - Date.parse(row.last_attempt_at)) / 1000;
    return bucket && !Number(row["has_" + bucket.toLowerCase()]) &&
      (!row.last_attempt_at || sinceAttempt >= 60) &&
      typeof row.buy_out_raw_amount === "string" &&
      /^[1-9]\d*$/.test(row.buy_out_raw_amount) &&
      Number.isInteger(row.buy_token_decimals) &&
      row.buy_token_decimals >= 0 && row.buy_token_decimals <= 18 &&
      Number.isSafeInteger(row.target_copy_lamports) && row.target_copy_lamports > 0;
  }).sort((a, b) => {
    // Serve the window that expires first, rather than always the oldest entry.
    const deadline = row => {
      const entryMs = Date.parse(row.checked_at);
      const bucket = exactExitBucket((currentMs - entryMs) / 1000);
      return entryMs + ({M1: 180, M3: 300, M5: 600, M10: 900}[bucket] * 1000);
    };
    return deadline(a) - deadline(b) || Date.parse(a.checked_at) - Date.parse(b.checked_at);
  }).slice(0, Math.max(1, Math.min(4, Math.floor(Number(limit) || 1))));
  if (!due.length) return {checked: 0, deferred: 0, execution: "DISABLED", realMoney: false};
  const config = await getConfig(env);
  const buyFee = Number(config?.buy_fee_lamports);
  const sellFee = Number(config?.sell_fee_lamports);
  if (![buyFee, sellFee].every(x => Number.isSafeInteger(x) && x >= 0)) {
    throw new Error("Invalid configured fees for exact exit observation");
  }
  let checked = 0, deferred = 0;
  for (const row of due) {
    // Recheck age after earlier requests; never label a late request as an earlier bucket.
    const startedMs = now();
    const ageSeconds = (startedMs - Date.parse(row.checked_at)) / 1000;
    const bucket = exactExitBucket(ageSeconds);
    if (!bucket || Number(row["has_" + bucket.toLowerCase()])) continue;
    const quote = await sellQuote({
      mint: row.mint, rawTokenAmount: row.buy_out_raw_amount,
      tokenDecimals: row.buy_token_decimals,
      wrappedSolMint: WSOL, jupiterApiKey: env?.JUPITER_API_KEY || null,
    });
    const exactMatch = quote?.rawAmount === row.buy_out_raw_amount &&
      quote?.decimals === row.buy_token_decimals;
    const success = quote?.executable === true && exactMatch &&
      Number.isSafeInteger(quote.outAmountLamports) && quote.outAmountLamports > 0;
    const reason = quote?.executable === true && !success
      ? "invalid_exact_quote_result" : quote?.reason || "quote_unavailable";
    const definitive = success || (reason === "no_route" && exactMatch);
    const out = success ? quote.outAmountLamports : null;
    const net = success ? out - sellFee - row.target_copy_lamports - buyFee : null;
    const netPct = success ? 100 * net / (row.target_copy_lamports + buyFee) : null;
    const inserted = await databaseOperation("insert_exact_entry_exit_check", () =>
      env.DB.prepare(`
        INSERT OR IGNORE INTO paper_exact_entry_exit_checks (
          source_signature, mint, age_bucket, entry_checked_at, quote_started_at,
          checked_at, age_seconds, input_raw_amount, token_decimals,
          target_copy_lamports, buy_fee_lamports, sell_fee_lamports, fee_basis,
          executable, definitive, reason, http_status, out_lamports,
          net_lamports, net_pct, router
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(row.source_signature, row.mint, bucket, row.checked_at,
        new Date(startedMs).toISOString(), new Date(now()).toISOString(), ageSeconds,
        row.buy_out_raw_amount, row.buy_token_decimals, row.target_copy_lamports,
        buyFee, sellFee, "CONFIG_AT_EXIT_OBSERVATION_ONE_FULL_SELL",
        success ? 1 : 0, definitive ? 1 : 0, reason, quote?.status ?? null,
        out, net, netPct, quote?.router || null).run());
    if (Number(inserted?.meta?.changes || 0) === 1) {
      checked++;
      if (!definitive) deferred++;
    }
    console.log({
      message: "EXACT ENTRY EXIT OBSERVATION", sourceSignature: row.source_signature,
      mint: row.mint, ageBucket: bucket, ageSeconds, inputRawAmount: row.buy_out_raw_amount,
      executable: success, definitive, reason, status: quote?.status ?? null,
      netPct, feeBasis: "CONFIG_AT_EXIT_OBSERVATION_ONE_FULL_SELL",
      behavior: "OBSERVATION_ONLY_NO_ACCOUNT_MUTATION", execution: "DISABLED", realMoney: false,
    });
  }
  return {checked, deferred, execution: "DISABLED", realMoney: false};
}
