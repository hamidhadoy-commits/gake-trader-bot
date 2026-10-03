const WSOL = "So11111111111111111111111111111111111111112";
const CG_URL = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";
const JUP_URL = "https://api.jup.ag/price/v3?ids=" + WSOL;

export async function fetchLiveSolUsdPrice({
  coingeckoApiKey = null, jupiterApiKey = null,
} = {}) {
  const providers = [
    { source: "COINGECKO", url: CG_URL,
      headers: coingeckoApiKey ? { "x-cg-demo-api-key": coingeckoApiKey } : {},
      read: (data) => data?.solana?.usd },
    { source: "JUPITER_PRICE_V3", url: JUP_URL,
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
      read: (data) => data?.[WSOL]?.usdPrice },
  ];
  const failures = [];
  for (const provider of providers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(provider.url, {
        method: "GET", headers: { accept: "application/json", ...provider.headers },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const price = Number(provider.read(await response.json()));
      if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid price");
      return { price, source: provider.source };
    } catch (error) {
      // Do not log headers, credentials or provider response bodies.
      failures.push(provider.source + ": " + String(error));
    } finally { clearTimeout(timer); }
  }
  throw new Error("No live SOL/USD price; " + failures.join("; "));
}
