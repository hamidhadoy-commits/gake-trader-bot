const GAKE_WALLET = "DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

const OKX_INPUT_PATTERN = [987654, 2963, 4691, 4692];
const OKX_INPUT_TOTAL_LAMPORTS = 1_000_000;
const TERMINAL_ACTIONS = ["NO_MATCH", "REJECTED", "PAPER_BUY"];
const LAMPORTS_PER_SOL = 1_000_000_000;
const BPS_DENOMINATOR = 10_000;
const SOL_USD_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function lamportsToSOL(lamports) {
  return Number(lamports || 0) / LAMPORTS_PER_SOL;
}

function parseRawInteger(value) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function decimalAmountToRaw(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) return null;

  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;

  const [wholePart, fractionPart = ""] = text.split(".");
  if (fractionPart.length > decimals) {
    const discarded = fractionPart.slice(decimals);
    if (/[1-9]/.test(discarded)) return null;
  }

  const normalizedFraction = fractionPart.slice(0, decimals).padEnd(decimals, "0");

  try {
    const scale = 10n ** BigInt(decimals);
    return BigInt(wholePart) * scale + BigInt(normalizedFraction || "0");
  } catch {
    return null;
  }
}

function getTransferRawAmount(transfer, decimals) {
  const rawCandidates = [
    transfer?.rawTokenAmount?.tokenAmount,
    transfer?.tokenAmountRaw,
    transfer?.rawAmount,
  ];

  for (const candidate of rawCandidates) {
    const parsed = parseRawInteger(candidate);
    if (parsed !== null) return parsed;
  }

  return decimalAmountToRaw(transfer?.tokenAmount, decimals);
}

function normalizeTransactions(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") return [body];
  return [];
}

function getAccountData(tx, account) {
  const accountData = Array.isArray(tx?.accountData) ? tx.accountData : [];
  return accountData.find((item) => item?.account === account) || null;
}

function getNativeBalanceChange(tx, account) {
  const data = getAccountData(tx, account);
  return Number(data?.nativeBalanceChange || 0);
}

function findGakeReceivedTokens(tx) {
  const tokenTransfers = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
  return tokenTransfers.filter(
    (transfer) =>
      transfer?.toUserAccount === GAKE_WALLET &&
      transfer?.mint &&
      Number(transfer?.tokenAmount || 0) > 0
  );
}

function getLargestGakeReceivedToken(tx) {
  const received = findGakeReceivedTokens(tx);
  if (!received.length) return null;
  return [...received].sort(
    (a, b) => Number(b?.tokenAmount || 0) - Number(a?.tokenAmount || 0)
  )[0];
}

function groupNativeTransfersBySender(tx) {
  const nativeTransfers = Array.isArray(tx?.nativeTransfers) ? tx.nativeTransfers : [];
  const groups = new Map();

  for (const transfer of nativeTransfers) {
    const sender = transfer?.fromUserAccount;
    if (!sender) continue;
    if (!groups.has(sender)) groups.set(sender, []);
    groups.get(sender).push({
      fromUserAccount: sender,
      toUserAccount: transfer?.toUserAccount || null,
      amount: Number(transfer?.amount || 0),
    });
  }

  return groups;
}

function matchesOKXPattern(transfers) {
  if (!Array.isArray(transfers)) return false;

  const availableAmounts = transfers.map((transfer) => Number(transfer?.amount || 0));
  const remaining = [...availableAmounts];

  for (const requiredAmount of OKX_INPUT_PATTERN) {
    const index = remaining.indexOf(requiredAmount);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }

  return true;
}

function findOKXInputAccount(tx) {
  const groups = groupNativeTransfersBySender(tx);

  for (const [sender, transfers] of groups.entries()) {
    if (!matchesOKXPattern(transfers)) continue;

    return {
      inputAccount: sender,
      confidence: "VERY_HIGH",
      inputLamports: OKX_INPUT_TOTAL_LAMPORTS,
      inputSOL: lamportsToSOL(OKX_INPUT_TOTAL_LAMPORTS),
      patternComponents: [...OKX_INPUT_PATTERN],
      transfers,
    };
  }

  return null;
}

function buildDiagnosticEvent(tx) {
  const tokenTransfers = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
  const nativeTransfers = Array.isArray(tx?.nativeTransfers) ? tx.nativeTransfers : [];
  const rawAccountData = Array.isArray(tx?.accountData) ? tx.accountData : [];
  const receivedTokens = findGakeReceivedTokens(tx);
  const gakeNativeChange = getNativeBalanceChange(tx, GAKE_WALLET);
  const feePayer = tx?.feePayer || null;
  const relevantAccounts = new Set([GAKE_WALLET, feePayer].filter(Boolean));

  const diagnosticTokenTransfers = tokenTransfers.map((transfer) => ({
    mint: transfer?.mint || null,
    tokenAmount: Number(transfer?.tokenAmount || 0),
    fromUserAccount: transfer?.fromUserAccount || null,
    toUserAccount: transfer?.toUserAccount || null,
    ...(transfer?.fromTokenAccount
      ? { fromTokenAccount: transfer.fromTokenAccount }
      : {}),
    ...(transfer?.toTokenAccount
      ? { toTokenAccount: transfer.toTokenAccount }
      : {}),
  }));

  const diagnosticNativeTransfers = nativeTransfers.map((transfer) => ({
    fromUserAccount: transfer?.fromUserAccount || null,
    toUserAccount: transfer?.toUserAccount || null,
    amount: Number(transfer?.amount || 0),
  }));

  const diagnosticAccountData = rawAccountData
    .filter((item) => {
      const tokenBalanceChanges = Array.isArray(item?.tokenBalanceChanges)
        ? item.tokenBalanceChanges
        : [];

      return (
        relevantAccounts.has(item?.account) ||
        tokenBalanceChanges.some((change) => change?.userAccount === GAKE_WALLET)
      );
    })
    .map((item) => {
      const tokenBalanceChanges = Array.isArray(item?.tokenBalanceChanges)
        ? item.tokenBalanceChanges
        : [];

      return {
        account: item?.account || null,
        nativeBalanceChange: Number(item?.nativeBalanceChange || 0),
        nativeBalanceChangeSOL: lamportsToSOL(item?.nativeBalanceChange || 0),
        tokenBalanceChanges: tokenBalanceChanges.map((change) => ({
          mint: change?.mint || null,
          userAccount: change?.userAccount || null,
          tokenAccount: change?.tokenAccount || null,
          rawTokenAmount: change?.rawTokenAmount
            ? {
                tokenAmount: change.rawTokenAmount.tokenAmount ?? null,
                decimals: change.rawTokenAmount.decimals ?? null,
              }
            : null,
        })),
      };
    });

  return {
    message: "📦 HELIUS EVENT",
    signature: tx?.signature || null,
    type: tx?.type || null,
    source: tx?.source || null,
    description: tx?.description || null,
    feePayer,
    fee: Number(tx?.fee || 0),
    feeSOL: lamportsToSOL(tx?.fee || 0),
    transactionError: tx?.transactionError ?? null,
    tokenTransferCount: tokenTransfers.length,
    nativeTransferCount: nativeTransfers.length,
    gakeReceivedTokenCount: receivedTokens.length,
    gakeNativeBalanceChangeSOL: lamportsToSOL(gakeNativeChange),
    tokenTransfers: diagnosticTokenTransfers,
    nativeTransfers: diagnosticNativeTransfers,
    accountData: diagnosticAccountData,
    timestamp: tx?.timestamp || null,
  };
}

