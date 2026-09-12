export default {
  async fetch(request, env, ctx) {
    // فقط POST را قبول می‌کنیم
    if (request.method !== "POST") {
      return new Response("Gake Trader Bot is running", {
        status: 200,
      });
    }

    try {
      const body = await request.json();

      // Helius معمولاً webhook را به صورت آرایه می‌فرستد
      const events = Array.isArray(body) ? body : [body];

      for (const tx of events) {
        console.log("========== HELIUS TRANSACTION ==========");

        console.log("Signature:", tx.signature || "N/A");
        console.log("Type:", tx.type || "N/A");
        console.log("Description:", tx.description || "N/A");
        console.log("Source:", tx.source || "N/A");

        // اطلاعات پرداخت SOL
        if (Array.isArray(tx.nativeTransfers)) {
          console.log("Native Transfers:");

          for (const transfer of tx.nativeTransfers) {
            console.log({
              from: transfer.fromUserAccount,
              to: transfer.toUserAccount,
              amountSOL:
                typeof transfer.amount === "number"
                  ? transfer.amount / 1e9
                  : null,
            });
          }
        }

        // اطلاعات توکن
        if (Array.isArray(tx.tokenTransfers)) {
          console.log("Token Transfers:");

          for (const transfer of tx.tokenTransfers) {
            console.log({
              from: transfer.fromUserAccount,
              to: transfer.toUserAccount,
              mint: transfer.mint,
              amount: transfer.tokenAmount,
            });
          }
        }

        // تشخیص اولیه SWAP / BUY
        if (
          tx.type === "SWAP" ||
          tx.type === "BUY"
        ) {
          console.log(">>> SWAP/BUY DETECTED <<<");

          // اگر توکن دریافتی وجود داشته باشد
          if (Array.isArray(tx.tokenTransfers)) {
            for (const transfer of tx.tokenTransfers) {
              if (transfer.toUserAccount) {
                console.log(
                  "Possible received token mint:",
                  transfer.mint
                );
              }
            }
          }
        }

        console.log("========================================");
      }

      // Helius باید پاسخ موفق دریافت کند
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
      console.error("Webhook error:", error);

      // برای خطای JSON، 400 می‌دهیم
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
