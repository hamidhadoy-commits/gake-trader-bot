import {
  fetchPaperExitSolPrices,
  fetchJupiterExecutableSellQuote,
} from "./price-provider.js";
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
      `SELECT
   COUNT(*) AS open_count,
   COALESCE(
     SUM(
       CASE
         WHEN simulated_token_amount > 0
           AND remaining_token_amount > 0
         THEN CAST(
           copy_notional_lamports *
           remaining_token_amount /
           simulated_token_amount
           AS INTEGER
         )
         ELSE 0
       END
     ),
     0
   ) AS open_exposure_lamports
 FROM paper_copy_positions
 WHERE status = 'PAPER_OPEN'`
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
                SUM(
  CASE
    WHEN simulated_token_amount > 0
      AND remaining_token_amount > 0
    THEN CAST(
      copy_notional_lamports *
      remaining_token_amount /
      simulated_token_amount
      AS INTEGER
    )
    ELSE 0
  END
),
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

const DEXSCREENER_TOKEN_URL_PREFIX =
  "https://api.dexscreener.com/tokens/v1/solana/";
const DEXSCREENER_MAX_TOKENS_PER_REQUEST = 30;

async function getOpenPaperExitPositions(env) {
  const result = await runDatabaseOperation("get_open_paper_exit_positions", () =>
    env.DB.prepare(
      `SELECT
         source_signature,
         mint,
         detector,
         simulated_entry_price_sol_per_token,
         simulated_token_amount,
         remaining_token_amount,
         entry_cost_lamports,
         realized_proceeds_lamports,
         realized_pnl_lamports,
         highest_price_sol_per_token,
         take_profit_hit,
         status,
         opened_at,
         updated_at
       FROM paper_copy_positions
       WHERE status = 'PAPER_OPEN'
         AND remaining_token_amount > 0
       ORDER BY opened_at ASC`
    ).all()
  );

  return Array.isArray(result?.results) ? result.results : [];
}

async function getPaperExitPosition(env, sourceSignature) {
  return runDatabaseOperation("get_paper_exit_position", () =>
    env.DB.prepare(
      `SELECT
         source_signature,
         mint,
         detector,
         simulated_entry_price_sol_per_token,
         simulated_token_amount,
         remaining_token_amount,
         entry_cost_lamports,
         realized_proceeds_lamports,
         realized_pnl_lamports,
         highest_price_sol_per_token,
         take_profit_hit,
         status,
         opened_at,
         updated_at,
         closed_at,
         close_reason
       FROM paper_copy_positions
       WHERE source_signature = ?
       LIMIT 1`
    )
      .bind(sourceSignature)
      .first()
  );
}

async function refreshPaperPositionHigh(env, sourceSignature, observedPrice) {
  if (!Number.isFinite(observedPrice) || observedPrice <= 0) return;

  const now = new Date().toISOString();

  await runDatabaseOperation("refresh_paper_position_high", () =>
    env.DB.prepare(
      `UPDATE paper_copy_positions
       SET
         highest_price_sol_per_token =
           MAX(?, simulated_entry_price_sol_per_token),
         updated_at = ?
       WHERE source_signature = ?
         AND status = 'PAPER_OPEN'
         AND (
           highest_price_sol_per_token IS NULL
           OR MAX(?, simulated_entry_price_sol_per_token) >
              highest_price_sol_per_token
         )`
    )
      .bind(observedPrice, now, sourceSignature, observedPrice)
      .run()
  );
}

function selectBestSolQuotedPair(pairs, mint) {
  let best = null;

  for (const pair of pairs) {
    if (pair?.chainId !== "solana") continue;
    if (pair?.baseToken?.address !== mint) continue;
    if (pair?.quoteToken?.address !== WRAPPED_SOL_MINT) continue;

    const priceSOLPerToken = Number(pair?.priceNative);
    const liquidityUSD = Number(pair?.liquidity?.usd || 0);

    if (!Number.isFinite(priceSOLPerToken) || priceSOLPerToken <= 0) continue;

    if (!best || liquidityUSD > best.liquidityUSD) {
      best = {
        priceSOLPerToken,
        liquidityUSD: Number.isFinite(liquidityUSD) ? liquidityUSD : 0,
        pairAddress: pair?.pairAddress || null,
        dexId: pair?.dexId || null,
        url: pair?.url || null,
      };
    }
  }

  return best;
}

