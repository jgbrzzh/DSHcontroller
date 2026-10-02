import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, STATE, errorOf } from '../common.js';
const client=new Client({name:'dshcontroller-live-check',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:['--disable-warning=ExperimentalWarning',resolve(ROOT,'dist/entrypoints/mcp.js')],cwd:ROOT,stderr:'pipe'});
const report:Record<string,any>={checkedAt:new Date().toISOString(),checks:[],taskRequested:process.argv.includes('--task')};
async function call(name:string,args:Record<string,any>={}){
  const result=await client.callTool({name,arguments:args});const block=(result.content as any[]).find(v=>v.type==='text');const value=JSON.parse(block.text);
  if(result.isError)throw new Error(`${value.code}: ${value.message}`);
  return value;
}
try{
  await client.connect(transport);report.checks.push({name:'MCP initialize',passed:true});
  const toolList=await client.listTools();report.toolCount=toolList.tools.length;report.checks.push({name:'MCP listTools',passed:true});
  const instances=(await call('dsh_discover')).instances;if(!instances.length)throw new Error('No running DSH instance');
  const instance=instances.find((i:any)=>i.version==='0.1.7-rc.2')??instances[0];const instanceId=instance.instanceId;report.instance={instanceId,version:instance.version,baseUrl:instance.baseUrl};
  const attached=await call('dsh_attach',{instanceId});report.capabilities=attached.capabilities;report.checks.push({name:'Authenticated attach',passed:true});
  const list=await call('dsh_sessions_list',{instanceId,limit:2});report.sessionCount=list.total;report.checks.push({name:'Session listing',passed:Array.isArray(list.items)});
  const settings=await call('dsh_settings_get',{instanceId});report.namespaceCount=settings.namespaces.length;report.checks.push({name:'Settings read',passed:true});
  const plugins=await call('dsh_plugins_list',{instanceId});report.bundleCount=plugins.bundles.length;report.checks.push({name:'Plugin read',passed:true});
  const models=await call('dsh_models_list',{instanceId});report.modelCatalogShape=Object.keys(models);report.checks.push({name:'Model read',passed:true});
  if(!process.argv.includes('--skip-ui')){await call('dsh_ui_restore',{instanceId});const snapshot=await call('dsh_ui_snapshot',{instanceId});report.screenshotPath=snapshot.screenshotPath;report.uiNodeCount=snapshot.nodes.length;report.checks.push({name:'Native UI snapshot',passed:snapshot.nodes.length>0});}
  console.log(JSON.stringify({phase:'read-only',...report}));
  if(process.argv.includes('--task')){
    const session=await call('dsh_session_create',{instanceId,cwd:ROOT});const sessionId=session.sessionId;report.testSessionId=sessionId;
    await call('dsh_session_rename',{instanceId,sessionId,title:'DSHcontroller 集成验收'});
    const run=await call('dsh_session_send',{instanceId,sessionId,text:'只回复 DSHCONTROLLER_OK。不要调用任何工具，不要修改任何文件。',mode:'queue',idempotencyKey:`live-check-${sessionId}`});report.testRunId=run.runId;
    console.log(JSON.stringify({phase:'task-submitted',sessionId,runId:run.runId,status:run.status}));
    const end=Date.now()+120000;let current=run;
    while(Date.now()<end&&!['completed','failed','interrupted','blocked','max_tokens'].includes(current.status))current=await call('dsh_run_wait',{runId:run.runId,revision:current.revision,timeoutMs:15000});
    report.run={status:current.status,observation:current.observation,turn:current.turn,userSeq:current.userSeq,output:current.output,error:current.error};report.checks.push({name:'Fresh task completion',passed:current.status==='completed'});
    const same=await call('dsh_session_send',{instanceId,sessionId,text:'只回复 DSHCONTROLLER_OK。不要调用任何工具，不要修改任何文件。',mode:'queue',idempotencyKey:`live-check-${sessionId}`});report.checks.push({name:'Idempotent retry',passed:same.runId===run.runId});
    if(current.status!=='completed')process.exitCode=1;
  }
}catch(e){report.error=errorOf(e);process.exitCode=1;}finally{
  await client.close();await mkdir(STATE,{recursive:true});await writeFile(resolve(STATE,'live-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
