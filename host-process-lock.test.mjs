import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseWindowsProcessInfo,lockIsActive} from './host-process-lock.mjs';
const oldBirth='2026-10-15T13:39:47.8144620Z',newBirth='2026-10-16T22:04:58.0149800Z';
const hidden=JSON.stringify({birth:newBirth,command:null,parent:4});
test('Windows PID reused by protected process is identifiable only with different recorded birth',()=>{
 assert.equal(parseWindowsProcessInfo(hidden,{expectedBirth:oldBirth}).birth,newBirth);
});
test('matching birth with inaccessible command fails closed',()=>{
 assert.throws(()=>parseWindowsProcessInfo(hidden,{expectedBirth:newBirth}),/PROCESS_INSPECTION_FAILED/);
});
test('unowned protected process cannot be declared absent',()=>{
 assert.throws(()=>parseWindowsProcessInfo(hidden),/PROCESS_INSPECTION_FAILED/);
});
test('empty successful CIM output means no process; malformed or unknown birth is rejected',()=>{
 assert.equal(parseWindowsProcessInfo(''),null);
 for(const text of ['not-json','{}',JSON.stringify({birth:'unknown',command:'node'})])
 assert.throws(()=>parseWindowsProcessInfo(text,{expectedBirth:oldBirth}),/PROCESS_INSPECTION_FAILED/);
});
test('readable current Windows identity requires no expected birth',()=>{
 assert.equal(parseWindowsProcessInfo(JSON.stringify({birth:newBirth,command:'node publisher.mjs'})).command,'node publisher.mjs');
});
test('structured locks pass recorded birth for protected PID reuse; legacy lock stays closed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gake-protected-pid-'));
 const identity={script:path.join(dir,'publisher.mjs'),output:path.join(dir,'publisher.json')},lock=identity.output+'.lock';
 try{
 fs.writeFileSync(lock,JSON.stringify({pid:3676,birth:oldBirth,owner:'old-owner',...identity}));
 assert.equal(lockIsActive(lock,identity,(pid,options)=>{assert.equal(pid,3676);assert.equal(options.expectedBirth,oldBirth);return parseWindowsProcessInfo(hidden,options);}),false);
 fs.writeFileSync(lock,'3676');assert.throws(()=>lockIsActive(lock,identity,(_pid,options)=>parseWindowsProcessInfo(hidden,options)),/PROCESS_INSPECTION_FAILED/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