async function fetchDexScreenerSolPrices(mints) {
  const uniqueMints = [...new Set((mints || []).filter(Boolean))];
  const prices = new Map();

  for (
    let offset = 0;
    offset < uniqueMints.length;
    offset += DEXSCREENER_MAX_TOKENS_PER_REQUEST
  ) {
    const chunk = uniqueMints.slice(
      offset,
      offset + DEXSCREENER_MAX_TOKENS_PER_REQUEST
    );

    if (!chunk.length) continue;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(
        `${DEXSCREENER_TOKEN_URL_PREFIX}${chunk.join(",")}`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new Error(`DEX Screener HTTP ${response.status}`);
      }

      const payload = await response.json();
      const pairs = Array.isArray(payload) ? payload : [];

      for (const mint of chunk) {
        const best = selectBestSolQuotedPair(pairs, mint);
        if (best) prices.set(mint, best);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return prices;
}

function buildPaperExitThresholds(position, config, observedPrice) {
  const entryPrice = Number(position?.simulated_entry_price_sol_per_token || 0);
  const storedHigh = Number(position?.highest_price_sol_per_token || 0);
  const highPrice = Math.max(entryPrice, storedHigh, observedPrice);

  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0 ||
    !Number.isFinite(observedPrice) ||
    observedPrice <= 0
  ) {
    return null;
  }

  const stopLossBps = clamp(
    Math.floor(Number(config?.stop_loss_bps || 0)),
    0,
    BPS_DENOMINATOR
  );
  const takeProfitBps = Math.max(
    0,
    Math.floor(Number(config?.take_profit_bps || 0))
  );
  const trailingStopBps = clamp(
    Math.floor(Number(config?.trailing_stop_bps || 0)),
    0,
    BPS_DENOMINATOR
  );

  return {
    entryPrice,
    highPrice,
    stopLossPrice:
      entryPrice * (1 - stopLossBps / BPS_DENOMINATOR),
    takeProfitPrice:
      entryPrice * (1 + takeProfitBps / BPS_DENOMINATOR),
    trailingStopPrice:
      highPrice * (1 - trailingStopBps / BPS_DENOMINATOR),
    stopLossBps,
    takeProfitBps,
    trailingStopBps,
  };
}

async function getPaperExitAccountingState(env, sourceSignature) {
  const row = await runDatabaseOperation("get_paper_exit_accounting_state", () =>
    env.DB.prepare(
      `SELECT
         COALESCE(MAX(exit_sequence), 0) + 1 AS next_sequence,
         COALESCE(SUM(allocated_entry_cost_lamports), 0) AS allocated_entry_cost_lamports
       FROM paper_copy_exits
       WHERE source_signature = ?`
    )
      .bind(sourceSignature)
      .first()
  );

  return {
    nextSequence: Math.max(1, Math.floor(Number(row?.next_sequence || 1))),
    allocatedEntryCostLamports: Math.max(
      0,
      Math.floor(Number(row?.allocated_entry_cost_lamports || 0))
    ),
  };
}

async function executePaperCopyExit({
  env,
  position,
  config,
  exitReason,
    triggerPriceSOLPerToken,
  executionPriceSOLPerToken = null,
  soldTokenAmount,
  closePosition,
  markTakeProfit,
}) {
  const sourceSignature = position?.source_signature || null;
  const initialTokenAmount = Number(position?.simulated_token_amount || 0);
  const remainingTokenAmount = Number(position?.remaining_token_amount || 0);
  const entryCostLamports = Math.max(
    0,
    Math.floor(Number(position?.entry_cost_lamports || 0))
  );

  if (
    !sourceSignature ||
    !Number.isFinite(triggerPriceSOLPerToken) ||
    triggerPriceSOLPerToken <= 0 ||
    !Number.isFinite(initialTokenAmount) ||
    initialTokenAmount <= 0 ||
    !Number.isFinite(remainingTokenAmount) ||
    remainingTokenAmount <= 0
  ) {
    return { inserted: false, skipped: true, reason: "invalid_exit_position" };
  }

  const tokensToSell = Math.min(
    remainingTokenAmount,
    Math.max(0, Number(soldTokenAmount || 0))
  );

  if (!Number.isFinite(tokensToSell) || tokensToSell <= 0) {
    return { inserted: false, skipped: true, reason: "invalid_exit_amount" };
  }

  const sellSlippageBps = clamp(
    Math.floor(Number(config?.sell_slippage_bps || 0)),
    0,
    BPS_DENOMINATOR
  );
  const sellFeeLamports = Math.max(
    0,
    Math.floor(Number(config?.sell_fee_lamports || 0))
  );
  const executableBasePriceSOLPerToken = Number(
  executionPriceSOLPerToken || triggerPriceSOLPerToken
);

if (
  !Number.isFinite(executableBasePriceSOLPerToken) ||
  executableBasePriceSOLPerToken <= 0
) {
  return {
    inserted: false,
    skipped: true,
    reason: "invalid_executable_exit_price",
  };
}

const simulatedExitPriceSOLPerToken =
  executableBasePriceSOLPerToken *
  (1 - sellSlippageBps / BPS_DENOMINATOR);

  const grossProceedsLamports = Math.floor(
  tokensToSell *
    executableBasePriceSOLPerToken *
    LAMPORTS_PER_SOL
);
  const postSlippageProceedsLamports = Math.floor(
    tokensToSell * simulatedExitPriceSOLPerToken * LAMPORTS_PER_SOL
  );
  const netProceedsLamports =
    postSlippageProceedsLamports - sellFeeLamports;

  if (
    !Number.isFinite(simulatedExitPriceSOLPerToken) ||
    simulatedExitPriceSOLPerToken < 0 ||
    !Number.isSafeInteger(grossProceedsLamports) ||
    !Number.isSafeInteger(postSlippageProceedsLamports) ||
    !Number.isSafeInteger(netProceedsLamports)
  ) {
    return { inserted: false, skipped: true, reason: "invalid_exit_proceeds" };
  }

  const accountingState = await getPaperExitAccountingState(
    env,
    sourceSignature
  );
  const unallocatedEntryCostLamports = Math.max(
    0,
    entryCostLamports - accountingState.allocatedEntryCostLamports
  );

  let allocatedEntryCostLamports;

  if (closePosition) {
    allocatedEntryCostLamports = unallocatedEntryCostLamports;
  } else {
    const proportionalCost = Math.floor(
      entryCostLamports *
      clamp(tokensToSell / initialTokenAmount, 0, 1)
    );
    allocatedEntryCostLamports = Math.min(
      unallocatedEntryCostLamports,
      Math.max(0, proportionalCost)
    );
  }

  const realizedPnlLamports =
    netProceedsLamports - allocatedEntryCostLamports;
  const exitSequence = accountingState.nextSequence;
  const operationId =
    `PAPER_COPY_EXIT:${sourceSignature}:${exitSequence}:${exitReason}`;
  const now = new Date().toISOString();
  const note =
    `Paper copy sell; reason=${exitReason}; ` +
    `operationId=${operationId}; triggerPriceSOL=${triggerPriceSOLPerToken}; ` +
    `simulatedExitPriceSOL=${simulatedExitPriceSOLPerToken}`;

  const exitGuard = markTakeProfit
    ? "AND take_profit_hit = 0"
    : "";

  const positionUpdateSQL = closePosition
    ? `UPDATE paper_copy_positions
       SET
         remaining_token_amount = 0,
         realized_proceeds_lamports =
           realized_proceeds_lamports + ?,
         realized_pnl_lamports =
           realized_pnl_lamports + ?,
         status = 'PAPER_CLOSED',
         take_profit_hit = CASE WHEN ? = 1 THEN 1 ELSE take_profit_hit END,
         closed_at = ?,
         close_reason = ?,
         updated_at = ?
       WHERE source_signature = ?
         AND status = 'PAPER_OPEN'
         AND EXISTS (
           SELECT 1
           FROM paper_copy_exits
           WHERE operation_id = ?
         )
         AND NOT EXISTS (
           SELECT 1
           FROM paper_copy_ledger
           WHERE event_type = 'PAPER_SELL'
             AND exit_id = (
               SELECT id
               FROM paper_copy_exits
               WHERE operation_id = ?
               LIMIT 1
             )
         )`
    : `UPDATE paper_copy_positions
       SET
         remaining_token_amount =
           MAX(0, remaining_token_amount - ?),
         realized_proceeds_lamports =
           realized_proceeds_lamports + ?,
         realized_pnl_lamports =
           realized_pnl_lamports + ?,
         take_profit_hit = CASE WHEN ? = 1 THEN 1 ELSE take_profit_hit END,
         updated_at = ?
       WHERE source_signature = ?
         AND status = 'PAPER_OPEN'
         AND EXISTS (
           SELECT 1
           FROM paper_copy_exits
           WHERE operation_id = ?
         )
         AND NOT EXISTS (
           SELECT 1
           FROM paper_copy_ledger
           WHERE event_type = 'PAPER_SELL'
             AND exit_id = (
               SELECT id
               FROM paper_copy_exits
               WHERE operation_id = ?
               LIMIT 1
             )
         )`;

  const positionStatement = closePosition
    ? env.DB.prepare(positionUpdateSQL).bind(
        netProceedsLamports,
        realizedPnlLamports,
        markTakeProfit ? 1 : 0,
        now,
        exitReason,
        now,
        sourceSignature,
        operationId,
        operationId
      )
    : env.DB.prepare(positionUpdateSQL).bind(
        tokensToSell,
        netProceedsLamports,
        realizedPnlLamports,
        markTakeProfit ? 1 : 0,
        now,
        sourceSignature,
        operationId,
        operationId
      );

  let batchResults;

  try {
    batchResults = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO paper_copy_exits (
          source_signature,
          exit_reason,
          sold_token_amount,
          trigger_price_sol_per_token,
          simulated_exit_price_sol_per_token,
          sell_slippage_bps,
          sell_fee_lamports,
          gross_proceeds_lamports,
          net_proceeds_lamports,
          realized_pnl_lamports,
          exited_at,
          created_at,
          exit_sequence,
          allocated_entry_cost_lamports,
          operation_id
        )
        SELECT
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM paper_copy_positions
          WHERE source_signature = ?
            AND status = 'PAPER_OPEN'
            AND remaining_token_amount > 0
            ${exitGuard}
        )`
      ).bind(
        sourceSignature,
        exitReason,
        tokensToSell,
        triggerPriceSOLPerToken,
        simulatedExitPriceSOLPerToken,
        sellSlippageBps,
        sellFeeLamports,
        grossProceedsLamports,
        netProceedsLamports,
        realizedPnlLamports,
        now,
        now,
        exitSequence,
        allocatedEntryCostLamports,
        operationId,
        sourceSignature
      ),

      positionStatement,

      env.DB.prepare(
        `UPDATE paper_copy_account
         SET
           cash_balance_lamports =
             cash_balance_lamports + ?,
           realized_pnl_lamports =
             realized_pnl_lamports + ?,
           total_fees_lamports =
             total_fees_lamports + ?,
           opened_positions_count =
             CASE
               WHEN ? = 1 THEN MAX(0, opened_positions_count - 1)
               ELSE opened_positions_count
             END,
           closed_positions_count =
             closed_positions_count + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
           updated_at = ?
         WHERE id = 1
           AND EXISTS (
             SELECT 1
             FROM paper_copy_exits
             WHERE operation_id = ?
           )
           AND NOT EXISTS (
             SELECT 1
             FROM paper_copy_ledger
             WHERE event_type = 'PAPER_SELL'
               AND exit_id = (
                 SELECT id
                 FROM paper_copy_exits
                 WHERE operation_id = ?
                 LIMIT 1
               )
           )`
      ).bind(
        netProceedsLamports,
        realizedPnlLamports,
        sellFeeLamports,
        closePosition ? 1 : 0,
        closePosition ? 1 : 0,
        now,
        operationId,
        operationId
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
          'PAPER_SELL',
          ?,
          e.id,
          ?,
          ?,
          a.cash_balance_lamports,
          ?,
          ?
        FROM paper_copy_account a
        JOIN paper_copy_exits e
          ON e.operation_id = ?
        WHERE a.id = 1
          AND NOT EXISTS (
            SELECT 1
            FROM paper_copy_ledger l
            WHERE l.event_type = 'PAPER_SELL'
              AND l.exit_id = e.id
          )`
      ).bind(
        sourceSignature,
        netProceedsLamports,
        sellFeeLamports,
        note,
        now,
        operationId
      ),
    ]);
  } catch (error) {
    console.error({
      message: "❌ DATABASE ERROR",
      operation: "execute_paper_copy_exit",
      sourceSignature,
      exitReason,
      operationId,
      error: String(error),
    });
    throw new DatabaseError("execute_paper_copy_exit", error);
  }

  const exitChanges = Number(batchResults?.[0]?.meta?.changes ?? 0);
  const positionChanges = Number(batchResults?.[1]?.meta?.changes ?? 0);
  const accountChanges = Number(batchResults?.[2]?.meta?.changes ?? 0);
  const ledgerChanges = Number(batchResults?.[3]?.meta?.changes ?? 0);

  if (exitChanges !== 1) {
    return {
      inserted: false,
      skipped: true,
      reason: "exit_guard_or_idempotency_blocked",
      operationId,
    };
  }

  if (
    positionChanges !== 1 ||
    accountChanges !== 1 ||
    ledgerChanges !== 1
  ) {
    const error = new Error(
      `Paper-copy exit accounting invariant failed: ` +
      `exit=${exitChanges}, position=${positionChanges}, ` +
      `account=${accountChanges}, ledger=${ledgerChanges}`
    );

    console.error({
      message: "❌ DATABASE ERROR",
      operation: "verify_paper_copy_exit_batch",
      sourceSignature,
      exitReason,
      operationId,
      exitChanges,
      positionChanges,
      accountChanges,
      ledgerChanges,
      error: String(error),
    });

    throw new DatabaseError("verify_paper_copy_exit_batch", error);
  }

  const freshAccount = await getPaperCopyAccount(env);

  return {
    inserted: true,
    skipped: false,
    exit: {
      message: "📕 PAPER COPY SELL",
      action: "PAPER_COPY_SELL",
      sourceSignature,
      mint: position.mint,
      exitReason,
      exitSequence,
      operationId,
      triggerPriceSOLPerToken,
      simulatedExitPriceSOLPerToken,
      soldTokenAmount: tokensToSell,
      grossProceedsLamports,
      sellSlippageBps,
      sellFeeLamports,
      netProceedsLamports,
      allocatedEntryCostLamports,
      realizedPnlLamports,
      closePosition,
      cashBalanceAfterLamports: Number(
        freshAccount.cash_balance_lamports || 0
      ),
      accountRealizedPnlLamports: Number(
        freshAccount.realized_pnl_lamports || 0
      ),
      execution: "DISABLED",
      realMoney: false,
      exitedAt: now,
    },
  };
}
async function recordPaperExitNoRoute({
  env,
  position,
  exitReason,
  tokenAmount,
  quote,
}) {
  const sourceSignature =
    position?.source_signature || null;
  const mint = position?.mint || null;
  const amount = Number(tokenAmount || 0);

  if (
    !env?.DB ||
    !sourceSignature ||
    !mint ||
    !exitReason
  ) {
    return;
  }

  const now = new Date().toISOString();

  await runDatabaseOperation(
    "record_paper_exit_no_route",
    () =>
      env.DB.prepare(
        `INSERT INTO paper_exit_blocks (
           source_signature,
           mint,
           exit_reason,
           token_amount,
           raw_amount,
           decimals,
           block_reason,
           http_status,
           response_body,
           first_seen_at,
           last_seen_at,
           attempt_count,
           resolved_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
         ON CONFLICT(source_signature, exit_reason)
         DO UPDATE SET
           mint = excluded.mint,
           token_amount = excluded.token_amount,
           raw_amount = excluded.raw_amount,
           decimals = excluded.decimals,
           block_reason = excluded.block_reason,
           http_status = excluded.http_status,
           response_body = excluded.response_body,
           last_seen_at = excluded.last_seen_at,
           attempt_count =
             paper_exit_blocks.attempt_count + 1,
           resolved_at = NULL`
      )
        .bind(
          sourceSignature,
          mint,
          exitReason,
          amount,
          quote?.rawAmount != null
            ? String(quote.rawAmount)
            : null,
          Number.isInteger(quote?.decimals)
            ? quote.decimals
            : null,
          quote?.reason || "no_route",
          quote?.status ?? null,
          quote?.responseBody ?? null,
          now,
          now
        )
        .run()
  );
}