function findGakeOwnedTokenIncreases(tx) {
  const accountData = Array.isArray(tx?.accountData) ? tx.accountData : [];
  const increases = [];

  for (const item of accountData) {
    const changes = Array.isArray(item?.tokenBalanceChanges)
      ? item.tokenBalanceChanges
      : [];

    for (const change of changes) {
      const mint = change?.mint || null;
      const rawAmount = parseRawInteger(change?.rawTokenAmount?.tokenAmount);
      const decimals = change?.rawTokenAmount?.decimals;

      if (
        change?.userAccount !== GAKE_WALLET ||
        !mint ||
        mint === WRAPPED_SOL_MINT ||
        rawAmount === null ||
        rawAmount <= 0n ||
        !Number.isInteger(decimals) ||
        decimals < 0
      ) {
        continue;
      }

      increases.push({
        account: item?.account || null,
        mint,
        tokenAccount: change?.tokenAccount || item?.account || null,
        rawAmount,
        decimals,
      });
    }
  }

  return increases;
}

function findRoutedGakeReceipt(tx) {
  if (tx?.transactionError !== null && tx?.transactionError !== undefined) {
    return null;
  }

  const tokenTransfers = Array.isArray(tx?.tokenTransfers) ? tx.tokenTransfers : [];
  const increases = findGakeOwnedTokenIncreases(tx);

  for (const increase of increases) {
    for (const finalTransfer of tokenTransfers) {
      if (
        finalTransfer?.mint !== increase.mint ||
        finalTransfer?.toUserAccount !== GAKE_WALLET ||
        !finalTransfer?.fromUserAccount ||
        finalTransfer.fromUserAccount === GAKE_WALLET
      ) {
        continue;
      }

      if (
        increase.tokenAccount &&
        finalTransfer?.toTokenAccount &&
        finalTransfer.toTokenAccount !== increase.tokenAccount
      ) {
        continue;
      }

      const finalRawAmount = getTransferRawAmount(finalTransfer, increase.decimals);

      if (
        finalRawAmount === null ||
        finalRawAmount <= 0n ||
        finalRawAmount !== increase.rawAmount
      ) {
        continue;
      }

      const routeOwner = finalTransfer.fromUserAccount;

      for (const upstreamTransfer of tokenTransfers) {
        if (
          upstreamTransfer?.mint !== increase.mint ||
          upstreamTransfer?.toUserAccount !== routeOwner ||
          !upstreamTransfer?.fromUserAccount ||
          upstreamTransfer.fromUserAccount === routeOwner ||
          upstreamTransfer.fromUserAccount === GAKE_WALLET
        ) {
          continue;
        }

        const upstreamRawAmount = getTransferRawAmount(
          upstreamTransfer,
          increase.decimals
        );

        if (
          upstreamRawAmount === null ||
          upstreamRawAmount <= 0n ||
          upstreamRawAmount !== finalRawAmount
        ) {
          continue;
        }

        const counterparty = upstreamTransfer.fromUserAccount;

        for (const wsolInput of tokenTransfers) {
          if (
            wsolInput?.mint !== WRAPPED_SOL_MINT ||
            wsolInput?.fromUserAccount !== routeOwner ||
            wsolInput?.toUserAccount !== counterparty
          ) {
            continue;
          }

          const wsolRawAmount = getTransferRawAmount(wsolInput, 9);

          if (wsolRawAmount === null || wsolRawAmount <= 0n) {
            continue;
          }

          return {
            increase,
            finalTransfer,
            finalRawAmount,
            upstreamTransfer,
            upstreamRawAmount,
            wsolInput,
            wsolRawAmount,
            routeOwner,
            counterparty,
          };
        }
      }
    }
  }

  return null;
}

