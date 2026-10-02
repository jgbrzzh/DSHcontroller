import { connectController } from '../ipc.js';
import { STATE, errorOf, delay } from '../common.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const sessionId=process.argv[2];if(!sessionId)throw new Error('Pass a dedicated test sessionId.');
const report:Record<string,any>={checkedAt:new Date().toISOString(),sessionId};
try{
  const c=await connectController();const i=(await c.call('dsh_discover')).instances.find((v:any)=>v.version==='0.1.7-rc.2');if(!i)throw new Error('No supported DSH instance.');
  await c.call('dsh_ui_restore',{instanceId:i.instanceId});
  report.action=await c.call('dsh_ui_open',{instanceId:i.instanceId,panel:'session',sessionId});await delay(500);
  const snapshot=await c.call('dsh_ui_snapshot',{instanceId:i.instanceId});report.screenshotPath=snapshot.screenshotPath;report.documentNames=snapshot.nodes.filter((n:any)=>n.type==='Document').map((n:any)=>n.name);report.uiNodeCount=snapshot.nodes.length;
  // This report confirms the action and observation; inspect its screenshot to verify the intended session.
  report.performed=report.action.performed;report.needsVisualVerification=true;
}catch(e){report.error=errorOf(e);process.exitCode=1;}finally{await writeFile(resolve(STATE,'ui-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
