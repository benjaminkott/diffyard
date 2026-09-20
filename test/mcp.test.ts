import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { VERSION } from '../dist/manifest.js';

/**
 * The MCP server, over its own wire.
 *
 * What it has to do: answer a client of the current protocol revision, where
 * every request carries its version and `server/discover` stands in for a
 * handshake, and still answer one that opens with `initialize` — the clients
 * people have installed today. Both from the bundle that ships, because the
 * era decision lives in how the server is started, not in what it registers.
 */

const SERVER = join(import.meta.dirname, '..', 'bin', 'diffyard-mcp.mjs');

/** Everything a request of the 2026-07-28 revision carries about its sender. */
const MODERN = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
};

type Reply = { id: number; result?: Record<string, unknown>; error?: { code: number; message: string } };

/** The one entry a list is expected to have, or a failure that says which. */
function first<T>(list: T[] | undefined, what: string): T {
  const entry = list?.[0];
  assert.ok(entry, `${what} came back`);
  return entry;
}

/**
 * One connection: the messages go in, and the replies come back keyed by id.
 * A notification has no id and no reply, so it never counts towards the wait.
 */
async function talk(messages: Array<Record<string, unknown>>): Promise<Map<number, Reply>> {
  const expected = messages.filter((message) => 'id' in message).length;
  const replies = new Map<number, Reply>();
  const server = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });

  const errors: string[] = [];
  server.stderr.on('data', (chunk: Buffer) => errors.push(chunk.toString()));

  const done = new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: server.stdout });
    lines.on('line', (line) => {
      const reply = JSON.parse(line) as Reply;
      replies.set(reply.id, reply);
      if (replies.size === expected) resolve();
    });
    server.on('error', reject);
    server.on('exit', (code) => reject(new Error(`server exited with ${code}: ${errors.join('')}`)));
    setTimeout(() => reject(new Error(`only ${replies.size} of ${expected} replies: ${errors.join('')}`)), 10000).unref();
  });

  for (const message of messages) server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

  try {
    await done;
  } finally {
    server.kill();
  }
  return replies;
}

describe('a client of the 2026-07-28 revision', () => {
  it('learns the version, the capabilities and the instructions from server/discover', async () => {
    const replies = await talk([{ id: 1, method: 'server/discover', params: { _meta: MODERN } }]);
    const result = replies.get(1)?.result;

    assert.ok(result, 'discover answered');
    assert.deepEqual(result.supportedVersions, ['2026-07-28']);
    assert.equal(result.resultType, 'complete');
    assert.match(String(result.instructions), /diffyard_usage/);
    assert.deepEqual((result._meta as Record<string, unknown>)['io.modelcontextprotocol/serverInfo'], {
      name: 'diffyard',
      version: VERSION,
    });
  });

  it('gets the lists with a cache lifetime, since nothing here changes while it runs', async () => {
    const replies = await talk([
      { id: 1, method: 'tools/list', params: { _meta: MODERN } },
      { id: 2, method: 'resources/list', params: { _meta: MODERN } },
      { id: 3, method: 'resources/read', params: { uri: 'diffyard://reference/steps', _meta: MODERN } },
    ]);

    for (const id of [1, 2, 3]) {
      const result = replies.get(id)?.result;
      assert.ok(result, `request ${id} answered`);
      assert.equal(result.resultType, 'complete');
      assert.ok(Number(result.ttlMs) > 0, `request ${id} may be cached`);
      assert.equal(result.cacheScope, 'private');
    }

    const tools = replies.get(1)?.result?.tools as Array<{ name: string; annotations: Record<string, boolean> }>;
    assert.deepEqual(tools.map((tool) => tool.name), ['diffyard_usage']);
    assert.equal(first(tools, 'the tool').annotations.readOnlyHint, true);

    const resources = replies.get(2)?.result?.resources as Array<{ uri: string }>;
    assert.deepEqual(
      resources.map((resource) => resource.uri),
      ['diffyard://reference/config', 'diffyard://reference/steps', 'diffyard://reference/schema']
    );

    const contents = replies.get(3)?.result?.contents as Array<{ text: string }>;
    assert.match(first(contents, 'the resource').text, /^# diffyard interaction steps/);
  });

  it('is told where the command is when it calls the tool', async () => {
    const replies = await talk([
      { id: 1, method: 'tools/call', params: { name: 'diffyard_usage', arguments: {}, _meta: MODERN } },
    ]);
    const usage = first(replies.get(1)?.result?.content as Array<{ text: string }>, 'the usage').text;

    assert.match(usage, /^diffyard \d+\.\d+\.\d+/);
    assert.ok(usage.includes(SERVER.replace('diffyard-mcp.mjs', 'diffyard.mjs')), 'names the sibling CLI');
  });
});

describe('a client that still opens with initialize', () => {
  it('is served the older revision by the same server', async () => {
    const replies = await talk([
      {
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list', params: {} },
      { id: 3, method: 'tools/call', params: { name: 'diffyard_usage', arguments: {} } },
    ]);

    const opened = replies.get(1)?.result;
    assert.ok(opened, 'initialize answered');
    assert.equal(opened.protocolVersion, '2025-11-25');
    assert.match(String(opened.instructions), /diffyard_usage/);

    const tools = replies.get(2)?.result?.tools as Array<{ name: string }>;
    assert.deepEqual(tools.map((tool) => tool.name), ['diffyard_usage']);
    assert.equal('ttlMs' in (replies.get(2)?.result ?? {}), false, 'the older revision has no cache fields');

    const usage = first(replies.get(3)?.result?.content as Array<{ text: string }>, 'the usage').text;
    assert.match(usage, /^diffyard \d+\.\d+\.\d+/);
  });
});
