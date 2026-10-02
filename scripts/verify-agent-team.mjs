// Real-instance acceptance, explicitly invoked; uses a dedicated session and model requests.
import { connectController } from '../dist/ipc.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const dir = resolve('.state/team-package-audit');
await mkdir(dir, { recursive: true });
const reportPath = resolve(dir, 'live-report.json');
const c = await connectController();
const phase = process.argv[2] ?? 'inspect';
const instances = (await c.call('dsh_discover')).instances;
const instance = instances.find(i => i.version === '0.1.7-rc.2');
if (!instance) throw new Error('DSH 0.1.7-rc.2 is not running');
const instanceId = instance.instanceId;
let report;
try { report = JSON.parse(await readFile(reportPath, 'utf8')); } catch { report = {}; }
report.instance = { instanceId, version: instance.version, profile: instance.profile };
report.checkedAt = new Date().toISOString();
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
const inventory = await c.call('dsh_plugins_list', { instanceId });
report.plugins = inventory.inventory.entries.filter(e => /agent-team/.test(e.moduleName));
report.bundle = inventory.bundles.filter(b => /agent-team-profile/.test(b.name)).map(({ name, version, enabled }) => ({ name, version, enabled }));
const active = report.plugins.some(e => e.moduleName === '@deepseek-ai/dsh-experimental-agent-team' && e.enabled && e.fiberPhase === 'active');
if (phase === 'inspect') {
  await save();
  console.log(JSON.stringify({ active, plugins: report.plugins, bundle: report.bundle }, null, 2));
} else if (phase === 'send') {
  if (!active) throw new Error('The Team service is not active. Restart/reconcile the profile first.');
  if (report.runId) throw new Error('A probe was already submitted. Use observe; do not duplicate model work.');
  report.sessionId ??= process.argv[3];
  if (!report.sessionId && (!process.env.DSH_TEST_PROVIDER || !process.env.DSH_TEST_MODEL)) throw new Error('Set DSH_TEST_PROVIDER and DSH_TEST_MODEL, or supply a dedicated session ID.');
  const session = report.sessionId
    ? { sessionId: report.sessionId }
    : await c.call('dsh_session_create', { instanceId, cwd: resolve('.'), provider: process.env.DSH_TEST_PROVIDER, model: process.env.DSH_TEST_MODEL, reasoningEffort: process.env.DSH_TEST_REASONING ?? 'max' });
  report.sessionId = session.sessionId;
  await c.call('dsh_session_rename', { instanceId, sessionId: report.sessionId, title: '官方智能体团队验收 ' + new Date().toISOString().slice(0, 10) });
  report.key ??= 'official-team-probe-' + randomUUID();
  await save();
  const run = await c.call('dsh_session_send', {
    instanceId, sessionId: report.sessionId, mode: 'queue', idempotencyKey: report.key,
    text: `这是经用户授权的官方 Agent Teams 功能验收。只使用团队工具，不读写任何文件、不执行 shell、不使用 workflow、不创建超过两个队友。保持所有回复简短。
目标：真实创建 alpha、beta 两个队友，alpha 和 beta 互发消息，并使用带依赖的共享任务板，最后由 lead 汇总。
1. team_task_create 创建任务 A（标题 PROBE_TASK_ALPHA），再创建依赖 A 的任务 B（标题 PROBE_TASK_BETA）。记住实际任务 ID。
2. spawn_teammate 首先创建 beta（context:fresh）：告诉它两项实际任务 ID，先用 list_agents 检查身份，向 lead 发一次 BETA_READY 然后结束当前回合。收到 alpha 的 PROBE_ALPHA_TO_BETA 后，读取任务 B 最新 revision，claim B、complete B；向 alpha 发送 PROBE_BETA_TO_ALPHA，并向 lead 发送 BETA_TASK_DONE。不要重复发 READY，不要重复处理相同测试消息。
3. spawn_teammate 创建 alpha（context:fresh）：告诉它实际任务 ID，list_agents 找到 beta，读取 A 最新 revision，claim A、complete A，然后 send_message 给 beta：PROBE_ALPHA_TO_BETA。收到 beta 的 PROBE_BETA_TO_ALPHA 后，向 lead 发送 ALPHA_ACK_BETA。不要重复处理测试消息。
4. 你作为 lead 用 list_agents、team_task_list/get 核对两个任务都是 completed。必要时 wait_agent 等待协作消息，但不要一直轮询；总计至多等待两分钟。
只有看到 BETA_TASK_DONE 与 ALPHA_ACK_BETA 并且两个任务 completed，才最终回复 DSH_AGENT_TEAM_OK，附成员名字和任务 ID。任何缺失都如实报告，不要虚构成功。队友回执可能触发后续回合，必要时在后续回合完成汇总。`,
  });
  report.runId = run.runId;
  report.run = run;
  await save();
  console.log(JSON.stringify({ sessionId: report.sessionId, runId: report.runId, status: run.status }));
} else if (phase === 'observe') {
  if (!report.sessionId) throw new Error('No probe session recorded');
  report.run = report.runId ? await c.call('dsh_run_wait', { runId: report.runId, revision: report.run?.revision, timeoutMs: 20000 }) : undefined;
  const view = await c.call('dsh_session_read', { instanceId, sessionId: report.sessionId, maxMessages: 100 });
  report.view = view;
  const events = view.records?.filter(r => r.type === 'event').map(r => r.event) ?? [];
  const team = view.projections?.values?.agentTeam;
  const errors = events.filter(e => e.type === 'tool/result' && e.data?.message?.isError || e.type === 'turn/end' && e.data?.reason?.kind !== 'completed');
  const checks = [];
  const check = (name, test) => { test(); checks.push(name); };
  report.childViews = {};
  if (team?.tasks?.length === 2 && team.tasks.every(t => t.status === 'completed') && report.run?.status === 'completed') {
    check('both named teammates created', () => assert.deepEqual(team.members.map(m => m.name).sort(), ['alpha', 'beta', 'lead']));
    check('dependent task completed after prerequisite', () => {
      const completed = events.find(e => e.type === 'team/task' && e.data.task.id === 'task-1' && e.data.task.status === 'completed');
      const claimed = events.find(e => e.type === 'team/task' && e.data.task.id === 'task-2' && e.data.task.status === 'in_progress');
      assert.ok(completed && claimed && completed.seq < claimed.seq);
      assert.deepEqual(team.tasks.find(t => t.id === 'task-2').blockedBy, ['task-1']);
      assert.deepEqual(team.tasks.map(t => [t.ownerName, t.revision]), [['alpha', 3], ['beta', 3]]);
    });
    const queued = events.filter(e => e.type === 'team/message/queued');
    check('five unique mailbox messages acknowledged', () => {
      assert.equal(queued.length, 5);
      assert.equal(new Set(queued.map(e => e.data.message.id)).size, 5);
      for (const event of queued) assert.equal(events.filter(e => e.type === 'team/message/delivered' && e.data.messageId === event.data.message.id).length, 1);
    });
    for (const name of ['alpha', 'beta']) {
      const member = team.members.find(m => m.name === name);
      const child = await c.call('dsh_session_read', {
        instanceId, sessionId: member.id, maxMessages: 100,
        address: { kind: 'subagent', parentSessionId: report.sessionId, childSessionId: member.id, mode: 'continuable' },
      });
      report.childViews[name] = child;
      const childEvents = child.records?.filter(r => r.type === 'event').map(r => r.event) ?? [];
      const incoming = queued.filter(e => e.data.message.targetId === member.id);
      check(`${name} durably consumed its peer message once`, () => {
        assert.equal(incoming.length, 1);
        const id = incoming[0].data.message.id;
        assert.equal(childEvents.filter(e => e.type === 'user/message' && e.data.source?.kind === 'team-message' && e.data.source.messageId === id).length, 1);
        assert.equal(childEvents.filter(e => e.type === 'turn/end').at(-1)?.data.reason.kind, 'completed');
      });
    }
    check('lead consumed both completion reports', () => {
      for (const token of ['BETA_TASK_DONE', 'ALPHA_ACK_BETA']) {
        assert.equal(events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'team-message' && JSON.stringify(e.data.content).includes(token)).length, 1);
      }
    });
    check('lead returned success with no failed tools', () => {
      assert.equal(errors.length, 0);
      assert.ok(events.some(e => e.type === 'assistant/message' && e.data.message.content.some(b => b.type === 'text' && b.text.includes('DSH_AGENT_TEAM_OK'))));
    });
    report.passed = true;
  } else report.passed = false;
  report.checks = checks;
  await save();
  console.log(JSON.stringify({
    passed: report.passed, checks, status: report.run?.status, cursor: view.cursor, team,
    errors,
    latestReplies: events.filter(e => e.type === 'assistant/message').slice(-2).map(e => ({ seq: e.seq, text: e.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') })),
  }, null, 2));
} else if (phase === 'gui') {
  await c.call('dsh_ui_restore', { instanceId });
  await c.call('dsh_ui_open', { instanceId, panel: 'session', sessionId: report.sessionId });
  let snapshot = await c.call('dsh_ui_snapshot', { instanceId });
  if (!snapshot.nodes.some(n => !n.offscreen && n.name === '成员 3')) {
    const button = snapshot.nodes.find(n => !n.offscreen && n.type === 'Button' && n.name === '智能体团队');
    assert.ok(button, 'The selected session has no Team panel button');
    await c.call('dsh_ui_action', { instanceId, snapshotId: snapshot.snapshotId, action: 'click', nodeId: button.id });
    snapshot = await c.call('dsh_ui_snapshot', { instanceId });
  }
  const visible = snapshot.nodes.filter(n => !n.offscreen);
  assert.ok(visible.some(n => n.name === '成员 3'));
  assert.ok(visible.some(n => n.name === '共享任务 2'));
  assert.ok(visible.filter(n => n.name === '已完成').length >= 2);
  for (const title of ['PROBE_TASK_ALPHA', 'PROBE_TASK_BETA']) assert.ok(visible.some(n => n.name === title));
  report.gui = { checkedAt: new Date().toISOString(), screenshotPath: snapshot.screenshotPath, snapshotId: snapshot.snapshotId, members: 3, completedTasks: 2 };
  await save();
  console.log(JSON.stringify(report.gui, null, 2));
} else throw new Error('Use inspect, send, observe, or gui');
