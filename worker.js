const GAKE_WALLET =
  "DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm";

function getNativeBalanceChange(accountData, wallet) {
  if (!Array.isArray(accountData)) {
    return 0;
  }

  const item = accountData.find(
    (x) => x?.account === wallet
  );

  return Number(item?.nativeBalanceChange ?? 0);
}

function getTokenBalanceChange(accountData, wallet, mint) {
  if (!Array.isArray(accountData)) {
    return 0;
  }

  let total = 0;

  for (const account of accountData) {
    const changes = account?.tokenBalanceChanges;

    if (!Array.isArray(changes)) {
      continue;
    }

    for (const change of changes) {
      if (
        change?.userAccount === wallet &&
        change?.mint === mint
      ) {
        total += Number(
          change?.rawTokenAmount?.tokenAmount ?? 0
        );
      }
    }
  }

  return total;
}

function findNegativeTokenSource(accountData, mint) {
  if (!Array.isArray(accountData)) {
    return null;
  }

  for (const account of accountData) {
    const changes = account?.tokenBalanceChanges;

    if (!Array.isArray(changes)) {
      continue;
    }

    for (const change of changes) {
      const amount = Number(
        change?.rawTokenAmount?.tokenAmount ?? 0
      );

      if (
        change?.mint === mint &&
        amount < 0
      ) {
        return {
          account: account?.account || null,
          userAccount:
            change?.userAccount || null,
          tokenAccount:
            change?.tokenAccount || null,
          rawTokenAmount: amount,
          decimals:
            Number(
              change?.rawTokenAmount?.decimals ?? 0
            ),
        };
      }
    }
  }

  return null;
}

function getNativeTransfersFromWallet(
  nativeTransfers,
  wallet
) {
  if (!Array.isArray(nativeTransfers)) {
    return [];
  }

  return nativeTransfers.filter(
    (transfer) =>
      transfer?.fromUserAccount === wallet
  );
}

function getNativeTransfersToWallet(
  nativeTransfers,
  wallet
) {
  if (!Array.isArray(nativeTransfers)) {
    return [];
  }

  return nativeTransfers.filter(
    (transfer) =>
      transfer?.toUserAccount === wallet
  );
}

function sumTransfers(transfers) {
  if (!Array.isArray(transfers)) {
    return 0;
  }

  return transfers.reduce(
    (sum, transfer) =>
      sum + Number(transfer?.amount ?? 0),
    0
  );
}

function lamportsToSol(lamports) {
  return Number(lamports || 0) / 1_000_000_000;
}

function rawAmountToToken(
  rawAmount,
  decimals
) {
  return (
    Number(rawAmount || 0) /
    Math.pow(10, Number(decimals || 0))
  );
}

function inferSwapInputSOL(
  accountData,
  nativeTransfers,
  mint
) {
  /*
   * We do NOT call this "actual spend".
   * This is only an inferred amount based on
   * the repeating OKX router pattern we've observed.
   */

  const source = findNegativeTokenSource(
    accountData,
    mint
  );

  if (!source) {
    return {
      valueSOL: null,
      confidence: "LOW",
      reason:
        "No negative token source account found.",
    };
  }

  const sourceWallet =
    source.userAccount;

  const outgoing =
    getNativeTransfersFromWallet(
      nativeTransfers,
      sourceWallet
    );

  const outgoingLamports =
    sumTransfers(outgoing);

  /*
   * In our repeated samples:
   *
   * 987654
   * + 2963
   * + 4691
   * + 4692
   * = 1,000,000 lamports
   */

  const outgoingSOL =
    lamportsToSol(outgoingLamports);

  let confidence = "LOW";
  let reason =
    "Pattern does not match known OKX 0.001 SOL structure.";

  if (
    outgoingLamports === 1_000_000
  ) {
    confidence = "HIGH";

    reason =
      "Source account sends exactly 0.001 SOL across the observed router transfer pattern.";
  }

  return {
    valueSOL:
      outgoingLamports > 0
        ? outgoingSOL
        : null,

    confidence,

    reason,

    sourceUserAccount:
      sourceWallet,

    sourceTokenAccount:
      source.tokenAccount,

    sourceRawTokenAmount:
      source.rawTokenAmount,

    sourceTokenAmount:
      rawAmountToToken(
        Math.abs(
          source.rawTokenAmount
        ),
        source.decimals
      ),

    sourceDecimals:
      source.decimals,

    sourceOutgoingLamports:
      outgoingLamports,

    sourceOutgoingSOL:
      outgoingSOL,

    sourceOutgoingTransfers:
      outgoing,
  };
}

