const GAKE_WALLET =
  "DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm";

const OKX_INPUT_PATTERN = [
  987654,
  2963,
  4691,
  4692,
];

const OKX_INPUT_TOTAL = 1_000_000;

function getNativeBalanceChange(accountData, wallet) {
  if (!Array.isArray(accountData)) {
    return 0;
  }

  const item = accountData.find(
    (x) => x?.account === wallet
  );

  return Number(item?.nativeBalanceChange ?? 0);
}

function getTokenBalanceChange(
  accountData,
  wallet,
  mint
) {
  if (!Array.isArray(accountData)) {
    return 0;
  }

  let total = 0;

  for (const account of accountData) {
    const changes =
      account?.tokenBalanceChanges;

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

function findNegativeTokenSource(
  accountData,
  mint
) {
  if (!Array.isArray(accountData)) {
    return null;
  }

  for (const account of accountData) {
    const changes =
      account?.tokenBalanceChanges;

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
          account:
            account?.account || null,

          userAccount:
            change?.userAccount || null,

          tokenAccount:
            change?.tokenAccount || null,

          rawTokenAmount:
            amount,

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

function groupNativeTransfersBySender(
  nativeTransfers
) {
  const groups = new Map();

  if (!Array.isArray(nativeTransfers)) {
    return groups;
  }

  for (const transfer of nativeTransfers) {
    const sender =
      transfer?.fromUserAccount;

    const amount =
      Number(transfer?.amount ?? 0);

    if (!sender || amount <= 0) {
      continue;
    }

    if (!groups.has(sender)) {
      groups.set(sender, []);
    }

    groups.get(sender).push({
      amount,
      transfer,
    });
  }

  return groups;
}

function findExactPattern(
  amounts,
  pattern
) {
  const remaining = [...amounts];

  for (const required of pattern) {
    const index =
      remaining.indexOf(required);

    if (index === -1) {
      return false;
    }

    remaining.splice(index, 1);
  }

  return true;
}

function findOKXInputPattern(
  nativeTransfers,
  expectedFromUser
) {
  const groups =
    groupNativeTransfersBySender(
      nativeTransfers
    );

  for (const [
    sender,
    transfers,
  ] of groups.entries()) {
    const amounts =
      transfers.map(
        (item) => item.amount
      );

    const matched =
      findExactPattern(
        amounts,
        OKX_INPUT_PATTERN
      );

    if (!matched) {
      continue;
    }

    const matchedTransfers = [];

    for (
      const required
      of OKX_INPUT_PATTERN
    ) {
      const item =
        transfers.find(
          (x) =>
            x.amount === required &&
            !matchedTransfers.includes(x)
        );

      if (item) {
        matchedTransfers.push(item);
      }
    }

    const total =
      OKX_INPUT_PATTERN.reduce(
        (sum, amount) =>
          sum + amount,
        0
      );

    const matchesTokenTransferUser =
      sender === expectedFromUser;

    return {
      matched: true,

      account: sender,

      lamports: total,

      sol:
        total / 1_000_000_000,

      components:
        OKX_INPUT_PATTERN,

      componentTransfers:
        matchedTransfers.map(
          (item) => item.transfer
        ),

      matchesTokenTransferUser,

      confidence:
        matchesTokenTransferUser
          ? "VERY_HIGH"
          : "HIGH",

      reason:
        matchesTokenTransferUser
          ? "Exact repeated OKX 0.001 SOL input pattern detected and the payer matches tokenTransfers.fromUserAccount."
          : "Exact repeated OKX 0.001 SOL input pattern detected; payer differs from token source user account.",
    };
  }

  return {
    matched: false,

    account: null,

    lamports: null,

    sol: null,

    components: [],

    componentTransfers: [],

    matchesTokenTransferUser: false,

    confidence: "LOW",

    reason:
      "Known OKX 0.001 SOL input pattern was not found.",
  };
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
      sum +
      Number(
        transfer?.amount ?? 0
      ),
    0
  );
}

function lamportsToSol(lamports) {
  return (
    Number(lamports || 0) /
    1_000_000_000
  );
}

function rawAmountToToken(
  rawAmount,
  decimals
) {
  return (
    Number(rawAmount || 0) /
    Math.pow(
      10,
      Number(decimals || 0)
    )
  );
}

function buildRoleAnalysis({
  gakeNativeChange,
  fromUser,
  feePayer,
  inference,
  tokenSourceUserAccount,
}) {
  return {
    gakeReceivedToken: true,

    gakePaidSOL:
      gakeNativeChange < 0,

    gakeNativeBalanceChangeSOL:
      lamportsToSol(
        gakeNativeChange
      ),

    tokenTransferFromUser:
      fromUser || null,

    inferredInputAccount:
      inference.account || null,

    tokenSourceUserAccount:
      tokenSourceUserAccount || null,

    feePayer:
      feePayer || null,

    inputAccountMatchesTokenTransfer:
      inference.matchesTokenTransferUser,

    inputAccountIsTokenSource:
      inference.account ===
      tokenSourceUserAccount,

    inputAccountIsFeePayer:
      inference.account ===
      feePayer,
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

  for (
    const transfer
    of tokenTransfers
  ) {
    const mint =
      transfer?.mint || null;

    if (!mint) {
      continue;
    }

    const fromUser =
      transfer?.fromUserAccount || "";

    const toUser =
      transfer?.toUserAccount || "";

    /*
     * We only care about tokens
     * entering Gake.
     */
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

    const fee =
      Number(tx?.fee ?? 0);

    const feePayerNativeChange =
      getNativeBalanceChange(
        accountData,
        feePayer
      );

    /*
     * IMPORTANT:
     *
     * Do NOT use the token source
     * account as the SOL payer.
     *
     * We search nativeTransfers
     * independently.
     */
    const inference =
      findOKXInputPattern(
        nativeTransfers,
        fromUser
      );

    const tokenSource =
      findNegativeTokenSource(
        accountData,
        mint
      );

    const roleAnalysis =
      buildRoleAnalysis({
        gakeNativeChange,
        fromUser,
        feePayer,
        inference,
        tokenSourceUserAccount:
          tokenSource?.userAccount ||
          null,
      });

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

      /*
       * Gake's own balance change.
       */
      gakeNativeBalanceChange:
        gakeNativeChange,

      gakeNativeBalanceChangeSOL:
        lamportsToSol(
          gakeNativeChange
        ),

      gakeTokenRawBalanceChange:
        gakeTokenRawChange,

      /*
       * Transaction fee payer.
       */
      feePayer,

      fee,

      feeSOL:
        lamportsToSol(fee),

      feePayerNativeBalanceChange:
        feePayerNativeChange,

      feePayerNativeBalanceChangeSOL:
        lamportsToSol(
          feePayerNativeChange
        ),

      /*
       * Inferred economic input.
       */
      inferredInputAccount:
        inference.account,

      inferredSwapInputSOL:
        inference.sol,

      inferredSwapInputLamports:
        inference.lamports,

      inferredInputConfidence:
        inference.confidence,

      inferenceReason:
        inference.reason,

      inputPatternMatched:
        inference.matched,

      inputPatternComponents:
        inference.components,

      inputPatternTotalLamports:
        inference.lamports,

      inputPatternComponentTransfers:
        inference.componentTransfers,

      inputAccountMatchesTokenTransfer:
        inference.matchesTokenTransferUser,

      /*
       * Token source is kept separate.
       */
      tokenSourceUserAccount:
        tokenSource?.userAccount ||
        null,

      tokenSourceTokenAccount:
        tokenSource?.tokenAccount ||
        null,

      tokenSourceRawTokenAmount:
        tokenSource?.rawTokenAmount ||
        null,

      tokenSourceTokenAmount:
        tokenSource
          ? rawAmountToToken(
              Math.abs(
                tokenSource.rawTokenAmount
              ),
              tokenSource.decimals
            )
          : null,

      tokenSourceDecimals:
        tokenSource?.decimals ??
        null,

      /*
       * Role analysis.
       */
      roleAnalysis,

      /*
       * All raw transfer data
       * remains available.
       */
      nativeTransfers,

      accountData,

      events:
        tx?.events ?? null,

      instructions:
        tx?.instructions ?? [],

      transactionError:
        tx?.transactionError ?? null,
    };

    candidates.push(candidate);
  }

  return candidates;
}

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    if (
      request.method !== "POST"
    ) {
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

      for (
        const tx
        of events
      ) {
        if (
          tx?.type !== "SWAP"
        ) {
          continue;
        }

        const candidates =
          buildSwapCandidate(tx);

        for (
          const candidate
          of candidates
        ) {
          console.log(
            candidate
          );
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          received:
            events.length,
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
          error:
            String(error),
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
