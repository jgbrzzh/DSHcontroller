import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NativeBridge } from './native.js';
import { PIPE, ROOT, STATE, delay, ControllerError, type Obj } from './common.js';
export async function localSecret(native:NativeBridge):Promise<string> {
  await mkdir(STATE,{recursive:true});const path=resolve(STATE,'ipc-secret.dpapi');
  for(let i=0;i<20;i++){
    try{const data=await readFile(path,'utf8');return (await native.call('unprotect',{data})).text;}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'){
      const secret=randomBytes(32).toString('hex');const data=(await native.call('protect',{text:secret})).data;
      try{await writeFile(path,data,{flag:'wx',mode:0o600});return secret;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    }else if(i===19)throw new ControllerError('ipc-auth-failed','Unable to decrypt the local IPC credential.');}
    await delay(50);
  }
  throw new ControllerError('ipc-auth-failed','Unable to initialize IPC.');
}
export function request(secret:string,tool:string,args:Obj={},timeoutMs=45000):Promise<any>{
  return new Promise((resolve,reject)=>{
    const socket=createConnection(PIPE);let buffer='',done=false;
    const finish=(e?:Error,v?:any)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();e?reject(e):resolve(v);};
    const timer=setTimeout(()=>finish(new ControllerError('controller-timeout','Controller request timed out. A submitted DSH task may still run.')),timeoutMs);
    socket.on('connect',()=>socket.write(JSON.stringify({id:randomUUID(),secret,tool,args})+'\n'));
    socket.setEncoding('utf8');socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>16*1024*1024)return finish(new Error('Controller response too large'));const end=buffer.indexOf('\n');if(end<0)return;try{const r=JSON.parse(buffer.slice(0,end));r.ok?finish(undefined,r.value):finish(new ControllerError(r.error.code,r.error.message,r.error.details));}catch(e){finish(e as Error);}});
    socket.on('error',e=>finish(e));socket.on('close',()=>{if(!done)finish(new ControllerError('controller-disconnected','Controller disconnected before returning a response.'));});
  });
}
export async function connectController(){
  const native=new NativeBridge();let secret:string;
  try{secret=await localSecret(native);}finally{native.close();}
  try{await request(secret!,'ping',{},2000);}catch{
    const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',resolve(ROOT,'dist/entrypoints/daemon.js')],{cwd:ROOT,windowsHide:true,detached:true,stdio:'ignore'});child.unref();
    let last:unknown;for(let i=0;i<40;i++){try{await request(secret!,'ping',{},1500);return {call:(tool:string,args:Obj={})=>request(secret!,tool,args)};}catch(e){last=e;await delay(250);}}
    throw new ControllerError('controller-unavailable','Cannot start Controller. Build the project and check .state/daemon.log.',{cause:String(last)});
  }
  return {call:(tool:string,args:Obj={})=>request(secret!,tool,args)};
}
