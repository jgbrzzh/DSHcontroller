import { createServer } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Controller } from '../controller.js';
import { localSecret } from '../ipc.js';
import { validate } from '../tools.js';
import { PIPE, STATE, errorOf, redact, type Obj } from '../common.js';
mkdirSync(STATE,{recursive:true});
const c=new Controller();const secret=await localSecret(c.native);
function validToken(s:unknown){if(typeof s!=='string')return false;const a=Buffer.from(s),b=Buffer.from(secret);return a.length===b.length&&timingSafeEqual(a,b);}
const server=createServer(socket=>{
  let buffer='',used=false;socket.setEncoding('utf8');socket.setTimeout(60000,()=>socket.destroy());socket.on('error',()=>{});
  socket.on('data',chunk=>{if(used)return;buffer+=chunk;if(buffer.length>1024*1024){socket.destroy();return;}const index=buffer.indexOf('\n');if(index<0)return;used=true;
    void (async()=>{let id:string|undefined;try{
      const r=JSON.parse(buffer.slice(0,index)) as Obj;id=r.id;
      if(!validToken(r.secret))throw new Error('IPC authentication failed');
      let value:any;
      if(r.tool==='ping')value={version:'0.1.0',pid:process.pid};
      else if(r.tool==='shutdown'){value={stopped:true};setTimeout(()=>{server.close();c.close();process.exit(0);},100);}
      else if(r.tool==='login')value=await c.login(r.args.instanceId,r.args.url);
      else value=await c.execute(r.tool,validate(r.tool,r.args));
      socket.end(JSON.stringify({id,ok:true,value:redact(value)})+'\n');
    }catch(e){socket.end(JSON.stringify({id,ok:false,error:errorOf(e)})+'\n');}})();
  });
});
server.on('error',e=>{c.close();if((e as NodeJS.ErrnoException).code!=='EADDRINUSE')appendFileSync(resolve(STATE,'daemon.log'),JSON.stringify(errorOf(e))+'\n');process.exit(1);});
server.listen(PIPE);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{server.close();c.close();process.exit(0);});
process.on('uncaughtException',e=>{appendFileSync(resolve(STATE,'daemon.log'),JSON.stringify(errorOf(e))+'\n');c.close();process.exit(1);});
