import {refreshNetlifyReferenceFeed} from './netlify-feed-publisher.js';
// Finite deployment trial. Outside exactly three approved minutes: no I/O.
export const NETLIFY_FEED_TRIAL_SLOTS = [1791662280000,1791662340000,1791662400000];
export async function runNetlifyFeedTrial(env,scheduledTime,
  {slots=NETLIFY_FEED_TRIAL_SLOTS,clock=Date.now,publisher=refreshNetlifyReferenceFeed}={}) {
  const now=clock(),minute=Math.floor(scheduledTime/60000)*60000;
  if (slots.length!==3 || !slots.every(Number.isSafeInteger) ||
      slots[1]!==slots[0]+60000 || slots[2]!==slots[1]+60000 ||
      !slots.includes(minute) || now<scheduledTime || now-scheduledTime>70000)
    return {status:'DISABLED',feedWritten:false};
  let result;
  try {result=await publisher(env.DB,{publish:true,clock});}
  catch {result={status:'PUBLISH_FAILED',feedWritten:false};}
  const summary={message:'NETLIFY FEED TRIAL',scheduledTime,...result,
    execution:'DISABLED',realMoney:false};
  console.log(summary);return summary;
}
