import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const launcher=fileURLToPath(new URL('./start-host-reference-supervisor.mjs',import.meta.url));
test('active supervisor is idempotent and preserves existing process metadata',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gake-launcher-'));try{
 fs.writeFileSync(path.join(dir,'supervisor.json.lock'),String(process.pid));
 const record=path.join(dir,'supervisor-process.json');fs.writeFileSync(record,'retained process metadata');
 const r=spawnSync(process.execPath,[launcher,'--state-dir',dir],{encoding:'utf8',timeout:5000});
 assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).supervisorPid,process.pid);assert.equal(JSON.parse(r.stdout).supervisorAlreadyRunning,true);assert.equal(fs.readFileSync(record,'utf8'),'retained process metadata');
 assert.equal(fs.existsSync(path.join(dir,'supervisor-config.json')),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('invalid supervisor lock fails closed and never spawns or rewrites state',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gake-launcher-'));try{
 fs.writeFileSync(path.join(dir,'supervisor.json.lock'),'not a pid');
 const r=spawnSync(process.execPath,[launcher,'--state-dir',dir],{encoding:'utf8',timeout:5000});
 assert.notEqual(r.status,0);assert.equal(fs.existsSync(path.join(dir,'supervisor-process.json')),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
