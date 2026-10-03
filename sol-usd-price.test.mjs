import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("./sol-usd-price.js", import.meta.url), "utf8");
const { fetchLiveSolUsdPrice } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const WSOL = "So11111111111111111111111111111111111111112";
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });
function responses(items) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const item = items.shift();
    if (item instanceof Error) throw item;
    return { ok: item.status === 200, status: item.status, json: async () => item.data };
  };
  return calls;
}
test("CoinGecko primary uses demo key and does not call fallback", async () => {
  const calls = responses([{ status: 200, data: { solana: { usd: 120 } } }]);
  assert.deepEqual(await fetchLiveSolUsdPrice({ coingeckoApiKey: "test-cg" }), { price: 120, source: "COINGECKO" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["x-cg-demo-api-key"], "test-cg");
});
test("HTTP403 uses live Jupiter and its key", async () => {
  const calls = responses([{ status: 403 }, { status: 200, data: { [WSOL]: { usdPrice: 119 } } }]);
  assert.deepEqual(await fetchLiveSolUsdPrice({ jupiterApiKey: "test-jup" }), { price: 119, source: "JUPITER_PRICE_V3" });
  assert.equal(calls[1].options.headers["x-api-key"], "test-jup");
});
test("invalid primary price falls back to live price", async () => {
  responses([{ status: 200, data: { solana: { usd: 0 } } }, { status: 200, data: { [WSOL]: { usdPrice: 121 } } }]);
  assert.equal((await fetchLiveSolUsdPrice()).price, 121);
});
test("network failure falls back without a key", async () => {
  const calls = responses([new Error("network"), { status: 200, data: { [WSOL]: { usdPrice: 122 } } }]);
  assert.equal((await fetchLiveSolUsdPrice()).price, 122);
  assert.equal(calls[1].options.headers["x-api-key"], undefined);
});
test("no valid live price throws instead of inventing a value", async () => {
  responses([{ status: 429 }, { status: 200, data: { [WSOL]: { usdPrice: -1 } } }]);
  await assert.rejects(fetchLiveSolUsdPrice(), /No live SOL\/USD price/);
});
test("missing prices are rejected", async () => {
  responses([{ status: 200, data: {} }, { status: 200, data: {} }]);
  await assert.rejects(fetchLiveSolUsdPrice(), /Invalid price/);
});
