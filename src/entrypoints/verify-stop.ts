import { connectController } from '../ipc.js';
import { STATE, errorOf } from '../common.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const sessionId=process.argv[2];if(!sessionId)throw new Error('Pass a dedicated test sessionId.');
const report:Record<string,any>={checkedAt:new Date().toISOString(),sessionId};
try{
  const c=await connectController();const instance=(await c.call('dsh_discover')).instances.find((i:any)=>i.version==='0.1.7-rc.2');const instanceId=instance.instanceId;
  const run=await c.call('dsh_session_send',{instanceId,sessionId,text:'请在回复中从1连续数到10000，每个数字单独一行。不要调用工具，不要修改文件。',mode:'queue',idempotencyKey:`stop-check-${Date.now()}`});report.runId=run.runId;
  report.stopReceipt=await c.call('dsh_session_stop',{instanceId,sessionId});
  let current=run;for(let count=0;count<4&&!['completed','failed','interrupted'].includes(current.status);count++)current=await c.call('dsh_run_wait',{runId:run.runId,revision:current.revision,timeoutMs:15000});
  report.status=current.status;report.observation=current.observation;report.passed=current.status==='interrupted';if(!report.passed)process.exitCode=1;
}catch(e){report.error=errorOf(e);process.exitCode=1;}finally{await writeFile(resolve(STATE,'stop-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
