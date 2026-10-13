import test from 'node:test';import assert from 'node:assert/strict';import {buildSharedPaperReport} from './paper-shared-portfolio-report.mjs';
const fixture=()=>({at:'2026-10-12T20:00:10Z',rowsWritten:0,execution:'DISABLED',realMoney:false,solUsd:100,account:{id:'RUN',status:'ACTIVE',initial_usd:20,initial_lamports:200,cash_lamports:200,realized_pnl_lamports:0,fees_lamports:0},positions:[],ledger:[{operation_id:'i',event_type:'INITIAL',cash_delta_lamports:200,pnl_delta_lamports:0,fee_lamports:0,checked_at:'2026-10-12T20:00:00Z'}]});
test('initial cash is fully reconciled with zero trades',()=>{const r=buildSharedPaperReport(fixture());assert(r.reconciled);assert.equal(r.quoteEstimatedTotalPnlSOL,0);});
test('open quantity without quote remains unknown, not marked at entry or zero',()=>{const f=fixture();f.account.cash_lamports=100;f.positions=[{source_signature:'a',status:'PAPER_OPEN',remaining_raw_amount:'100',config_json:'{"sell_slippage_bps":1500,"sell_fee_lamports":2}'}];f.ledger.push({operation_id:'b',event_type:'BUY',source_signature:'a',raw_amount:'100',cash_delta_lamports:-100,pnl_delta_lamports:0,fee_lamports:0,checked_at:'2026-10-12T20:00:01Z'});const r=buildSharedPaperReport(f);assert.equal(r.quoteEstimatedEquitySOL,null);assert.equal(r.unknownValuationEvents,1);});
test('wrong account balance or quantity cannot produce a report',()=>{const f=fixture();f.account.cash_lamports=201;assert.throws(()=>buildSharedPaperReport(f));});

test('account revision orders sale before later purchase at the same timestamp',()=>{
 const f=fixture(),same='2026-10-12T20:00:02Z';
 f.account.cash_lamports=135;f.account.realized_pnl_lamports=-20;
 const config_json=JSON.stringify({sell_slippage_bps:0,sell_fee_lamports:0});
 f.positions=[{source_signature:'a',status:'PAPER_CLOSED',remaining_raw_amount:'0',config_json},{source_signature:'b',status:'PAPER_OPEN',remaining_raw_amount:'10',config_json}];
 f.ledger[0].account_revision=0;
 const event=(event_type,checked_at,account_revision,cash_delta_lamports,source_signature,raw_amount,pnl_delta_lamports=0)=>({operation_id:event_type+source_signature,event_type,checked_at,account_revision,cash_delta_lamports,source_signature,raw_amount,pnl_delta_lamports,fee_lamports:0});
 f.ledger.push(event('BUY','2026-10-12T20:00:01Z',1,-50,'a','10'),event('BUY',same,3,-45,'b','10'),event('SELL',same,2,30,'a','10',-20));
 const r=buildSharedPaperReport(f);
 assert.equal(r.observedMaxDrawdownBps,1000);assert.equal(r.quoteEstimatedEquitySOL,null);assert.equal(r.quoteEstimatedTotalPnlSOL,null);assert.equal(r.reconciled,true);
 f.ledger.reverse();assert.deepEqual(buildSharedPaperReport(f),r);
});
