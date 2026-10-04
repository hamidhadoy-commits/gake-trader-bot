import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';

const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('./sol-usd-observation-migration.sql', import.meta.url), 'utf8');
const observation = source.slice(source.indexOf('async function runImmediateEntryObservation('), source.indexOf('async function handleWebhook('));
const pricing = source.slice(source.indexOf('async function getSolUsdPrice('), source.indexOf('async function getPaperCopyPosition('));
const columns = observation.match(/INSERT OR IGNORE INTO paper_immediate_entry_checks \(([\s\S]*?)\)\s*VALUES/)[1].split(',').map(x => x.trim());

function setup(live) {
  const db = new DatabaseSync(':memory:');
  const oldColumns = columns.filter(x => !['sol_usd_price', 'sol_usd_source'].includes(x));
  db.exec(`CREATE TABLE paper_immediate_entry_checks (${oldColumns.map(x => x + (x === 'source_signature' ? ' TEXT PRIMARY KEY' : '')).join(',')})`);
  db.prepare('INSERT INTO paper_immediate_entry_checks(source_signature, mint) VALUES (?,?)').run('old', 'OLD_MINT');
  db.exec(migration);
  const logs = []; let quoteCount = 0;
  const context = vm.createContext({
    console: { log: x => logs.push(x), warn: x => logs.push(x) },
    getPaperCopyConfig: async () => ({}), getPaperCopyAccount: async () => ({initial_sol_usd_price: 110.25}),
    fetchLiveSolUsdPrice: async () => { if (live instanceof Error) throw live; return live; },
    buildPaperCopySizing: ({solUsdPrice}) => ({ok: true, finalNotionalLamports: Math.floor(5 / solUsdPrice * 1e9)}),
    lamportsToSOL: n => n / 1e9, WRAPPED_SOL_MINT: 'WSOL',
    fetchJupiterExecutableBuyQuote: async () => { quoteCount++; return {executable: false, reason: 'http_error', status: 429}; },
    fetchJupiterExecutableSellQuote: async () => { throw new Error('Failed buy must not request sell'); },
    runDatabaseOperation: async (_name, fn) => fn(),
  });
  vm.runInContext(pricing + '\n' + observation, context);
  const env = {DB: {prepare(sql) {return {bind(...values) {return {run() {return {meta: db.prepare(sql).run(...values)}}}}}}}};
  return {db, logs, quoteCount: () => quoteCount, run: signature => context.runImmediateEntryObservation({signature, mint:'MINT', inputSOL: 1, tokenAmount:100}, env)};
}

for (const provider of ['COINGECKO', 'JUPITER_PRICE_V3']) {
  test('records exact sizing price and source for ' + provider, async () => {
    const h = setup({price: 150.5, source:provider});
    try {
      const result = await h.run('new');
      const row = h.db.prepare('SELECT * FROM paper_immediate_entry_checks WHERE source_signature=?').get('new');
      assert.equal(row.sol_usd_price,150.5); assert.equal(row.sol_usd_source,provider);
      assert.equal(row.target_copy_lamports,Math.floor(5/150.5*1e9));
      assert.equal(row.buy_http_status,429); assert.equal(row.buy_executable,0);
      assert.equal(result.solUsdPrice,150.5); assert.equal(result.solUsdSource,provider);
      assert.equal(result.execution,'DISABLED'); assert.equal(result.realMoney,false);
      assert.equal(h.quoteCount(),1);
      assert.equal(h.logs.find(x=>x.inserted === true).solUsdSource,provider);
    } finally {h.db.close();}
  });
}
test('records account fallback honestly after live provider failure', async () => {
  const h=setup(new Error('No live price'));
  try {
    await h.run('fallback');
    const row=h.db.prepare('SELECT sol_usd_price,sol_usd_source FROM paper_immediate_entry_checks WHERE source_signature=?').get('fallback');
    assert.equal(row.sol_usd_price,110.25); assert.equal(row.sol_usd_source,'ACCOUNT_INITIAL_PRICE');
  } finally {h.db.close();}
});
test('migration preserves historical rows with unknown price and duplicate cannot overwrite them', async () => {
  const h=setup({price:150,source:'COINGECKO'});
  try {
    const result=await h.run('old');
    assert.equal(result.inserted,false); assert.equal(result.duplicate,true);
    const row=h.db.prepare('SELECT mint,sol_usd_price,sol_usd_source FROM paper_immediate_entry_checks WHERE source_signature=?').get('old');
    assert.equal(row.mint,'OLD_MINT'); assert.equal(row.sol_usd_price,null); assert.equal(row.sol_usd_source,null);
  } finally {h.db.close();}
});
