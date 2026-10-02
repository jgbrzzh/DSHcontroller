import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { STATE, ControllerError, assertLocalUrl, type Instance } from './common.js';
import { NativeBridge } from './native.js';
export class Auth {
  constructor(private native:NativeBridge) {}
  private file(instance:Instance){return resolve(STATE,`auth-${instance.instanceId}.dpapi`);}
  async cookie(instance:Instance):Promise<string> {
    try {const data=await readFile(this.file(instance),'utf8');const result=await this.native.call('unprotect',{data});return result.text;}catch{}
    if(!instance.window?.path)throw new ControllerError('authentication-required','Cannot identify DSHL logs for this instance. Use the local CLI login command.');
    const directory=resolve(instance.window.path,'..','DSHL');
    const names=(await readdir(directory)).filter(n=>/^Log[1-5]\.txt$/.test(n)).sort();
    const candidates:string[]=[];
    for(const name of names){const content=(await readFile(resolve(directory,name),'utf8')).slice(-2*1024*1024);const found=content.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/?\?token=[A-Za-z0-9_-]+/g)??[];for(const value of found.reverse()){const u=new URL(value);if(u.origin===instance.baseUrl)candidates.push(value);}}
    for(const url of [...new Set(candidates)].slice(0,12)){try{return await this.login(instance,url);}catch{}}
    throw new ControllerError('authentication-required','No valid launch URL was found for this instance. Run the local CLI login command with DSH_LOGIN_URL in your environment.');
  }
  async login(instance:Instance,value:string) {
    const url=assertLocalUrl(value);
    if(url.origin!==instance.baseUrl||url.pathname!=='/'||!url.searchParams.get('token'))throw new ControllerError('invalid-login','Login URL does not match the selected DSH instance.');
    const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(4000)});
    const cookies=response.headers.getSetCookie();
    if(response.status!==303||cookies.length===0)throw new ControllerError('authentication-required','DSH launch URL is expired or invalid.');
    const cookie=cookies.map(c=>c.split(';',1)[0]).join('; ');
    await mkdir(STATE,{recursive:true});const protectedValue=await this.native.call('protect',{text:cookie});await writeFile(this.file(instance),protectedValue.data,{mode:0o600});
    return cookie;
  }
  async forget(instance:Instance) {await writeFile(this.file(instance),'',{mode:0o600});}
}
