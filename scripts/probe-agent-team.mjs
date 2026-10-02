// Offline checks of the exact published Agent Teams packages. No model or user profile is started.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { version, installedPackages } from './dsh-paths.mjs';
const audit = resolve('.state/team-package-audit');
const packages = await installedPackages();
for (const [kind, name] of [['service', 'agent-team'], ['tools', 'tool-agent-team']]) {
  packages.set(`@deepseek-ai/dsh-experimental-${name}`, join(audit, kind, 'package/package.json'));
}
let resolving = false;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier;
    const manifest = packages.get(name);
    if (manifest && !resolving) {
      resolving = true;
      try { return { url: pathToFileURL(createRequire(manifest).resolve(specifier)).href, shortCircuit: true }; }
      finally { resolving = false; }
    }
    return nextResolve(specifier, context);
  },
});

const checks = [];
const check = async (name, operation) => { await operation(); checks.push(name); };
const expected = {
  profile: '1df85943871e0a0e90aee8475b56c31c456bf65d',
  service: '742d186c32337e01cc9194883fb1acbf45b75313',
  tools: 'a189508c65cc026d49c6770d1350511dc5ce2e4b',
};
const stems = { profile: 'agent-team-profile', service: 'agent-team', tools: 'tool-agent-team' };
for (const [kind, hash] of Object.entries(expected)) {
  await check(`published tarball identity: ${kind}`, async () => {
    const bytes = await readFile(join(audit, `deepseek-ai-dsh-experimental-${stems[kind]}-${version}.tgz`));
    assert.equal(createHash('sha1').update(bytes).digest('hex'), hash);
    const manifest = JSON.parse(await readFile(join(audit, kind, 'package/package.json'), 'utf8'));
    assert.equal(manifest.version, version);
  });
}
const service = pathToFileURL(join(audit, 'service/package/lib/types/')).href;
const { TeamJournal } = await import(service + 'journal.js');
const { TeamTaskBoard } = await import(service + 'task-board.js');
const { teamProjectionDefinition: projection } = await import(service + 'projection.js');
let state = projection.init({ id: 'probe-lead' });
const events = [];
let flushes = 0;
const lead = {
  id: 'probe-lead',
  session: {
    append(type, data) {
      const event = { type, data, seq: events.length + 1, time: Date.now() };
      state = projection.apply(state, event);
      assert.equal(state.failure, undefined);
      events.push(event);
    },
  },
};
const membership = { root: lead, id: lead.id, role: 'lead', name: 'lead' };
const ctx = { sessionProjections: { stateOf: () => state }, sessions: { flush: async () => { flushes++; } } };
const journal = new TeamJournal(ctx, () => {});
const board = new TeamTaskBoard(journal, 256);
const initial = await board.create(membership, { subject: 'requirements', description: 'inspect requirements', writeScopes: ['src'] });
const dependent = await board.create(membership, { subject: 'implementation', description: 'implement after requirements', blockedBy: [initial.id], writeScopes: ['src'] });
const update = (task, action, extra = {}) => board.update(lead, membership, { taskId: task.id, expectedRevision: task.revision, action, ...extra });
await check('blocked task cannot be claimed', async () => {
  assert.equal(dependent.ready, false);
  await assert.rejects(update(dependent, 'claim'), { code: 'TEAM_TASK_BLOCKED' });
});
await check('concurrent claims: exactly one succeeds', async () => {
  const results = await Promise.allSettled([update(initial, 'claim'), update(initial, 'claim')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'TEAM_TASK_STALE_REVISION');
});
await check('stale revisions cannot overwrite current task', async () => {
  await assert.rejects(update(initial, 'edit', { subject: 'stale' }), { code: 'TEAM_TASK_STALE_REVISION' });
});
await check('task dependency cycles are rejected', async () => {
  await assert.rejects(update(board.get(membership, initial.id), 'set_dependencies', { blockedBy: [dependent.id] }), { code: 'TEAM_TASK_DEPENDENCY_CYCLE' });
});
await check('completing dependency unblocks next task', async () => {
  await update(board.get(membership, initial.id), 'complete');
  assert.equal(board.get(membership, dependent.id).ready, true);
});
await check('task state replays from log and successful changes flush', async () => {
  let replay = projection.init({ id: lead.id });
  for (const event of events) replay = projection.apply(replay, event);
  assert.deepEqual(replay, state);
  assert.equal(flushes, events.length);
});

const definitions = new Map();
lead.ctx = {
  tools: { register: tool => { definitions.set(tool.name, tool); return () => definitions.delete(tool.name); } },
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 1 },
};
const effects = [];
const toolCtx = {
  agents: { list: () => [lead] },
  agentTeams: { tryMembership: () => membership },
  on: () => () => {},
  effect: setup => { effects.push(setup()); },
};
const tools = await import(pathToFileURL(join(audit, 'tools/package/lib/index.js')).href);
tools.apply(toolCtx, { freshProvider: 'spawn', forkProvider: 'fork' });
await check('published plugin registers nine team tools', async () => {
  assert.deepEqual([...definitions.keys()], ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']);
});
const spawnParameters = definitions.get('spawn_teammate').parameters;
await check('spawn schema has no per-member model selection', async () => {
  assert.deepEqual(Object.keys(spawnParameters.properties), ['name', 'description', 'prompt', 'context']);
});
await check('scoped registrations are removed on plugin disposal', async () => {
  for (const dispose of effects) dispose();
  assert.equal(definitions.size, 0);
});
hook.deregister();
const report = {
  version, checkedAt: new Date().toISOString(), checks,
  spawnParameters, events: events.length, flushes,
  boundary: 'Offline package-code checks with an in-memory host adapter. No real model, mailbox delivery, user-profile install, or GUI acceptance.',
};
await writeFile(join(audit, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
