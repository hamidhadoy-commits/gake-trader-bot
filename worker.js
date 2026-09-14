const GAKE_WALLET =
  "DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm";

function getNativeBalanceChange(accountData, wallet) {
  if (!Array.isArray(accountData)) {
    return 0;
  }

  const item = accountData.find(
    (x) => x.account === wallet
  );

  return item?.nativeBalanceChange ?? 0;
}

function getTokenBalanceChange(accountData, wallet, mint) {
  if (!Array.isArray(accountData)) {
    return 0;
  }

  let total = 0;

  for (const account of accountData) {
    if (
      account?.tokenBalanceChanges &&
      Array.isArray(account.tokenBalanceChanges)
    ) {
      for (const change of account.tokenBalanceChanges) {
        if (
          change.userAccount === wallet &&
          change.mint === mint
        ) {
          total += Number(
            change.rawTokenAmount?.tokenAmount || 0
          );
        }
      }
    }
  }

  return total;
}

function lamportsToSol(lamports) {
  return lamports / 1_000_000_000;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Gake Trader Bot is running", {
        status: 200,
      });
    }

    try {
      const body = await request.json();
      const events = Array.isArray(body) ? body : [body];

      for (const tx of events) {
        const signature = tx.signature || "N/A";
        const type = tx.type || "N/A";
        const source = tx.source || "N/A";

        const accountData = Array.isArray(tx.accountData)
          ? tx.accountData
          : [];

        const nativeTransfers = Array.isArray(tx.nativeTransfers)
          ? tx.nativeTransfers
          : [];

        const tokenTransfers = Array.isArray(tx.tokenTransfers)
          ? tx.tokenTransfers
          : [];

        if (type !== "SWAP") {
          continue;
        }

        for (const transfer of tokenTransfers) {
          const mint = transfer.mint || "N/A";
          const tokenAmount = Number(
            transfer.tokenAmount ?? 0
          );

          const fromUser =
            transfer.fromUserAccount || "";

          const toUser =
            transfer.toUserAccount || "";

          // =========================================
          // TOKEN ENTERED GAKE
          // =========================================

          if (
            toUser === GAKE_WALLET &&
            fromUser !== GAKE_WALLET
          ) {
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

            const feePayerNativeChange =
              getNativeBalanceChange(
                accountData,
                tx.feePayer || ""
              );

            console.log({
              message: "🟡 TOKEN RECEIVED",
              action: "TOKEN_RECEIVED",

              wallet: GAKE_WALLET,

              signature,
              source,
              type,

              description: tx.description || "N/A",

              mint,
              tokenAmount,

              fromUserAccount: fromUser,
              toUserAccount: toUser,

              fee: tx.fee ?? 0,
              feeSOL: lamportsToSol(tx.fee ?? 0),

              feePayer: tx.feePayer || "N/A",

              gakeNativeBalanceChange:
                gakeNativeChange,

              gakeNativeBalanceChangeSOL:
                lamportsToSol(gakeNativeChange),

              gakeTokenRawBalanceChange:
                gakeTokenRawChange,

              feePayerNativeBalanceChange:
                feePayerNativeChange,

              feePayerNativeBalanceChangeSOL:
                lamportsToSol(
                  feePayerNativeChange
                ),

              accountData,
              nativeTransfers,
            });
          }

          // =========================================
          // TOKEN LEFT GAKE
          // =========================================

          if (
            fromUser === GAKE_WALLET &&
            toUser !== GAKE_WALLET
          ) {
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

            const feePayerNativeChange =
              getNativeBalanceChange(
                accountData,
                tx.feePayer || ""
              );

            console.log({
              message: "🟠 TOKEN SENT",
              action: "TOKEN_SENT",

              wallet: GAKE_WALLET,

              signature,
              source,
              type,

              description: tx.description || "N/A",

              mint,
              tokenAmount,

              fromUserAccount: fromUser,
              toUserAccount: toUser,

              fee: tx.fee ?? 0,
              feeSOL: lamportsToSol(tx.fee ?? 0),

              feePayer: tx.feePayer || "N/A",

              gakeNativeBalanceChange:
                gakeNativeChange,

              gakeNativeBalanceChangeSOL:
                lamportsToSol(gakeNativeChange),

              gakeTokenRawBalanceChange:
                gakeTokenRawChange,

              feePayerNativeBalanceChange:
                feePayerNativeChange,

              feePayerNativeBalanceChangeSOL:
                lamportsToSol(
                  feePayerNativeChange
                ),

              accountData,
              nativeTransfers,
            });
          }
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
            "content-type": "application/json",
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
            "content-type": "application/json",
          },
        }
      );
    }
  },
};
