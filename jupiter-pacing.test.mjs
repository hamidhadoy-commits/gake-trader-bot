import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const original = await readFile(new URL("./price-provider.js", import.meta.url), "utf8");
let run = 0;
async function setup() {
  let clock = 10000;
  const waiting = [];
  const starts = [];
  const responses = [];
  const source = original.replace(
    /function sleep\(ms\) \{[\s\S]*?\n\}/,
    "function sleep(ms) { return globalThis.__pacingSleep(ms); }"
  ) + "\nexport { fetchJupiterWithPacing };\n// run " + (++run);
  globalThis.__pacingSleep = ms => new Promise(resolve => waiting.push({ ms, due: clock + ms, resolve }));
  Date.now = () => clock;
  globalThis.fetch = () => {
    starts.push(clock);
    return new Promise((resolve, reject) => responses.push({ resolve, reject }));
  };
  const m = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const advance = async (lateBy = 0) => {
    assert.ok(waiting.length > 0, "expected a pending pacing timer");
    clock = Math.min(...waiting.map(timer => timer.due)) + lateBy;
    const due = waiting.filter(timer => timer.due <= clock);
    for (const timer of due) waiting.splice(waiting.indexOf(timer), 1);
    due.forEach(timer => timer.resolve());
    await flush();
  };
  return { m, starts, responses, waiting, flush, advance };
}
const realNow = Date.now;
const realFetch = globalThis.fetch;
test.afterEach(() => { Date.now = realNow; globalThis.fetch = realFetch; delete globalThis.__pacingSleep; });
test("concurrent starts remain 1100ms apart", async () => {
  const h = await setup();
  const ps = [1, 2, 3].map(i => h.m.fetchJupiterWithPacing("mock:" + i, "test"));
  await h.flush(); assert.deepEqual(h.starts, [10000]);
  await h.advance(); assert.deepEqual(h.starts, [10000, 11100]);
  await h.advance(); assert.deepEqual(h.starts, [10000, 11100, 12200]);
  h.responses.forEach(x => x.resolve(Response.json({ ok: true }))); await Promise.all(ps);
});
test("slow responses do not block later request starts", async () => {
  const h = await setup();
  const p1 = h.m.fetchJupiterWithPacing("mock:1", "test");
  const p2 = h.m.fetchJupiterWithPacing("mock:2", "test");
  await h.flush(); await h.advance();
  assert.equal(h.responses.length, 2);
  h.responses[1].resolve(Response.json({ ok: true })); await p2;
  h.responses[0].resolve(Response.json({ ok: true })); await p1;
});
test("failed request does not leave queue locked", async () => {
  const h = await setup();
  const p1 = h.m.fetchJupiterWithPacing("mock:1", "test");
  const rejected = assert.rejects(p1, /network failed/);
  await h.flush(); h.responses[0].reject(new Error("network failed")); await rejected;
  const p2 = h.m.fetchJupiterWithPacing("mock:2", "test");
  await h.flush(); await h.advance();
  assert.deepEqual(h.starts, [10000, 11100]);
  h.responses[1].resolve(Response.json({ ok: true })); await p2;
});


test("simultaneous late timer wakes recheck the last start time", async () => {
  const h = await setup();
  const ps = [1, 2, 3].map(i => h.m.fetchJupiterWithPacing("mock:" + i, "test"));
  await h.flush();
  assert.deepEqual(h.starts, [10000]);
  await h.advance(500);
  assert.deepEqual(h.starts, [10000, 11600]);
  await h.advance();
  assert.deepEqual(h.starts, [10000, 11600, 12700]);
  h.responses.forEach(x => x.resolve(Response.json({ ok: true })));
  await Promise.all(ps);
});
