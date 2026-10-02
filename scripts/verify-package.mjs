// Exercise the actual portable Node, native helper and MCP over stdio, without dev tools.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(process.argv[2] ?? '.');
const runtime = JSON.parse(await readFile(join(root, 'native/DshUiBridge/portable/DshUiBridge.runtimeconfig.json'), 'utf8')).runtimeOptions;
assert.ok(runtime.includedFrameworks?.some(framework => framework.name === 'Microsoft.WindowsDesktop.App'));
assert.equal(runtime.framework, undefined);
assert.equal(runtime.frameworks, undefined);
const windows = process.env.SystemRoot ?? 'C:\\Windows';
// Deliberately exclude installed Node, npm and dotnet from PATH.
const env = { ...process.env, PATH: [windows, join(windows, 'System32'), join(windows, 'System32/Wbem'), join(windows, 'System32/WindowsPowerShell/v1.0')].join(';') };
const helper = spawn(join(root, 'native/DshUiBridge/portable/DshUiBridge.exe'), [], { env, windowsHide: true, stdio: 'pipe' });
const lines = createInterface({ input: helper.stdout });
let sequence = 0;
const pending = new Map();
const callNative = (method, args) => new Promise((resolve, reject) => {
  const id = String(++sequence);
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Portable native helper timed out')); }, 20000);
  pending.set(id, { resolve, reject, timer });
  helper.stdin.write(JSON.stringify({ id, method, args }) + '\n');
});
lines.on('line', line => {
  try {
    const result = JSON.parse(line), request = pending.get(result.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(result.id);
    result.ok ? request.resolve(result.value) : request.reject(new Error(result.error.message));
  } catch { /* Unrelated output cannot satisfy a request. */ }
});
const fail = error => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
helper.on('error', fail);
helper.on('exit', () => fail(new Error('Portable native helper exited')));
helper.stderr.resume();
const client = new Client({ name: 'portable-package-check', version: '1.0.0' });
const transport = new StdioClientTransport({ command: join(root, 'runtime/node/node.exe'), args: ['--disable-warning=ExperimentalWarning', join(root, 'dist/entrypoints/mcp.js')], cwd: root, env, stderr: 'pipe' });
let controllerStarted = false;
try {
  const text = 'DSHcontroller portable DPAPI check';
  const protectedValue = await callNative('protect', { text });
  assert.equal((await callNative('unprotect', { data: protectedValue.data })).text, text);
  await client.connect(transport);
  transport.stderr?.resume();
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 28);
  assert.ok(tools.tools.some(tool => tool.name === 'dsh_discover'));
  const result = await client.callTool({ name: 'dsh_discover', arguments: {} });
  controllerStarted = true;
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const data = JSON.parse(result.content.find(item => item.type === 'text').text);
  assert.ok(Array.isArray(data.instances));
  console.log(`PASS: portable native DPAPI, MCP initialization, 28 tools, discovery (${data.instances.length} instances); no installed Node/.NET required.`);
} finally {
  await client.close().catch(() => {});
  helper.kill(); lines.close();
  if (controllerStarted) {
    // Stop only the Controller associated with this package directory.
    const child = spawn(join(root, 'runtime/node/node.exe'), ['--disable-warning=ExperimentalWarning', join(root, 'dist/entrypoints/cli.js'), 'shutdown'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Package Controller shutdown failed'))); });
  }
}
