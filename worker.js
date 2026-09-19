const GAKE_WALLET =
  "DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm";

const WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

const OKX_INPUT_PATTERN = [
  987654,
  2963,
  4691,
  4692,
];

const OKX_INPUT_TOTAL_LAMPORTS =
  1_000_000;

const processedSignatures = new Set();
const paperPositions = new Map();


function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",
      },
    }
  );
}


function lamportsToSOL(lamports) {
  return (
    Number(lamports || 0) /
    1_000_000_000
  );
}


function parseRawInteger(value) {
  const text =
    String(value ?? "").trim();

  if (!/^-?\d+$/.test(text)) {
    return null;
  }

  try {
    return BigInt(text);
  } catch {
    return null;
  }
}


function decimalAmountToRaw(
  value,
  decimals
) {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0
  ) {
    return null;
  }

  const text =
    String(value ?? "").trim();

  if (
    !/^\d+(?:\.\d+)?$/.test(text)
  ) {
    return null;
  }

  const [
    wholePart,
    fractionPart = "",
  ] = text.split(".");

  if (
    fractionPart.length > decimals
  ) {
    const discarded =
      fractionPart.slice(decimals);

    if (/[1-9]/.test(discarded)) {
      return null;
    }
  }

  const normalizedFraction =
    fractionPart
      .slice(0, decimals)
      .padEnd(decimals, "0");

  try {
    const scale =
      10n ** BigInt(decimals);

    return (
      BigInt(wholePart) *
        scale +
      BigInt(
        normalizedFraction || "0"
      )
    );
  } catch {
    return null;
  }
}


function getTransferRawAmount(
  transfer,
  decimals
) {
  const rawCandidates = [
    transfer
      ?.rawTokenAmount
      ?.tokenAmount,

    transfer?.tokenAmountRaw,
    transfer?.rawAmount,
  ];

  for (
    const candidate
    of rawCandidates
  ) {
    const parsed =
      parseRawInteger(candidate);

    if (parsed !== null) {
      return parsed;
    }
  }

  return decimalAmountToRaw(
    transfer?.tokenAmount,
    decimals
  );
}


function normalizeTransactions(body) {
  if (Array.isArray(body)) {
    return body;
  }

  if (
    body &&
    typeof body === "object"
  ) {
    return [body];
  }

  return [];
}


function getAccountData(tx, account) {
  const accountData =
    Array.isArray(tx?.accountData)
      ? tx.accountData
      : [];

  return (
    accountData.find(
      (item) =>
        item?.account === account
    ) || null
  );
}


function getNativeBalanceChange(
  tx,
  account
) {
  const data =
    getAccountData(tx, account);

  return Number(
    data?.nativeBalanceChange || 0
  );
}


function findGakeReceivedTokens(tx) {
  const tokenTransfers =
    Array.isArray(tx?.tokenTransfers)
      ? tx.tokenTransfers
      : [];

  return tokenTransfers.filter(
    (transfer) =>
      transfer?.toUserAccount ===
        GAKE_WALLET &&
      transfer?.mint &&
      Number(
        transfer?.tokenAmount || 0
      ) > 0
  );
}


function getLargestGakeReceivedToken(tx) {
  const received =
    findGakeReceivedTokens(tx);

  if (!received.length) {
    return null;
  }

  return [...received].sort(
    (a, b) =>
      Number(
        b?.tokenAmount || 0
      ) -
      Number(
        a?.tokenAmount || 0
      )
  )[0];
}


function groupNativeTransfersBySender(tx) {
  const nativeTransfers =
    Array.isArray(tx?.nativeTransfers)
      ? tx.nativeTransfers
      : [];

  const groups = new Map();

  for (const transfer of nativeTransfers) {
    const sender =
      transfer?.fromUserAccount;

    if (!sender) {
      continue;
    }

    if (!groups.has(sender)) {
      groups.set(sender, []);
    }

    groups.get(sender).push({
      fromUserAccount:
        sender,

      toUserAccount:
        transfer?.toUserAccount ||
        null,

      amount:
        Number(
          transfer?.amount || 0
        ),
    });
  }

  return groups;
}


