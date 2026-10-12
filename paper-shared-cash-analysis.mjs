// Read-only account feasibility evidence. Never resets positions or invents fills.
export function analyzeSharedCash(snapshot) {
 if(snapshot?.rowsWritten!==0||snapshot.execution!=='DISABLED'||snapshot.realMoney!==false)throw Error('READ_ONLY_PAPER_REQUIRED');
 const account=snapshot.account[0],config=snapshot.config[0],positions=snapshot.mainPositions;
 const keys=['initial_balance_lamports','cash_balance_lamports','total_deposits_lamports','total_withdrawals_lamports','realized_pnl_lamports'];
 if(!account||!config||!keys.every(k=>Number.isSafeInteger(account[k])))throw Error('INVALID_ACCOUNT');
 for(const p of positions)if(!['entry_cost_lamports','realized_proceeds_lamports','realized_pnl_lamports','copy_notional_lamports'].every(k=>Number.isSafeInteger(p[k])))throw Error('INVALID_POSITION');
 const sum=k=>positions.reduce((v,p)=>v+BigInt(p[k]),0n);
 const base=BigInt(account.initial_balance_lamports)+BigInt(account.total_deposits_lamports)-BigInt(account.total_withdrawals_lamports);
 if(base-sum('entry_cost_lamports')+sum('realized_proceeds_lamports')!==BigInt(account.cash_balance_lamports)||sum('realized_pnl_lamports')!==BigInt(account.realized_pnl_lamports))throw Error('ACCOUNT_RECONCILIATION_FAILED');
 for(const k of ['profit_reinvest_bps','max_total_exposure_bps','max_open_positions'])if(!Number.isSafeInteger(config[k])||config[k]<0||(k!=='max_open_positions'&&config[k]>10000))throw Error('INVALID_RISK_CONFIG');
 const pnl=BigInt(account.realized_pnl_lamports),equity=base+(pnl>=0n?pnl*BigInt(config.profit_reinvest_bps)/10000n:pnl);
 const sizingEquity=equity>0n?equity:0n;
 const open=positions.filter(p=>p.status==='PAPER_OPEN');
 const exposure=open.reduce((v,p)=>{if(!Number.isFinite(p.simulated_token_amount)||p.simulated_token_amount<=0||!Number.isFinite(p.remaining_token_amount)||p.remaining_token_amount<0||p.remaining_token_amount>p.simulated_token_amount)throw Error('INVALID_TOKEN_AMOUNT');return v+BigInt(Math.trunc(p.copy_notional_lamports*p.remaining_token_amount/p.simulated_token_amount));},0n);
 const cap=sizingEquity*BigInt(config.max_total_exposure_bps)/10000n,available=cap>exposure?cap-exposure:0n;
 const slots=config.max_open_positions===0?null:Math.max(0,config.max_open_positions-open.length);
 const newer=snapshot.newQuotePositions,cost=newer.reduce((v,p)=>v+BigInt(p.entry_cost_lamports),0n);
 const actualNewInMain=newer.filter(p=>positions.some(m=>m.source_signature===p.source_signature)).length;
 return {at:snapshot.at,execution:'DISABLED',realMoney:false,cashReconciled:true,pnlReconciled:true,
 main:{cashLamports:String(account.cash_balance_lamports),partialRealizedPnlLamports:String(account.realized_pnl_lamports),sizingEquityLamports:sizingEquity.toString(),openPositions:open.length,maxOpenPositions:config.max_open_positions,freeSlots:slots,openExposureLamports:exposure.toString(),exposureCapLamports:cap.toString(),availableExposureLamports:available.toString(),totalLiquidationEquity:null,mainPnlComplete:false},
 research:{positions:newer.length,entryCostLamports:cost.toString(),costVsInitialCapital:Number(cost)/Number(account.initial_balance_lamports),actualPositionsInMain:actualNewInMain,knownBlockedByCurrentPositionCap:slots===0?newer.length:null,replayPnl:null},
 limitations:['Current-state feasibility is not a reconstruction of every past admission decision.','Research groups do not share the Main cash budget; their return is not Main portfolio return.','A zero slot budget prevents admission even when cash is available.','No hypothetical exits, resets or proportional quote rescaling are used.']};
}
