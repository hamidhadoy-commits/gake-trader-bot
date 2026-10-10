export const TERMINAL_FEED_EXIT=78;
export function failureDecision(consecutiveFailures) {
  if(!Number.isSafeInteger(consecutiveFailures)||consecutiveFailures<1)throw Error('INVALID_FAILURE_COUNT');
  return {stop:consecutiveFailures>=3,delayMs:30000*2**Math.min(consecutiveFailures-1,1)};
}
export async function runFeedLoop({tick,state,save,once=false,isStopping=()=>false,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}) {
  do {
    const start=now();let delayMs=30000,terminal=false;
    try{await tick();state.consecutiveFailures=0;state.status='RUNNING';}
    catch(e){
      state.failures++;state.consecutiveFailures++;
      state.lastError={at:new Date(now()).toISOString(),reason:/^[A-Z_]+$/.test(e.message)?e.message:'REQUEST_OR_IO_FAILED'};
      const decision=failureDecision(state.consecutiveFailures);delayMs=decision.delayMs;terminal=decision.stop;
      state.status=terminal?'FAILED_RETRY_LIMIT':'RETRY_WAIT';
    }
    if(terminal||once||isStopping()){
      if(!terminal)state.status='STOPPED';delete state.nextAttemptAt;save();return terminal?TERMINAL_FEED_EXIT:0;
    }
    const delay=Math.max(1000,delayMs-(now()-start));state.nextAttemptAt=new Date(now()+delay).toISOString();save();await sleep(delay);
  }while(!isStopping());
  state.status='STOPPED';delete state.nextAttemptAt;save();return 0;
}
