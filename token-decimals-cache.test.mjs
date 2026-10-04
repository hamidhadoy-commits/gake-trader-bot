import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const original = await readFile(new URL("./price-provider.js", import.meta.url), "utf8");
const realFetch = globalThis.fetch;
const realNow = Date.now;
let run = 0;
test.afterEach(() => { globalThis.fetch = realFetch; Date.now = realNow; });
async function setup(reply) {
  let clock = 10000;
  const calls = [];
  Date.now = () => clock;
  globalThis.fetch = async url => {
    const mints = new URL(url).searchParams.get("query").split(",");
    calls.push(mints); clock += 2000;
    return new Response(JSON.stringify(reply(mints)), { status: 200 });
  };
  const source = original + "\nexport { fetchJupiterTokenDecimals };\n// cache test " + (++run);
  const m = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  return { m, calls, advance: ms => { clock += ms; } };
}
test("repeated metadata request uses valid cached decimals including zero", async () => {
  const h = await setup(ms => ms.map(id => ({ id, decimals: id === "A" ? 6 : 0 })));
  const first = await h.m.fetchJupiterTokenDecimals(["A", "B"], "test");
  const second = await h.m.fetchJupiterTokenDecimals(["A", "B"], "test");
  assert.deepEqual([...second], [...first]); assert.equal(second.get("B"), 0);
  assert.equal(h.calls.length, 1);
});
test("mixed cached and missing mints request only the missing mint", async () => {
  const h = await setup(ms => ms.map(id => ({ id, decimals: 6 })));
  await h.m.fetchJupiterTokenDecimals(["A"], "test");
  const map = await h.m.fetchJupiterTokenDecimals(["A", "B", "B"], "test");
  assert.deepEqual(h.calls, [["A"], ["B"]]); assert.equal(map.size, 2);
});
test("expired metadata is fetched again", async () => {
  let decimals = 6;
  const h = await setup(ms => ms.map(id => ({ id, decimals })));
  await h.m.fetchJupiterTokenDecimals(["A"], "test");
  h.advance(300000); decimals = 9;
  const map = await h.m.fetchJupiterTokenDecimals(["A"], "test");
  assert.equal(h.calls.length, 2); assert.equal(map.get("A"), 9);
});
test("missing and invalid metadata are not cached", async () => {
  let valid = false;
  const h = await setup(ms => valid ? ms.map(id => ({ id, decimals: 6 })) : [{ id: "A", decimals: 19 }]);
  assert.equal((await h.m.fetchJupiterTokenDecimals(["A", "B"], "test")).size, 0);
  valid = true; const map = await h.m.fetchJupiterTokenDecimals(["A", "B"], "test");
  assert.equal(h.calls.length, 2); assert.equal(map.size, 2);
});
test("cache is bounded and evicted metadata is requested again", async () => {
  const h = await setup(ms => ms.map(id => ({ id, decimals: 6 })));
  const ids = Array.from({ length: 257 }, (_, i) => "M" + i);
  await h.m.fetchJupiterTokenDecimals(ids, "test");
  const before = h.calls.length;
  await h.m.fetchJupiterTokenDecimals(["M256"], "test");
  assert.equal(h.calls.length, before);
  await h.m.fetchJupiterTokenDecimals(["M0"], "test");
  assert.equal(h.calls.length, before + 1);
});
test("cached metadata does not bypass a missing API key", async () => {
  const h = await setup(ms => ms.map(id => ({ id, decimals: 6 })));
  await h.m.fetchJupiterTokenDecimals(["A"], "test");
  assert.equal((await h.m.fetchJupiterTokenDecimals(["A"], null)).size, 0);
  assert.equal(h.calls.length, 1);
});

