import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {runQuoteResearchExitCycle,recordQuoteResearchExit} from './paper-quote-research.js';

const migration=readFileSync(new URL('./paper-quote-research-migration.sql',import.meta.url),'utf8');
const baseConfig={enabled:1,buy_fee_lamports:1500000,sell_fee_lamports:2000000,
  sell_slippage_bps:1500,stop_loss_bps:1500,take_profit_enabled:1,take_profit_bps:4000,
  take_profit_sell_bps:3000,trailing_stop_enabled:1,trailing_stop_bps:2000};
const epoch=Date.parse('2026-10-04T17:00:00Z');
function setup() {
  const db=new DatabaseSync(':memory:');let clock=epoch;let mark=0.00005;
  let failure=null;let malformed=false;const requests=[];
  db.exec(`
    CREATE TABLE paper_immediate_entry_checks(source_signature TEXT PRIMARY KEY,mint TEXT,
      checked_at TEXT,buy_executable INTEGER,buy_out_raw_amount TEXT,buy_token_decimals INTEGER,target_copy_lamports INTEGER);
    CREATE TABLE paper_copy_account(id INTEGER PRIMARY KEY,cash_balance_lamports INTEGER);
    INSERT INTO paper_copy_account VALUES(1,93274733);
    CREATE TABLE paper_copy_positions(signature TEXT PRIMARY KEY,status TEXT);
    INSERT INTO paper_copy_positions VALUES('old1','PAPER_OPEN'),('old2','PAPER_OPEN'),('old3','PAPER_OPEN');
    CREATE TABLE paper_research_positions(source_signature TEXT PRIMARY KEY,status TEXT);
    INSERT INTO paper_research_positions VALUES('baseline','RESEARCH_OPEN');
    CREATE TABLE processed_signatures(signature TEXT PRIMARY KEY);
    INSERT INTO processed_signatures VALUES('history');
  `);
  db.exec(migration);db.exec(migration);
  const env={JUPITER_API_KEY:'test',DB:{
    prepare(sql){return {bind(...values){return {sql,values,
      all:()=>({results:db.prepare(sql).all(...values)}),
      first:()=>db.prepare(sql).get(...values),
      run:()=>({meta:db.prepare(sql).run(...values)})};}};},
    async batch(statements){
      db.exec('BEGIN');try{const r=statements.map(s=>s.run());db.exec('COMMIT');return r;}
      catch(e){db.exec('ROLLBACK');throw e;}
    },
  }};
  const config={...baseConfig};
  const deps={getConfig:async()=>config,now:()=>clock,
    priceFeed:async mints=>new Map(mints.map(m=>[m,{priceSOLPerToken:mark,source:'SYNTHETIC'}])),
    sellQuote:async args=>{
      requests.push(args);
      if(failure instanceof Error) throw failure;
      if(failure) return {executable:false,reason:failure,status:failure==='no_route'?400:429};
      return {executable:true,reason:'quote_available',status:200,
        rawAmount:malformed?'1':args.rawTokenAmount,decimals:args.tokenDecimals,
        outAmountLamports:Math.floor(Number(args.rawTokenAmount)/10**args.tokenDecimals*mark*1e9),router:'test'};
    },
  };
  const add=(sig='new',at=clock,raw='1000000000',decimals=6,notional=50000000,success=1)=>
    db.prepare('INSERT INTO paper_immediate_entry_checks VALUES(?,?,?,?,?,?,?)')
      .run(sig,'SYNTHETIC',new Date(at).toISOString(),success,raw,decimals,notional);
  const position=(sig='new')=>db.prepare('SELECT * FROM paper_quote_research_positions WHERE source_signature=?').get(sig);
  return {db,env,deps,config,requests,add,position,
    run:()=>runQuoteResearchExitCycle(env,deps),advance:ms=>{clock+=ms;},now:()=>clock,
    mark:v=>{mark=v;},fail:v=>{failure=v;},malformed:v=>{malformed=v;},close:()=>db.close()};
}
async function entered() {
  const h=setup();await h.run();h.advance(1000);h.add();await h.run();return h;
}
test('quote-trigger cutoff admits only fresh successful new entries and isolates old books',async()=>{
  const h=setup();try {
    h.add('old',epoch-1);await h.run();h.advance(200000);
    h.add('stale',h.now()-120001);h.add('failed',h.now(),'1000000000',6,50000000,0);
    h.add('invalid',h.now(),'1',19);h.add('new');await h.run();
    assert.equal(h.position('old'),undefined);assert.equal(h.position('stale'),undefined);
    assert.equal(h.position('failed'),undefined);assert.equal(h.position('invalid'),undefined);
    assert.equal(h.position().status,'RESEARCH_OPEN');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM paper_research_positions').get().n,1);
    assert.equal(h.db.prepare('SELECT cash_balance_lamports FROM paper_copy_account').get().cash_balance_lamports,93274733);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM processed_signatures').get().n,1);
  }finally{h.close();}
});
test('full-position SL reuses the exact remaining quote without another request',async()=>{
  const h=await entered();try {
    h.deps.priceFeed=()=>{throw Error('must not read mark feed');};
    h.mark(0.00004);const r=await h.run();
    assert.equal(r.quotes,1);assert.equal(r.exits,1);
    const p=h.position();assert.equal(p.close_reason,'STOP_LOSS');assert.equal(p.remaining_raw_amount,'0');
    const e=h.db.prepare('SELECT * FROM paper_quote_research_exits').get();
    assert.equal(e.sold_raw_amount,'1000000000');assert.equal(e.quoted_out_lamports,40000000);
    assert.equal(e.modeled_net_lamports,32000000);assert.equal(e.modeled_pnl_lamports,-19500000);
    assert.equal(p.allocated_cost_lamports,p.entry_cost_lamports);
  }finally{h.close();}
});
test('TP quotes the exact 30 percent slice then trailing sells the exact remainder next tick',async()=>{
  const h=await entered();try {
    h.mark(0.000075);const tp=await h.run();assert.equal(tp.quotes,2);assert.equal(tp.exits,1);
    assert.equal(h.requests.at(-1).rawTokenAmount,'300000000');
    assert.equal(h.position().remaining_raw_amount,'700000000');assert.equal(h.position().take_profit_hit,1);
    h.mark(0.000059);const tsl=await h.run();assert.equal(tsl.quotes,1);assert.equal(tsl.exits,1);
    assert.equal(h.requests.at(-1).rawTokenAmount,'700000000');
    assert.equal(h.position().close_reason,'TRAILING_STOP');
    const es=h.db.prepare('SELECT * FROM paper_quote_research_exits ORDER BY position_revision').all();
    assert.deepEqual(es.map(e=>e.exit_reason),['TAKE_PROFIT_PARTIAL','TRAILING_STOP']);
    assert.equal(es.reduce((n,e)=>n+e.allocated_entry_cost_lamports,0),51500000);
    assert.equal(es.reduce((n,e)=>n+e.modeled_pnl_lamports,0),h.position().modeled_pnl_lamports);
  }finally{h.close();}
});
test('SL retains priority when fixed SL and trailing both apply',async()=>{
  const h=await entered();try {
    h.mark(0.000065);await h.run();h.mark(0.00004);await h.run();
    assert.equal(h.position().close_reason,'STOP_LOSS');
  }finally{h.close();}
});
test('trailing works before TP just as in baseline rules',async()=>{
  const h=await entered();try {
    h.mark(0.000065);await h.run();h.mark(0.000051);await h.run();
    assert.equal(h.position().close_reason,'TRAILING_STOP');
  }finally{h.close();}
});
test('TP with one request left is deferred and records exhausted slice budget',async()=>{
  const h=await entered();try {
    h.deps.maxQuotes=1;h.mark(0.000075);const r=await h.run();
    assert.equal(r.quotes,1);assert.equal(r.exits,0);assert.equal(h.position().take_profit_hit,0);
    assert.equal(h.db.prepare('SELECT planned_exit_reason FROM paper_quote_research_observations ORDER BY id DESC LIMIT 1').get().planned_exit_reason,'TP_QUOTE_BUDGET_EXHAUSTED');
    h.deps.maxQuotes=2;await h.run();assert.equal(h.position().remaining_raw_amount,'700000000');
  }finally{h.close();}
});
for(const failure of ['no_route','http_error',new Error('offline')]) test('unavailable quote keeps position open: '+String(failure),async()=>{
  const h=await entered();try {
    h.fail(failure);const r=await h.run();assert.equal(r.unavailable,1);assert.equal(r.exits,0);
    assert.equal(h.position().status,'RESEARCH_OPEN');assert.equal(h.position().last_mark_price_sol,null);
    assert.equal(h.position().highest_price_sol,0.00005);
    assert.equal(h.db.prepare('SELECT executable FROM paper_quote_research_observations ORDER BY id DESC LIMIT 1').get().executable,0);
  }finally{h.close();}
});
test('mismatched exact raw result is rejected instead of triggering SL',async()=>{
  const h=await entered();try {
    h.mark(0.00004);h.malformed(true);const r=await h.run();assert.equal(r.exits,0);
    assert.equal(h.position().status,'RESEARCH_OPEN');
    assert.equal(h.db.prepare('SELECT reason FROM paper_quote_research_observations ORDER BY id DESC LIMIT 1').get().reason,'invalid_exact_quote_result');
  }finally{h.close();}
});
test('quote taking over 30 seconds is rejected and clock rollback is rejected',async()=>{
  for(const delay of [31000,-1]) {
    const h=await entered();try {
      const original=h.deps.sellQuote;h.mark(0.00004);
      h.deps.sellQuote=async a=>{const q=await original(a);h.advance(delay);return q;};
      const r=await h.run();assert.equal(r.exits,0);assert.equal(h.position().status,'RESEARCH_OPEN');
      assert.equal(h.db.prepare('SELECT reason FROM paper_quote_research_observations ORDER BY id DESC LIMIT 1').get().reason,'stale_quote');
    }finally{h.close();}
  }
});
test('two-request cap and oldest-first selection rotate through queued positions',async()=>{
  const h=setup();try {
    await h.run();h.advance(1000);for(const sig of ['a','b','c','d'])h.add(sig);
    h.deps.maxQuotes=99;assert.equal((await h.run()).quotes,2);h.advance(60000);
    assert.equal((await h.run()).quotes,2);
    const rows=h.db.prepare('SELECT source_signature FROM paper_quote_research_observations ORDER BY id').all();
    assert.deepEqual(rows.map(x=>x.source_signature),['a','b','c','d']);
  }finally{h.close();}
});
test('disabled configuration pauses admission and all quote requests',async()=>{
  const h=await entered();try {
    const count=h.requests.length;h.config.enabled=0;h.add('paused');
    assert.equal((await h.run()).paused,true);assert.equal(h.requests.length,count);assert.equal(h.position('paused'),undefined);
  }finally{h.close();}
});
test('configuration remains frozen per entry',async()=>{
  const h=await entered();try {
    h.config.sell_fee_lamports=9999999;h.config.stop_loss_bps=9000;h.mark(0.00004);await h.run();
    const e=h.db.prepare('SELECT * FROM paper_quote_research_exits').get();
    assert.equal(e.exit_reason,'STOP_LOSS');assert.equal(e.sell_fee_lamports,2000000);
  }finally{h.close();}
});
test('raw amount above safe Number range is sent exactly as a string',async()=>{
  const h=setup();try {
    await h.run();h.advance(1000);h.add('large',h.now(),'18446744073709551615',18);await h.run();
    assert.equal(h.requests.at(-1).rawTokenAmount,'18446744073709551615');
  }finally{h.close();}
});
test('duplicate accounting operation cannot charge another fee or sell twice',async()=>{
  const h=await entered();try {
    const p=h.position(),c=JSON.parse(p.config_json),intent={reason:'STOP_LOSS',raw:p.remaining_raw_amount};
    const q={executable:true,rawAmount:intent.raw,decimals:p.decimals,outAmountLamports:40000000,status:200,reason:'quote_available'};
    const info={priceSOLPerToken:0.00004,source:'JUPITER_EXACT_REMAINING_QUOTE'},at=new Date(h.now()).toISOString();
    assert.equal((await recordQuoteResearchExit(h.env,p,c,intent,q,info,at,at)).inserted,true);
    assert.equal((await recordQuoteResearchExit(h.env,p,c,intent,q,info,at,at)).inserted,false);
    assert.equal(h.position().revision,1);assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM paper_quote_research_exits').get().n,1);
  }finally{h.close();}
});

