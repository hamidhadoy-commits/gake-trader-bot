import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const launcher=fileURLToPath(new URL('./start-host-reference-supervisor.mjs',import.meta.url));
const supervisor=fileURLToPath(new URL('./host-reference-supervisor.mjs',import.meta.url));
test('active supervisor identity is idempotent and preserves metadata',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gake-launcher-'));let parent,childPid;
 try{
  const publisher=path.join(dir,'child.mjs');fs.writeFileSync(publisher,'setInterval(()=>{},1000);');
  const config=path.join(dir,'config.json'),output=path.join(dir,'supervisor.json');fs.writeFileSync(config,JSON.stringify({publisher,cwd:dir,output,heartbeatMs:50}));
  parent=spawn(process.execPath,[supervisor,'--config',config],{stdio:'ignore'});
  const deadline=Date.now()+10000;while(!fs.existsSync(output)){if(Date.now()>deadline)throw Error('TEST_TIMEOUT');await new Promise(r=>setTimeout(r,50));}
  childPid=JSON.parse(fs.readFileSync(output,'utf8')).childPid;
  fs.writeFileSync(path.join(dir,'supervisor-process.json'),'retained process metadata');
  const r=spawnSync(process.execPath,[launcher,'--state-dir',dir],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).supervisorPid,parent.pid);assert.equal(JSON.parse(r.stdout).supervisorAlreadyRunning,true);assert.equal(fs.readFileSync(path.join(dir,'supervisor-process.json'),'utf8'),'retained process metadata');assert.equal(fs.existsSync(path.join(dir,'supervisor-config.json')),false);
 }finally{
  if(parent){parent.kill();await new Promise(r=>parent.exitCode!==null?r():parent.once('close',r));}
  if(childPid)try{process.kill(childPid);}catch{}
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
test('invalid lock fails closed and never spawns or rewrites state',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gake-launcher-'));try{
  fs.writeFileSync(path.join(dir,'supervisor.json.lock'),'not a pid');
  const r=spawnSync(process.execPath,[launcher,'--state-dir',dir],{encoding:'utf8',timeout:10000});assert.notEqual(r.status,0);assert.equal(fs.existsSync(path.join(dir,'supervisor-process.json')),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
