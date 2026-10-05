// Pump AMM buy layout: https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json
const PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const BUY = [102,6,61,18,1,218,235,234];
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const U64 = 18446744073709551615n;
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const integer = value => {
  if(typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const s=String(value??'');
  return s.length<=21 && /^-?\d+$/.test(s) ? BigInt(s) : null;
};
function raw(transfer, decimals) {
  const value=transfer?.rawTokenAmount?.tokenAmount ?? transfer?.tokenAmountRaw ?? transfer?.rawAmount;
  if(value!==undefined) return integer(value);
  const s=String(transfer?.tokenAmount??'');
  if(!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole,fraction='']=s.split('.');
  if(fraction.length>decimals && /[1-9]/.test(fraction.slice(decimals))) return null;
  return BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.slice(0,decimals).padEnd(decimals,'0')||'0');
}
function buyData(data) {
  if(typeof data!=='string' || data.length<8 || data.length>90) return null;
  let n=0n;
  for(const c of data){const d=ALPHABET.indexOf(c);if(d<0)return null;n=n*58n+BigInt(d);}
  const bytes=[];
  while(n){bytes.unshift(Number(n&255n));n>>=8n;}
  for(const c of data){if(c!=='1')break;bytes.unshift(0);}
  if(bytes.length<24 || !BUY.every((v,i)=>bytes[i]===v)) return null;
  const u64=offset=>bytes.slice(offset,offset+8).reduce((v,b,i)=>v+(BigInt(b)<<BigInt(8*i)),0n);
  return {output:u64(8),maxInput:u64(16)};
}
function instructions(tx) {
  const result=[];
  function visit(items,depth){
    if(depth>4 || !Array.isArray(items))return;
    for(const item of items){if(result.length>=128)return;result.push(item);visit(item?.innerInstructions,depth+1);}
  }
  visit(tx?.instructions,0);
  return result;
}
function balance(tx,account,owner,mint,decimals) {
  const found=[];
  for(const item of tx.accountData||[])for(const c of Array.isArray(item?.tokenBalanceChanges)?item.tokenBalanceChanges:[]){
    if((c.tokenAccount||item.account)===account && c.userAccount===owner && c.mint===mint && c.rawTokenAmount?.decimals===decimals)found.push(integer(c.rawTokenAmount.tokenAmount));
  }
  return found.length===1 ? found[0] : null;
}
export function buildDirectPumpCandidate(tx,{wallet,wrappedSolMint,nowMs=Date.now()}) {
  if(!Array.isArray(tx?.accountData) || tx?.transactionError!=null || tx?.feePayer!==wallet || typeof tx?.signature!=='string' || !tx.signature) return null;
  const time=Number(tx.timestamp)*1000,age=nowMs-time;
  if(!Number.isFinite(time) || !Number.isFinite(age) || age < -30000 || age>120000) return null;
  const buys=instructions(tx).filter(i=>i?.programId===PROGRAM && Array.isArray(i.accounts) && i.accounts[1]===wallet && buyData(i.data));
  if(buys.length!==1) return null;
  const instruction=buys[0],a=instruction.accounts,args=buyData(instruction.data);
  if(a.length<9 || a[4]!==wrappedSolMint || !a[3] || a[3]===wrappedSolMint || a[0]===wallet) return null;
  const transfers=Array.isArray(tx.tokenTransfers)?tx.tokenTransfers:[];
  const outs=transfers.filter(t=>t.mint===a[3] && t.fromUserAccount===a[0] && t.toUserAccount===wallet && t.fromTokenAccount===a[7] && t.toTokenAccount===a[5]);
  const ins=transfers.filter(t=>t.mint===wrappedSolMint && t.fromUserAccount===wallet && t.toUserAccount===a[0] && t.fromTokenAccount===a[6] && t.toTokenAccount===a[8]);
  if(outs.length!==1 || ins.length!==1) return null;
  const changes=tx.accountData.flatMap(x=>Array.isArray(x?.tokenBalanceChanges)?x.tokenBalanceChanges:[]);
  const outputChange=changes.find(c=>c.userAccount===wallet && c.mint===a[3] && c.tokenAccount===a[5]);
  const decimals=outputChange?.rawTokenAmount?.decimals;
  if(!Number.isInteger(decimals) || decimals<0 || decimals>18) return null;
  const output=raw(outs[0],decimals),input=raw(ins[0],9);
  if(output===null || output<=0n || output>U64 || input===null || input<=0n || input>SAFE || output!==args.output || input>args.maxInput) return null;
  if(balance(tx,a[5],wallet,a[3],decimals)!==output || balance(tx,a[7],a[0],a[3],decimals)!==-output || balance(tx,a[8],a[0],wrappedSolMint,9)!==input) return null;
  const tokenAmount=Number(output)/10**decimals;
  if(!Number.isFinite(tokenAmount) || tokenAmount<=0) return null;
  const native=(tx.accountData||[]).find(x=>x.account===wallet)?.nativeBalanceChange||0;
  const fee=Number(tx.fee||0);
  return {message:'🔎 SWAP CANDIDATE',action:'SWAP_CANDIDATE',detector:'DIRECT_PUMP_AMM_WSOL',confidence:'HIGH',
    wallet,rawTokenAmount:output.toString(),tokenDecimals:decimals,toTokenAccount:a[5],signature:tx.signature,source:tx.source||null,type:tx.type||null,mint:a[3],tokenAmount,
    fromUserAccount:a[0],toUserAccount:wallet,feePayer:wallet,inferredInputAccount:wallet,
    inferredSwapInputSOL:Number(input)/1e9,inferredSwapInputLamports:input.toString(),
    directEconomicChainMatched:true,directProgram:PROGRAM,directUser:wallet,counterparty:a[0],
    finalOutputRawAmount:output.toString(),gakeBalanceIncreaseRawAmount:output.toString(),wsolInputRawAmount:input.toString(),
    gakeNativeBalanceChangeSOL:Number(native)/1e9,fee,feeSOL:fee/1e9,transactionError:null,timestamp:tx.timestamp};
}
export function validateDirectPumpCandidate(c,wallet) {
  const out=integer(c?.finalOutputRawAmount),increase=integer(c?.gakeBalanceIncreaseRawAmount),input=integer(c?.wsolInputRawAmount);
  const valid=c?.directEconomicChainMatched===true && c.directProgram===PROGRAM && c.directUser===wallet && c.toUserAccount===wallet && c.feePayer===wallet && c.confidence==='HIGH' && c.transactionError==null && c.counterparty && c.counterparty!==wallet && out!==null && out>0n && out<=U64 && increase===out && input!==null && input>0n && input<=SAFE && integer(c.inferredSwapInputLamports)===input && Number(c.inferredSwapInputSOL)===Number(input)/1e9 && c.mint && Number.isFinite(c.tokenAmount) && c.tokenAmount>0;
  return valid ? [] : ['invalid_direct_pump_evidence'];
}
