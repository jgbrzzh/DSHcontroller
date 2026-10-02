import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ROOT, type Instance, ControllerError } from './common.js';
const exec=promisify(execFile);
export async function discover():Promise<{instances:Instance[];windows:any[]}> {
  const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve(ROOT,'scripts/discover.ps1')],{windowsHide:true,timeout:15000,maxBuffer:1024*1024,encoding:'utf8'});
  const found=JSON.parse(stdout.replace(/^\uFEFF/,''));
  found.instances=found.instances.map((i:Instance)=>({...i,instanceId:createHash('sha256').update(`${i.pid}/${i.startedAt}/${i.baseUrl}`).digest('hex').slice(0,20)}));
  return found;
}
export async function requireInstance(id:string) { const i=(await discover()).instances.find(i=>i.instanceId===id);if(!i)throw new ControllerError('instance-changed','Instance is gone or was restarted. Discover and attach again.');return i; }
