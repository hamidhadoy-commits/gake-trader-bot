import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {lockIsActive,inspectProcess} from './host-process-lock.mjs';
const i=process.argv.indexOf('--state-dir');if(i<0)throw Error('STATE_DIR_REQUIRED');
const dir=path.resolve(process.argv[i+1]),lock=path.join(dir,'supervisor.json.lock');
const supervisorPath=fileURLToPath(new URL('./host-reference-supervisor.mjs',import.meta.url));
if(lockIsActive(lock,{script:supervisorPath,output:path.join(dir,'supervisor.json')})){
 const value=JSON.parse(fs.readFileSync(lock,'utf8'));console.log(JSON.stringify({supervisorAlreadyRunning:true,supervisorPid:typeof value==='number'?value:value.pid}));process.exit(0);
}
const record=JSON.parse(fs.readFileSync(path.join(dir,'publisher-process.json'),'utf8'));
const publisher=path.resolve(record.args[0]),cwd=path.dirname(publisher);
if(path.basename(publisher)!=='host-reference-publisher.mjs')throw Error('UNEXPECTED_PUBLISHER');
const publisherLock=path.join(dir,'publisher.json.lock');
if(lockIsActive(publisherLock,{script:publisher,output:path.join(dir,'publisher.json')}))throw Error('EXISTING_PUBLISHER_ACTIVE');
const info=inspectProcess(record.pid);
if(info?.command.toLowerCase().includes(publisher.toLowerCase()))throw Error('EXISTING_PUBLISHER_ACTIVE');
const config={publisher,publisherArgs:[...record.args.slice(1),...(record.args.includes('--recover-transient')?[]:['--recover-transient'])],cwd,output:path.join(dir,'supervisor.json'),maxRestarts:2};
const configPath=path.join(dir,'supervisor-config.json');fs.writeFileSync(configPath,JSON.stringify(config,null,2));
const child=spawn(process.execPath,[path.join(cwd,'host-reference-supervisor.mjs'),'--config',configPath],{cwd,detached:true,stdio:'ignore',windowsHide:true});child.unref();
fs.writeFileSync(path.join(dir,'supervisor-process.json'),JSON.stringify({pid:child.pid,startedAt:new Date().toISOString(),mode:'PROJECT_PROCESS_NO_AUTOSTART'},null,2));console.log(JSON.stringify({supervisorPid:child.pid}));