test('failed TP slice does not account proceeds or mark TP hit and is retried freshly',async()=>{
  const h=await entered();try {
    const original=h.deps.sellQuote;h.mark(0.000075);
    h.deps.sellQuote=async a=>a.rawTokenAmount==='300000000'
      ? {executable:false,status:429,reason:'http_error'} : original(a);
    const r=await h.run();assert.equal(r.quotes,2);assert.equal(r.exits,0);
    assert.equal(h.position().remaining_raw_amount,'1000000000');assert.equal(h.position().take_profit_hit,0);
    assert.equal(h.position().modeled_proceeds_lamports,0);
    h.deps.sellQuote=original;h.advance(60000);await h.run();
    assert.equal(h.position().take_profit_hit,1);assert.equal(h.position().remaining_raw_amount,'700000000');
  }finally{h.close();}
});
test('partial size quote rather than proportional full quote determines booked proceeds',async()=>{
  const h=await entered();try{
    const original=h.deps.sellQuote;h.mark(0.000075);
    h.deps.sellQuote=async a=>{
      const q=await original(a);if(a.rawTokenAmount==='300000000')q.outAmountLamports=10000000;return q;
    };
    await h.run();const e=h.db.prepare('SELECT * FROM paper_quote_research_exits').get();
    assert.equal(e.quoted_out_lamports,10000000);assert.equal(e.modeled_net_lamports,6500000);
  }finally{h.close();}
});
