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
        console.log("========== NEW HELIUS EVENT ==========");

        console.log("SIGNATURE:", tx.signature || "N/A");
        console.log("TYPE:", tx.type || "N/A");
        console.log("SOURCE:", tx.source || "N/A");
        console.log("DESCRIPTION:", tx.description || "N/A");

        console.log("----- NATIVE TRANSFERS -----");

        if (
          Array.isArray(tx.nativeTransfers) &&
          tx.nativeTransfers.length > 0
        ) {
          tx.nativeTransfers.forEach((transfer, index) => {
            console.log(
              "NATIVE #" + index,
              JSON.stringify(transfer)
            );
          });
        } else {
          console.log("No native transfers");
        }

        console.log("----- TOKEN TRANSFERS -----");

        if (
          Array.isArray(tx.tokenTransfers) &&
          tx.tokenTransfers.length > 0
        ) {
          tx.tokenTransfers.forEach((transfer, index) => {
            console.log(
              "TOKEN #" + index,
              JSON.stringify(transfer)
            );
          });
        } else {
          console.log("No token transfers");
        }

        console.log("----- FULL TRANSACTION -----");
        console.log(JSON.stringify(tx));

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
