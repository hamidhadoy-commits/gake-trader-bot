const GAKE_WALLET =
  "DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm";

export default {
  async fetch(request, env, ctx) {
    // Helius sends webhook events with POST
    if (request.method !== "POST") {
      return new Response("Gake Trader Bot is running", {
        status: 200,
      });
    }

    try {
      const payload = await request.json();

      console.log("========== HELIUS WEBHOOK ==========");
      console.log("Received at:", new Date().toISOString());
      console.log("Payload type:", Array.isArray(payload) ? "ARRAY" : typeof payload);

      const events = Array.isArray(payload) ? payload : [payload];

      console.log("Number of events:", events.length);

      for (const event of events) {
        console.log("---------- EVENT ----------");

        console.log("Signature:", event.signature || "N/A");
        console.log("Type:", event.type || "N/A");
        console.log("Source:", event.source || "N/A");
        console.log("Description:", event.description || "N/A");
        console.log("Timestamp:", event.timestamp || "N/A");

        // Native SOL transfers
        if (event.nativeTransfers) {
          console.log(
            "Native transfers:",
            JSON.stringify(event.nativeTransfers)
          );
        }

        // Token transfers
        if (event.tokenTransfers) {
          console.log(
            "Token transfers:",
            JSON.stringify(event.tokenTransfers)
          );
        }

        // Account-level parsed data
        if (event.accountData) {
          console.log(
            "Account data:",
            JSON.stringify(event.accountData)
          );
        }

        // Keep the raw event available for analysis
        console.log(
          "RAW EVENT:",
          JSON.stringify(event)
        );

        // Basic Buy/Sell detection from the Helius description
        const description = (event.description || "").toLowerCase();

        let detectedAction = "UNKNOWN";

        if (
          description.includes("swapped") &&
          description.includes("for")
        ) {
          if (
            description.includes("sol for") ||
            description.includes("solana for")
          ) {
            detectedAction = "BUY_CANDIDATE";
          }
        }

        if (
          description.includes("for sol") ||
          description.includes("for solana")
        ) {
          detectedAction = "SELL_CANDIDATE";
        }

        console.log("Detected action:", detectedAction);
        console.log("Monitored wallet:", GAKE_WALLET);
      }

      console.log("========== END WEBHOOK ==========");

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
      console.error("WEBHOOK ERROR:", error);

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