async function resolvePaperExitNoRoute({
  env,
  position,
  exitReason,
}) {
  const sourceSignature =
    position?.source_signature || null;

  if (
    !env?.DB ||
    !sourceSignature ||
    !exitReason
  ) {
    return;
  }

  const now = new Date().toISOString();

  await runDatabaseOperation(
    "resolve_paper_exit_no_route",
    () =>
      env.DB.prepare(
        `UPDATE paper_exit_blocks
         SET resolved_at = ?
         WHERE source_signature = ?
           AND exit_reason = ?
           AND resolved_at IS NULL`
      )
        .bind(
          now,
          sourceSignature,
          exitReason
        )
        .run()
  );
    }
async function getPaperExitExecutableQuote({
  env,
  position,
  tokenAmount,
  exitReason,
}) {
  const sourceSignature = position?.source_signature || null;
  const mint = position?.mint || null;
  const amount = Number(tokenAmount || 0);

  const quote = await fetchJupiterExecutableSellQuote({
    mint,
    tokenAmount: amount,
    wrappedSolMint: WRAPPED_SOL_MINT,
    jupiterApiKey: env?.JUPITER_API_KEY || null,
  });

  if (!quote?.executable) {
    if (quote?.reason === "no_route") {
  await recordPaperExitNoRoute({
    env,
    position,
    exitReason,
    tokenAmount: amount,
    quote,
  });
    }
    console.warn({
      message: "⛔ PAPER EXIT BLOCKED NO ROUTE",
      sourceSignature,
      mint,
      exitReason,
      blockState:
  quote?.reason === "no_route"
    ? "EXIT_BLOCKED_NO_ROUTE"
    : null,
      tokenAmount: amount,
      reason: quote?.reason || "quote_unavailable",
      status: quote?.status ?? null,
      responseBody: quote?.responseBody ?? null,
      execution: "DISABLED",
      realMoney: false,
    });

    return null;
  }
await resolvePaperExitNoRoute({
  env,
  position,
  exitReason,
});
  console.log({
    message: "✅ PAPER EXIT EXECUTABLE QUOTE",
    sourceSignature,
    mint,
    exitReason,
    tokenAmount: amount,
    quotedTokenAmount: quote.quotedTokenAmount,
    outSOL: quote.outSOL,
    effectivePriceSOLPerToken: quote.effectivePriceSOLPerToken,
    router: quote.router || null,
    execution: "DISABLED",
    realMoney: false,
  });

  return quote;
      }