function matchesOKXPattern(transfers) {
  if (!Array.isArray(transfers)) {
    return false;
  }

  const availableAmounts =
    transfers.map(
      (transfer) =>
        Number(
          transfer?.amount || 0
        )
    );

  const remaining =
    [...availableAmounts];

  for (
    const requiredAmount
    of OKX_INPUT_PATTERN
  ) {
    const index =
      remaining.indexOf(
        requiredAmount
      );

    if (index === -1) {
      return false;
    }

    remaining.splice(index, 1);
  }

  return true;
}


function findOKXInputAccount(tx) {
  const groups =
    groupNativeTransfersBySender(tx);

  for (
    const [sender, transfers]
    of groups.entries()
  ) {
    if (
      !matchesOKXPattern(
        transfers
      )
    ) {
      continue;
    }

    return {
      inputAccount:
        sender,

      confidence:
        "VERY_HIGH",

      inputLamports:
        OKX_INPUT_TOTAL_LAMPORTS,

      inputSOL:
        lamportsToSOL(
          OKX_INPUT_TOTAL_LAMPORTS
        ),

      patternComponents:
        [...OKX_INPUT_PATTERN],

      transfers,
    };
  }

  return null;
}


function buildDiagnosticEvent(tx) {
  const tokenTransfers =
    Array.isArray(tx?.tokenTransfers)
      ? tx.tokenTransfers
      : [];

  const nativeTransfers =
    Array.isArray(tx?.nativeTransfers)
      ? tx.nativeTransfers
      : [];

  const rawAccountData =
    Array.isArray(tx?.accountData)
      ? tx.accountData
      : [];

  const receivedTokens =
    findGakeReceivedTokens(tx);

  const gakeNativeChange =
    getNativeBalanceChange(
      tx,
      GAKE_WALLET
    );

  const feePayer =
    tx?.feePayer || null;

  const relevantAccounts =
    new Set(
      [
        GAKE_WALLET,
        feePayer,
      ].filter(Boolean)
    );

  const diagnosticTokenTransfers =
    tokenTransfers.map(
      (transfer) => ({
        mint:
          transfer?.mint || null,

        tokenAmount:
          Number(
            transfer?.tokenAmount || 0
          ),

        fromUserAccount:
          transfer?.fromUserAccount ||
          null,

        toUserAccount:
          transfer?.toUserAccount ||
          null,

        ...(transfer?.fromTokenAccount
          ? {
              fromTokenAccount:
                transfer.fromTokenAccount,
            }
          : {}),

        ...(transfer?.toTokenAccount
          ? {
              toTokenAccount:
                transfer.toTokenAccount,
            }
          : {}),
      })
    );

  const diagnosticNativeTransfers =
    nativeTransfers.map(
      (transfer) => ({
        fromUserAccount:
          transfer?.fromUserAccount ||
          null,

        toUserAccount:
          transfer?.toUserAccount ||
          null,

        amount:
          Number(
            transfer?.amount || 0
          ),
      })
    );

  const diagnosticAccountData =
    rawAccountData
      .filter((item) => {
        const tokenBalanceChanges =
          Array.isArray(
            item?.tokenBalanceChanges
          )
            ? item.tokenBalanceChanges
            : [];

        return (
          relevantAccounts.has(
            item?.account
          ) ||
          tokenBalanceChanges.some(
            (change) =>
              change?.userAccount ===
              GAKE_WALLET
          )
        );
      })
      .map((item) => {
        const tokenBalanceChanges =
          Array.isArray(
            item?.tokenBalanceChanges
          )
            ? item.tokenBalanceChanges
            : [];

        return {
          account:
            item?.account || null,

          nativeBalanceChange:
            Number(
              item?.nativeBalanceChange ||
                0
            ),

          nativeBalanceChangeSOL:
            lamportsToSOL(
              item?.nativeBalanceChange ||
                0
            ),

          tokenBalanceChanges:
            tokenBalanceChanges.map(
              (change) => ({
                mint:
                  change?.mint || null,

                userAccount:
                  change?.userAccount ||
                  null,

                tokenAccount:
                  change?.tokenAccount ||
                  null,

                rawTokenAmount:
                  change?.rawTokenAmount
                    ? {
                        tokenAmount:
                          change
                            .rawTokenAmount
                            .tokenAmount ??
                          null,

                        decimals:
                          change
                            .rawTokenAmount
                            .decimals ??
                          null,
                      }
                    : null,
              })
            ),
        };
      });

  return {
    message:
      "📦 HELIUS EVENT",

    signature:
      tx?.signature || null,

    type:
      tx?.type || null,

    source:
      tx?.source || null,

    description:
      tx?.description || null,

    feePayer,

    fee:
      Number(tx?.fee || 0),

    feeSOL:
      lamportsToSOL(
        tx?.fee || 0
      ),

    transactionError:
      tx?.transactionError ?? null,

    tokenTransferCount:
      tokenTransfers.length,

    nativeTransferCount:
      nativeTransfers.length,

    gakeReceivedTokenCount:
      receivedTokens.length,

    gakeNativeBalanceChangeSOL:
      lamportsToSOL(
        gakeNativeChange
      ),

    tokenTransfers:
      diagnosticTokenTransfers,

    nativeTransfers:
      diagnosticNativeTransfers,

    accountData:
      diagnosticAccountData,

    timestamp:
      tx?.timestamp || null,
  };
}


