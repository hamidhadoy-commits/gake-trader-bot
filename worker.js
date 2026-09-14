const GAKE_WALLET =
  "DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm";

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

        if (!Array.isArray(tx.tokenTransfers)) {
          continue;
        }

        for (const transfer of tx.tokenTransfers) {
          const mint = transfer.mint || "N/A";
          const tokenAmount = transfer.tokenAmount ?? 0;

          const fromUser = transfer.fromUserAccount || "";
          const toUser = transfer.toUserAccount || "";

          // =========================
          // BUY DETECTION
          // =========================

          if (
            type === "SWAP" &&
            toUser === GAKE_WALLET &&
            fromUser !== GAKE_WALLET
          ) {
            console.log({
              message: "🟢 BUY DETECTED",
              action: "BUY",

              wallet: GAKE_WALLET,

              signature,
              source,
              type,

              description: tx.description || "N/A",

              fee: tx.fee ?? 0,
              feePayer: tx.feePayer || "N/A",

              mint,
              tokenAmount,

              fromUserAccount: fromUser,
              toUserAccount: toUser,

              accountData: Array.isArray(tx.accountData)
                ? tx.accountData
                : [],

              nativeTransfers: Array.isArray(tx.nativeTransfers)
                ? tx.nativeTransfers
                : [],
            });
          }

          // =========================
          // SELL DETECTION
          // =========================

          if (
            type === "SWAP" &&
            fromUser === GAKE_WALLET &&
            toUser !== GAKE_WALLET
          ) {
            console.log({
              message: "🔴 SELL DETECTED",
              action: "SELL",

              wallet: GAKE_WALLET,

              signature,
              source,
              type,

              description: tx.description || "N/A",

              fee: tx.fee ?? 0,
              feePayer: tx.feePayer || "N/A",

              mint,
              tokenAmount,

              fromUserAccount: fromUser,
              toUserAccount: toUser,

              accountData: Array.isArray(tx.accountData)
                ? tx.accountData
                : [],

              nativeTransfers: Array.isArray(tx.nativeTransfers)
                ? tx.nativeTransfers
                : [],
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
      console.error("WEBHOOK ERROR:", String(error));

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
