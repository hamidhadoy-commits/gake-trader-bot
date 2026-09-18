const GAKE_WALLET = "DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm";

const OKX_INPUT_PATTERN = [
  987654,
  2963,
  4691,
  4692,
];

const OKX_INPUT_TOTAL = 1_000_000;

// فقط برای تست.
// با restart شدن Worker ممکن است پاک شود.
const processedSignatures = new Set();
const paperPositions = new Map();


function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}


function lamportsToSOL(value) {
  return Number(value || 0) / 1_000_000_000;
}


function normalizeTransactions(body) {
  if (Array.isArray(body)) {
    return body;
  }

  if (body && typeof body === "object") {
    return [body];
  }

  return [];
}


function getGakeNativeBalanceChange(tx) {
  const rows = Array.isArray(tx?.accountData)
    ? tx.accountData
    : [];

  const item = rows.find(
    (row) => row?.account === GAKE_WALLET
  );

  return Number(item?.nativeBalanceChange || 0);
}


function findGakeReceivedToken(tx) {
  const transfers = Array.isArray(tx?.tokenTransfers)
    ? tx.tokenTransfers
    : [];

  const candidates = transfers.filter((transfer) => {
    return (
      transfer?.toUserAccount === GAKE_WALLET &&
      transfer?.mint &&
      Number(transfer?.tokenAmount || 0) > 0
    );
  });

  if (!candidates.length) {
    return null;
  }

  // فعلاً بزرگ‌ترین دریافت توکن را انتخاب می‌کنیم.
  candidates.sort(
    (a, b) =>
      Number(b?.tokenAmount || 0) -
      Number(a?.tokenAmount || 0)
  );

  return candidates[0];
}


function groupNativeTransfersBySender(tx) {
  const transfers = Array.isArray(tx?.nativeTransfers)
    ? tx.nativeTransfers
    : [];

  const groups = new Map();

  for (const transfer of transfers) {
    const sender = transfer?.fromUserAccount;

    if (!sender) continue;

    if (!groups.has(sender)) {
      groups.set(sender, []);
    }

    groups.get(sender).push({
      fromUserAccount: sender,
      toUserAccount: transfer?.toUserAccount || null,
      amount: Number(transfer?.amount || 0),
    });
  }

  return groups;
}


function matchesExactInputPattern(transfers) {
  if (!Array.isArray(transfers)) {
    return false;
  }

  const amounts = transfers.map((x) =>
    Number(x?.amount || 0)
  );

  // لازم نیست تنها انتقال‌های فرستنده همین ۴ عدد باشند.
  // کافی است هر چهار جزء pattern وجود داشته باشند.
  const remaining = [...amounts];

  for (const target of OKX_INPUT_PATTERN) {
    const index = remaining.indexOf(target);

    if (index === -1) {
      return false;
    }

    remaining.splice(index, 1);
  }

  return true;
}


function findOKXInputAccount(tx) {
  const groups = groupNativeTransfersBySender(tx);

  for (const [sender, transfers] of groups.entries()) {
    if (!matchesExactInputPattern(transfers)) {
      continue;
    }

    return {
      inputAccount: sender,
      confidence: "VERY_HIGH",
      inputLamports: OKX_INPUT_TOTAL,
      inputSOL: lamportsToSOL(OKX_INPUT_TOTAL),
      components: OKX_INPUT_PATTERN,
      transfers,
    };
  }

  return null;
}


function getFeePayerNativeBalanceChange(tx) {
  const feePayer = tx?.feePayer;

  if (!feePayer) return 0;

  const rows = Array.isArray(tx?.accountData)
    ? tx.accountData
    : [];

  const item = rows.find(
    (row) => row?.account === feePayer
  );

  return Number(item?.nativeBalanceChange || 0);
}