function findGakeOwnedTokenIncreases(tx) {
  const accountData =
    Array.isArray(tx?.accountData)
      ? tx.accountData
      : [];

  const increases = [];

  for (const item of accountData) {
    const changes =
      Array.isArray(
        item?.tokenBalanceChanges
      )
        ? item.tokenBalanceChanges
        : [];

    for (const change of changes) {
      const mint =
        change?.mint || null;

      const rawAmount =
        parseRawInteger(
          change
            ?.rawTokenAmount
            ?.tokenAmount
        );

      const decimals =
        change
          ?.rawTokenAmount
          ?.decimals;

      if (
        change?.userAccount !==
          GAKE_WALLET ||
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
        account:
          item?.account || null,

        mint,

        tokenAccount:
          change?.tokenAccount ||
          item?.account ||
          null,

        rawAmount,
        decimals,
      });
    }
  }

  return increases;
}


function findRoutedGakeReceipt(tx) {
  if (
    tx?.transactionError !== null &&
    tx?.transactionError !== undefined
  ) {
    return null;
  }

  const tokenTransfers =
    Array.isArray(tx?.tokenTransfers)
      ? tx.tokenTransfers
      : [];

  const increases =
    findGakeOwnedTokenIncreases(tx);

  for (const increase of increases) {
    for (
      const finalTransfer
      of tokenTransfers
    ) {
      if (
        finalTransfer?.mint !==
          increase.mint ||
        finalTransfer?.toUserAccount !==
          GAKE_WALLET ||
        !finalTransfer?.fromUserAccount ||
        finalTransfer.fromUserAccount ===
          GAKE_WALLET
      ) {
        continue;
      }

      if (
        increase.tokenAccount &&
        finalTransfer?.toTokenAccount &&
        finalTransfer.toTokenAccount !==
          increase.tokenAccount
      ) {
        continue;
      }

      const finalRawAmount =
        getTransferRawAmount(
          finalTransfer,
          increase.decimals
        );

      if (
        finalRawAmount === null ||
        finalRawAmount <= 0n ||
        finalRawAmount !==
          increase.rawAmount
      ) {
        continue;
      }

      const routeOwner =
        finalTransfer.fromUserAccount;

      for (
        const upstreamTransfer
        of tokenTransfers
      ) {
        if (
          upstreamTransfer?.mint !==
            increase.mint ||
          upstreamTransfer?.toUserAccount !==
            routeOwner ||
          !upstreamTransfer
            ?.fromUserAccount ||
          upstreamTransfer
            .fromUserAccount ===
            routeOwner ||
          upstreamTransfer
            .fromUserAccount ===
            GAKE_WALLET
        ) {
          continue;
        }

        const upstreamRawAmount =
          getTransferRawAmount(
            upstreamTransfer,
            increase.decimals
          );

        if (
          upstreamRawAmount === null ||
          upstreamRawAmount <= 0n ||
          upstreamRawAmount !==
            finalRawAmount
        ) {
          continue;
        }

        const counterparty =
          upstreamTransfer
            .fromUserAccount;

        for (
          const wsolInput
          of tokenTransfers
        ) {
          if (
            wsolInput?.mint !==
              WRAPPED_SOL_MINT ||
            wsolInput?.fromUserAccount !==
              routeOwner ||
            wsolInput?.toUserAccount !==
              counterparty
          ) {
            continue;
          }

          const wsolRawAmount =
            getTransferRawAmount(
              wsolInput,
              9
            );

          if (
            wsolRawAmount === null ||
            wsolRawAmount <= 0n
          ) {
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
  const evidence =
    findRoutedGakeReceipt(tx);

  if (!evidence) {
    return null;
  }

  const tokenAmount =
    Number(
      evidence
        .finalTransfer
        ?.tokenAmount || 0
    );

  const inputSOL =
    Number(
      evidence.wsolRawAmount
    ) /
    1_000_000_000;

  if (
    tokenAmount <= 0 ||
    inputSOL <= 0
  ) {
    return null;
  }

  const feePayer =
    tx?.feePayer || null;

  return {
    message:
      "🔎 SWAP CANDIDATE",

    action:
      "SWAP_CANDIDATE",

    detector:
      "ROUTED_WSOL_GAKE_RECEIPT",

    confidence:
      "HIGH",

    wallet:
      GAKE_WALLET,

    signature:
      tx?.signature || null,

    source:
      tx?.source || null,

    type:
      tx?.type || null,

    mint:
      evidence.increase.mint,

    tokenAmount,

    rawTokenAmount:
      evidence
        .finalRawAmount
        .toString(),

    tokenDecimals:
      evidence
        .increase
        .decimals,

    fromUserAccount:
      evidence.routeOwner,

    toUserAccount:
      GAKE_WALLET,

    toTokenAccount:
      evidence
        .increase
        .tokenAccount,

    feePayer,

    inferredInputAccount:
      evidence.routeOwner,

    inferredInputConfidence:
      "HIGH",

    inferredSwapInputSOL:
      inputSOL,

    inferredSwapInputLamports:
      evidence
        .wsolRawAmount
        .toString(),

    inputPatternMatched:
      false,

    inputPatternComponents:
      null,

    inputPatternTotalLamports:
      null,

    inputAccountMatchesTokenTransfer:
      true,

    routedEconomicChainMatched:
      true,

    routeOwner:
      evidence.routeOwner,

    counterparty:
      evidence.counterparty,

    finalOutputRawAmount:
      evidence
        .finalRawAmount
        .toString(),

    upstreamOutputRawAmount:
      evidence
        .upstreamRawAmount
        .toString(),

    gakeBalanceIncreaseRawAmount:
      evidence
        .increase
        .rawAmount
        .toString(),

    wsolInputRawAmount:
      evidence
        .wsolRawAmount
        .toString(),

    gakeNativeBalanceChangeSOL:
      lamportsToSOL(
        getNativeBalanceChange(
          tx,
          GAKE_WALLET
        )
      ),

    fee:
      Number(tx?.fee || 0),

    feeSOL:
      lamportsToSOL(
        tx?.fee || 0
      ),

    feePayerNativeBalanceChangeSOL:
      feePayer
        ? lamportsToSOL(
            getNativeBalanceChange(
              tx,
              feePayer
            )
          )
        : 0,

    transactionError:
      tx?.transactionError ?? null,

    description:
      tx?.description || null,

    timestamp:
      tx?.timestamp || null,
  };
}


/*
 * Existing OKX detector.
 * Only the function name changed so
 * this remains the first detection path.
 */
function buildOKXSwapCandidate(tx) {
  const received =
    getLargestGakeReceivedToken(tx);

  if (!received) {
    return null;
  }

  const input =
    findOKXInputAccount(tx);

  if (!input) {
    return null;
  }

  const fromUserAccount =
    received?.fromUserAccount ||
    null;

  const inputMatchesTokenTransfer =
    input.inputAccount ===
    fromUserAccount;

  const feePayer =
    tx?.feePayer || null;

  const gakeNativeChange =
    getNativeBalanceChange(
      tx,
      GAKE_WALLET
    );

  const feePayerNativeChange =
    feePayer
      ? getNativeBalanceChange(
          tx,
          feePayer
        )
      : 0;

  return {
    message:
      "🔎 SWAP CANDIDATE",

    action:
      "SWAP_CANDIDATE",

    confidence:
      inputMatchesTokenTransfer
        ? "VERY_HIGH"
        : "HIGH",

    wallet:
      GAKE_WALLET,

    signature:
      tx?.signature || null,

    source:
      tx?.source || null,

    type:
      tx?.type || null,

    mint:
      received?.mint || null,

    tokenAmount:
      Number(
        received?.tokenAmount || 0
      ),

    fromUserAccount,

    toUserAccount:
      received?.toUserAccount ||
      null,

    feePayer,

    inferredInputAccount:
      input.inputAccount,

    inferredInputConfidence:
      input.confidence,

    inferredSwapInputSOL:
      input.inputSOL,

    inferredSwapInputLamports:
      input.inputLamports,

    inputPatternMatched:
      true,

    inputPatternComponents:
      input.patternComponents,

    inputPatternTotalLamports:
      OKX_INPUT_TOTAL_LAMPORTS,

    inputAccountMatchesTokenTransfer:
      inputMatchesTokenTransfer,

    gakeNativeBalanceChangeSOL:
      lamportsToSOL(
        gakeNativeChange
      ),

    fee:
      Number(tx?.fee || 0),

    feeSOL:
      lamportsToSOL(
        tx?.fee || 0
      ),

    feePayerNativeBalanceChangeSOL:
      lamportsToSOL(
        feePayerNativeChange
      ),

    transactionError:
      tx?.transactionError ?? null,

    description:
      tx?.description || null,

    timestamp:
      tx?.timestamp || null,
  };
}


function buildSwapCandidate(tx) {
  const okxCandidate =
    buildOKXSwapCandidate(tx);

  if (okxCandidate) {
    return okxCandidate;
  }

  return buildRoutedGakeCandidate(
    tx
  );
}


function validateCandidate(candidate) {
  const reasons = [];

  if (!candidate) {
    reasons.push(
      "candidate_missing"
    );

    return reasons;
  }

  if (
    candidate.transactionError !==
      null &&
    candidate.transactionError !==
      undefined
  ) {
    reasons.push(
      "transaction_error"
    );
  }

  if (
    candidate.detector ===
    "ROUTED_WSOL_GAKE_RECEIPT"
  ) {
    if (
      candidate
        .routedEconomicChainMatched !==
      true
    ) {
      reasons.push(
        "routed_chain_not_matched"
      );
    }

    if (
      candidate.confidence !==
      "HIGH"
    ) {
      reasons.push(
        "routed_confidence_not_high"
      );
    }

    if (
      !candidate.routeOwner ||
      !candidate.counterparty ||
      candidate.routeOwner ===
        candidate.counterparty ||
      candidate.routeOwner ===
        GAKE_WALLET
    ) {
      reasons.push(
        "invalid_route_accounts"
      );
    }

    const finalRawAmount =
      parseRawInteger(
        candidate
          .finalOutputRawAmount
      );

    const upstreamRawAmount =
      parseRawInteger(
        candidate
          .upstreamOutputRawAmount
      );

    const gakeRawAmount =
      parseRawInteger(
        candidate
          .gakeBalanceIncreaseRawAmount
      );

    const wsolRawAmount =
      parseRawInteger(
        candidate
          .wsolInputRawAmount
      );

    if (
      finalRawAmount === null ||
      finalRawAmount <= 0n ||
      upstreamRawAmount === null ||
      upstreamRawAmount <= 0n ||
      gakeRawAmount === null ||
      gakeRawAmount <= 0n ||
      upstreamRawAmount !==
        finalRawAmount ||
      gakeRawAmount !==
        finalRawAmount
    ) {
      reasons.push(
        "routed_output_amount_mismatch"
      );
    }

    if (
      wsolRawAmount === null ||
      wsolRawAmount <= 0n
    ) {
      reasons.push(
        "invalid_wsol_input"
      );
    }

    if (!candidate.mint) {
      reasons.push(
        "mint_missing"
      );
    }

    if (
      Number(
        candidate.tokenAmount
      ) <= 0
    ) {
      reasons.push(
        "invalid_token_amount"
      );
    }

    return reasons;
  }

  /*
   * Existing OKX validation remains
   * behaviorally unchanged below.
   */
  if (
    candidate
      .inputPatternMatched !==
    true
  ) {
    reasons.push(
      "input_pattern_not_matched"
    );
  }

  if (
    candidate
      .inputAccountMatchesTokenTransfer !==
    true
  ) {
    reasons.push(
      "input_account_mismatch"
    );
  }

  if (
    candidate
      .inferredInputConfidence !==
    "VERY_HIGH"
  ) {
    reasons.push(
      "confidence_not_very_high"
    );
  }

  if (
    Number(
      candidate
        .inferredSwapInputLamports
    ) !==
    OKX_INPUT_TOTAL_LAMPORTS
  ) {
    reasons.push(
      "input_amount_mismatch"
    );
  }

  if (!candidate.mint) {
    reasons.push(
      "mint_missing"
    );
  }

  if (
    Number(
      candidate.tokenAmount
    ) <= 0
  ) {
    reasons.push(
      "invalid_token_amount"
    );
  }

  return reasons;
}


function buildBuySignal(candidate) {
  const rejectionReasons =
    validateCandidate(candidate);

  if (
    rejectionReasons.length > 0
  ) {
    return {
      signal: null,
      rejectionReasons,
    };
  }

  const signal = {
    message:
      "🟢 BUY SIGNAL",

    action:
      "BUY_SIGNAL",

    detector:
      candidate.detector ||
      "OKX_EXACT_PATTERN",

    confidence:
      candidate.confidence,

    signature:
      candidate.signature,

    source:
      candidate.source,

    type:
      candidate.type,

    mint:
      candidate.mint,

    tokenAmount:
      Number(
        candidate.tokenAmount
      ),

    inputAccount:
      candidate
        .inferredInputAccount,

    inputSOL:
      Number(
        candidate
          .inferredSwapInputSOL
      ),

    inputLamports:
      Number(
        candidate
          .inferredSwapInputLamports
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
      Number(
        candidate.feeSOL || 0
      ),

    gakeNativeBalanceChangeSOL:
      Number(
        candidate
          .gakeNativeBalanceChangeSOL ||
          0
      ),

    detectedAt:
      new Date().toISOString(),

    execution:
      "DISABLED",

    realMoney:
      false,
  };

  return {
    signal,
    rejectionReasons: [],
  };
}


function createPaperBuy(
  buySignal
) {
  if (!buySignal) {
    return null;
  }

  const signature =
    buySignal.signature;

  const mint =
    buySignal.mint;

  const tokenAmount =
    Number(
      buySignal.tokenAmount
    );

  const inputSOL =
    Number(
      buySignal.inputSOL
    );

  if (
    !signature ||
    !mint ||
    tokenAmount <= 0 ||
    inputSOL <= 0
  ) {
    return null;
  }

  if (
    paperPositions.has(
      signature
    )
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
    inputSOL /
    tokenAmount;

  const position = {
    message:
      "📄 PAPER BUY",

    action:
      "PAPER_BUY",

    status:
      "PAPER_OPEN",

    signature,
    mint,

    tokenAmount,

    inputSOL,

    entryPriceSOLPerToken,

    entryTime:
      new Date().toISOString(),

    source:
      buySignal.source,

    inputAccount:
      buySignal.inputAccount,

    confidence:
      buySignal.confidence,

    execution:
      "DISABLED",

    realMoney:
      false,
  };

  paperPositions.set(
    signature,
    position
  );

  return position;
}


async function handleWebhook(
  request
) {
  let body;

  try {
    body =
      await request.json();
  } catch (error) {
    console.error({
      message:
        "❌ INVALID JSON",

      error:
        String(error),
    });

    return jsonResponse(
      {
        ok: false,
        error:
          "invalid_json",
      },
      400
    );
  }

  const transactions =
    normalizeTransactions(body);

  console.log({
    message:
      "📥 HELIUS POST RECEIVED",

    receivedCount:
      transactions.length,

    receivedAt:
      new Date().toISOString(),
  });

  if (
    transactions.length === 0
  ) {
    console.warn({
      message:
        "⚠️ EMPTY HELIUS PAYLOAD",
    });

    return jsonResponse({
      ok: true,
      received: 0,

      execution:
        "DISABLED",

      realMoney:
        false,
    });
  }

  let candidates = 0;
  let buySignals = 0;
  let paperBuys = 0;
  let duplicates = 0;

  for (
    const tx
    of transactions
  ) {
    const diagnostic =
      buildDiagnosticEvent(tx);

    console.log(
      diagnostic
    );

    const signature =
      tx?.signature || null;

    if (!signature) {
      console.warn({
        message:
          "⚠️ EVENT WITHOUT SIGNATURE",
      });

      continue;
    }

    if (
      processedSignatures.has(
        signature
      )
    ) {
      duplicates++;

      console.log({
        message:
          "♻️ DUPLICATE SIGNATURE",

        signature,
      });

      continue;
    }

    processedSignatures.add(
      signature
    );

    const candidate =
      buildSwapCandidate(tx);

    if (!candidate) {
      console.log({
        message:
          "⚪ NO MATCHING CANDIDATE",

        signature,

        type:
          tx?.type || null,

        source:
          tx?.source || null,

        reason:
          "No exact OKX 0.001 SOL match and no complete routed WSOL -> token -> Gake economic chain",
      });

      continue;
    }

    candidates++;

    console.log(
      candidate
    );

    const {
      signal,
      rejectionReasons,
    } =
      buildBuySignal(
        candidate
      );

    if (!signal) {
      console.log({
        message:
          "🟡 CANDIDATE REJECTED",

        signature,

        rejectionReasons,

        candidate,
      });

      continue;
    }

    buySignals++;

    console.log(
      signal
    );

    const paperBuy =
      createPaperBuy(
        signal
      );

    if (paperBuy) {
      paperBuys++;

      console.log(
        paperBuy
      );
    }
  }

  return jsonResponse({
    ok: true,

    received:
      transactions.length,

    duplicates,

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
      new URL(
        request.url
      );

    if (
      request.method ===
        "GET" &&
      (
        url.pathname ===
          "/" ||
        url.pathname ===
          "/health"
      )
    ) {
      return jsonResponse({
        ok: true,

        service:
          "gake-trader-bot",

        status:
          "RUNNING",

        version:
          "GAKE-DIAGNOSTIC-ANY-V1",

        strategy:
          "GAKE_OKX_PATTERN_PAPER",

        webhookModeExpected:
          "ANY",

        execution:
          "DISABLED",

        realMoney:
          false,

        monitoredWallet:
          GAKE_WALLET,

        inputPatternLamports:
          OKX_INPUT_PATTERN,

        expectedInputLamports:
          OKX_INPUT_TOTAL_LAMPORTS,

        serverTime:
          new Date().toISOString(),
      });
    }

    if (
      request.method ===
      "POST"
    ) {
      return handleWebhook(
        request
      );
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
