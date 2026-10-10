import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

// OS birth identity prevents a recycled PID from inheriting a project lock.
export function inspectProcess(pid) {
  if(!Number.isSafeInteger(pid)||pid<=0)throw Error('INVALID_PROCESS_ID');
  try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return null;throw Error('PROCESS_INSPECTION_FAILED');}
  if(process.platform==='win32') {
    const code=`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){@{birth=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine;parent=$p.ParentProcessId}|ConvertTo-Json -Compress}`;
    const r=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',timeout:10000,windowsHide:true});
    if(r.status!==0)throw Error('PROCESS_INSPECTION_FAILED');
    if(!r.stdout.trim())return null;
    const info=JSON.parse(r.stdout);if(!info.birth||!info.command)throw Error('PROCESS_INSPECTION_FAILED');return info;
  }
  if(process.platform==='linux') {
    try{
      const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
      return {birth:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],command:fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').replaceAll('\0',' ')};
    }catch{throw Error('PROCESS_INSPECTION_FAILED');}
  }
  throw Error('PROCESS_INSPECTION_UNSUPPORTED');
}
const normalized=s=>String(s).replaceAll('\\','/').toLowerCase();
export function lockIsActive(lock,{script,output},inspect=inspectProcess) {
  if(!fs.existsSync(lock))return false;
  let record;try{record=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{throw Error('INVALID_PROCESS_LOCK');}
  const pid=typeof record==='number'?record:record?.pid;
  if(!Number.isSafeInteger(pid)||pid<=0)throw Error('INVALID_PROCESS_LOCK');
  const info=inspect(pid);if(!info)return false;
  if(typeof record==='object') {
    if(!record.birth||!record.owner||record.script!==path.resolve(script)||record.output!==path.resolve(output))throw Error('INVALID_PROCESS_LOCK');
    return record.birth===info.birth;
  }
  // Legacy numeric locks require both script and checkpoint in the OS command.
  const cmd=normalized(info.command);
  if(!cmd.includes(normalized(path.resolve(script))))return false;
  if(cmd.includes(normalized(path.resolve(output))))return true;
  // Supervisors carry the checkpoint through --config, not a direct --output.
  if(path.basename(script)==='host-reference-supervisor.mjs') {
    const match=info.command.match(/--config\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    if(!match)throw Error('PROCESS_INSPECTION_FAILED');
    try{return normalized(path.resolve(JSON.parse(fs.readFileSync(match[1]||match[2]||match[3],'utf8')).output))===normalized(path.resolve(output));}
    catch{throw Error('PROCESS_INSPECTION_FAILED');}
  }
  return false;
}
export function acquireLock(lock,identity,inspect=inspectProcess) {
  if(lockIsActive(lock,identity,inspect))throw Error('PROJECT_PROCESS_ALREADY_RUNNING');
  if(fs.existsSync(lock))fs.renameSync(lock,lock+'.stale-'+Date.now()+'-'+randomUUID());
  const info=inspect(process.pid);if(!info?.birth)throw Error('PROCESS_INSPECTION_FAILED');
  const record={pid:process.pid,birth:info.birth,owner:randomUUID(),script:path.resolve(identity.script),output:path.resolve(identity.output)};
  fs.writeFileSync(lock,JSON.stringify(record),{flag:'wx'});
  return ()=>{try{if(JSON.parse(fs.readFileSync(lock,'utf8')).owner===record.owner)fs.unlinkSync(lock);}catch{}};
}