async function processPaperExitPosition(env, rawPosition, config, priceInfo) {
  const sourceSignature = rawPosition?.source_signature || null;
  const observedPrice = Number(priceInfo?.priceSOLPerToken || 0);

  if (!sourceSignature || !Number.isFinite(observedPrice) || observedPrice <= 0) {
    return { exits: 0, skipped: 1 };
  }

  await refreshPaperPositionHigh(env, sourceSignature, observedPrice);
  let position = await getPaperExitPosition(env, sourceSignature);

  if (!position || position.status !== "PAPER_OPEN") {
    return { exits: 0, skipped: 1 };
  }

  let thresholds = buildPaperExitThresholds(position, config, observedPrice);
  if (!thresholds) return { exits: 0, skipped: 1 };

  console.log({
    message: "📈 PAPER PRICE",
    sourceSignature,
    mint: position.mint,
    observedPriceSOLPerToken: observedPrice,
    highestPriceSOLPerToken: thresholds.highPrice,
    entryPriceSOLPerToken: thresholds.entryPrice,
    stopLossPriceSOLPerToken: thresholds.stopLossPrice,
    takeProfitPriceSOLPerToken: thresholds.takeProfitPrice,
    trailingStopPriceSOLPerToken: thresholds.trailingStopPrice,
    takeProfitHit: Number(position.take_profit_hit || 0),
    remainingTokenAmount: Number(position.remaining_token_amount || 0),
    pairAddress: priceInfo?.pairAddress || null,
    dexId: priceInfo?.dexId || null,
    liquidityUSD: Number(priceInfo?.liquidityUSD || 0),
    priceSource: priceInfo?.source || null,
  });

  let exits = 0;

  if (observedPrice <= thresholds.stopLossPrice) {
  const tokenAmount = Number(position.remaining_token_amount || 0);

  const executableQuote = await getPaperExitExecutableQuote({
    env,
    position,
    tokenAmount,
    exitReason: "STOP_LOSS",
  });

  if (!executableQuote) {
    return { exits, skipped: 1 };
  }

  const result = await executePaperCopyExit({
    env,
    position,
    config,
    exitReason: "STOP_LOSS",
    triggerPriceSOLPerToken: observedPrice,
    executionPriceSOLPerToken:
      executableQuote.effectivePriceSOLPerToken,
    soldTokenAmount: tokenAmount,
    closePosition: true,
    markTakeProfit: false,
  });

  if (result?.inserted && result.exit) {
    exits++;
    console.log(result.exit);
  }
    
  return { exits, skipped: result?.inserted ? 0 : 1 };
  }

  const takeProfitEnabled = Number(config?.take_profit_enabled || 0) === 1;
  const takeProfitHit = Number(position.take_profit_hit || 0) === 1;
  const takeProfitSellBps = clamp(
    Math.floor(Number(config?.take_profit_sell_bps || 0)),
    0,
    BPS_DENOMINATOR
  );
  if (
  takeProfitEnabled &&
  !takeProfitHit &&
  takeProfitSellBps > 0 &&
  observedPrice >= thresholds.takeProfitPrice
) {
  const targetSellAmount =
    Number(position.simulated_token_amount || 0) *
    (takeProfitSellBps / BPS_DENOMINATOR);

  const tokenAmount = Math.min(
    targetSellAmount,
    Number(position.remaining_token_amount || 0)
  );

  const executableQuote = await getPaperExitExecutableQuote({
    env,
    position,
    tokenAmount,
    exitReason: "TAKE_PROFIT_PARTIAL",
  });

  if (!executableQuote) {
    return { exits, skipped: 1 };
  }

  const result = await executePaperCopyExit({
    env,
    position,
    config,
    exitReason: "TAKE_PROFIT_PARTIAL",
    triggerPriceSOLPerToken: observedPrice,
    executionPriceSOLPerToken:
      executableQuote.effectivePriceSOLPerToken,
    soldTokenAmount: tokenAmount,
    closePosition:
      tokenAmount >= Number(position.remaining_token_amount || 0),
    markTakeProfit: true,
  });

  if (result?.inserted && result.exit) {
    exits++;
    console.log(result.exit);
  }

  position = await getPaperExitPosition(env, sourceSignature);

  if (!position || position.status !== "PAPER_OPEN") {
    return { exits, skipped: 0 };
  }

  thresholds = buildPaperExitThresholds(
    position,
    config,
    observedPrice
  );

  if (!thresholds) {
    return { exits, skipped: 1 };
  }
      }
const trailingStopEnabled =
  Number(config?.trailing_stop_enabled || 0) === 1;

if (
  trailingStopEnabled &&
  Number(config?.trailing_stop_bps || 0) > 0 &&
  observedPrice <= thresholds.trailingStopPrice
) {
  const tokenAmount = Number(
    position.remaining_token_amount || 0
  );

  const executableQuote = await getPaperExitExecutableQuote({
    env,
    position,
    tokenAmount,
    exitReason: "TRAILING_STOP",
  });

  if (!executableQuote) {
    return { exits, skipped: 1 };
  }

  const result = await executePaperCopyExit({
    env,
    position,
    config,
    exitReason: "TRAILING_STOP",
    triggerPriceSOLPerToken: observedPrice,
    executionPriceSOLPerToken:
      executableQuote.effectivePriceSOLPerToken,
    soldTokenAmount: tokenAmount,
    closePosition: true,
    markTakeProfit: false,
  });

  if (result?.inserted && result.exit) {
    exits++;
    console.log(result.exit);
  }

  return {
    exits,
    skipped: result?.inserted ? 0 : 1,
  };
}

  return { exits, skipped: 0 };
}
async function getPendingPaperEntryRouteCheck(env) {
  return runDatabaseOperation(
    "get_pending_paper_entry_route_check",
    () =>
      env.DB.prepare(
        `SELECT
           p.source_signature,
           p.mint,
           p.simulated_token_amount,
           p.remaining_token_amount,
           p.opened_at
         FROM paper_copy_positions p
         LEFT JOIN paper_entry_route_checks c
           ON c.source_signature = p.source_signature
         WHERE c.source_signature IS NULL
           AND p.status = 'PAPER_OPEN'
           AND p.simulated_token_amount > 0
         ORDER BY p.opened_at ASC
         LIMIT 1`
      ).first()
  );
}

