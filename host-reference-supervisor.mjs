import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
export function startSupervisor(config) {
  const {publisher,publisherArgs=[],cwd,output}=config;
  if(!path.isAbsolute(publisher)||!path.isAbsolute(output)||!path.isAbsolute(cwd)) throw Error('ABSOLUTE_PATH_REQUIRED');
  const lock=output+'.lock';
  if(fs.existsSync(lock)) {
    const old=Number(fs.readFileSync(lock,'utf8'));
    if(!Number.isSafeInteger(old)||old<=0)throw Error('INVALID_SUPERVISOR_LOCK');
    try {process.kill(old,0);throw Error('SUPERVISOR_ALREADY_RUNNING');}
    catch(e){if(e.code!=='ESRCH')throw e;fs.unlinkSync(lock);}
  }
  fs.writeFileSync(lock,String(process.pid),{flag:'wx'});
  const state={startedAt:new Date().toISOString(),pid:process.pid,status:'STARTING',launches:0,restarts:0};
  let child,timer,stopping=false,finished=false;
  const minDelay=config.restartMs??5000,maxDelay=config.maxRestartMs??60000;
  let resolveDone;const done=new Promise(r=>{resolveDone=r;});
  function save(){
    const temp=output+'.'+process.pid+'.tmp';
    fs.writeFileSync(temp,JSON.stringify({...state,heartbeatAt:new Date().toISOString()},null,2));
    fs.renameSync(temp,output);
  }
  function finish(){
    if(finished)return;finished=true;clearInterval(heartbeat);clearTimeout(timer);
    state.status='STOPPED';state.stoppedAt=new Date().toISOString();
    try{save();}finally{try{if(Number(fs.readFileSync(lock,'utf8'))===process.pid)fs.unlinkSync(lock);}catch{}resolveDone(state);}
  }
  function launch(){
    if(stopping)return finish();
    const started=Date.now();state.launches++;state.status='RUNNING';
    child=spawn(process.execPath,[publisher,...publisherArgs],{cwd,stdio:['ignore','ignore','pipe'],windowsHide:true});
    state.childPid=child.pid??null;
    // Store categories only. Child output can include credentials; never retain it.
    child.stderr.on('data',()=>{state.stderrObserved=true;});
    child.on('error',()=>{state.lastSpawnError='CHILD_SPAWN_FAILED';});
    child.once('close',(code,signal)=>{
      state.childPid=null;state.lastExit={at:new Date().toISOString(),code,signal};
      if(stopping)return finish();
      if(state.restarts >= (config.maxRestarts??Infinity))return finish();
      state.restarts++;state.status='RESTART_WAIT';
      const streak=Date.now()-started>=120000?0:Math.min((state.failureStreak??0)+1,5);
      state.failureStreak=streak;const delay=Math.min(maxDelay,minDelay*2**Math.max(0,streak-1));
      state.nextRestartAt=new Date(Date.now()+delay).toISOString();save();
      timer=setTimeout(launch,delay);
    });
    save();
  }
  const heartbeat=setInterval(()=>{try{save();}catch{stop();}},config.heartbeatMs??30000);
  function stop(){
    if(stopping)return done;stopping=true;clearTimeout(timer);state.status='STOPPING';
    if(!child?.pid||child.exitCode!==null){finish();return done;}
    child.kill('SIGTERM');
    timer=setTimeout(()=>{if(child?.exitCode===null)child.kill('SIGKILL');},45000);
    return done;
  }
  launch();
  return {stop,done,getState:()=>({...state})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try {
    const i=process.argv.indexOf('--config');if(i<0)throw Error('CONFIG_REQUIRED');
    const config=JSON.parse(fs.readFileSync(process.argv[i+1],'utf8'));
    const supervisor=startSupervisor(config);
    process.on('SIGINT',()=>supervisor.stop());process.on('SIGTERM',()=>supervisor.stop());
    await supervisor.done;
  }catch(e){console.error(JSON.stringify({reason:/^[A-Z_]+$/.test(e.message)?e.message:'SUPERVISOR_FAILED'}));process.exitCode=1;}
}
