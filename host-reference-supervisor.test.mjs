import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {startSupervisor} from './host-reference-supervisor.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('TEST_TIMEOUT');await wait(20);}}
function fixture(code){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gake-supervisor-'));const publisher=path.join(dir,'child.mjs');fs.writeFileSync(publisher,code);return {dir,config:{publisher,publisherArgs:[path.join(dir,'attempt.txt')],cwd:dir,output:path.join(dir,'state.json'),restartMs:25,maxRestartMs:50,heartbeatMs:20}};}
test('restarts failed child, records exit and does not retain child stderr',async()=>{
 const f=fixture("import fs from 'node:fs';const file=process.argv[2];const n=fs.existsSync(file)?Number(fs.readFileSync(file)):0;fs.writeFileSync(file,String(n+1));if(n===0){console.error('SECRET_TEST_DO_NOT_STORE');process.exit(9)}setInterval(()=>{},1000);");
 const s=startSupervisor(f.config);try{await until(()=>s.getState().launches===2);await until(()=>fs.readFileSync(path.join(f.dir,'attempt.txt'),'utf8')==='2');assert.equal(s.getState().lastExit.code,9);assert.equal(s.getState().restarts,1);assert.equal(fs.readFileSync(f.config.output,'utf8').includes('SECRET_TEST'),false);}
 finally{await s.stop();fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('duplicate supervisor rejected; stop removes lock and child',async()=>{
 const f=fixture("setInterval(()=>{},1000);");const s=startSupervisor(f.config);
 assert.throws(()=>startSupervisor(f.config),/SUPERVISOR_ALREADY_RUNNING/);
 const pid=s.getState().childPid;await s.stop();assert.equal(fs.existsSync(f.config.output+'.lock'),false);assert.equal(s.getState().status,'STOPPED');assert.throws(()=>process.kill(pid,0));fs.rmSync(f.dir,{recursive:true,force:true});
});
test('restart bound stops crash loop and records failures',async()=>{
 const f=fixture("process.exit(7);");const s=startSupervisor({...f.config,maxRestarts:2});
 await s.done;assert.equal(s.getState().launches,3);assert.equal(s.getState().restarts,2);assert.equal(s.getState().lastExit.code,7);assert.equal(fs.existsSync(f.config.output+'.lock'),false);fs.rmSync(f.dir,{recursive:true,force:true});
});