async function runOnePaperEntryRouteObservation(env) {
  const position =
    await getPendingPaperEntryRouteCheck(env);

  if (!position) {
    return {
      checked: 0,
      deferred: 0,
      reason: "no_pending_position",
    };
  }

  const sourceSignature =
    position.source_signature;

  const mint =
    position.mint;

  const tokenAmount =
    Number(position.simulated_token_amount || 0);

  if (
    !sourceSignature ||
    !mint ||
    !Number.isFinite(tokenAmount) ||
    tokenAmount <= 0
  ) {
    console.warn({
      message: "⚠️ ENTRY ROUTE CHECK DEFERRED",
      sourceSignature,
      mint,
      tokenAmount,
      reason: "invalid_position_data",
      execution: "DISABLED",
      realMoney: false,
    });

    return {
      checked: 0,
      deferred: 1,
      reason: "invalid_position_data",
    };
  }

  const quote =
    await fetchJupiterExecutableSellQuote({
      mint,
      tokenAmount,
      wrappedSolMint: WRAPPED_SOL_MINT,
      jupiterApiKey:
        env?.JUPITER_API_KEY || null,
    });

  const reason =
    quote?.reason || "quote_unavailable";

  const definitive =
    quote?.executable === true ||
    reason === "no_route";

  /*
   * Temporary provider/network failures are NOT stored.
   * They will be retried on a later Cron tick.
   */
  if (!definitive) {
    console.warn({
      message: "⚠️ ENTRY ROUTE CHECK DEFERRED",
      sourceSignature,
      mint,
      tokenAmount,
      reason,
      status: quote?.status ?? null,
      execution: "DISABLED",
      realMoney: false,
    });

    return {
      checked: 0,
      deferred: 1,
      reason,
    };
  }

  const checkedAt =
    new Date().toISOString();

  const result =
    await runDatabaseOperation(
      "insert_paper_entry_route_check",
      () =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO paper_entry_route_checks (
             source_signature,
             mint,
             token_amount,
             raw_amount,
             decimals,
             executable,
             reason,
             http_status,
             response_body,
             out_sol,
             effective_price_sol_per_token,
             router,
             checked_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            sourceSignature,
            mint,
            tokenAmount,

            quote?.rawAmount != null
              ? String(quote.rawAmount)
              : null,

            Number.isInteger(quote?.decimals)
              ? quote.decimals
              : null,

            quote?.executable === true
              ? 1
              : 0,

            reason,

            quote?.status ?? null,

            quote?.responseBody ?? null,

            Number.isFinite(Number(quote?.outSOL))
              ? Number(quote.outSOL)
              : null,

            Number.isFinite(
              Number(
                quote?.effectivePriceSOLPerToken
              )
            )
              ? Number(
                  quote.effectivePriceSOLPerToken
                )
              : null,

            quote?.router || null,

            checkedAt
          )
          .run()
    );

  const inserted =
    Number(result?.meta?.changes ?? 0) === 1;

  console.log({
    message:
      quote?.executable === true
        ? "✅ ENTRY ROUTE EXECUTABLE"
        : "⛔ ENTRY ROUTE NO ROUTE",

    sourceSignature,
    mint,
    tokenAmount,

    rawAmount:
      quote?.rawAmount != null
        ? String(quote.rawAmount)
        : null,

    decimals:
      Number.isInteger(quote?.decimals)
        ? quote.decimals
        : null,

    executable:
      quote?.executable === true,

    reason,

    status:
      quote?.status ?? null,

    outSOL:
      Number.isFinite(Number(quote?.outSOL))
        ? Number(quote.outSOL)
        : null,

    effectivePriceSOLPerToken:
      Number.isFinite(
        Number(
          quote?.effectivePriceSOLPerToken
        )
      )
        ? Number(
            quote.effectivePriceSOLPerToken
          )
        : null,

    router:
      quote?.router || null,

    inserted,

    observationScope:
      "FULL_SIMULATED_POSITION",

    behavior:
      "OBSERVATION_ONLY_NO_BUY_FILTER",

    execution: "DISABLED",
    realMoney: false,
  });

  return {
    checked: inserted ? 1 : 0,
    deferred: 0,
    executable:
      quote?.executable === true,
    reason,
  };
        }
