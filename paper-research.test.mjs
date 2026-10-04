import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {captureResearchConfig,chooseResearchExit,admitResearchEntries,recordResearchExit,runResearchExitCycle} from './paper-research.js';

const migration=readFileSync(new URL('./paper-research-migration.sql',import.meta.url),'utf8');
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
  const position=(sig='new')=>db.prepare('SELECT * FROM paper_research_positions WHERE source_signature=?').get(sig);
  return {db,env,deps,config,requests,add,position,
    run:()=>runResearchExitCycle(env,deps),advance:ms=>{clock+=ms;},now:()=>clock,
    mark:v=>{mark=v;},fail:v=>{failure=v;},malformed:v=>{malformed=v;},close:()=>db.close()};
}
async function entered() {
  const h=setup();await h.run();h.advance(1000);h.add();await h.run();return h;
}
test('new research cutoff excludes history, failed buy, invalid input and stale observation',async()=>{
  const h=setup();try {
    h.add('old',epoch-1000);await h.run();
    h.advance(200000);h.add('stale',epoch+1000);h.add('failed',h.now(),'1',6,50000000,0);
    h.add('invalid',h.now(),'0');h.add('valid');
    const r=await h.run();assert.equal(r.admitted,1);assert.equal(h.position('valid').remaining_raw_amount,'1000000000');
    assert.equal(h.position('old'),undefined);assert.equal(h.position('stale'),undefined);
    assert.equal(h.position('failed'),undefined);assert.equal(h.position('invalid'),undefined);
    assert.equal((await h.run()).admitted,0);
  }finally{h.close();}
});
test('research admission and exits preserve existing account, three positions and detector history',async()=>{
  const h=await entered();try {
    h.mark(0.00004);await h.run();
    assert.equal(h.db.prepare('SELECT cash_balance_lamports FROM paper_copy_account').get().cash_balance_lamports,93274733);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM paper_copy_positions WHERE status='PAPER_OPEN'").get().n,3);
    assert.equal(h.db.prepare('SELECT signature FROM processed_signatures').get().signature,'history');
  }finally{h.close();}
});
test('TP 30 percent then trailing 70 percent uses separate exact raw quotes and fees',async()=>{
  const h=await entered();try {
    h.mark(0.000075);await h.run();
    assert.equal(h.position().remaining_raw_amount,'700000000');
    assert.equal(h.position().take_profit_hit,1);
    h.mark(0.00009);await h.run();h.mark(0.000071);await h.run();
    assert.deepEqual(h.requests.map(x=>x.rawTokenAmount),['300000000','700000000']);
    assert.ok(h.requests.every(x=>x.tokenAmount===undefined&&x.tokenDecimals===6));
    const p=h.position();assert.equal(p.status,'RESEARCH_CLOSED');
    assert.equal(p.allocated_cost_lamports,p.entry_cost_lamports);
    assert.equal(p.modeled_pnl_lamports,p.modeled_proceeds_lamports-p.entry_cost_lamports);
    const sums=h.db.prepare('SELECT SUM(sell_fee_lamports) AS fees,SUM(haircut_lamports) AS haircut,SUM(quoted_out_lamports) AS gross,SUM(modeled_net_lamports) AS modeled FROM paper_research_exits').get();
    assert.equal(sums.fees,4000000);assert.equal(sums.modeled,sums.gross-sums.haircut-sums.fees);
  }finally{h.close();}
});
for(const reason of ['http_error','no_route']) test(reason+' preserves open raw position and no modeled proceeds',async()=>{
  const h=await entered();try {
    h.mark(0.00004);h.fail(reason);await h.run();
    assert.equal(h.position().status,'RESEARCH_OPEN');assert.equal(h.position().remaining_raw_amount,'1000000000');
    assert.equal(h.position().modeled_proceeds_lamports,0);
    assert.equal(h.db.prepare('SELECT quoted_out_lamports FROM paper_research_exit_attempts').get().quoted_out_lamports,null);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM paper_research_exits').get().n,0);
    h.fail(null);await h.run();assert.equal(h.position().status,'RESEARCH_CLOSED');
  }finally{h.close();}
});
test('mark feed missing does not guess a price or request sale',async()=>{
  const h=await entered();try {
    h.mark(NaN);const r=await h.run();assert.equal(r.missingPrices,1);assert.equal(r.quotes,0);
    assert.equal(h.position().status,'RESEARCH_OPEN');assert.equal(h.position().last_mark_price_sol,null);
  }finally{h.close();}
});
test('quote exception and raw mismatch cannot mutate financial research state',async()=>{
  const h=await entered();try {
    h.mark(0.00004);h.fail(new Error('synthetic network error'));await h.run();
    h.fail(null);h.malformed(true);await h.run();
    assert.equal(h.position().revision,0);assert.equal(h.position().modeled_proceeds_lamports,0);
    const reasons=h.db.prepare('SELECT reason FROM paper_research_exit_attempts ORDER BY id').all().map(x=>x.reason);
    assert.deepEqual(reasons,['quote_exception','invalid_exact_quote_result']);
  }finally{h.close();}
});
test('captured fee/risk configuration is stable after live configuration changes',async()=>{
  const h=await entered();try {
    h.config.sell_fee_lamports=9000000;h.config.stop_loss_bps=9000;
    h.mark(0.00004);await h.run();
    assert.equal(h.position().status,'RESEARCH_CLOSED');
    assert.equal(h.db.prepare('SELECT sell_fee_lamports FROM paper_research_exits').get().sell_fee_lamports,2000000);
  }finally{h.close();}
});
test('research quote budget is bounded at four even with many triggers',async()=>{
  const h=setup();try {
    await h.run();h.advance(1000);for(let i=0;i<8;i++)h.add('n'+i);
    h.mark(0.00004);const r=await h.run();assert.equal(r.quotes,4);assert.equal(r.exits,4);
    assert.equal(h.requests.length,4);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM paper_research_positions WHERE status='RESEARCH_OPEN'").get().n,4);
    h.advance(60000);assert.equal((await h.run()).exits,4);
  }finally{h.close();}
});
test('CAS revision prevents duplicate proceeds from concurrent stale exit',async()=>{
  const h=await entered();try {
    const p=h.position(),c=captureResearchConfig(h.config),intent={reason:'STOP_LOSS',raw:p.remaining_raw_amount};
    const q={executable:true,reason:'quote_available',status:200,rawAmount:intent.raw,decimals:p.decimals,outAmountLamports:40000000};
    const info={priceSOLPerToken:0.00004,source:'SYNTHETIC'},at=new Date(h.now()).toISOString();
    const r=await Promise.all([
      recordResearchExit(h.env,p,c,intent,q,info,at,at),
      recordResearchExit(h.env,p,c,intent,q,info,at,at)]);
    assert.equal(r.filter(x=>x.inserted).length,1);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM paper_research_exits').get().n,1);
    assert.equal(h.position().revision,1);assert.equal(h.position().modeled_proceeds_lamports,32000000);
  }finally{h.close();}
});
test('accounting transaction failure rolls back exit row and raw state',async()=>{
  const h=await entered();try {
    h.db.exec("CREATE TRIGGER fail_update BEFORE UPDATE OF revision ON paper_research_positions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    h.mark(0.00004);await assert.rejects(h.run(),/synthetic failure/);
    assert.equal(h.position().revision,0);assert.equal(h.position().remaining_raw_amount,'1000000000');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM paper_research_exits').get().n,0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM paper_research_exit_attempts').get().n,1);
  }finally{h.close();}
});
test('same tick partial and remaining exit charges two sell fees',async()=>{
  const h=await entered();try {
    h.db.exec('UPDATE paper_research_positions SET highest_price_sol=0.00012');
    h.mark(0.000075);const r=await h.run();assert.equal(r.exits,2);
    assert.deepEqual(h.requests.map(x=>x.rawTokenAmount),['300000000','700000000']);
    assert.equal(h.position().status,'RESEARCH_CLOSED');
  }finally{h.close();}
});
test('integer partial amount floors raw units and preserves every remainder unit',()=>{
  const p={status:'RESEARCH_OPEN',initial_raw_amount:'7',remaining_raw_amount:'7',
    entry_price_sol:1,highest_price_sol:1,take_profit_hit:0};
  const r=chooseResearchExit(p,captureResearchConfig(baseConfig),1.5);
  assert.equal(r.raw,'2');assert.equal(7n-BigInt(r.raw),5n);
});
test('raw quantity above Number precision is retained unchanged in exit request',async()=>{
  const h=setup();try {
    await h.run();h.advance(1000);h.add('new',h.now(),'9007199254740993',18);
    await h.run();h.mark(h.position().entry_price_sol*0.8);await h.run();
    assert.equal(h.requests[0].rawTokenAmount,'9007199254740993');
  }finally{h.close();}
});
test('invalid configuration fails before admission or quote',()=>{
  assert.throws(()=>captureResearchConfig({...baseConfig,sell_slippage_bps:10001}),/Invalid/);
  assert.throws(()=>captureResearchConfig({...baseConfig,sell_fee_lamports:NaN}),/Invalid/);
});
test('SL priority and pre-TP trailing match original rules',()=>{
  const c=captureResearchConfig(baseConfig),p={status:'RESEARCH_OPEN',initial_raw_amount:'100',
    remaining_raw_amount:'100',entry_price_sol:1,highest_price_sol:1.3,take_profit_hit:0};
  assert.equal(chooseResearchExit(p,c,0.8).reason,'STOP_LOSS');
  assert.equal(chooseResearchExit(p,c,1.02).reason,'TRAILING_STOP');
});

test('disabled paper config pauses research without admitting or executing',async()=>{
  const h=await entered();try {
    h.config.enabled=0;h.mark(0.00004);h.advance(1000);h.add('paused');
    const r=await h.run();assert.equal(r.paused,true);assert.equal(r.quotes,0);
    assert.equal(h.position('paused'),undefined);assert.equal(h.position().status,'RESEARCH_OPEN');
    assert.equal(h.requests.length,0);
  }finally{h.close();}
});
