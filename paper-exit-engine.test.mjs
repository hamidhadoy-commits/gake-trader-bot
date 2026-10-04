import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';

// Run actual production exit decisions and accounting; only price/quote feeds are synthetic.
const source=readFileSync(new URL('./worker.js',import.meta.url),'utf8');
const accounting=source.slice(source.indexOf('function buildPaperExitThresholds('),
  source.indexOf('async function recordPaperExitNoRoute('));
const decisions=source.slice(source.indexOf('async function processPaperExitPosition('),
  source.indexOf('async function getPendingPaperEntryRouteCheck('));
function setup() {
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE paper_copy_positions(
      source_signature TEXT PRIMARY KEY,mint TEXT,simulated_entry_price_sol_per_token REAL,
      highest_price_sol_per_token REAL,simulated_token_amount REAL,remaining_token_amount REAL,
      entry_cost_lamports INTEGER,realized_proceeds_lamports INTEGER DEFAULT 0,
      realized_pnl_lamports INTEGER DEFAULT 0,status TEXT,take_profit_hit INTEGER DEFAULT 0,
      closed_at TEXT,close_reason TEXT,updated_at TEXT);
    CREATE TABLE paper_copy_account(id INTEGER PRIMARY KEY,cash_balance_lamports INTEGER,
      realized_pnl_lamports INTEGER,total_fees_lamports INTEGER,opened_positions_count INTEGER,
      closed_positions_count INTEGER,updated_at TEXT);
    CREATE TABLE paper_copy_exits(id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_signature TEXT,exit_reason TEXT,sold_token_amount REAL,trigger_price_sol_per_token REAL,
      simulated_exit_price_sol_per_token REAL,sell_slippage_bps INTEGER,sell_fee_lamports INTEGER,
      gross_proceeds_lamports INTEGER,net_proceeds_lamports INTEGER,realized_pnl_lamports INTEGER,
      exited_at TEXT,created_at TEXT,exit_sequence INTEGER,allocated_entry_cost_lamports INTEGER,
      operation_id TEXT UNIQUE);
    CREATE TABLE paper_copy_ledger(event_type TEXT,source_signature TEXT,exit_id INTEGER UNIQUE,
      cash_delta_lamports INTEGER,fee_lamports INTEGER,balance_after_lamports INTEGER,note TEXT,created_at TEXT);
    INSERT INTO paper_copy_positions(source_signature,mint,simulated_entry_price_sol_per_token,
      highest_price_sol_per_token,simulated_token_amount,remaining_token_amount,entry_cost_lamports,status)
      VALUES ('sig','SYNTHETIC',0.00005,0.00005,1000,1000,51500000,'PAPER_OPEN');
    INSERT INTO paper_copy_account VALUES(1,100000000,0,1500000,1,0,NULL);
  `);
  const env={DB:{
    prepare(sql) {return {bind(...values){return {sql,values,
      first:()=>db.prepare(sql).get(...values),
      run:()=>({meta:db.prepare(sql).run(...values)})};}};},
    async batch(statements) {
      db.exec('BEGIN');
      try {const r=statements.map(s=>s.run());db.exec('COMMIT');return r;}
      catch(e){db.exec('ROLLBACK');throw e;}
    },
  }};
  const config={stop_loss_bps:1500,take_profit_enabled:1,take_profit_bps:4000,
    take_profit_sell_bps:3000,trailing_stop_enabled:1,trailing_stop_bps:2000,
    sell_slippage_bps:1500,sell_fee_lamports:2000000};
  const quotes=[];let available=true;
  const position=()=>db.prepare('SELECT * FROM paper_copy_positions').get();
  const account=()=>db.prepare('SELECT * FROM paper_copy_account').get();
  const context=vm.createContext({
    console:{log(){},error(){}},BPS_DENOMINATOR:10000,LAMPORTS_PER_SOL:1e9,
    clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),
    DatabaseError:class extends Error {constructor(op,e){super(op+': '+e.message);}},
    runDatabaseOperation:async(_op,fn)=>fn(),getPaperCopyAccount:async()=>account(),
    getPaperExitPosition:async()=>position(),
    refreshPaperPositionHigh:async(_env,_sig,p)=>db.prepare('UPDATE paper_copy_positions SET highest_price_sol_per_token=MAX(highest_price_sol_per_token,?)').run(p),
    getPaperExitExecutableQuote:async args=>{
      quotes.push({reason:args.exitReason,amount:args.tokenAmount});
      return available?{effectivePriceSOLPerToken:context.currentMark}:null;
    },
  });
  vm.runInContext(accounting+'\n'+decisions,context);
  return {db,env,config,position,account,quotes,context,
    available:v=>{available=v;},
    run:async price=>{context.currentMark=price;return context.processPaperExitPosition(env,position(),config,{priceSOLPerToken:price});},
    close:()=>db.close(),
  };
}
test('SL has priority and closes at available quote with configured cost haircut',async()=>{
  const h=setup();try {
    const r=await h.run(0.00004);assert.equal(r.exits,1);
    assert.equal(h.quotes[0].reason,'STOP_LOSS');assert.equal(h.quotes[0].amount,1000);
    assert.equal(h.position().status,'PAPER_CLOSED');
    assert.equal(h.position().remaining_token_amount,0);
    const e=h.db.prepare('SELECT * FROM paper_copy_exits').get();
    assert.equal(e.allocated_entry_cost_lamports,51500000);
    assert.equal(e.net_proceeds_lamports,32000000);
    assert.equal(h.account().opened_positions_count,0);
    assert.equal(h.account().closed_positions_count,1);
    assert.equal(h.account().total_fees_lamports,3500000);
  }finally {h.close();}
});
test('TP sells 30 percent once; trailing closes 70 percent with another fee',async()=>{
  const h=setup();try {
    await h.run(0.000075);
    assert.equal(h.position().remaining_token_amount,700);
    assert.equal(h.position().take_profit_hit,1);
    assert.equal(h.position().status,'PAPER_OPEN');
    await h.run(0.00009);assert.equal(h.quotes.length,1);
    await h.run(0.000071);
    assert.deepEqual(h.quotes.map(x=>x.reason),['TAKE_PROFIT_PARTIAL','TRAILING_STOP']);
    assert.deepEqual(h.quotes.map(x=>x.amount),[300,700]);
    assert.equal(h.position().remaining_token_amount,0);
    const e=h.db.prepare('SELECT SUM(allocated_entry_cost_lamports) AS cost,SUM(sell_fee_lamports) AS fees,SUM(net_proceeds_lamports) AS proceeds,SUM(realized_pnl_lamports) AS pnl FROM paper_copy_exits').get();
    assert.equal(e.cost,51500000);assert.equal(e.fees,4000000);
    assert.equal(e.pnl,e.proceeds-e.cost);
    assert.equal(h.account().cash_balance_lamports,100000000+e.proceeds);
    assert.equal(h.account().realized_pnl_lamports,e.pnl);
    assert.equal(h.account().total_fees_lamports,5500000);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM paper_copy_ledger').get().n,2);
  }finally {h.close();}
});
test('failed SL quote leaves position, cash and realized PnL intact',async()=>{
  const h=setup();try {
    h.available(false);const r=await h.run(0.00004);
    assert.equal(r.exits,0);assert.equal(h.position().remaining_token_amount,1000);
    assert.equal(h.position().status,'PAPER_OPEN');assert.equal(h.account().cash_balance_lamports,100000000);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM paper_copy_exits').get().n,0);
    h.available(true);await h.run(0.000039);assert.equal(h.position().status,'PAPER_CLOSED');
  }finally {h.close();}
});
test('failed partial quote does not mark TP; later success can sell once',async()=>{
  const h=setup();try {
    h.available(false);await h.run(0.000075);
    assert.equal(h.position().take_profit_hit,0);assert.equal(h.position().remaining_token_amount,1000);
    h.available(true);await h.run(0.00008);await h.run(0.000081);
    assert.equal(h.position().take_profit_hit,1);assert.equal(h.position().remaining_token_amount,700);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM paper_copy_exits').get().n,1);
  }finally {h.close();}
});
test('trailing is active before TP in current production rules',async()=>{
  const h=setup();try {
    await h.run(0.000065);await h.run(0.000051);
    assert.equal(h.quotes[0].reason,'TRAILING_STOP');
    assert.equal(h.quotes[0].amount,1000);assert.equal(h.position().take_profit_hit,0);
  }finally {h.close();}
});
test('old high can trigger partial TP then trailing for remainder in same tick',async()=>{
  const h=setup();try {
    h.db.exec('UPDATE paper_copy_positions SET highest_price_sol_per_token=0.00012');
    const r=await h.run(0.000075);assert.equal(r.exits,2);
    assert.deepEqual(h.quotes.map(x=>x.amount),[300,700]);
    assert.equal(h.account().total_fees_lamports,5500000);
    assert.equal(h.position().status,'PAPER_CLOSED');
  }finally {h.close();}
});
test('closed position cannot debit sell fee again',async()=>{
  const h=setup();try {
    await h.run(0.00004);const a=h.account();await h.run(0.00003);
    assert.deepEqual(h.account(),a);assert.equal(h.quotes.length,1);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM paper_copy_exits').get().n,1);
  }finally {h.close();}
});
test('duplicate partial using stale position is blocked by TP guard',async()=>{
  const h=setup();try {
    const old=h.position();await h.run(0.000075);const a=h.account();
    const r=await h.context.executePaperCopyExit({env:h.env,position:old,config:h.config,
      exitReason:'TAKE_PROFIT_PARTIAL',triggerPriceSOLPerToken:0.000075,
      executionPriceSOLPerToken:0.000075,soldTokenAmount:300,closePosition:false,markTakeProfit:true});
    assert.equal(r.inserted,false);assert.deepEqual(h.account(),a);
    assert.equal(h.position().remaining_token_amount,700);
  }finally {h.close();}
});
test('invalid price makes no quote or account mutation',async()=>{
  const h=setup();try {
    for(const p of [0,-1,NaN,Infinity]) assert.equal((await h.run(p)).exits,0);
    assert.equal(h.quotes.length,0);assert.equal(h.account().cash_balance_lamports,100000000);
  }finally {h.close();}
});
test('failed accounting batch rolls back partial position and account writes',async()=>{
  const h=setup();try {
    h.db.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON paper_copy_ledger BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    await assert.rejects(h.run(0.000075),/synthetic failure/);
    assert.equal(h.position().remaining_token_amount,1000);assert.equal(h.position().take_profit_hit,0);
    assert.equal(h.account().cash_balance_lamports,100000000);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM paper_copy_exits').get().n,0);
  }finally {h.close();}
});