function buildRoutedGakeCandidate(tx) {
  const evidence = findRoutedGakeReceipt(tx);
  if (!evidence) return null;

  const tokenAmount = Number(evidence.finalTransfer?.tokenAmount || 0);
  const inputSOL = Number(evidence.wsolRawAmount) / LAMPORTS_PER_SOL;

  if (tokenAmount <= 0 || inputSOL <= 0) return null;

  const feePayer = tx?.feePayer || null;

  return {
    message: "🔎 SWAP CANDIDATE",
    action: "SWAP_CANDIDATE",
    detector: "ROUTED_WSOL_GAKE_RECEIPT",
    confidence: "HIGH",
    wallet: GAKE_WALLET,
    signature: tx?.signature || null,
    source: tx?.source || null,
    type: tx?.type || null,
    mint: evidence.increase.mint,
    tokenAmount,
    rawTokenAmount: evidence.finalRawAmount.toString(),
    tokenDecimals: evidence.increase.decimals,
    fromUserAccount: evidence.routeOwner,
    toUserAccount: GAKE_WALLET,
    toTokenAccount: evidence.increase.tokenAccount,
    feePayer,
    inferredInputAccount: evidence.routeOwner,
    inferredInputConfidence: "HIGH",
    inferredSwapInputSOL: inputSOL,
    inferredSwapInputLamports: evidence.wsolRawAmount.toString(),
    inputPatternMatched: false,
    inputPatternComponents: null,
    inputPatternTotalLamports: null,
    inputAccountMatchesTokenTransfer: true,
    routedEconomicChainMatched: true,
    routeOwner: evidence.routeOwner,
    counterparty: evidence.counterparty,
    finalOutputRawAmount: evidence.finalRawAmount.toString(),
    upstreamOutputRawAmount: evidence.upstreamRawAmount.toString(),
    gakeBalanceIncreaseRawAmount: evidence.increase.rawAmount.toString(),
    wsolInputRawAmount: evidence.wsolRawAmount.toString(),
    gakeNativeBalanceChangeSOL: lamportsToSOL(
      getNativeBalanceChange(tx, GAKE_WALLET)
    ),
    fee: Number(tx?.fee || 0),
    feeSOL: lamportsToSOL(tx?.fee || 0),
    feePayerNativeBalanceChangeSOL: feePayer
      ? lamportsToSOL(getNativeBalanceChange(tx, feePayer))
      : 0,
    transactionError: tx?.transactionError ?? null,
    description: tx?.description || null,
    timestamp: tx?.timestamp || null,
  };
}

/* Existing OKX detector. This remains the first detection path. */
function buildOKXSwapCandidate(tx) {
  const received = getLargestGakeReceivedToken(tx);
  if (!received) return null;

  const input = findOKXInputAccount(tx);
  if (!input) return null;

  const fromUserAccount = received?.fromUserAccount || null;
  const inputMatchesTokenTransfer = input.inputAccount === fromUserAccount;
  const feePayer = tx?.feePayer || null;
  const gakeNativeChange = getNativeBalanceChange(tx, GAKE_WALLET);
  const feePayerNativeChange = feePayer
    ? getNativeBalanceChange(tx, feePayer)
    : 0;

  return {
    message: "🔎 SWAP CANDIDATE",
    action: "SWAP_CANDIDATE",
    confidence: inputMatchesTokenTransfer ? "VERY_HIGH" : "HIGH",
    wallet: GAKE_WALLET,
    signature: tx?.signature || null,
    source: tx?.source || null,
    type: tx?.type || null,
    mint: received?.mint || null,
    tokenAmount: Number(received?.tokenAmount || 0),
    fromUserAccount,
    toUserAccount: received?.toUserAccount || null,
    feePayer,
    inferredInputAccount: input.inputAccount,
    inferredInputConfidence: input.confidence,
    inferredSwapInputSOL: input.inputSOL,
    inferredSwapInputLamports: input.inputLamports,
    inputPatternMatched: true,
    inputPatternComponents: input.patternComponents,
    inputPatternTotalLamports: OKX_INPUT_TOTAL_LAMPORTS,
    inputAccountMatchesTokenTransfer: inputMatchesTokenTransfer,
    gakeNativeBalanceChangeSOL: lamportsToSOL(gakeNativeChange),
    fee: Number(tx?.fee || 0),
    feeSOL: lamportsToSOL(tx?.fee || 0),
    feePayerNativeBalanceChangeSOL: lamportsToSOL(feePayerNativeChange),
    transactionError: tx?.transactionError ?? null,
    description: tx?.description || null,
    timestamp: tx?.timestamp || null,
  };
}

function buildSwapCandidate(tx) {
  const okxCandidate = buildOKXSwapCandidate(tx);
  if (okxCandidate) return okxCandidate;
  return buildRoutedGakeCandidate(tx);
}

function validateCandidate(candidate) {
  const reasons = [];

  if (!candidate) {
    reasons.push("candidate_missing");
    return reasons;
  }

  if (candidate.transactionError !== null && candidate.transactionError !== undefined) {
    reasons.push("transaction_error");
  }

  if (candidate.detector === "ROUTED_WSOL_GAKE_RECEIPT") {
    if (candidate.routedEconomicChainMatched !== true) {
      reasons.push("routed_chain_not_matched");
    }

    if (candidate.confidence !== "HIGH") {
      reasons.push("routed_confidence_not_high");
    }

    if (
      !candidate.routeOwner ||
      !candidate.counterparty ||
      candidate.routeOwner === candidate.counterparty ||
      candidate.routeOwner === GAKE_WALLET
    ) {
      reasons.push("invalid_route_accounts");
    }

    const finalRawAmount = parseRawInteger(candidate.finalOutputRawAmount);
    const upstreamRawAmount = parseRawInteger(candidate.upstreamOutputRawAmount);
    const gakeRawAmount = parseRawInteger(candidate.gakeBalanceIncreaseRawAmount);
    const wsolRawAmount = parseRawInteger(candidate.wsolInputRawAmount);

    if (
      finalRawAmount === null ||
      finalRawAmount <= 0n ||
      upstreamRawAmount === null ||
      upstreamRawAmount <= 0n ||
      gakeRawAmount === null ||
      gakeRawAmount <= 0n ||
      upstreamRawAmount !== finalRawAmount ||
      gakeRawAmount !== finalRawAmount
    ) {
      reasons.push("routed_output_amount_mismatch");
    }

    if (wsolRawAmount === null || wsolRawAmount <= 0n) {
      reasons.push("invalid_wsol_input");
    }

    if (!candidate.mint) reasons.push("mint_missing");
    if (Number(candidate.tokenAmount) <= 0) reasons.push("invalid_token_amount");

    return reasons;
  }

  /* Existing OKX validation remains behaviorally unchanged below. */
  if (candidate.inputPatternMatched !== true) {
    reasons.push("input_pattern_not_matched");
  }

  if (candidate.inputAccountMatchesTokenTransfer !== true) {
    reasons.push("input_account_mismatch");
  }

  if (candidate.inferredInputConfidence !== "VERY_HIGH") {
    reasons.push("confidence_not_very_high");
  }

  if (Number(candidate.inferredSwapInputLamports) !== OKX_INPUT_TOTAL_LAMPORTS) {
    reasons.push("input_amount_mismatch");
  }

  if (!candidate.mint) reasons.push("mint_missing");
  if (Number(candidate.tokenAmount) <= 0) reasons.push("invalid_token_amount");

  return reasons;
}

