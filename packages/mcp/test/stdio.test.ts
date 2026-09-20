import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts');

/** Speak JSON-RPC to the real server over stdio, the way an MCP client does. */
function talk(messages: unknown[], timeoutMs = 20000): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    // A dummy key: listing tools must not require a working one.
    const child = spawn(process.execPath, ['--no-warnings', serverPath], { env: { ...process.env, OPENROUTER_API_KEY: 'test-key' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Record<string, unknown>[] = [];
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out; stderr: ${stderr.slice(0, 300)}`)); }, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) if (line.trim()) out.push(JSON.parse(line));
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
      if (out.length >= messages.filter((m) => (m as { id?: number }).id !== undefined).length) {
        clearTimeout(timer);
        child.kill();
        resolve(out);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  });
}

test('the server initializes and lists its tools over stdio', async () => {
  const replies = await talk([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  const init = replies.find((r) => r.id === 1) as { result: { serverInfo: { name: string } } };
  assert.equal(init.result.serverInfo.name, 'decisis');
  const list = replies.find((r) => r.id === 2) as { result: { tools: { name: string; description: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] } };
  const tools = list.result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ['classify', 'decide', 'route_model']);
  const route = tools.find((t) => t.name === 'route_model')!;
  assert.match(route.description, /cheapest model tier/);
  assert.ok('task' in route.inputSchema.properties);
  assert.deepEqual(route.inputSchema.required, ['task']);
  const classify = tools.find((t) => t.name === 'classify')!;
  assert.deepEqual(classify.inputSchema.required!.sort(), ['options', 'state']);
});

test('a tool call with no reachable model returns an error result rather than crashing the server', async () => {
  const replies = await talk([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'classify', arguments: { state: 's', options: { a: 'A' } } } },
  ]);
  const call = replies.find((r) => r.id === 2) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /at least two/);
});
