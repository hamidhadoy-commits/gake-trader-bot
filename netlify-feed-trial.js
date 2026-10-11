import {refreshNetlifyReferenceFeed} from './netlify-feed-publisher.js';
// Finite deployment trial. Outside up to 240 consecutive approved minutes: no I/O.
export const NETLIFY_FEED_TRIAL_SLOTS = [1791716400000,1791716460000,1791716520000,1791716580000,1791716640000];
export async function runNetlifyFeedTrial(env,scheduledTime,
  {slots=NETLIFY_FEED_TRIAL_SLOTS,clock=Date.now,publisher=refreshNetlifyReferenceFeed}={}) {
  const now=clock(),minute=Math.floor(scheduledTime/60000)*60000,
    currentMinute=Math.floor(now/60000)*60000;
  if (!slots.length || slots.length>240 || !slots.every(Number.isSafeInteger) ||
      !slots.every((x,i)=>x===slots[0]+i*60000) ||
      !slots.includes(minute) || !slots.includes(currentMinute) || now<scheduledTime || now-scheduledTime>70000)
    return {status:'DISABLED',feedWritten:false};
  // Global wall-clock minute reservation: different cron offsets, late deliveries
  // and concurrent versions cannot call the provider twice in one minute.
  // A failed call consumes its reservation; no retry or catch-up burst.
  let claim;
  try {
    claim=await env.DB.prepare(
      "INSERT OR IGNORE INTO paper_cron_queue_runs(id,scheduled_time,status,started_at) VALUES (?,?,'NETLIFY_FEED_CLAIMED',?)"
    ).bind('NETLIFY_REFERENCE_MINUTE:'+currentMinute,currentMinute,new Date(now).toISOString()).run();
    if (claim?.success!==true || !Number.isSafeInteger(claim.meta?.changes))
      return {status:'CLAIM_FAILED',feedWritten:false};
  } catch {return {status:'CLAIM_FAILED',feedWritten:false};}
  if (claim.meta.changes===0) return {status:'DUPLICATE_MINUTE_SKIPPED',feedWritten:false};
  if (claim.meta.changes!==1) return {status:'CLAIM_FAILED',feedWritten:false};
  let result;
  try {result=await publisher(env.DB,{publish:true,clock,publishUntil:slots.at(-1)+60000,
    fetcher:(...args)=>{
      // A slow DB lookup must not carry an old reservation into a new minute.
      if (Math.floor(clock()/60000)*60000!==currentMinute)
        throw Error('MINUTE_WINDOW_CLOSED');
      return fetch(...args);
    }});}
  catch {result={status:'PUBLISH_FAILED',feedWritten:false};}
  const summary={message:'NETLIFY FEED TRIAL',scheduledTime,...result,
    execution:'DISABLED',realMoney:false};
  console.log(summary);return summary;
}
