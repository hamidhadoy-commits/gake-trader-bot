import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {exactExitBucket, runExactEntryExitObservationBatch} from './exact-exit-observation.js';

const migration = readFileSync(new URL('./exact-exit-observation-migration.sql',import.meta.url),'utf8');
const provider = readFileSync(new URL('./price-provider.js',import.meta.url),'utf8');
const sellSource = provider.slice(provider.indexOf('export async function fetchJupiterExecutableSellQuote('),
  provider.indexOf('\nfunction selectBestSolQuotedPair(')).replace('export async','async');
const raw = '9007199254740993'; // larger than exact JS Number range
function quoteHarness(payload = {inAmount:raw,outAmount:'45000000',router:'test'},status=200) {
  const urls=[]; let metadata=0;
  const c=vm.createContext({
    DEFAULT_WRAPPED_SOL_MINT:'WSOL',JUPITER_SWAP_ORDER_URL:'https://api.jup.ag/swap/v2/order',
    URLSearchParams,RETRY_DELAYS_MS:[],sleep:async()=>{},
    fetchJupiterTokenDecimals:async()=>{metadata++;return new Map([['M',6]]);},
    humanAmountToRaw:(amount,decimals)=>String(Math.floor(amount*10**decimals)),
    fetchJupiterWithPacing:async url=>{urls.push(url);return {
      ok:status===200,status,json:async()=>payload,text:async()=>String(payload),
    };},
  });
  vm.runInContext(sellSource,c);
  return {run:params=>c.fetchJupiterExecutableSellQuote({mint:'M',jupiterApiKey:'test',...params}),
    urls,metadata:()=>metadata};
}
test('exact quote sends original integer above Number precision and skips metadata',async()=>{
  const h=quoteHarness();const q=await h.run({rawTokenAmount:raw,tokenDecimals:6});
  assert.equal(new URL(h.urls[0]).searchParams.get('amount'),raw);
  assert.equal(q.rawAmount,raw);assert.equal(q.executable,true);assert.equal(h.metadata(),0);
  assert.deepEqual([...new URL(h.urls[0]).searchParams.keys()],['inputMint','outputMint','amount']);
});
test('exact quote rejects malformed raw/decimals before any request',async()=>{
  for(const params of [{rawTokenAmount:'0',tokenDecimals:6},{rawTokenAmount:123,tokenDecimals:6},
    {rawTokenAmount:'1.5',tokenDecimals:6},{rawTokenAmount:'1',tokenDecimals:null},
    {rawTokenAmount:'1',tokenDecimals:19},{rawTokenAmount:'01',tokenDecimals:6}]) {
    const h=quoteHarness();assert.equal((await h.run(params)).reason,'invalid_exact_raw_amount');
    assert.equal(h.urls.length,0);
  }
});
test('exact quote rejects mismatched or missing provider input amount',async()=>{
  for(const inAmount of ['9007199254740992',undefined]) {
    const h=quoteHarness({inAmount,outAmount:'45000000'});
    assert.equal((await h.run({rawTokenAmount:raw,tokenDecimals:6})).reason,'quote_input_amount_mismatch');
  }
});
test('legacy human amount sell path retains metadata sizing',async()=>{
  const h=quoteHarness({outAmount:'45000000'});
  const q=await h.run({tokenAmount:123.5});
  assert.equal(q.executable,true);assert.equal(q.rawAmount,'123500000');assert.equal(h.metadata(),1);
});
test('exact no-route retains input evidence',async()=>{
  const h=quoteHarness('Failed to get quotes',400);
  const q=await h.run({rawTokenAmount:raw,tokenDecimals:6});
  assert.equal(q.reason,'no_route');assert.equal(q.rawAmount,raw);assert.equal(q.decimals,6);
});

