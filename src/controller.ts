import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Auth } from './auth.js';
import { discover, requireInstance } from './discovery.js';
import { DshWeb } from './dsh-web.js';
import { NativeBridge } from './native.js';
import { Store } from './storage.js';
import { Runs } from './runs.js';
import { checkSettingsPatch, rollbackOps, redactNamespace } from './settings.js';
import { STATE, ControllerError, redact, type Instance, type Obj } from './common.js';
export class Controller {
  readonly native=new NativeBridge(); readonly auth=new Auth(this.native); readonly store=new Store();
  private clients=new Map<string,DshWeb>();private gates=new Map<string,Promise<unknown>>();
  readonly runs=new Runs(this.store,id=>this.client(id));
  async lock<T>(key:string,action:()=>Promise<T>):Promise<T>{const previous=this.gates.get(key)??Promise.resolve();const next=previous.catch(()=>{}).then(action);this.gates.set(key,next);try{return await next;}finally{if(this.gates.get(key)===next)this.gates.delete(key);}}
  async client(id:string) {
    const instance=await requireInstance(id);
    if(instance.version!=='0.1.7-rc.2')throw new ControllerError('unsupported-version','This adapter supports DSH 0.1.7-rc.2 only.');
    let client=this.clients.get(id);
    if(!client){client=new DshWeb(instance.baseUrl,await this.auth.cookie(instance));this.clients.set(id,client);}
    return client;
  }
  async attach(id:string){const instance=await requireInstance(id);let c=await this.client(id);let list:any;
    try{list=await c.rpc('session/list',{_request:{}});}catch(e){if(e instanceof ControllerError&&e.code==='http-401'){this.clients.delete(id);await this.auth.forget(instance);c=await this.client(id);list=await c.rpc('session/list',{_request:{}});}else throw e;}
    const capabilities:Obj={sessions:true,nativeUi:!!instance.window,domUi:false};
    for(const [key,method] of [['settings','settings/describe'],['plugins','pluginInventory/list'],['models','session/modelCatalog']]){try{await c.rpc(method);capabilities[key]=true;}catch(e){capabilities[key]={available:false,error:e instanceof ControllerError?e.code:'unknown'};}}
    this.store.put('instance',id,instance);return {instance,authenticated:true,sessionCount:list.items.length,capabilities};
  }
  async login(id:string,url:string){const cookie=await this.auth.login(await requireInstance(id),url);this.clients.delete(id);return {authenticated:!!cookie};}
  async execute(tool:string,a:Obj):Promise<any> {
    if(tool==='dsh_discover')return discover();
    if(tool==='dsh_attach')return this.attach(a.instanceId);
    if(tool==='dsh_ui_open')return this.openUi(a);
    if(tool==='dsh_ui_restore'){const i=await requireInstance(a.instanceId);if(!i.window)throw new ControllerError('window-unavailable','No bound DSHL window.');return this.lock('ui',()=>this.native.call('restore',{handle:i.window!.handle}));}
    if(tool==='dsh_ui_snapshot'){const i=await requireInstance(a.instanceId);if(!i.window)throw new ControllerError('window-unavailable','No bound DSHL window.');return this.lock('ui',async()=>{const snapshot=await this.native.call('snapshot',{handle:i.window!.handle});const image=Buffer.from(snapshot.imageBase64,'base64');delete snapshot.imageBase64;await mkdir(resolve(STATE,'screenshots'),{recursive:true});snapshot.screenshotPath=resolve(STATE,'screenshots',`${snapshot.snapshotId}.png`);await writeFile(snapshot.screenshotPath,image);this.store.put('snapshot',snapshot.snapshotId,{instanceId:a.instanceId,handle:i.window!.handle});return snapshot;});}
    if(tool==='dsh_ui_action'){const snapshot=this.store.get('snapshot',a.snapshotId);if(!snapshot||snapshot.instanceId!==a.instanceId)throw new ControllerError('snapshot-mismatch','Snapshot does not belong to the selected instance.');const i=await requireInstance(a.instanceId);if(i.window?.handle!==snapshot.handle)throw new ControllerError('window-changed','Window binding changed.');return this.lock('ui',()=>this.native.call('action',a));}
    if(tool==='dsh_run_get')return this.runs.get(a.runId);
    if(tool==='dsh_run_wait')return this.runs.wait(a.runId,a.revision,a.timeoutMs);
    const c=await this.client(a.instanceId);
    switch(tool){
      case 'dsh_status': {const s=await c.rpc('session/list',{_request:{}});return {instance:await requireInstance(a.instanceId),connected:true,totalSessions:s.items.length,runningSessions:s.items.filter((x:Obj)=>x.running).map((x:Obj)=>({sessionId:x.sessionId,cwd:x.cwd})),observedRuns:this.store.list('run').filter(r=>r.instanceId===a.instanceId).slice(-20)};}
      case 'dsh_sessions_list': {let s:any,searchMode='list';if(a.query){try{s=await c.rpc('session/search',{request:{query:a.query}});searchMode='content';}catch(e){if(!(e instanceof ControllerError)||!e.message.includes('session search is disabled'))throw e;const listed=await c.rpc('session/list',{_request:{}});s={items:listed.items.filter((r:Obj)=>typeof r.projections?.values?.title==='string'&&r.projections.values.title.toLocaleLowerCase().includes(a.query.toLocaleLowerCase()))};searchMode='title-fallback';}}else s=await c.rpc('session/list',{_request:{}});const offset=a.offset??0,limit=a.limit??25;return {items:s.items.slice(offset,offset+limit),total:s.items.length,searchMode,hasMore:s.hasMore??false,nextOffset:offset+limit<s.items.length?offset+limit:null};}
      case 'dsh_session_create': {const created=await c.rpc('session/create',{request:{cwd:a.cwd,agentPreset:a.agentPreset}});if(a.provider&&a.model){try{created.selected=(await c.rpc('session/selectModel',{request:{sessionId:created.sessionId,provider:a.provider,model:a.model,reasoningEffort:a.reasoningEffort}})).selected;}catch(e){throw new ControllerError('created-model-failed','Session was created, but model selection failed.',{sessionId:created.sessionId,cause:String(e)});}}return created;}
      case 'dsh_session_fork': return c.rpc('session/fork',{request:{sessionId:a.sessionId,atSeq:a.atSeq}});
      case 'dsh_session_rename': return c.rpc('session/rename',{request:{sessionId:a.sessionId,title:a.title}});
      case 'dsh_session_send': return this.lock(`send:${a.instanceId}:${a.sessionId}`,()=>this.runs.send(a.instanceId,a.sessionId,a.text,a.mode??'queue',a.idempotencyKey));
      case 'dsh_session_stop': return c.rpc('session/cancel',{request:{sessionId:a.sessionId}});
      case 'dsh_session_read': {
        const snapshots:Obj[]=[];const stream=c.follow('session/follow',{request:{address:a.address??{kind:'session',sessionId:a.sessionId},maxMessages:a.maxMessages??20}},v=>snapshots.push(v),()=>{});
        try{await stream.ready;const first=snapshots[0];if(a.beforeSeq!==undefined)return c.rpc('session/page',{request:{address:a.address??{kind:'session',sessionId:a.sessionId},throughSeq:a.throughSeq??first.cursor,beforeSeq:a.beforeSeq,maxMessages:a.maxMessages??20}});return first;}finally{stream.close();}
      }
      case 'dsh_subagents_list': {const p=await c.rpc('session/projections',{request:{sessionId:a.parentSessionId}});return {asOfSeq:p?.asOfSeq,children:p?.values?.subagentCatalog??[],continuableChildren:p?.values?.continuableChildren??null};}
      case 'dsh_subagent_send': return c.rpc('subagents/prompt',{request:{requestId:randomUUID(),parentSessionId:a.parentSessionId,childSessionId:a.childSessionId,mode:'continuable',delivery:a.mode??'queue',content:[{type:'text',text:a.text}],clientTimeZone:'Asia/Shanghai'}});
      case 'dsh_subagent_stop': return c.rpc('subagents/interruptByParent',{childSessionId:a.childSessionId,parentSessionId:a.parentSessionId,mode:'continuable'});
      case 'dsh_models_list': return c.rpc('session/modelCatalog');
      case 'dsh_model_select': return c.rpc('session/selectModel',{request:{sessionId:a.sessionId,provider:a.provider,model:a.model,reasoningEffort:a.reasoningEffort}});
      case 'dsh_settings_get': {const d=await c.rpc('settings/describe');const selected=d.namespaces.filter((n:Obj)=>!a.namespace||n.ns===a.namespace);return redact({...d,namespaces:selected.map((n:Obj)=>{const safe=redactNamespace(n);if(a.includeSchema)return safe;const {schema,base,...view}=safe;return view;})});}
      case 'dsh_settings_update': return this.lock(`settings:${a.instanceId}:${a.namespace}`,()=>this.changeSettings(a,c));
      case 'dsh_change_rollback': return this.rollback(a,c);
      case 'dsh_plugins_list': return {inventory:await c.rpc('pluginInventory/list'),bundles:await c.rpc('pluginManager/listBundles')};
      case 'dsh_plugin_change': return this.lock(`plugins:${a.instanceId}`,async()=>{
        const operations:Obj={install:()=>c.rpc('pluginManager/installBundle',{spec:a.target}),remove:()=>c.rpc('pluginManager/removeBundle',{name:a.target}),enable_bundle:()=>c.rpc('pluginManager/setBundleEnabled',{name:a.target,enabled:true}),disable_bundle:()=>c.rpc('pluginManager/setBundleEnabled',{name:a.target,enabled:false}),enable_plugin:()=>c.rpc('pluginManager/setPluginEnabled',{id:a.target,enabled:true}),disable_plugin:()=>c.rpc('pluginManager/setPluginEnabled',{id:a.target,enabled:false})};
        return operations[a.action]();
      });
      case 'dsh_plugin_install_wait': return c.rpc('pluginManager/waitForInstall',{requestId:a.requestId});
      case 'dsh_instance_restart': {const s=await c.rpc('session/list',{_request:{}});const running=s.items.filter((r:Obj)=>r.running);throw new ControllerError(running.length?'running-tasks':'launcher-restart-unavailable',running.length?'There are running tasks. Stop them explicitly before restarting.':'DSHL has no verified restart interface. Use its restart control; rediscover afterward.',{running:running.map((r:Obj)=>r.sessionId)});}
      default:throw new ControllerError('unknown-tool','Unknown controller tool.');
    }
  }
  private async changeSettings(a:Obj,c:DshWeb) {
    const describe=await c.rpc('settings/describe');const namespaces=describe.namespaces??describe;const ns=Array.isArray(namespaces)?namespaces.find((n:Obj)=>n.namespace===a.namespace||n.ns===a.namespace||n.name===a.namespace):namespaces[a.namespace];
    if(!ns)throw new ControllerError('namespace-not-found','Unknown settings namespace.');
    const revision=ns.revision; if(a.expectedRevision!==undefined&&a.expectedRevision!==revision)throw new ControllerError('revision-conflict','Settings changed since they were read.');
    checkSettingsPatch(a.patch,ns.secrets??[]);
    const before=ns.user??{};
    if(!before||typeof revision!=='number')throw new ControllerError('settings-shape-unsupported','Settings shape needs a matching adapter; no write performed.');
    const changeId=randomUUID();const protectedValue=await this.native.call('protect',{text:JSON.stringify({before,patch:a.patch})});
    this.store.put('change',changeId,{instanceId:a.instanceId,namespace:a.namespace,backup:protectedValue.data,revision,status:'prepared'});
    const result=await c.rpc('settings/update',{ns:a.namespace,patch:a.patch,expectedRevision:revision});
    const safe=redact(redactNamespace({...result,secrets:result.secrets??ns.secrets??[]}));
    this.store.put('change',changeId,{instanceId:a.instanceId,namespace:a.namespace,backup:protectedValue.data,revision,status:'applied',result:safe});
    return {changeId,result:safe};
  }
  private async openUi(a:Obj){
    const i=await requireInstance(a.instanceId);if(!i.window)throw new ControllerError('window-unavailable','No bound DSHL window.');
    const handle=i.window.handle;
    return this.lock('ui',async()=>{
      let title:string|undefined;
      if(a.panel==='session'){
        const c=await this.client(a.instanceId);const p=await c.rpc('session/projections',{request:{sessionId:a.sessionId}});title=p?.values?.title;
        if(!title)throw new ControllerError('ui-session-title-unavailable','Session has no known title. Use UI snapshot and search manually.');
        const listed=await c.rpc('session/list',{_request:{}});
        const matching=listed.items.filter((r:Obj)=>typeof r.projections?.values?.title==='string'&&r.projections.values.title.toLocaleLowerCase().includes(title!.toLocaleLowerCase()));
        if(matching.length!==1||matching[0].sessionId!==a.sessionId)throw new ControllerError('ui-session-ambiguous','The session title does not identify one search result; no UI action performed.',{title,matchCount:matching.length});
      }
      const snapshot=await this.native.call('snapshot',{handle});
      const names:Obj={settings:'设置',plugins:'插件',search:'搜索会话'};
      const name=a.panel==='session'?'搜索会话':names[a.panel];
      const node=snapshot.nodes.find((n:Obj)=>n.name===name&&n.type==='Button'&&!n.offscreen);
      if(!node)throw new ControllerError('ui-target-unavailable',`Cannot locate ${name}. Take a snapshot and use a visible control.`);
      await this.native.call('action',{snapshotId:snapshot.snapshotId,nodeId:node.id,action:node.patterns.some((p:string)=>p.includes('ExpandCollapse'))?'expand':'click'});
      if(a.panel==='session'){
        await new Promise(r=>setTimeout(r,250));
        const search=await this.native.call('snapshot',{handle});const edit=search.nodes.find((n:Obj)=>n.type==='Edit'&&n.name==='搜索会话名称'&&!n.offscreen);
        if(!edit)throw new ControllerError('ui-search-unavailable','Search input is not visible.');
        await this.native.call('action',{snapshotId:search.snapshotId,nodeId:edit.id,action:'fill',text:title});await new Promise(r=>setTimeout(r,700));
        const results=await this.native.call('snapshot',{handle});
        // DSH prefixes accessible row names with task status and appends workspace/time labels.
        const matches=results.nodes.filter((n:Obj)=>['TreeItem','ListItem'].includes(n.type)&&!n.offscreen&&n.name.includes(title!));
        if(matches.length!==1)throw new ControllerError('ui-session-ambiguous','Search did not return one uniquely identifiable session; select it manually.',{title,matchCount:matches.length});
        await this.native.call('action',{snapshotId:results.snapshotId,nodeId:matches[0].id,action:'click'});
      }
      return {performed:true,verified:false,panel:a.panel,next:'Use dsh_ui_snapshot to verify the panel or selected session.'};
    });
  }
  private async rollback(a:Obj,c:DshWeb) {
    const change=this.store.get('change',a.changeId);if(!change||change.instanceId!==a.instanceId||change.status!=='applied')throw new ControllerError('change-not-found','No applied change to roll back.');
    return this.lock(`settings:${a.instanceId}:${change.namespace}`,async()=>{
      const {text}=await this.native.call('unprotect',{data:change.backup});const {before,patch}=JSON.parse(text);
      const current=change.result;const ops=rollbackOps(patch,before);
      // Compare the document revision returned by the write; reject concurrent edits.
      if(typeof current.revision!=='number')throw new ControllerError('rollback-unavailable','Write result has no revision; cannot safely roll back.');
      const result=await c.rpc('settings/mutate',{ns:change.namespace,ops,expectedRevision:current.revision});change.status='rolled-back';this.store.put('change',a.changeId,change);return redact(redactNamespace({...result,secrets:result.secrets??current.secrets??[]}));
    });
  }
  close(){this.runs.close();this.native.close();this.store.close();}
}
