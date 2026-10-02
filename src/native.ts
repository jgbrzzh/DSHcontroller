import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ROOT, ControllerError, type Obj } from './common.js';
export class NativeBridge {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private start() {
    if(this.child) return;
    const portable = resolve(ROOT,'native/DshUiBridge/portable/DshUiBridge.exe');
    const child = existsSync(portable)
      ? spawn(portable,[],{windowsHide:true,stdio:'pipe'})
      : spawn('dotnet',[resolve(ROOT,'native/DshUiBridge/bin/Release/net8.0-windows/DshUiBridge.dll')],{windowsHide:true,stdio:'pipe'});
    this.child=child;
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=> { try { const r=JSON.parse(line), p=this.pending.get(r.id); if(!p)return; this.pending.delete(r.id); clearTimeout(p.timer); r.ok ? p.resolve(r.value) : p.reject(new ControllerError(r.error.code,r.error.message)); } catch { /* Non-protocol output cannot satisfy a request. */ } });
    child.stderr.resume();
    const fail=()=>{ for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new ControllerError('native-unavailable','Native helper exited. Re-extract the complete portable package, or build the source checkout.'));}this.pending.clear();this.child=undefined;};
    child.on('error',fail); child.on('exit',fail);
  }
  call(method:string,args:Obj={}):Promise<any> {
    this.start();const id=randomUUID();
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new ControllerError('native-timeout','Native UI helper did not respond.'));this.child?.kill();},20000);this.pending.set(id,{resolve,reject,timer});this.child!.stdin.write(JSON.stringify({id,method,args})+'\n');});
  }
  close(){this.child?.kill();}
}