function buildSwapCandidate(tx) {
  const received = findGakeReceivedToken(tx);

  if (!received) {
    return null;
  }

  const input = findOKXInputAccount(tx);

  if (!input) {
    return null;
  }

  const fromUserAccount =
    received?.fromUserAccount || null;

  const inputMatchesTokenTransfer =
    input.inputAccount === fromUserAccount;

  const gakeNativeBalanceChange =
    getGakeNativeBalanceChange(tx);

  const feePayerNativeBalanceChange =
    getFeePayerNativeBalanceChange(tx);

  return {
    message: "🔎 SWAP CANDIDATE",
    action: "SWAP_CANDIDATE",

    confidence:
      inputMatchesTokenTransfer
        ? "VERY_HIGH"
        : "HIGH",

    signature: tx?.signature || null,
    source: tx?.source || null,
    type: tx?.type || null,

    mint: received?.mint || null,
    tokenAmount: Number(
      received?.tokenAmount || 0
    ),

    fromUserAccount,
    toUserAccount:
      received?.toUserAccount || null,

    wallet: GAKE_WALLET,

    feePayer: tx?.feePayer || null,

    inferredInputAccount:
      input.inputAccount,

    inferredInputConfidence:
      input.confidence,

    inferredSwapInputSOL:
      input.inputSOL,

    inferredSwapInputLamports:
      input.inputLamports,

    inputPatternMatched: true,

    inputPatternComponents:
      input.components,

    inputPatternTotalLamports:
      OKX_INPUT_TOTAL,

    inputAccountMatchesTokenTransfer:
      inputMatchesTokenTransfer,

    gakeNativeBalanceChangeSOL:
      lamportsToSOL(
        gakeNativeBalanceChange
      ),

    fee: Number(tx?.fee || 0),

    feeSOL:
      lamportsToSOL(tx?.fee || 0),

    feePayerNativeBalanceChangeSOL:
      lamportsToSOL(
        feePayerNativeBalanceChange
      ),

    transactionError:
      tx?.transactionError ?? null,

    description:
      tx?.description || null,

    timestamp:
      tx?.timestamp || null,
  };
}


function buildBuySignal(candidate) {
  if (!candidate) {
    return null;
  }

  // خطای تراکنش نباید وجود داشته باشد.
  if (
    candidate.transactionError !== null &&
    candidate.transactionError !== undefined
  ) {
    return null;
  }

  if (
    candidate.inputPatternMatched !== true
  ) {
    return null;
  }

  if (
    candidate.inputAccountMatchesTokenTransfer !== true
  ) {
    return null;
  }

  if (
    candidate.inferredInputConfidence !==
    "VERY_HIGH"
  ) {
    return null;
  }

  if (
    Number(candidate.inferredSwapInputLamports) !==
    OKX_INPUT_TOTAL
  ) {
    return null;
  }

  if (!candidate.mint) {
    return null;
  }

  if (
    Number(candidate.tokenAmount) <= 0
  ) {
    return null;
  }

  return {
    message: "🟢 BUY SIGNAL",
    action: "BUY_SIGNAL",

    confidence: "VERY_HIGH",

    signature:
      candidate.signature,

    source:
      candidate.source,

    type:
      candidate.type,

    mint:
      candidate.mint,

    tokenAmount:
      Number(candidate.tokenAmount),

    inputAccount:
      candidate.inferredInputAccount,

    inputSOL:
      Number(
        candidate.inferredSwapInputSOL
      ),

    inputLamports:
      Number(
        candidate.inferredSwapInputLamports
      ),

    fromUserAccount:
      candidate.fromUserAccount,

    toUserAccount:
      candidate.toUserAccount,

    gakeWallet:
      GAKE_WALLET,

    feePayer:
      candidate.feePayer,

    feeSOL:
      Number(candidate.feeSOL || 0),

    gakeNativeBalanceChangeSOL:
      Number(
        candidate.gakeNativeBalanceChangeSOL || 0
      ),

    detectedAt:
      new Date().toISOString(),

    execution: "DISABLED",
  };
}


