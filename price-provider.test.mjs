import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./price-provider.js", import.meta.url), "utf8");
const SOL = "So11111111111111111111111111111111111111112";
let moduleId = 0;
const coinGecko = (prices) =>
  Response.json({ data: { attributes: { token_prices: prices } } });
const pair = (mint, price = 0.04, quote = SOL) => ({
  chainId: "solana", baseToken: { address: mint },
  quoteToken: { address: quote }, priceNative: String(price),
  liquidity: { usd: 1000 },
});

async function check(mints, options, mock, verify) {
  const calls = [], logs = [];
  const saved = { fetch: globalThis.fetch, log: console.log, warn: console.warn };
  try {
    console.log = console.warn = (entry) => logs.push(entry);
    globalThis.fetch = async (url) => {
      const request = String(url);
      calls.push(request);
      assert.ok(!request.includes("/swap/"), "Mark pricing must not call swap APIs");
      return mock(request, calls);
    };
    const encoded = Buffer.from(source + "\n// case " + (++moduleId)).toString("base64");
    const provider = await import("data:text/javascript;base64," + encoded);
    const prices = await provider.fetchPaperExitSolPrices(mints, options);
    verify(prices, calls, logs);
  } finally {
    globalThis.fetch = saved.fetch; console.log = saved.log; console.warn = saved.warn;
  }
}

test("CoinGecko remains primary and duplicate mints are removed", async () => {
  await check(["A", "A"], { coingeckoApiKey: "mock", jupiterApiKey: "mock" },
    () => coinGecko({ [SOL]: 100, A: 2 }), (p, c) => {
      assert.equal(p.get("A").priceSOLPerToken, 0.02); assert.equal(c.length, 1);
    });
});

test("Fallbacks request only missing mints and preserve primary prices", async () => {
  await check(["A", "B", "C", "D"], { coingeckoApiKey: "mock", jupiterApiKey: "mock" },
    (url) => {
      if (url.includes("coingecko")) return coinGecko({ [SOL]: 100, A: 2 });
      if (url.includes("jup.ag")) {
        const ids = new URL(url).searchParams.get("ids").split(",");
        assert.ok(!ids.includes("A"));
        return Response.json({ [SOL]: { usdPrice: 100 }, A: { usdPrice: 999 },
          B: { usdPrice: 3 }, C: { usdPrice: 0 } });
      }
      assert.deepEqual(url.split("/").at(-1).split(","), ["C", "D"]);
      return Response.json([pair("C"), pair("D", -1), pair("D", 1, "USDC")]);
    }, (p, c, logs) => {
      assert.equal(p.size, 3); assert.equal(c.length, 3);
      assert.equal(p.get("A").priceSOLPerToken, 0.02);
      assert.equal(p.get("B").priceSOLPerToken, 0.03);
      assert.equal(p.get("C").priceSOLPerToken, 0.04);
      const summary = logs.at(-1);
      assert.equal(summary.coinGeckoPriced, 1); assert.equal(summary.jupiterPriced, 1);
      assert.equal(summary.dexScreenerPriced, 1); assert.equal(summary.missing, 1);
      assert.equal(summary.execution, "DISABLED"); assert.equal(summary.realMoney, false);
    });
});

test("Jupiter needs a valid SOL price before computing the ratio", async () => {
  await check(["A"], { jupiterApiKey: "mock" },
    (u) => u.includes("jup.ag") ? Response.json({ A: { usdPrice: 2 } })
      : Response.json([pair("A")]),
    (p) => assert.equal(p.get("A").priceSOLPerToken, 0.04));
});

test("CoinGecko 429 permits the next provider without throwing", async () => {
  await check(["A"], { coingeckoApiKey: "mock" },
    (u) => u.includes("coingecko") ? new Response("limited", { status: 429 })
      : Response.json([pair("A")]),
    (p, c) => { assert.equal(p.size, 1); assert.equal(c.length, 2); });
});

test("DEX 429 stops later batches and keeps already collected prices", async () => {
  const mints = Array.from({ length: 61 }, (_, i) => "M" + i);
  await check(mints, {}, (_, calls) => calls.length === 1
    ? Response.json(mints.slice(0, 30).map((m) => pair(m)))
    : new Response("limited", { status: 429 }),
    (p, c) => { assert.equal(p.size, 30); assert.equal(c.length, 2); });
});

test("Invalid primary JSON permits fallback", async () => {
  await check(["A"], { coingeckoApiKey: "mock" },
    (u) => u.includes("coingecko") ? new Response("bad json")
      : Response.json([pair("A")]), (p) => assert.equal(p.size, 1));
});

test("Unavailable prices remain absent", async () => {
  await check(["A"], {}, () => Response.json([]),
    (p, c) => { assert.equal(p.size, 0); assert.equal(c.length, 1); });
});

test("Empty input does not make HTTP requests", async () => {
  await check([], { coingeckoApiKey: "mock", jupiterApiKey: "mock" },
    () => { throw new Error("Unexpected HTTP request"); },
    (p, c) => { assert.equal(p.size, 0); assert.equal(c.length, 0); });
});

test("A network failure retries DEX once and safely leaves prices absent", async () => {
  await check(["A"], {}, () => { throw new Error("Mock network failure"); },
    (p, c) => { assert.equal(p.size, 0); assert.equal(c.length, 2); });
});

test("Jupiter HTTP failures still allow DEX fallback", async () => {
  await check(["A"], { jupiterApiKey: "mock" },
    (u) => u.includes("jup.ag") ? new Response("unavailable", { status: 503 })
      : Response.json([pair("A")]), (p, c) => {
        assert.equal(p.size, 1); assert.equal(c.filter(u => u.includes("jup.ag")).length, 2);
      });
});