const epoch=Date.parse('2026-10-04T15:00:00Z');
function setup() {
  const db=new DatabaseSync(':memory:');let clock=epoch;const calls=[];
  db.exec('CREATE TABLE paper_immediate_entry_checks(source_signature TEXT PRIMARY KEY,mint TEXT,checked_at TEXT,buy_executable INTEGER,buy_out_raw_amount TEXT,buy_token_decimals INTEGER,target_copy_lamports INTEGER)');
  db.prepare('INSERT INTO paper_immediate_entry_checks VALUES (?,?,?,?,?,?,?)')
    .run('sig','M',new Date(epoch-90000).toISOString(),1,raw,6,40000000);
  db.exec(migration);db.exec(migration);
  const env={JUPITER_API_KEY:'test',DB:{prepare(sql){return {bind(...values){return {
    all:()=>({results:db.prepare(sql).all(...values)}),
    run:()=>({meta:db.prepare(sql).run(...values)}),
  };}};}}};
  const deps={now:()=>clock,getConfig:async()=>({buy_fee_lamports:1500000,sell_fee_lamports:2000000}),
    databaseOperation:async(_name,fn)=>fn(),
    sellQuote:async args=>{calls.push(args);return {executable:true,reason:'quote_available',
      status:200,rawAmount:args.rawTokenAmount,decimals:args.tokenDecimals,outAmountLamports:45000000};}};
  return {db,env,deps,calls,advance:ms=>{clock+=ms;},run:()=>runExactEntryExitObservationBatch(env,deps)};
}
test('bucket boundaries skip future/old and never backfill missed windows',()=>{
  for(const [age,bucket] of [[-1,null],[59.999,null],[60,'M1'],[179.99,'M1'],[180,'M3'],
    [300,'M5'],[600,'M10'],[900,null],[NaN,null]]) assert.equal(exactExitBucket(age),bucket);
});
test('SQLite observation stores exact input, fees and net without account writes',async()=>{
  const h=setup();try {
    const r=await h.run();assert.equal(r.checked,1);
    assert.equal(h.calls[0].rawTokenAmount,raw);assert.equal(h.calls[0].tokenDecimals,6);
    assert.equal(h.calls[0].tokenAmount,undefined);
    const row=h.db.prepare('SELECT * FROM paper_exact_entry_exit_checks').get();
    assert.equal(row.input_raw_amount,raw);assert.equal(row.age_bucket,'M1');
    assert.equal(row.net_lamports,1500000);assert.equal(row.net_pct,100*1500000/41500000);
    assert.equal(row.fee_basis,'CONFIG_AT_EXIT_OBSERVATION_ONE_FULL_SELL');
    assert.equal((await h.run()).checked,0);assert.equal(h.calls.length,1);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM paper_immediate_entry_checks').get().n,1);
  } finally {h.db.close();}
});
test('temporary 429 is stored with null net and retried only after cooldown',async()=>{
  const h=setup();try {
    h.deps.sellQuote=async args=>{h.calls.push(args);return {executable:false,reason:'http_error',status:429};};
    assert.equal((await h.run()).deferred,1);
    const row=h.db.prepare('SELECT * FROM paper_exact_entry_exit_checks').get();
    assert.equal(row.definitive,0);assert.equal(row.net_pct,null);assert.equal(row.http_status,429);
    assert.equal((await h.run()).checked,0);
    h.advance(60000);assert.equal((await h.run()).checked,1);assert.equal(h.calls.length,2);
  }finally {h.db.close();}
});
test('definitive no-route never invents zero proceeds or loss',async()=>{
  const h=setup();try {
    h.deps.sellQuote=async args=>({executable:false,reason:'no_route',status:400,
      rawAmount:args.rawTokenAmount,decimals:args.tokenDecimals});
    await h.run();
    const row=h.db.prepare('SELECT * FROM paper_exact_entry_exit_checks').get();
    assert.equal(row.definitive,1);assert.equal(row.net_pct,null);assert.equal(row.out_lamports,null);
    assert.equal((await h.run()).checked,0);
  }finally {h.db.close();}
});
test('invalid or failed entry records cause no quote and no guessed input',async()=>{
  const h=setup();try {
    for(const sql of ["UPDATE paper_immediate_entry_checks SET buy_executable=0",
      "UPDATE paper_immediate_entry_checks SET buy_executable=1,buy_out_raw_amount=NULL",
      "UPDATE paper_immediate_entry_checks SET buy_out_raw_amount='1',buy_token_decimals=NULL"]) {
      h.db.exec(sql);assert.equal((await h.run()).checked,0);
    }
    assert.equal(h.calls.length,0);
  }finally {h.db.close();}
});
test('wrong quote size never produces net result',async()=>{
  const h=setup();try {
    h.deps.sellQuote=async()=>({executable:true,rawAmount:'1',decimals:6,outAmountLamports:45000000});
    assert.equal((await h.run()).deferred,1);
    const row=h.db.prepare('SELECT * FROM paper_exact_entry_exit_checks').get();
    assert.equal(row.net_pct,null);assert.equal(row.reason,'invalid_exact_quote_result');
  }finally {h.db.close();}
});
test('next bucket is measured once, expired entry is ignored',async()=>{
  const h=setup();try {
    await h.run();h.advance(100000);await h.run();
    const rows=h.db.prepare('SELECT age_bucket FROM paper_exact_entry_exit_checks ORDER BY id').all();
    assert.deepEqual(rows.map(x=>x.age_bucket),['M1','M3']);
    h.advance(900000);assert.equal((await h.run()).checked,0);
  }finally {h.db.close();}
});

test('earliest window deadline wins over older backlog within four-request cap',async()=>{
  const h=setup();try {
    h.db.prepare('UPDATE paper_immediate_entry_checks SET checked_at=?')
      .run(new Date(epoch-175000).toISOString());
    for(let i=0;i<5;i++) h.db.prepare('INSERT INTO paper_immediate_entry_checks VALUES (?,?,?,?,?,?,?)')
      .run('old'+i,'M',new Date(epoch-700000-i*1000).toISOString(),1,raw,6,40000000);
    const r=await h.run();assert.equal(r.checked,4);assert.equal(h.calls.length,4);
    const rows=h.db.prepare('SELECT source_signature,age_bucket FROM paper_exact_entry_exit_checks ORDER BY id').all();
    assert.equal(rows[0].source_signature,'sig');assert.equal(rows[0].age_bucket,'M1');
    assert.deepEqual(rows.slice(1).map(x=>x.source_signature),['old4','old3','old2']);
  }finally {h.db.close();}
});
test('expiring M10 still wins over less urgent M1',async()=>{
  const h=setup();try {
    h.db.prepare('INSERT INTO paper_immediate_entry_checks VALUES (?,?,?,?,?,?,?)')
      .run('urgent','M',new Date(epoch-895000).toISOString(),1,raw,6,40000000);
    h.deps.limit=1;await h.run();
    const row=h.db.prepare('SELECT source_signature,age_bucket FROM paper_exact_entry_exit_checks').get();
    assert.equal(row.source_signature,'urgent');assert.equal(row.age_bucket,'M10');
    assert.equal(h.calls.length,1);
  }finally {h.db.close();}
});
