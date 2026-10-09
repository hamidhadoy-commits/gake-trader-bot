import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
const i=process.argv.indexOf('--state-dir');if(i<0)throw Error('STATE_DIR_REQUIRED');
const dir=path.resolve(process.argv[i+1]),record=JSON.parse(fs.readFileSync(path.join(dir,'publisher-process.json'),'utf8'));
const publisher=path.resolve(record.args[0]),cwd=path.dirname(publisher);
if(path.basename(publisher)!=='host-reference-publisher.mjs')throw Error('UNEXPECTED_PUBLISHER');
try{process.kill(record.pid,0);throw Error('EXISTING_PUBLISHER_ACTIVE');}catch(e){if(e.code!=='ESRCH')throw e;}
const config={publisher,publisherArgs:record.args.slice(1),cwd,output:path.join(dir,'supervisor.json')};
const configPath=path.join(dir,'supervisor-config.json');fs.writeFileSync(configPath,JSON.stringify(config,null,2));
const child=spawn(process.execPath,[path.join(cwd,'host-reference-supervisor.mjs'),'--config',configPath],{cwd,detached:true,stdio:'ignore',windowsHide:true});child.unref();
fs.writeFileSync(path.join(dir,'supervisor-process.json'),JSON.stringify({pid:child.pid,startedAt:new Date().toISOString(),mode:'PROJECT_PROCESS_NO_AUTOSTART'},null,2));console.log(JSON.stringify({supervisorPid:child.pid}));
