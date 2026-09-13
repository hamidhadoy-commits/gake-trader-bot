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

        console.log("========== HELIUS EVENT ==========");
        console.log("SIGNATURE:", signature);
        console.log("TYPE:", type);
        console.log("SOURCE:", source);

        let detectedTrade = false;

        // =========================
        // TOKEN TRANSFERS
        // =========================

        if (Array.isArray(tx.tokenTransfers)) {
          for (const transfer of tx.tokenTransfers) {
            const mint = transfer.mint || "N/A";
            const amount = transfer.tokenAmount ?? 0;

            const fromUser = transfer.fromUserAccount || "";
            const toUser = transfer.toUserAccount || "";

            // =========================
            // BUY
            // Token enters Gake
            // =========================

            if (toUser === GAKE_WALLET && fromUser !== GAKE_WALLET) {
              detectedTrade = true;

              console.log("🟢 BUY DETECTED");
              console.log(
                JSON.stringify({
                  action: "BUY",
                  wallet: GAKE_WALLET,
                  signature,
                  source,
                  mint,
                  tokenAmount: amount,
                  fromUserAccount: fromUser,
                  toUserAccount: toUser,
                })
              );
            }

            // =========================
            // SELL
            // Token leaves Gake
            // =========================

            if (fromUser === GAKE_WALLET && toUser !== GAKE_WALLET) {
              detectedTrade = true;

              console.log("🔴 SELL DETECTED");
              console.log(
                JSON.stringify({
                  action: "SELL",
                  wallet: GAKE_WALLET,
                  signature,
                  source,
                  mint,
                  tokenAmount: amount,
                  fromUserAccount: fromUser,
                  toUserAccount: toUser,
                })
              );
            }
          }
        }

        if (!detectedTrade) {
          console.log("NO GAKE TRADE DETECTED");
        }

        console.log("========== END EVENT ==========");
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
