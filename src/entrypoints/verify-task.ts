import { connectController } from '../ipc.js';
import { ROOT, STATE, errorOf } from '../common.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const args=new Map(process.argv.slice(2).map(v=>{const at=v.indexOf('=');return [v.slice(0,at),v.slice(at+1)];}));
const report:Record<string,any>={checkedAt:new Date().toISOString()};
try{
  const c=await connectController();const i=(await c.call('dsh_discover')).instances.find((v:any)=>v.version==='0.1.7-rc.2');if(!i)throw new Error('DSH 0.1.7-rc.2 is not running.');
  const instanceId=i.instanceId;const sessionId=args.get('--session')??(await c.call('dsh_session_create',{instanceId,cwd:ROOT})).sessionId;report.sessionId=sessionId;
  if(args.has('--provider'))report.model=await c.call('dsh_model_select',{instanceId,sessionId,provider:args.get('--provider'),model:args.get('--model'),reasoningEffort:args.get('--reasoning')});
  const key=`task-check-${Date.now()}`;const input={instanceId,sessionId,text:'只回复 DSHCONTROLLER_OK。不要调用任何工具，不要修改任何文件。',mode:'queue',idempotencyKey:key};
  const r=await c.call('dsh_session_send',input);console.log(JSON.stringify({phase:'submitted',runId:r.runId,sessionId}));let current=r;
  const until=Date.now()+120000;while(Date.now()<until&&!['completed','failed','interrupted','blocked','max_tokens'].includes(current.status)){current=await c.call('dsh_run_wait',{runId:r.runId,revision:current.revision,timeoutMs:15000});console.log(JSON.stringify({phase:'observed',status:current.status,observation:current.observation}));}
  report.run=current;report.idempotent=(await c.call('dsh_session_send',input)).runId===r.runId;report.passed=current.status==='completed'&&JSON.stringify(current.output).includes('DSHCONTROLLER_OK')&&report.idempotent;
  if(!report.passed)process.exitCode=1;
}catch(e){report.error=errorOf(e);process.exitCode=1;}finally{await mkdir(STATE,{recursive:true});await writeFile(resolve(STATE,'task-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
