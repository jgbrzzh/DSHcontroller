import { z } from 'zod';
const id=z.string().min(1).max(200), instance={instanceId:id}, session={...instance,sessionId:id};
const parent={...instance,parentSessionId:id}, child={...parent,childSessionId:id};
const text=z.string().trim().min(1).max(100000);
const definitions={
  dsh_discover:{description:'发现本机运行中的 DSH 与 DSHL 原生窗口，不启动或停止实例。',schema:z.object({})},
  dsh_attach:{description:'认证并接入现有 DSH，报告实际可用能力。先用 dsh_discover 获取 instanceId。',schema:z.object(instance)},
  dsh_status:{description:'读取运行会话、连接身份及 Controller 任务。',schema:z.object(instance)},
  dsh_sessions_list:{description:'列出现有会话或按文字搜索。DSH 内容索引禁用时降级为标题搜索，并返回 searchMode:title-fallback。返回有限结果和 nextOffset。',schema:z.object({...instance,query:z.string().max(500).optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(25)})},
  dsh_session_create:{description:'在现有 DSH 创建新会话，保留其他会话。返回 sessionId。可显式选择 provider/model；省略时沿用 DSH 默认模型。',schema:z.object({...instance,cwd:z.string().min(1),agentPreset:id.optional(),provider:id.optional(),model:id.optional(),reasoningEffort:id.optional()})},
  dsh_session_read:{description:'读取当前会话消息窗口、持久事件游标及投影。只读但 DSH follow 可能激活冷会话。',schema:z.object({...session,maxMessages:z.number().int().min(1).max(200).default(20),beforeSeq:z.number().int().min(0).optional(),throughSeq:z.number().int().min(0).optional(),address:z.object({kind:z.literal('subagent'),parentSessionId:id,childSessionId:id,mode:z.enum(['one-shot','continuable','unknown'])}).optional()})},
  dsh_session_fork:{description:'按 DSH 原有语义分叉会话，保留来源历史。',schema:z.object({...session,atSeq:z.number().int().min(0).optional()})},
  dsh_session_rename:{description:'修改会话标题。',schema:z.object({...session,title:z.string().min(1).max(500)})},
  dsh_session_send:{description:'给明确指定会话发送消息；queue 排队，steer 引导执行。返回 runId，accepted 不代表任务完成。重试请复用 idempotencyKey，不要另发同一任务。',schema:z.object({...session,text,mode:z.enum(['queue','steer']).default('queue'),idempotencyKey:id.optional()})},
  dsh_session_stop:{description:'请求取消当前执行。返回 accepted 只表示受理；通过 run_get 或 session_read 验证停止。',schema:z.object(session)},
  dsh_run_get:{description:'查询本次发送关联的任务结果；输出不会取自无关的旧轮次。',schema:z.object({runId:id})},
  dsh_run_wait:{description:'等待任务完成或 revision 增长，最长 25 秒。断线不会取消 DSH 任务。',schema:z.object({runId:id,revision:z.number().int().optional(),timeoutMs:z.number().int().min(0).max(25000).default(25000)})},
  dsh_subagents_list:{description:'读取指定父会话的子代理投影。',schema:z.object(parent)},
  dsh_subagent_send:{description:'给持续型子代理发送消息，需要正确父子身份。一次性子代理不支持此操作。',schema:z.object({...child,text,mode:z.enum(['queue','steer']).default('queue')})},
  dsh_subagent_stop:{description:'请求中断持续型子代理。',schema:z.object(child)},
  dsh_models_list:{description:'读取当前 DSH 模型路由与推理能力。',schema:z.object(instance)},
  dsh_model_select:{description:'切换指定会话的模型；不改所有会话的默认配置。',schema:z.object({...session,provider:id,model:id,reasoningEffort:id.optional()})},
  dsh_settings_get:{description:'读取命名空间、revision 与脱敏设置，不返回凭据值。可指定 namespace；默认省略大型 schema，includeSchema 可获取字段描述。',schema:z.object({...instance,namespace:id.optional(),includeSchema:z.boolean().default(false)})},
  dsh_settings_update:{description:'局部修改普通设置，使用 revision 并保存 DPAPI 加密的回滚前值。密钥通过 DSH 界面设置。',schema:z.object({...instance,namespace:id,patch:z.record(z.string(),z.json()),expectedRevision:z.number().int().optional()})},
  dsh_change_rollback:{description:'在 revision 未被并发修改时回滚本次设置变更。',schema:z.object({...instance,changeId:id})},
  dsh_plugins_list:{description:'查询安装、配置及实际运行的插件。',schema:z.object(instance)},
  dsh_plugin_change:{description:'使用 DSH 插件管理器安装、移除、启用或停用明确的 Bundle/Plugin。保留其生效结果；restart-required 不是运行已生效。',schema:z.object({...instance,action:z.enum(['install','remove','enable_bundle','disable_bundle','enable_plugin','disable_plugin']),target:id})},
  dsh_plugin_install_wait:{description:'读取插件安装任务的结果。',schema:z.object({...instance,requestId:id})},
  dsh_instance_restart:{description:'检查重启条件。当前 DSHL 没有已核实的程序重启入口，本版报告原因并保留实例，不杀进程。',schema:z.object(instance)},
  dsh_ui_restore:{description:'恢复已绑定的 DSHL 最小化窗口，以便控件读取与截图。',schema:z.object(instance)},
  dsh_ui_open:{description:'在原生窗口打开设置菜单、插件页、搜索，或按唯一标题搜索并打开会话。会话标题重名时报告歧义。操作后必须 snapshot 验证。',schema:z.object({...instance,panel:z.enum(['settings','plugins','search','session']),sessionId:id.optional()})},
  dsh_ui_snapshot:{description:'读取原生窗口可访问控件和 PNG 截图，返回 snapshotId、nodeId 与窗口内坐标。保留截图用于后续动作验证。',schema:z.object(instance)},
  dsh_ui_action:{description:'操作已绑定原生窗口。click 优先 nodeId，fill 需要 nodeId；type/press/scroll 或坐标 click 必须使用内容未变化的截图。动作后再 snapshot 验证。快照最长 90 秒且只可用一次。',schema:z.object({...instance,snapshotId:id,action:z.enum(['click','fill','type','press','scroll']),nodeId:id.optional(),text:z.string().max(100000).optional(),x:z.number().int().min(0).optional(),y:z.number().int().min(0).optional(),key:z.enum(['ENTER','TAB','ESCAPE','UP','DOWN','LEFT','RIGHT','HOME','END','BACKSPACE','DELETE','CTRL+A']).optional(),delta:z.number().int().min(-2400).max(2400).optional()})}
};
export const tools=definitions;
export function validate(name:string,args:unknown) {
  const tool=tools[name as keyof typeof tools];if(!tool)throw new Error('Unknown tool');
  const result=tool.schema.parse(args) as Record<string,any>;
  if(name==='dsh_session_create'&&Boolean(result.provider)!==Boolean(result.model))throw new Error('provider and model must be supplied together.');
  if(name==='dsh_ui_open'&&result.panel==='session'&&!result.sessionId)throw new Error('sessionId is required for the session panel.');
  if(name==='dsh_ui_action'){
    if(result.action==='click'&&!result.nodeId&&(result.x===undefined||result.y===undefined))throw new Error('Click requires nodeId or x and y.');
    if(result.action==='fill'&&(!result.nodeId||result.text===undefined))throw new Error('Fill requires nodeId and text.');
    if(result.action==='type'&&result.text===undefined)throw new Error('Type requires text.');
    if(result.action==='press'&&!result.key)throw new Error('Press requires key.');
    if(result.action==='scroll'&&result.delta===undefined)throw new Error('Scroll requires delta.');
  }
  return result;
}