async function runPaperExitTick(env, trigger = {}) {
  const startedAt = new Date().toISOString();
  const [config, positions] = await Promise.all([
    getPaperCopyConfig(env),
    getOpenPaperExitPositions(env),
  ]);

  console.log({
    message: "⏱️ PAPER EXIT TICK",
    startedAt,
    trigger: trigger?.type || "UNKNOWN",
    cron: trigger?.cron || null,
    scheduledTime: trigger?.scheduledTime || null,
    openPositions: positions.length,
    execution: "DISABLED",
    realMoney: false,
  });

  if (!positions.length) {
    return { checked: 0, priced: 0, exits: 0, missingPrices: 0, errors: 0 };
  }

  let priceMap;

  try {
  const tokenAmountsByMint = new Map();

for (const position of positions) {
  const mint = position?.mint;
  const amount = Number(position?.remaining_token_amount || 0);

  if (!mint || !Number.isFinite(amount) || amount <= 0) {
    continue;
  }

  tokenAmountsByMint.set(
    mint,
    (tokenAmountsByMint.get(mint) || 0) + amount
  );
}

priceMap = await fetchPaperExitSolPrices(
  positions.map((position) => position.mint),
  {
    wrappedSolMint: WRAPPED_SOL_MINT,
    jupiterApiKey: env?.JUPITER_API_KEY || null,
    coingeckoApiKey: env?.COINGECKO_API_KEY || null,
    tokenAmountsByMint,
  }
);
} catch (error) {
  console.error({
    message: "❌ PAPER PRICE FETCH ERROR",
    error: String(error),
    behavior: "continue_with_no_prices",
  });
  priceMap = new Map();
  }

  let priced = 0;
  let exits = 0;
  let missingPrices = 0;
  let errors = 0;

  for (const position of positions) {
    const priceInfo = priceMap.get(position.mint);

    if (!priceInfo) {
      missingPrices++;
      console.warn({
        message: "⚠️ PAPER PRICE UNAVAILABLE",
        sourceSignature: position.source_signature,
        mint: position.mint,
        reason: "no_price_from_any_provider",
      });
      continue;
    }

    priced++;

    try {
      const result = await processPaperExitPosition(
        env,
        position,
        config,
        priceInfo
      );
      exits += Number(result?.exits || 0);
    } catch (error) {
      errors++;
      console.error({
        message: "❌ PAPER EXIT POSITION ERROR",
        sourceSignature: position.source_signature,
        mint: position.mint,
        error: String(error),
      });
    }
  }

  const summary = {
    message: "✅ PAPER EXIT TICK COMPLETE",
    checked: positions.length,
    priced,
    exits,
    missingPrices,
    errors,
    completedAt: new Date().toISOString(),
  };

  console.log(summary);

  if (errors > 0) {
    throw new Error(`Paper exit tick completed with ${errors} position error(s)`);
  }

  return summary;
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
async function getPendingPaperSourceRouteChecks(env, limit = 4) {
  const safeLimit = Math.max(
    1,
    Math.min(10, Math.floor(Number(limit) || 1))
  );

  const result = await runDatabaseOperation(
    "get_pending_paper_source_route_checks",
    () =>
      env.DB.prepare(
        `SELECT
           p.signature AS source_signature,
           p.mint,
           p.token_amount AS source_token_amount,
           p.input_sol AS source_input_sol,
           p.entry_time
         FROM paper_positions p
         LEFT JOIN paper_source_route_checks c
           ON c.source_signature = p.signature
         WHERE c.source_signature IS NULL
           AND p.status = 'PAPER_OPEN'
           AND p.token_amount > 0
           AND p.input_sol > 0
         ORDER BY p.entry_time DESC
         LIMIT ?`
      )
        .bind(safeLimit)
        .all()
  );

  return Array.isArray(result?.results)
    ? result.results
    : [];
}

async function runPaperSourceRouteObservationBatch(
  env,
  limit = 4
) {
  const positions =
    await getPendingPaperSourceRouteChecks(env, limit);

  if (positions.length === 0) {
    return {
      checked: 0,
      executable: 0,
      noRoute: 0,
      deferred: 0,
    };
  }

  const [config, account] = await Promise.all([
    getPaperCopyConfig(env),
    getPaperCopyAccount(env),
  ]);

  const { price: solUsdPrice } =
    await getSolUsdPrice(account);

  /*
   * Reuse the exact Paper Copy sizing logic,
   * but model the account as if no positions were
   * currently occupying open-position/exposure slots.
   *
   * This does NOT alter the real Paper Copy account.
   */
  const sizing = buildPaperCopySizing({
    account,
    config,
    openStats: {
      openCount: 0,
      openExposureLamports: 0,
    },
    solUsdPrice,
  });

  if (!sizing.ok) {
    console.warn({
      message: "⚠️ SOURCE ROUTE BATCH DEFERRED",
      reason: sizing.reason,
      execution: "DISABLED",
      realMoney: false,
    });

    return {
      checked: 0,
      executable: 0,
      noRoute: 0,
      deferred: positions.length,
    };
  }

  const targetCopySOL =
    lamportsToSOL(sizing.finalNotionalLamports);

  const buySlippageBps = Math.max(
    0,
    Math.floor(Number(config.buy_slippage_bps || 0))
  );

  let checked = 0;
  let executable = 0;
  let noRoute = 0;
  let deferred = 0;

  for (const position of positions) {
    const sourceSignature =
      position.source_signature;

    const mint =
      position.mint;

    const sourceTokenAmount =
      Number(position.source_token_amount || 0);

    const sourceInputSOL =
      Number(position.source_input_sol || 0);

    const sourceEntryPriceSOLPerToken =
      sourceInputSOL > 0 && sourceTokenAmount > 0
        ? sourceInputSOL / sourceTokenAmount
        : 0;

    const simulatedEntryPriceSOLPerToken =
      sourceEntryPriceSOLPerToken *
      (1 + buySlippageBps / BPS_DENOMINATOR);

    const probeTokenAmount =
      simulatedEntryPriceSOLPerToken > 0
        ? targetCopySOL /
          simulatedEntryPriceSOLPerToken
        : 0;

    if (
      !sourceSignature ||
      !mint ||
      !Number.isFinite(probeTokenAmount) ||
      probeTokenAmount <= 0
    ) {
      deferred += 1;
      continue;
    }

    const quote =
      await fetchJupiterExecutableSellQuote({
        mint,
        tokenAmount: probeTokenAmount,
        wrappedSolMint: WRAPPED_SOL_MINT,
        jupiterApiKey:
          env?.JUPITER_API_KEY || null,
      });

    const reason =
      quote?.reason || "quote_unavailable";

    const definitive =
      quote?.executable === true ||
      reason === "no_route";

    /*
     * Temporary API/network failures are not persisted.
     * They can be retried by a later Cron tick.
     */
    if (!definitive) {
      deferred += 1;

      console.warn({
        message: "⚠️ SOURCE ROUTE CHECK DEFERRED",
        sourceSignature,
        mint,
        reason,
        status: quote?.status ?? null,
        execution: "DISABLED",
        realMoney: false,
      });

      continue;
    }

    const entryTimeMs =
      Date.parse(position.entry_time || "");

    const ageMs =
      Number.isFinite(entryTimeMs)
        ? Date.now() - entryTimeMs
        : Number.POSITIVE_INFINITY;

    const probeBasis =
      ageMs >= 0 &&
      ageMs <= 5 * 60 * 1000
        ? "NEAR_ENTRY_COPY_TARGET_WITH_BUY_SLIPPAGE"
        : "HISTORICAL_BACKLOG_COPY_TARGET_WITH_BUY_SLIPPAGE";

    const result =
      await runDatabaseOperation(
        "insert_paper_source_route_check",
        () =>
          env.DB.prepare(
            `INSERT OR IGNORE INTO paper_source_route_checks (
               source_signature,
               mint,
               source_token_amount,
               probe_token_amount,
               probe_basis,
               raw_amount,
               decimals,
               executable,
               reason,
               http_status,
               response_body,
               out_sol,
               effective_price_sol_per_token,
               router,
               checked_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              sourceSignature,
              mint,
              sourceTokenAmount,
              probeTokenAmount,
              probeBasis,

              quote?.rawAmount != null
                ? String(quote.rawAmount)
                : null,

              Number.isInteger(quote?.decimals)
                ? quote.decimals
                : null,

              quote?.executable === true
                ? 1
                : 0,

              reason,

              quote?.status ?? null,

              quote?.responseBody ?? null,

              Number.isFinite(Number(quote?.outSOL))
                ? Number(quote.outSOL)
                : null,

              Number.isFinite(
                Number(
                  quote?.effectivePriceSOLPerToken
                )
              )
                ? Number(
                    quote.effectivePriceSOLPerToken
                  )
                : null,

              quote?.router || null,

              new Date().toISOString()
            )
            .run()
      );

    if (
      Number(result?.meta?.changes ?? 0) === 1
    ) {
      checked += 1;

      if (quote?.executable === true) {
        executable += 1;
      } else {
        noRoute += 1;
      }
    }

    console.log({
      message:
        quote?.executable === true
          ? "✅ SOURCE ROUTE EXECUTABLE"
          : "⛔ SOURCE ROUTE NO ROUTE",

      sourceSignature,
      mint,
      sourceTokenAmount,
      sourceInputSOL,
      probeTokenAmount,
      probeBasis,
      targetCopySOL,
      buySlippageBps,

      executable:
        quote?.executable === true,

      reason,

      status:
        quote?.status ?? null,

      router:
        quote?.router || null,

      behavior:
        "OBSERVATION_ONLY_NO_BUY_FILTER",

      execution: "DISABLED",
      realMoney: false,
    });
  }

  return {
    checked,
    executable,
    noRoute,
    deferred,
    requested: positions.length,
    targetCopySOL,
    buySlippageBps,
  };
}
export default {
  async scheduled(controller, env, ctx) {
    if (!env?.DB) {
      console.error({
        message: "❌ DATABASE ERROR",
        operation: "validate_database_binding_scheduled",
        error: "env.DB is missing",
      });
      throw new DatabaseError(
        "validate_database_binding_scheduled",
        new Error("env.DB is missing")
      );
    }
    await runPaperExitTick(env, {
      type: "CRON",
      cron: controller?.cron || null,
      scheduledTime: controller?.scheduledTime || null,
    });

    try {
      await runOnePaperEntryRouteObservation(env);
    } catch (error)     try {
      await runPaperSourceRouteObservationBatch(env, 4);
    } catch (error) {
      console.error({
        message: "❌ SOURCE ROUTE OBSERVATION ERROR",
        error: String(error),
        behavior:
          "observation_failed_exit_engine_already_completed",
        execution: "DISABLED",
        realMoney: false,
      });
    } {
      console.error({
        message: "❌ ENTRY ROUTE OBSERVATION ERROR",
        error: String(error),
        behavior:
          "observation_failed_exit_engine_already_completed",
        execution: "DISABLED",
        realMoney: false,
      });
    }
  },  
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
        version: "GAKE-D1-PAPER-MARK-COINGECKO-V1",
        strategy: "OKX_EXACT_THEN_ROUTED_WSOL_PAPER_EXIT_D1",
        webhookModeExpected: "ANY",
        databaseBinding: env?.DB ? "BOUND" : "MISSING",
        paperCopyAccounting: "ENABLED",
        paperCopyRiskGuard: "D1_BATCH_TRANSACTIONAL",
        paperExitEngine: "SL_TP_PARTIAL_TSL",
        paperPriceSource: "COINGECKO_MARK_THEN_JUPITER_EXECUTABILITY",
        jupiterApiKey:
  env?.JUPITER_API_KEY ? "CONFIGURED" : "MISSING",
        coingeckoApiKey:
  env?.COINGECKO_API_KEY ? "CONFIGURED" : "MISSING",
        paperExitScheduleExpected: "* * * * *",
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
