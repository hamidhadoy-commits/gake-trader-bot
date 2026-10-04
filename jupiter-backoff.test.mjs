import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const original = await readFile(new URL("./price-provider.js", import.meta.url), "utf8");
let run = 0;
const base = await import("data:text/javascript;base64," + Buffer.from(original + "\nexport { getJupiterRetryDelay };").toString("base64"));
const delay = (headers, status = 429) => base.getJupiterRetryDelay(new Response("", { status, headers }), 1200, 10000);
test("reset timestamp postpones retry until after reset", () => {
  assert.equal(delay({ "x-ratelimit-reset": "13" }), 3050);
});
test("Retry-After seconds and date are honoured", () => {
  assert.equal(delay({ "retry-after": "3" }), 3000);
  assert.equal(delay({ "retry-after": new Date(14000).toUTCString() }), 4000);
});
test("conflicting headers use the later allowed retry", () => {
  assert.equal(delay({ "x-ratelimit-reset": "13", "retry-after": "4" }), 4000);
});
test("missing malformed and expired headers retain fallback", () => {
  assert.equal(delay({}), 1200);
  assert.equal(delay({ "x-ratelimit-reset": "NaN", "retry-after": "bad" }), 1200);
  assert.equal(delay({ "x-ratelimit-reset": "1", "retry-after": "-1" }), 1200);
});
test("long quota waits skip retry rather than retry prematurely", () => {
  assert.equal(delay({ "x-ratelimit-reset": "30" }), null);
  assert.equal(delay({ "retry-after": "60" }), null);
});
test("server errors keep the existing retry delay", () => {
  assert.equal(delay({ "retry-after": "60" }, 503), 1200);
});
const realNow = Date.now, realFetch = globalThis.fetch;
test.afterEach(() => { Date.now = realNow; globalThis.fetch = realFetch; });
for (const side of ["Buy", "Sell"]) {
  test(side + " quote preserves HTTP429 and does not retry long quota wait", async () => {
    let clock = 10000, calls = 0;
    Date.now = () => clock;
    globalThis.fetch = async () => {
      clock += 2000; calls++;
      if (calls === 1) return new Response(JSON.stringify([{ id: "A", decimals: 6 }]));
      return new Response("quota exceeded", { status: 429, headers: { "x-ratelimit-reset": "30" } });
    };
    const source = original + "\n// quota integration " + (++run);
    const m = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    const quote = await m["fetchJupiterExecutable" + side + "Quote"]({
      mint: "A", inputLamports: 1000000000, tokenAmount: 1, jupiterApiKey: "test"
    });
    assert.equal(calls, 2);
    assert.equal(quote.executable, false);
    assert.equal(quote.reason, "http_error");
    assert.equal(quote.status, 429);
  });
}

