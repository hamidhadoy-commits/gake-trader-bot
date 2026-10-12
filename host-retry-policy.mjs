export const TERMINAL_FEED_EXIT=78;
const RECOVERABLE_FEED_ERRORS=new Set(['REQUEST_OR_IO_FAILED','PUBLIC_RATE_LIMIT','PUBLIC_HTTP_ERROR','DATABASE_REQUEST_FAILED','AUTH_REFRESH_FAILED']);
export function failureDecision(consecutiveFailures,{recoverTransient=false,reason}={}) {
  if(!Number.isSafeInteger(consecutiveFailures)||consecutiveFailures<1)throw Error('INVALID_FAILURE_COUNT');
  if(recoverTransient&&RECOVERABLE_FEED_ERRORS.has(reason)&&consecutiveFailures>=3)
    return {stop:false,delayMs:Math.min(900000,300000*2**Math.min(consecutiveFailures-3,2)),recovery:true};
  return {stop:consecutiveFailures>=3,delayMs:30000*2**Math.min(consecutiveFailures-1,1)};
}
export function waitForRetry(ms,signal) {
 if(signal?.aborted)return Promise.resolve();
 return new Promise(resolve=>{let timer;const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};timer=setTimeout(finish,ms);signal?.addEventListener('abort',finish,{once:true});});
}
export async function runFeedLoop({tick,state,save,once=false,recoverTransient=false,isStopping=()=>false,stopSignal,sleep=ms=>waitForRetry(ms,stopSignal),now=Date.now}) {
  do {
    const start=now();let delayMs=30000,terminal=false;
    try{await tick();state.consecutiveFailures=0;state.status='RUNNING';}
    catch(e){
      state.failures++;state.consecutiveFailures++;
      state.lastError={at:new Date(now()).toISOString(),reason:/^[A-Z_]+$/.test(e.message)?e.message:'REQUEST_OR_IO_FAILED'};
      const decision=failureDecision(state.consecutiveFailures,{recoverTransient,reason:state.lastError.reason});delayMs=decision.delayMs;terminal=decision.stop;
      state.status=terminal?'FAILED_RETRY_LIMIT':decision.recovery?'RECOVERY_WAIT':'RETRY_WAIT';
    }
    if(terminal||once||isStopping()){
      if(!terminal)state.status='STOPPED';delete state.nextAttemptAt;save();return terminal?TERMINAL_FEED_EXIT:0;
    }
    const delay=Math.max(1000,delayMs-(now()-start));state.nextAttemptAt=new Date(now()+delay).toISOString();save();await sleep(delay);
  }while(!isStopping());
  state.status='STOPPED';delete state.nextAttemptAt;save();return 0;
}
