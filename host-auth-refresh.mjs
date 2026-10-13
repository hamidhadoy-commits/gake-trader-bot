import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const KINDS=new Set(['TIMEOUT','SPAWN_ERROR','PROCESS_EXIT','EXPIRED_CREDENTIAL']);
export function sanitizeAuthRefreshFailure(value){
 if(!value||!KINDS.has(value.kind))return undefined;
 return {kind:value.kind,exitCode:Number.isInteger(value.exitCode)?value.exitCode:null,signal:typeof value.signal==='string'&&/^SIG[A-Z]+$/.test(value.signal)?value.signal:null};
}
export function createHostAuth({configPath,configDir,cli,cwd,workerName='gake-trader-bot',readFile=fs.readFileSync,spawn=spawnSync,now=Date.now,execPath=process.execPath}){
 let lastRefreshAt=null;
 function read(){
  const text=readFile(configPath,'utf8');
  return {token:text.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1],expires:Date.parse(text.match(/expiration_time\s*=\s*"([^"]+)"/)?.[1])};
 }
 function failure(kind,result={}){
  const e=Error('AUTH_REFRESH_FAILED');e.authRefreshFailure=sanitizeAuthRefreshFailure({kind,exitCode:result.status,signal:result.signal});throw e;
 }
 function getToken({forceRefresh=false}={}){
  // Wrangler and other project processes may have rotated the cached credentials.
  // Read the current file for every request; never retain an older bearer token.
  let current=read();
  const knownExpiry=Number.isFinite(current.expires);
  const usable=current.token&&(knownExpiry?current.expires>now():lastRefreshAt!==null&&now()-lastRefreshAt<1200000);
  if(!forceRefresh&&usable)return current.token;
  const r=spawn(execPath,[cli,'deployments','list','--name',workerName],{cwd,env:{...process.env,XDG_CONFIG_HOME:configDir,WRANGLER_SEND_METRICS:'false'},encoding:'utf8',timeout:60000,maxBuffer:1000000,windowsHide:true});
  if(r.error)failure(r.error.code==='ETIMEDOUT'?'TIMEOUT':'SPAWN_ERROR',r);
  if(r.status!==0)failure('PROCESS_EXIT',r);
  current=read();if(!current.token)throw Error('AUTH_TOKEN_UNAVAILABLE');
  if(Number.isFinite(current.expires)&&current.expires<=now())failure('EXPIRED_CREDENTIAL',r);
  lastRefreshAt=now();return current.token;
 }
 return {getToken};
}