function buildSwapCandidate(tx) {
  const signature =
    tx?.signature || "N/A";

  const accountData =
    Array.isArray(tx?.accountData)
      ? tx.accountData
      : [];

  const nativeTransfers =
    Array.isArray(tx?.nativeTransfers)
      ? tx.nativeTransfers
      : [];

  const tokenTransfers =
    Array.isArray(tx?.tokenTransfers)
      ? tx.tokenTransfers
      : [];

  const candidates = [];

  for (const transfer of tokenTransfers) {
    const mint =
      transfer?.mint || null;

    if (!mint) {
      continue;
    }

    const fromUser =
      transfer?.fromUserAccount || "";

    const toUser =
      transfer?.toUserAccount || "";

    if (
      toUser !== GAKE_WALLET ||
      fromUser === GAKE_WALLET
    ) {
      continue;
    }

    const tokenAmount =
      Number(
        transfer?.tokenAmount ?? 0
      );

    const gakeNativeChange =
      getNativeBalanceChange(
        accountData,
        GAKE_WALLET
      );

    const gakeTokenRawChange =
      getTokenBalanceChange(
        accountData,
        GAKE_WALLET,
        mint
      );

    const feePayer =
      tx?.feePayer || "";

    const feePayerNativeChange =
      getNativeBalanceChange(
        accountData,
        feePayer
      );

    const inference =
      inferSwapInputSOL(
        accountData,
        nativeTransfers,
        mint
      );

    const candidate = {
      message:
        "🔎 SWAP CANDIDATE",

      action:
        "SWAP_CANDIDATE",

      confidence:
        inference.confidence,

      wallet:
        GAKE_WALLET,

      signature,

      source:
        tx?.source || "N/A",

      type:
        tx?.type || "N/A",

      description:
        tx?.description || "N/A",

      mint,

      tokenAmount,

      fromUserAccount:
        fromUser,

      toUserAccount:
        toUser,

      gakeNativeBalanceChange:
        gakeNativeChange,

      gakeNativeBalanceChangeSOL:
        lamportsToSol(
          gakeNativeChange
        ),

      gakeTokenRawBalanceChange:
        gakeTokenRawChange,

      feePayer,

      fee:
        Number(tx?.fee ?? 0),

      feeSOL:
        lamportsToSol(
          tx?.fee ?? 0
        ),

      feePayerNativeBalanceChange:
        feePayerNativeChange,

      feePayerNativeBalanceChangeSOL:
        lamportsToSol(
          feePayerNativeChange
        ),

      inferredSwapInputSOL:
        inference.valueSOL,

      inferenceReason:
        inference.reason,

      tokenSourceUserAccount:
        inference.sourceUserAccount ||
        null,

      tokenSourceTokenAccount:
        inference.sourceTokenAccount ||
        null,

      tokenSourceTokenAmount:
        inference.sourceTokenAmount ||
        null,

      tokenSourceOutgoingSOL:
        inference.sourceOutgoingSOL ||
        null,

      tokenSourceOutgoingLamports:
        inference.sourceOutgoingLamports ||
        null,

      tokenSourceOutgoingTransfers:
        inference.sourceOutgoingTransfers ||
        [],

      /*
       * IMPORTANT:
       * We now capture these fields so we can inspect
       * the actual instruction/event structure later.
       */

      events:
        tx?.events ?? null,

      instructions:
        tx?.instructions ?? [],

      transactionError:
        tx?.transactionError ?? null,

      nativeTransfers,

      accountData,
    };

    candidates.push(candidate);
  }

  return candidates;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response(
        "Gake Trader Bot is running",
        {
          status: 200,
        }
      );
    }

    try {
      const body =
        await request.json();

      const events =
        Array.isArray(body)
          ? body
          : [body];

      for (const tx of events) {
        if (tx?.type !== "SWAP") {
          continue;
        }

        const candidates =
          buildSwapCandidate(tx);

        for (const candidate of candidates) {
          console.log(candidate);
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          received: events.length,
        }),
        {
          status: 200,
          headers: {
            "content-type":
              "application/json",
          },
        }
      );
    } catch (error) {
      console.error(
        "WEBHOOK ERROR:",
        String(error)
      );

      return new Response(
        JSON.stringify({
          ok: false,
          error: String(error),
        }),
        {
          status: 400,
          headers: {
            "content-type":
              "application/json",
          },
        }
      );
    }
  },
};