function buildBuySignal(candidate) {
  const rejectionReasons = validateCandidate(candidate);

  if (rejectionReasons.length > 0) {
    return { signal: null, rejectionReasons };
  }

  const signal = {
    message: "🟢 BUY SIGNAL",
    action: "BUY_SIGNAL",
    detector: candidate.detector || "OKX_EXACT_PATTERN",
    confidence: candidate.confidence,
    signature: candidate.signature,
    source: candidate.source,
    type: candidate.type,
    mint: candidate.mint,
    tokenAmount: Number(candidate.tokenAmount),
    inputAccount: candidate.inferredInputAccount,
    inputSOL: Number(candidate.inferredSwapInputSOL),
    inputLamports: Number(candidate.inferredSwapInputLamports),
    fromUserAccount: candidate.fromUserAccount,
    toUserAccount: candidate.toUserAccount,
    gakeWallet: GAKE_WALLET,
    feePayer: candidate.feePayer,
    feeSOL: Number(candidate.feeSOL || 0),
    gakeNativeBalanceChangeSOL: Number(candidate.gakeNativeBalanceChangeSOL || 0),
    detectedAt: new Date().toISOString(),
    execution: "DISABLED",
    realMoney: false,
  };

  return { signal, rejectionReasons: [] };
}

class DatabaseError extends Error {
  constructor(operation, cause) {
    super(`Database operation failed: ${operation}`);
    this.name = "DatabaseError";
    this.operation = operation;
    this.cause = cause;
  }
}

async function runDatabaseOperation(operation, callback) {
  try {
    return await callback();
  } catch (error) {
    console.error({
      message: "❌ DATABASE ERROR",
      operation,
      error: String(error),
    });
    throw new DatabaseError(operation, error);
  }
}

async function getProcessedSignature(env, signature) {
  return runDatabaseOperation("get_processed_signature", () =>
    env.DB.prepare(
      "SELECT signature, detector, action FROM processed_signatures WHERE signature = ? LIMIT 1"
    )
      .bind(signature)
      .first()
  );
}

async function insertReceivedSignature(env, signature, firstSeenAt) {
  return runDatabaseOperation("insert_received_signature", () =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO processed_signatures (signature, first_seen_at, detector, action) VALUES (?, ?, ?, ?)"
    )
      .bind(signature, firstSeenAt, null, "RECEIVED")
      .run()
  );
}

async function beginSignatureProcessing(env, signature) {
  let record = await getProcessedSignature(env, signature);

  if (record && TERMINAL_ACTIONS.includes(record.action)) {
    return { duplicate: true, record };
  }

  if (!record) {
    await insertReceivedSignature(env, signature, new Date().toISOString());
    record = await getProcessedSignature(env, signature);

    if (record && TERMINAL_ACTIONS.includes(record.action)) {
      return { duplicate: true, record };
    }
  }

  if (!record || record.action !== "RECEIVED") {
    const error = new Error(
      `Unexpected processed_signatures state: ${String(record?.action)}`
    );
    console.error({
      message: "❌ DATABASE ERROR",
      operation: "begin_signature_processing",
      signature,
      error: String(error),
    });
    throw new DatabaseError("begin_signature_processing", error);
  }

  return { duplicate: false, record };
}

async function markProcessedSignature(env, signature, detector, action) {
  const result = await runDatabaseOperation("mark_processed_signature", () =>
    env.DB.prepare(
      "UPDATE processed_signatures SET detector = ?, action = ? WHERE signature = ?"
    )
      .bind(detector, action, signature)
      .run()
  );

  if (Number(result?.meta?.changes ?? 0) < 1) {
    const error = new Error("processed_signatures update changed zero rows");
    console.error({
      message: "❌ DATABASE ERROR",
      operation: "mark_processed_signature",
      signature,
      action,
      error: String(error),
    });
    throw new DatabaseError("mark_processed_signature", error);
  }
}