function createPaperBuy(buySignal) {
  if (!buySignal) {
    return null;
  }

  const {
    signature,
    mint,
    tokenAmount,
    inputSOL,
  } = buySignal;

  if (
    !signature ||
    !mint ||
    Number(tokenAmount) <= 0 ||
    Number(inputSOL) <= 0
  ) {
    return null;
  }

  if (
    paperPositions.has(signature)
  ) {
    console.log({
      message:
        "♻️ PAPER POSITION ALREADY EXISTS",
      signature,
      mint,
    });

    return null;
  }

  const entryPriceSOLPerToken =
    Number(inputSOL) /
    Number(tokenAmount);

  const position = {
    message: "📄 PAPER BUY",
    action: "PAPER_BUY",

    status: "PAPER_OPEN",

    signature,
    mint,

    tokenAmount:
      Number(tokenAmount),

    inputSOL:
      Number(inputSOL),

    entryPriceSOLPerToken,

    entryTime:
      new Date().toISOString(),

    source:
      buySignal.source,

    inputAccount:
      buySignal.inputAccount,

    confidence:
      buySignal.confidence,

    execution: "DISABLED",
    realMoney: false,
  };

  paperPositions.set(
    signature,
    position
  );

  return position;
}


async function handleWebhook(request) {
  let body;

  try {
    body = await request.json();
  } catch (error) {
    console.error({
      message: "❌ INVALID JSON",
      error: String(error),
    });

    return jsonResponse(
      {
        ok: false,
        error: "invalid_json",
      },
      400
    );
  }

  const transactions =
    normalizeTransactions(body);

  console.log({
    message: "📥 HELIUS POST RECEIVED",
    receivedCount:
      transactions.length,
    receivedAt:
      new Date().toISOString(),
  });

  if (!transactions.length) {
    console.warn({
      message:
        "⚠️ EMPTY HELIUS PAYLOAD",
    });

    return jsonResponse({
      ok: true,
      received: 0,
    });
  }

  let candidates = 0;
  let buySignals = 0;
  let paperBuys = 0;

  for (const tx of transactions) {
    const signature =
      tx?.signature || null;

    console.log({
      message: "📦 HELIUS EVENT",
      signature,
      type: tx?.type || null,
      source: tx?.source || null,
      description:
        tx?.description || null,
      tokenTransfers:
        Array.isArray(tx?.tokenTransfers)
          ? tx.tokenTransfers.length
          : 0,
      nativeTransfers:
        Array.isArray(tx?.nativeTransfers)
          ? tx.nativeTransfers.length
          : 0,
    });

    if (!signature) {
      console.warn({
        message:
          "⚠️ EVENT WITHOUT SIGNATURE",
      });

      continue;
    }

    if (
      processedSignatures.has(signature)
    ) {
      console.log({
        message:
          "♻️ DUPLICATE SIGNATURE",
        signature,
      });

      continue;
    }

    processedSignatures.add(signature);

    const candidate =
      buildSwapCandidate(tx);

    if (!candidate) {
      console.log({
        message:
          "⚪ NO MATCHING CANDIDATE",
        signature,
        type: tx?.type || null,
        source: tx?.source || null,
      });

      continue;
    }

    candidates++;

    console.log(candidate);

    const buySignal =
      buildBuySignal(candidate);

    if (!buySignal) {
      console.log({
        message:
          "🟡 CANDIDATE REJECTED",
        signature,
        reason:
          "BUY_SIGNAL validation failed",
        candidate,
      });

      continue;
    }

    buySignals++;

    console.log(buySignal);

    const paperBuy =
      createPaperBuy(buySignal);

    if (paperBuy) {
      paperBuys++;
      console.log(paperBuy);
    }
  }

  return jsonResponse({
    ok: true,

    received:
      transactions.length,

    candidates,
    buySignals,
    paperBuys,

    execution:
      "DISABLED",

    realMoney:
      false,
  });
}


export default {
  async fetch(request) {
    const url =
      new URL(request.url);

    if (
      request.method === "GET" &&
      (
        url.pathname === "/" ||
        url.pathname === "/health"
      )
    ) {
      return jsonResponse({
        ok: true,

        service:
          "gake-trader-bot",

        status:
          "RUNNING",

        strategy:
          "GAKE_OKX_PATTERN_PAPER",

        execution:
          "DISABLED",

        realMoney:
          false,

        monitoredWallet:
          GAKE_WALLET,

        inputPatternLamports:
          OKX_INPUT_PATTERN,

        expectedInputLamports:
          OKX_INPUT_TOTAL,

        serverTime:
          new Date().toISOString(),
      });
    }

    if (
      request.method === "POST"
    ) {
      return handleWebhook(request);
    }

    return jsonResponse(
      {
        ok: false,
        error:
          "method_not_allowed",
      },
      405
    );
  },
};
