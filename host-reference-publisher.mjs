import fs from 'node:fs';
import {HOST_FEED_SELECTION_SQL,selectHostFeedMints} from './host-feed-selection.mjs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {acquireLock} from './host-process-lock.mjs';
import {runFeedLoop} from './host-retry-policy.mjs';
import {capturePriceResponseMetadata} from './price-provider.js';
const args=process.argv.slice(2), arg=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined};
const configDir=arg('--config-dir'), account=arg('--account'), db=arg('--db'), cli=arg('--wrangler');
if(!configDir||!account||!db||!cli)throw Error('REQUIRED_ARGUMENT_MISSING');
const SOL='So11111111111111111111111111111111111111112';
const configPath=path.join(configDir,'.wrangler/config/default.toml');
const output=arg('--output')||path.join(configDir,'host-reference-publisher.json');
const lock=output+'.lock';let stopping=false;
const releaseLock=acquireLock(lock,{script:fileURLToPath(import.meta.url),output});
process.on('SIGINT',()=>{stopping=true});process.on('SIGTERM',()=>{stopping=true});
let token,refreshAt=0;
function refresh(){
 const r=spawnSync(process.execPath,[cli,'deployments','list'],{env:{...process.env,XDG_CONFIG_HOME:configDir,WRANGLER_SEND_METRICS:'false'},encoding:'utf8',timeout:30000});
 if(r.status!==0)throw Error('AUTH_REFRESH_FAILED');
 token=fs.readFileSync(configPath,'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
 if(!token)throw Error('AUTH_TOKEN_UNAVAILABLE');refreshAt=Date.now();
}
async function query(sql,params=[]){
 if(!token||Date.now()-refreshAt>1200000)refresh();
 const url='https://api.cloudflare.com/client/v4/accounts/'+account+'/d1/database/'+db+'/query';
 let r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(15000)});
 if(r.status===401||r.status===403){refresh();r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(15000)})}
 const b=await r.json();if(!r.ok||!b.success)throw Error('DATABASE_REQUEST_FAILED');return b.result[0];
}
let state={startedAt:new Date().toISOString(),pid:process.pid,successes:0,failures:0,consecutiveFailures:0,status:'RUNNING'};
function save(){fs.writeFileSync(output,JSON.stringify(state,null,2));}
async function tick(){
 const result=await query(HOST_FEED_SELECTION_SQL);
 const selection=selectHostFeedMints(result.results),{mints}=selection;if(!mints.length){state.last={at:new Date().toISOString(),mints:0};return}
 // One coherent response; keep Main and the next due research observations in the bounded batch.
 if(mints.length>29)throw Error('HOST_FEED_BATCH_LIMIT');
 const addresses=[...new Set([...mints,SOL])];const start=Date.now();
 const response=await fetch('https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/'+addresses.map(encodeURIComponent).join(','),{headers:{accept:'application/json;version=20230302'},signal:AbortSignal.timeout(10000)});
 const body=await response.json();const end=Date.now();
 if(!response.ok)throw Error(response.status===429?'PUBLIC_RATE_LIMIT':'PUBLIC_HTTP_ERROR');
 const responseMetadata=capturePriceResponseMetadata(response,start,end);
 const tokens=body?.data?.attributes?.token_prices||{}, tokenPrices={};
 for(const mint of addresses){const price=Number(tokens[mint]);if(Number.isFinite(price)&&price>0)tokenPrices[mint]=price}
 if(!(tokenPrices[SOL]>0))throw Error('SOL_PRICE_UNAVAILABLE');
 const payload={schemaVersion:1,provider:'GECKOTERMINAL_PUBLIC',wrappedSolMint:SOL,tokenPrices,responseMetadata};
 const observedAt=new Date(end).toISOString();
 const write=await query('INSERT INTO paper_reference_price_feed(id,observed_at,payload_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,payload_json=excluded.payload_json WHERE excluded.observed_at>paper_reference_price_feed.observed_at',[observedAt,JSON.stringify(payload)]);
 state.successes++;state.last={observedAt,responseMetadata,capacityLimited:selection.capacityLimited,observedMintsLowerBound:selection.observedMintsLowerBound,mints:mints.length,priced:mints.filter(x=>tokenPrices[x]>0).length,changes:write.meta?.changes,rowsWritten:write.meta?.rows_written};
}
try{
 process.exitCode=await runFeedLoop({tick,state,save,once:args.includes('--once'),isStopping:()=>stopping});
}finally{releaseLock();}