async function createPaperBuy(buySignal, env) {
  if (!buySignal) return null;

  const signature = buySignal.signature;
  const mint = buySignal.mint;
  const detector = buySignal.detector || "OKX_EXACT_PATTERN";
  const confidence = buySignal.confidence;
  const tokenAmount = Number(buySignal.tokenAmount);
  const inputSOL = Number(buySignal.inputSOL);

  if (!signature || !mint || tokenAmount <= 0 || inputSOL <= 0) {
    return null;
  }

  const entryPriceSOLPerToken = inputSOL / tokenAmount;
  const entryTime = buySignal.detectedAt || new Date().toISOString();
  const createdAt = new Date().toISOString();
  const inputAccount = buySignal.inputAccount || null;

  const result = await runDatabaseOperation("insert_paper_position", () =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO paper_positions (signature, mint, detector, confidence, token_amount, input_sol, entry_price_sol_per_token, input_account, status, entry_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        signature,
        mint,
        detector,
        confidence,
        tokenAmount,
        inputSOL,
        entryPriceSOLPerToken,
        inputAccount,
        "PAPER_OPEN",
        entryTime,
        createdAt
      )
      .run()
  );

  if (Number(result?.meta?.changes ?? 0) === 0) {
    console.log({
      message: "♻️ PAPER POSITION ALREADY EXISTS",
      signature,
      mint,
      detector,
    });
    return { inserted: false, position: null };
  }

  return {
    inserted: true,
    position: {
      message: "📄 PAPER BUY",
      action: "PAPER_BUY",
      status: "PAPER_OPEN",
      signature,
      mint,
      detector,
      tokenAmount,
      inputSOL,
      entryPriceSOLPerToken,
      entryTime,
      createdAt,
      source: buySignal.source,
      inputAccount,
      confidence,
      execution: "DISABLED",
      realMoney: false,
    },
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function usdToLamports(usd, solUsdPrice) {
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(solUsdPrice) || solUsdPrice <= 0) {
    return 0;
  }
  return Math.floor((usd / solUsdPrice) * LAMPORTS_PER_SOL);
}

async function getSolUsdPrice(account) {
  const fallback = Number(account?.initial_sol_usd_price || 0);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(SOL_USD_PRICE_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`SOL/USD HTTP ${response.status}`);
    }

    const payload = await response.json();
    const price = Number(payload?.solana?.usd);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Invalid SOL/USD response");
    }

    return { price, source: "COINGECKO" };
  } catch (error) {
    if (!Number.isFinite(fallback) || fallback <= 0) {
      throw new DatabaseError("resolve_sol_usd_price", error);
    }

    console.warn({
      message: "⚠️ SOL/USD FALLBACK",
      error: String(error),
      fallbackPrice: fallback,
      fallbackSource: "ACCOUNT_INITIAL_PRICE",
    });

    return { price: fallback, source: "ACCOUNT_INITIAL_PRICE" };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getPaperCopyPosition(env, sourceSignature) {
  return runDatabaseOperation("get_paper_copy_position", () =>
    env.DB.prepare(
      "SELECT source_signature, status FROM paper_copy_positions WHERE source_signature = ? LIMIT 1"
    )
      .bind(sourceSignature)
      .first()
  );
}

async function getPaperCopyConfig(env) {
  const row = await runDatabaseOperation("get_paper_copy_config", () =>
    env.DB.prepare("SELECT * FROM paper_copy_config WHERE id = 1 LIMIT 1").first()
  );

  if (!row) {
    throw new DatabaseError(
      "get_paper_copy_config",
      new Error("paper_copy_config id=1 is missing")
    );
  }

  return row;
}

async function getPaperCopyAccount(env) {
  const row = await runDatabaseOperation("get_paper_copy_account", () =>
    env.DB.prepare("SELECT * FROM paper_copy_account WHERE id = 1 LIMIT 1").first()
  );

  if (!row) {
    throw new DatabaseError(
      "get_paper_copy_account",
      new Error("paper_copy_account id=1 is missing")
    );
  }

  return row;
}

async function getOpenPaperCopyStats(env) {
  const row = await runDatabaseOperation("get_open_paper_copy_stats", () =>
    env.DB.prepare(
      "SELECT COUNT(*) AS open_count, COALESCE(SUM(copy_notional_lamports), 0) AS open_exposure_lamports FROM paper_copy_positions WHERE status = 'PAPER_OPEN'"
    ).first()
  );

  return {
    openCount: Number(row?.open_count || 0),
    openExposureLamports: Number(row?.open_exposure_lamports || 0),
  };
}

function calculateSizingEquityLamports(account, config) {
  const initial = Number(account.initial_balance_lamports || 0);
  const deposits = Number(account.total_deposits_lamports || 0);
  const withdrawals = Number(account.total_withdrawals_lamports || 0);
  const realizedPnl = Number(account.realized_pnl_lamports || 0);
  const reinvestBps = clamp(
    Number(config.profit_reinvest_bps || 0),
    0,
    BPS_DENOMINATOR
  );

  const baseCapital = initial + deposits - withdrawals;
  const pnlContribution =
    realizedPnl >= 0
      ? Math.floor((realizedPnl * reinvestBps) / BPS_DENOMINATOR)
      : realizedPnl;

  return Math.max(0, baseCapital + pnlContribution);
}

function buildPaperCopySizing({ account, config, openStats, solUsdPrice }) {
  const sizingMode = String(config.sizing_mode || "");
  const sizingEquityLamports = calculateSizingEquityLamports(account, config);

  const minTradeLamports = usdToLamports(Number(config.min_trade_usd), solUsdPrice);
  const maxTradeLamports = usdToLamports(Number(config.max_trade_usd), solUsdPrice);

  if (minTradeLamports <= 0 || maxTradeLamports <= 0 || maxTradeLamports < minTradeLamports) {
    return { ok: false, reason: "invalid_trade_limits" };
  }

  let targetLamports = 0;

  if (sizingMode === "PERCENT_EQUITY") {
    const equityTradeBps = clamp(
      Number(config.equity_trade_bps || 0),
      0,
      BPS_DENOMINATOR
    );
    targetLamports = Math.floor(
      (sizingEquityLamports * equityTradeBps) / BPS_DENOMINATOR
    );
  } else if (sizingMode === "FIXED_USD") {
    targetLamports = usdToLamports(Number(config.fixed_trade_usd), solUsdPrice);
  } else {
    return { ok: false, reason: "invalid_sizing_mode" };
  }

  targetLamports = clamp(targetLamports, minTradeLamports, maxTradeLamports);

  const maxOpenPositions = Number(config.max_open_positions || 0);
  if (maxOpenPositions > 0 && openStats.openCount >= maxOpenPositions) {
    return { ok: false, reason: "max_open_positions_reached" };
  }

  const maxExposureBps = clamp(
    Number(config.max_total_exposure_bps || 0),
    0,
    BPS_DENOMINATOR
  );
  const maxExposureLamports = Math.floor(
    (sizingEquityLamports * maxExposureBps) / BPS_DENOMINATOR
  );
  const availableExposureLamports = Math.max(
    0,
    maxExposureLamports - openStats.openExposureLamports
  );

  const buyFeeLamports = Math.max(0, Math.floor(Number(config.buy_fee_lamports || 0)));
  const cashBalanceLamports = Math.max(
    0,
    Math.floor(Number(account.cash_balance_lamports || 0))
  );
  const availableCashForNotional = Math.max(0, cashBalanceLamports - buyFeeLamports);

  const finalNotionalLamports = Math.floor(
    Math.min(targetLamports, availableExposureLamports, availableCashForNotional)
  );

  if (finalNotionalLamports < minTradeLamports) {
    return {
      ok: false,
      reason: "below_min_trade_after_risk_limits",
      sizingEquityLamports,
      targetLamports,
      minTradeLamports,
      maxTradeLamports,
      availableExposureLamports,
      availableCashForNotional,
    };
  }

  return {
    ok: true,
    sizingMode,
    sizingEquityLamports,
    targetLamports,
    minTradeLamports,
    maxTradeLamports,
    maxExposureLamports,
    availableExposureLamports,
    finalNotionalLamports,
    buyFeeLamports,
    cashBalanceLamports,
  };
}

async function createPaperCopyBuy(buySignal, env) {
  if (!buySignal?.signature) return null;

  const sourceSignature = buySignal.signature;
  const operationId = `PAPER_COPY_BUY:${sourceSignature}`;
  const existing = await getPaperCopyPosition(env, sourceSignature);

  if (existing) {
    return {
      inserted: false,
      duplicate: true,
      skipped: false,
      reason: "paper_copy_position_already_exists",
      position: null,
    };
  }

  const [config, account, openStats] = await Promise.all([
    getPaperCopyConfig(env),
    getPaperCopyAccount(env),
    getOpenPaperCopyStats(env),
  ]);

  if (Number(config.enabled || 0) !== 1) {
    return {
      inserted: false,
      duplicate: false,
      skipped: true,
      reason: "paper_copy_disabled",
      position: null,
    };
  }

  const { price: solUsdPrice, source: solUsdSource } = await getSolUsdPrice(account);
  const sizing = buildPaperCopySizing({
    account,
    config,
    openStats,
    solUsdPrice,
  });

  if (!sizing.ok) {
    return {
      inserted: false,
      duplicate: false,
      skipped: true,
      reason: sizing.reason,
      sizing,
      position: null,
    };
  }

  const sourceTokenAmount = Number(buySignal.tokenAmount || 0);
  const sourceInputSOL = Number(buySignal.inputSOL || 0);

  if (
    !buySignal.mint ||
    sourceTokenAmount <= 0 ||
    sourceInputSOL <= 0
  ) {
    return {
      inserted: false,
      duplicate: false,
      skipped: true,
      reason: "invalid_source_entry",
      position: null,
    };
  }

  const sourceEntryPriceSOLPerToken = sourceInputSOL / sourceTokenAmount;
  const buySlippageBps = Math.max(
    0,
    Math.floor(Number(config.buy_slippage_bps || 0))
  );
  const simulatedEntryPriceSOLPerToken =
    sourceEntryPriceSOLPerToken *
    (1 + buySlippageBps / BPS_DENOMINATOR);

  if (
    !Number.isFinite(sourceEntryPriceSOLPerToken) ||
    sourceEntryPriceSOLPerToken <= 0 ||
    !Number.isFinite(simulatedEntryPriceSOLPerToken) ||
    simulatedEntryPriceSOLPerToken <= 0
  ) {
    return {
      inserted: false,
      duplicate: false,
      skipped: true,
      reason: "invalid_simulated_entry_price",
      position: null,
    };
  }

  const copyNotionalLamports = sizing.finalNotionalLamports;
  const copyNotionalSOL = lamportsToSOL(copyNotionalLamports);
  const simulatedTokenAmount =
    copyNotionalSOL / simulatedEntryPriceSOLPerToken;
  const buyFeeLamports = sizing.buyFeeLamports;
  const entryCostLamports = copyNotionalLamports + buyFeeLamports;
  const copyNotionalUSD = copyNotionalSOL * solUsdPrice;
  const now = new Date().toISOString();
  const openedAt = buySignal.detectedAt || now;
  const detector = buySignal.detector || "OKX_EXACT_PATTERN";
  const note =
    `Paper copy buy; sizing=${sizing.sizingMode}; ` +
    `SOL/USD=${solUsdPrice}; priceSource=${solUsdSource}; ` +
    `operationId=${operationId}`;

  if (!Number.isFinite(simulatedTokenAmount) || simulatedTokenAmount <= 0) {
    return {
      inserted: false,
      duplicate: false,
      skipped: true,
      reason: "invalid_simulated_token_amount",
      position: null,
    };
  }

  let batchResults;

  try {
    /*
     * IMPORTANT CONCURRENCY RULE:
     *
     * D1 batch() executes these statements sequentially as one transaction.
     * The first INSERT re-checks cash, open-position count, and total exposure
     * against the database state at commit time. If the guard does not pass,
     * no position is inserted. The account and ledger statements are then
     * conditional on that exact operation_id, so a blocked/duplicate INSERT
     * cannot debit cash or create a ledger row.
     */
    batchResults = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO paper_copy_positions (
          source_signature,
          mint,
          detector,
          source_entry_price_sol_per_token,
          copy_notional_lamports,
          buy_slippage_bps,
          buy_fee_lamports,
          simulated_entry_price_sol_per_token,
          simulated_token_amount,
          remaining_token_amount,
          entry_cost_lamports,
          realized_proceeds_lamports,
          realized_pnl_lamports,
          status,
          opened_at,
          updated_at,
          copy_notional_usd,
          sol_usd_at_entry,
          sizing_mode,
          sizing_basis_lamports,
          operation_id
        )
        SELECT
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          0, 0, 'PAPER_OPEN',
          ?, ?, ?, ?, ?, ?, ?
        WHERE
          EXISTS (
            SELECT 1
            FROM paper_copy_config
            WHERE id = 1
              AND enabled = 1
          )
          AND EXISTS (
            SELECT 1
            FROM paper_copy_account
            WHERE id = 1
              AND cash_balance_lamports >= ?
          )
          AND NOT EXISTS (
            SELECT 1
            FROM paper_copy_ledger
            WHERE event_type = 'PAPER_BUY'
              AND source_signature = ?
          )
          AND (
            COALESCE(
              (
                SELECT max_open_positions
                FROM paper_copy_config
                WHERE id = 1
              ),
              0
            ) <= 0
            OR (
              SELECT COUNT(*)
              FROM paper_copy_positions
              WHERE status = 'PAPER_OPEN'
            ) < (
              SELECT max_open_positions
              FROM paper_copy_config
              WHERE id = 1
            )
          )
          AND (
            (
              SELECT COALESCE(
                SUM(copy_notional_lamports),
                0
              )
              FROM paper_copy_positions
              WHERE status = 'PAPER_OPEN'
            ) + ?
          ) <= CAST(
            ? * (
              MIN(
                10000,
                MAX(
                  0,
                  COALESCE(
                    (
                      SELECT max_total_exposure_bps
                      FROM paper_copy_config
                      WHERE id = 1
                    ),
                    0
                  )
                )
              )
            ) / 10000
            AS INTEGER
          )`
      ).bind(
        sourceSignature,
        buySignal.mint,
        detector,
        sourceEntryPriceSOLPerToken,
        copyNotionalLamports,
        buySlippageBps,
        buyFeeLamports,
        simulatedEntryPriceSOLPerToken,
        simulatedTokenAmount,
        simulatedTokenAmount,
        entryCostLamports,
        openedAt,
        now,
        copyNotionalUSD,
        solUsdPrice,
        sizing.sizingMode,
        sizing.sizingEquityLamports,
        operationId,
        entryCostLamports,
        sourceSignature,
        copyNotionalLamports,
        sizing.sizingEquityLamports
      ),

      env.DB.prepare(
        `UPDATE paper_copy_account
         SET
           cash_balance_lamports =
             cash_balance_lamports - ?,
           total_fees_lamports =
             total_fees_lamports + ?,
           opened_positions_count =
             opened_positions_count + 1,
           updated_at = ?
         WHERE id = 1
           AND EXISTS (
             SELECT 1
             FROM paper_copy_positions
             WHERE operation_id = ?
               AND source_signature = ?
           )
           AND NOT EXISTS (
             SELECT 1
             FROM paper_copy_ledger
             WHERE event_type = 'PAPER_BUY'
               AND source_signature = ?
           )`
      ).bind(
        entryCostLamports,
        buyFeeLamports,
        now,
        operationId,
        sourceSignature,
        sourceSignature
      ),

      env.DB.prepare(
        `INSERT OR IGNORE INTO paper_copy_ledger (
          event_type,
          source_signature,
          exit_id,
          cash_delta_lamports,
          fee_lamports,
          balance_after_lamports,
          note,
          created_at
        )
        SELECT
          'PAPER_BUY',
          ?,
          NULL,
          ?,
          ?,
          cash_balance_lamports,
          ?,
          ?
        FROM paper_copy_account
        WHERE id = 1
          AND EXISTS (
            SELECT 1
            FROM paper_copy_positions
            WHERE operation_id = ?
              AND source_signature = ?
          )`
      ).bind(
        sourceSignature,
        -entryCostLamports,
        buyFeeLamports,
        note,
        now,
        operationId,
        sourceSignature
      ),
    ]);
  } catch (error) {
    const text = String(error);

    if (text.includes("UNIQUE constraint failed")) {
      const duplicate = await getPaperCopyPosition(env, sourceSignature);
      if (duplicate) {
        return {
          inserted: false,
          duplicate: true,
          skipped: false,
          reason: "paper_copy_position_already_exists",
          position: null,
        };
      }
    }

    console.error({
      message: "❌ DATABASE ERROR",
      operation: "create_paper_copy_buy",
      sourceSignature,
      operationId,
      error: text,
    });
    throw new DatabaseError("create_paper_copy_buy", error);
  }

  const positionChanges = Number(batchResults?.[0]?.meta?.changes ?? 0);
  const accountChanges = Number(batchResults?.[1]?.meta?.changes ?? 0);
  const ledgerChanges = Number(batchResults?.[2]?.meta?.changes ?? 0);

  if (positionChanges !== 1) {
    const duplicate = await getPaperCopyPosition(env, sourceSignature);

    if (duplicate) {
      return {
        inserted: false,
        duplicate: true,
        skipped: false,
        reason: "paper_copy_position_already_exists",
        position: null,
      };
    }

    const [freshAccount, freshOpenStats] = await Promise.all([
      getPaperCopyAccount(env),
      getOpenPaperCopyStats(env),
    ]);

    const freshSizing = buildPaperCopySizing({
      account: freshAccount,
      config,
      openStats: freshOpenStats,
      solUsdPrice,
    });

    return {
      inserted: false,
      duplicate: false,
      skipped: true,
      reason: freshSizing.ok
        ? "risk_guard_blocked_at_commit"
        : freshSizing.reason,
      sizing: freshSizing,
      position: null,
    };
  }

  if (accountChanges !== 1 || ledgerChanges !== 1) {
    const error = new Error(
      `Paper-copy accounting invariant failed: ` +
      `position=${positionChanges}, account=${accountChanges}, ledger=${ledgerChanges}`
    );

    console.error({
      message: "❌ DATABASE ERROR",
      operation: "verify_paper_copy_buy_batch",
      sourceSignature,
      operationId,
      positionChanges,
      accountChanges,
      ledgerChanges,
      error: String(error),
    });

    throw new DatabaseError(
      "verify_paper_copy_buy_batch",
      error
    );
  }

  const freshAccount = await getPaperCopyAccount(env);

  return {
    inserted: true,
    duplicate: false,
    skipped: false,
    reason: null,
    position: {
      message: "📘 PAPER COPY BUY",
      action: "PAPER_COPY_BUY",
      status: "PAPER_OPEN",
      sourceSignature,
      operationId,
      mint: buySignal.mint,
      detector,
      sizingMode: sizing.sizingMode,
      sizingBasisLamports: sizing.sizingEquityLamports,
      copyNotionalLamports,
      copyNotionalSOL,
      copyNotionalUSD,
      sourceEntryPriceSOLPerToken,
      buySlippageBps,
      simulatedEntryPriceSOLPerToken,
      simulatedTokenAmount,
      buyFeeLamports,
      entryCostLamports,
      solUsdAtEntry: solUsdPrice,
      solUsdSource,
      cashBalanceAfterLamports: Number(
        freshAccount.cash_balance_lamports || 0
      ),
      cashBalanceAfterSOL: lamportsToSOL(
        freshAccount.cash_balance_lamports || 0
      ),
      openedAt,
      execution: "DISABLED",
      realMoney: false,
    },
  };
}

async function handleWebhook(request, env) {
  let body;

  try {
    body = await request.json();
  } catch (error) {
    console.error({ message: "❌ INVALID JSON", error: String(error) });
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const transactions = normalizeTransactions(body);

  console.log({
    message: "📥 HELIUS POST RECEIVED",
    receivedCount: transactions.length,
    receivedAt: new Date().toISOString(),
  });

  if (transactions.length === 0) {
    console.warn({ message: "⚠️ EMPTY HELIUS PAYLOAD" });
    return jsonResponse({
      ok: true,
      received: 0,
      execution: "DISABLED",
      realMoney: false,
    });
  }

  let candidates = 0;
  let buySignals = 0;
  let paperBuys = 0;
  let paperCopyBuys = 0;
  let paperCopySkips = 0;
  let duplicates = 0;

  try {
    for (const tx of transactions) {
      const diagnostic = buildDiagnosticEvent(tx);
      console.log(diagnostic);

      const signature = tx?.signature || null;

      if (!signature) {
        console.warn({ message: "⚠️ EVENT WITHOUT SIGNATURE" });
        continue;
      }

      const processingState = await beginSignatureProcessing(env, signature);

      if (processingState.duplicate) {
        duplicates++;
        console.log({
          message: "♻️ DUPLICATE SIGNATURE",
          signature,
          detector: processingState.record?.detector || null,
          action: processingState.record?.action || null,
        });
        continue;
      }

      const candidate = buildSwapCandidate(tx);

      if (!candidate) {
        await markProcessedSignature(env, signature, null, "NO_MATCH");
        console.log({
          message: "⚪ NO MATCHING CANDIDATE",
          signature,
          type: tx?.type || null,
          source: tx?.source || null,
          reason:
            "No exact OKX 0.001 SOL match and no complete routed WSOL -> token -> Gake economic chain",
        });
        continue;
      }

      candidates++;
      console.log(candidate);

      const { signal, rejectionReasons } = buildBuySignal(candidate);

      if (!signal) {
        const detector = candidate.detector || "OKX_EXACT_PATTERN";
        await markProcessedSignature(env, signature, detector, "REJECTED");
        console.log({
          message: "🟡 CANDIDATE REJECTED",
          signature,
          rejectionReasons,
          candidate,
        });
        continue;
      }

      buySignals++;
      console.log(signal);

      const paperBuyResult = await createPaperBuy(signal, env);

      if (!paperBuyResult) {
        throw new Error("Accepted BUY signal could not produce a paper position");
      }

      if (paperBuyResult.inserted && paperBuyResult.position) {
        paperBuys++;
        console.log(paperBuyResult.position);
      }

      /*
       * Always ensure the copy position before making the signature terminal.
       * This preserves crash recovery if the source paper position was inserted
       * but the worker stopped before the paper-copy accounting completed.
       */
      const paperCopyResult = await createPaperCopyBuy(signal, env);

      if (paperCopyResult?.inserted && paperCopyResult.position) {
        paperCopyBuys++;
        console.log(paperCopyResult.position);
      } else if (paperCopyResult?.skipped) {
        paperCopySkips++;
        console.log({
          message: "⏭️ PAPER COPY SKIPPED",
          action: "PAPER_COPY_SKIPPED",
          sourceSignature: signature,
          mint: signal.mint,
          detector: signal.detector,
          reason: paperCopyResult.reason,
          sizing: paperCopyResult.sizing || null,
          execution: "DISABLED",
          realMoney: false,
        });
      } else if (paperCopyResult?.duplicate) {
        console.log({
          message: "♻️ PAPER COPY POSITION ALREADY EXISTS",
          sourceSignature: signature,
          mint: signal.mint,
          detector: signal.detector,
        });
      }

      /*
       * Terminal update happens only after both durable source-paper storage
       * and paper-copy handling have completed.
       */
      await markProcessedSignature(env, signature, signal.detector, "PAPER_BUY");
    }
  } catch (error) {
    if (error instanceof DatabaseError) {
      return jsonResponse(
        {
          ok: false,
          error: "database_error",
          execution: "DISABLED",
          realMoney: false,
        },
        503
      );
    }

    console.error({
      message: "❌ WEBHOOK PROCESSING ERROR",
      error: String(error),
    });

    return jsonResponse(
      {
        ok: false,
        error: "processing_error",
        execution: "DISABLED",
        realMoney: false,
      },
      500
    );
  }

  return jsonResponse({
    ok: true,
    received: transactions.length,
    duplicates,
    candidates,
    buySignals,
    paperBuys,
    paperCopyBuys,
    paperCopySkips,
    execution: "DISABLED",
    realMoney: false,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return jsonResponse({
        ok: true,
        service: "gake-trader-bot",
        status: "RUNNING",
        version: "GAKE-D1-PAPER-COPY-V1",
        strategy: "OKX_EXACT_THEN_ROUTED_WSOL_PAPER_COPY_D1",
        webhookModeExpected: "ANY",
        databaseBinding: env?.DB ? "BOUND" : "MISSING",
        paperCopyAccounting: "ENABLED",
        paperCopyRiskGuard: "D1_BATCH_TRANSACTIONAL",
        solUsdPricing: "COINGECKO_WITH_ACCOUNT_FALLBACK",
        execution: "DISABLED",
        realMoney: false,
        monitoredWallet: GAKE_WALLET,
        inputPatternLamports: OKX_INPUT_PATTERN,
        expectedInputLamports: OKX_INPUT_TOTAL_LAMPORTS,
        serverTime: new Date().toISOString(),
      });
    }

    if (request.method === "POST") {
      if (!env?.DB) {
        console.error({
          message: "❌ DATABASE ERROR",
          operation: "validate_database_binding",
          error: "env.DB is missing",
        });

        return jsonResponse(
          {
            ok: false,
            error: "database_error",
            execution: "DISABLED",
            realMoney: false,
          },
          503
        );
      }

      return handleWebhook(request, env);
    }

    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  },
};
