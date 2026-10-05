import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {buildDirectPumpCandidate,validateDirectPumpCandidate} from './direct-pump-buy.js';
// Reconstructed from finalized RPC facts; this is not an original Helius payload.
const fixture=JSON.parse(readFileSync(new URL('./fixtures/direct-pump-buy-rpc.json',import.meta.url),'utf8'));
const wallet=fixture.feePayer,wsol='So11111111111111111111111111111111111111112';
const options={wallet,wrappedSolMint:wsol,nowMs:fixture.timestamp*1000+4000};
const fresh=()=>structuredClone(fixture);
test('confirmed direct buy matches exact pool input and output, excluding fee transfers',()=>{
  const c=buildDirectPumpCandidate(fresh(),options);
  assert.equal(c.detector,'DIRECT_PUMP_AMM_WSOL');
  assert.equal(c.inferredSwapInputLamports,'10020000002');
  assert.equal(c.finalOutputRawAmount,'5102386789753');
  assert.deepEqual(validateDirectPumpCandidate(c,wallet),[]);
});
for(const [name,mutate] of [
  ['native deposit without token purchase',x=>{x.tokenTransfers=[];x.accountData=[];}],
  ['free token receipt without reciprocal WSOL payment',x=>{x.tokenTransfers=x.tokenTransfers.filter(t=>t.mint!==wsol);}],
  ['failed transaction',x=>{x.transactionError={InstructionError:[0,'error']};}],
  ['another payer',x=>{x.feePayer='OTHER';}],
  ['missing buy instruction',x=>{x.instructions=[];}],
  ['wrong program',x=>{x.instructions.find(i=>i.programId.startsWith('pAMM')).programId='OTHER';}],
  ['wrong instruction discriminator',x=>{x.instructions.find(i=>i.programId.startsWith('pAMM')).data='11111111111111111111111111111111';}],
  ['wrong pool recipient',x=>{x.tokenTransfers.find(t=>t.mint===wsol).toUserAccount='OTHER';}],
  ['wrong destination token account',x=>{x.tokenTransfers.find(t=>t.mint!==wsol).toTokenAccount='OTHER';}],
  ['received raw amount differs from bought amount',x=>{x.tokenTransfers.find(t=>t.mint!==wsol).rawTokenAmount.tokenAmount='5102386789752';}],
  ['pool quote balance differs by one lamport',x=>{x.accountData.find(a=>a.account===x.instructions.find(i=>i.programId.startsWith('pAMM')).accounts[8]).tokenBalanceChanges[0].rawTokenAmount.tokenAmount='10020000001';}],
  ['pool output balance missing',x=>{x.accountData=x.accountData.filter(a=>a.account!==x.instructions.find(i=>i.programId.startsWith('pAMM')).accounts[7]);}],
  ['ambiguous duplicate payment',x=>{x.tokenTransfers.push(structuredClone(x.tokenTransfers.find(t=>t.mint===wsol)));}],
  ['ambiguous duplicate buy instruction',x=>{x.instructions.push(structuredClone(x.instructions.find(i=>i.programId.startsWith('pAMM'))));}],
  ['missing decimals',x=>{for(const a of x.accountData)for(const c of a.tokenBalanceChanges)delete c.rawTokenAmount.decimals;}],
  ['missing timestamp',x=>{delete x.timestamp;}],
  ['malformed account data',x=>{x.accountData={};}],
]) test(`reject ${name}`,()=>{const tx=fresh();mutate(tx);assert.equal(buildDirectPumpCandidate(tx,options),null);});
test('reject historical and future timestamps; accept exact freshness boundary',()=>{
  assert.equal(buildDirectPumpCandidate(fresh(),{...options,nowMs:fixture.timestamp*1000+120001}),null);
  assert.equal(buildDirectPumpCandidate(fresh(),{...options,nowMs:fixture.timestamp*1000-30001}),null);
  assert.ok(buildDirectPumpCandidate(fresh(),{...options,nowMs:fixture.timestamp*1000+120000}));
});
test('tampered candidate evidence fails validation',()=>{
  const c=buildDirectPumpCandidate(fresh(),options);
  for(const patch of [{directUser:'OTHER'},{gakeBalanceIncreaseRawAmount:'1'},{inferredSwapInputLamports:'1'},{transactionError:'failed'},{inferredSwapInputSOL:0}])assert.equal(validateDirectPumpCandidate({...c,...patch},wallet).length,1);
});
function engine() {
  const source=readFileSync(new URL('./worker.js',import.meta.url),'utf8');
  const core=source.slice(source.indexOf('const GAKE_WALLET'),source.indexOf('class DatabaseError'));
  const context=vm.createContext({console,Response,Date,
    buildDirectPumpCandidate:(tx,o)=>buildDirectPumpCandidate(tx,{...o,nowMs:options.nowMs}),validateDirectPumpCandidate});
  vm.runInContext(core,context);return context;
}
test('production detection produces a disabled paper signal for the direct buy',()=>{
  const e=engine(),c=e.buildSwapCandidate(fresh()),r=e.buildBuySignal(c);
  assert.equal(r.signal.detector,'DIRECT_PUMP_AMM_WSOL');assert.equal(r.signal.inputLamports,10020000002);
  assert.equal(r.signal.execution,'DISABLED');assert.equal(r.signal.realMoney,false);
});
test('existing OKX match retains precedence and validation',()=>{
  const tx=fresh(),out=tx.tokenTransfers.find(t=>t.mint!==wsol);
  tx.nativeTransfers=[987654,2963,4691,4692].map(amount=>({fromUserAccount:out.fromUserAccount,toUserAccount:'OTHER',amount}));
  const e=engine(),c=e.buildSwapCandidate(tx),r=e.buildBuySignal(c);
  assert.equal(c.inputPatternMatched,true);assert.equal(r.signal.detector,'OKX_EXACT_PATTERN');assert.equal(r.signal.inputLamports,1000000);
});
test('existing routed economic chain retains precedence',()=>{
  const tx=fresh(),out=tx.tokenTransfers.find(t=>t.mint!==wsol),route='ROUTE',pool=out.fromUserAccount;
  out.fromUserAccount=route;
  tx.tokenTransfers.push({...structuredClone(out),fromUserAccount:pool,toUserAccount:route,fromTokenAccount:'POOL',toTokenAccount:'ROUTE_TOKEN'});
  const input=tx.tokenTransfers.find(t=>t.mint===wsol);input.fromUserAccount=route;input.toUserAccount=pool;
  const e=engine(),c=e.buildSwapCandidate(tx),r=e.buildBuySignal(c);
  assert.equal(c.detector,'ROUTED_WSOL_GAKE_RECEIPT');assert.equal(r.signal.detector,'ROUTED_WSOL_GAKE_RECEIPT');
});
