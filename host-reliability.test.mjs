import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {acquireLock,lockIsActive,inspectProcess} from './host-process-lock.mjs';
import {runFeedLoop} from './host-retry-policy.mjs';
import {startSupervisor} from './host-reference-supervisor.mjs';
test('two retries then terminal stop; no secret error text retained',async()=>{
 const state={failures:0,consecutiveFailures:0};let calls=0,saves=0;const delays=[];
 const code=await runFeedLoop({tick:async()=>{calls++;throw Error('token=PRIVATE');},state,save:()=>saves++,sleep:async ms=>delays.push(ms),now:()=>100000});
 assert.equal(calls,3);assert.equal(code,78);assert.deepEqual(delays,[30000,60000]);assert.equal(saves,3);assert.equal(state.status,'FAILED_RETRY_LIMIT');assert.equal(JSON.stringify(state).includes('PRIVATE'),false);assert.equal(state.nextAttemptAt,undefined);
});
test('success resets consecutive failure budget',async()=>{
 const state={failures:0,consecutiveFailures:0};let calls=0;
 const code=await runFeedLoop({tick:async()=>{calls++;if(calls!==3)throw Error('AUTH_REFRESH_FAILED');},state,save:()=>{},sleep:async()=>{}});
 assert.equal(calls,6);assert.equal(state.failures,5);assert.equal(code,78);
});
test('once mode never retries and records stopped state',async()=>{
 const state={failures:0,consecutiveFailures:0};let sleeps=0;
 await runFeedLoop({tick:async()=>{throw Error('AUTH_REFRESH_FAILED');},state,save:()=>{},once:true,sleep:async()=>sleeps++});
 assert.equal(state.failures,1);assert.equal(sleeps,0);assert.equal(state.status,'STOPPED');
});
test('OS inspection returns current process birth identity',()=>{assert.ok(inspectProcess(process.pid).birth);});
test('legacy supervisor lock resolves output through config without duplicate spawn',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gake-legacy-'));const output=path.join(dir,'state.json'),lock=output+'.lock',script=path.join(dir,'host-reference-supervisor.mjs'),config=path.join(dir,'config.json');
 try{fs.writeFileSync(config,JSON.stringify({output}));fs.writeFileSync(lock,'1234');assert.equal(lockIsActive(lock,{script,output},()=>({birth:'legacy',command:`node "${script}" --config "${config}"`})),true);}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('recycled PID legacy lock archives safely; active owner blocks duplicate',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gake-lock-'));const output=path.join(dir,'state.json'),lock=output+'.lock',identity={script:path.join(dir,'publisher.mjs'),output};
 try{
  fs.writeFileSync(lock,'1234');const inspect=pid=>({birth:'new-process',command:'chrome.exe'});
  assert.equal(lockIsActive(lock,identity,inspect),false);const release=acquireLock(lock,identity,inspect);
  assert.equal(fs.readdirSync(dir).filter(x=>x.includes('.stale-')).length,1);
  assert.throws(()=>acquireLock(lock,identity,inspect),/ALREADY_RUNNING/);release();assert.equal(fs.existsSync(lock),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('birth mismatch is stale; unknown inspection and invalid lock fail closed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gake-lock-'));const output=path.join(dir,'state.json'),lock=output+'.lock',identity={script:path.join(dir,'publisher.mjs'),output};
 try{
  const release=acquireLock(lock,identity,()=>({birth:'old',command:'node'}));
  assert.equal(lockIsActive(lock,identity,()=>({birth:'new',command:'chrome'})),false);
  assert.throws(()=>lockIsActive(lock,identity,()=>{throw Error('PROCESS_INSPECTION_FAILED');}),/INSPECTION_FAILED/);
  release();fs.writeFileSync(lock,'invalid');assert.throws(()=>acquireLock(lock,identity),/INVALID_PROCESS_LOCK/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('supervisor cannot multiply exhausted publisher retry budget',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gake-terminal-'));const publisher=path.join(dir,'child.mjs');fs.writeFileSync(publisher,'process.exit(78);');
 try{const s=startSupervisor({publisher,cwd:dir,output:path.join(dir,'state.json'),restartMs:10,heartbeatMs:20});await s.done;assert.equal(s.getState().launches,1);assert.equal(s.getState().restarts,0);assert.equal(s.getState().stopReason,'PUBLISHER_RETRY_LIMIT');}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
