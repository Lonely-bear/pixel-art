/**
 * `mcp-call` - drive the local MCP server by hand, over the wire.
 *
 * An agent normally gets these tools from its client. This script exists so the
 * *surface itself* can be exercised from a shell or a subagent: it starts
 * `packages/mcp/dist/cli.js` as a child process, speaks JSON-RPC to it over stdio, and
 * does nothing else. No imports from `@pixel/core`, no shortcuts through the library —
 * the only thing that reaches the editor is the advertised tool list.
 *
 * That is what makes it a real test of the lazy surface. The tool list is 33 entries and
 * the ~90 core commands are absent until the session discovers them, so an agent using
 * this script has to go through `list_commands` / `describe_command` / `find_workflow`
 * exactly as any other client would. Promotion changes the list mid-session, which is
 * why `list` is a separate command and why every response reports how many
 * `tools/list_changed` notifications arrived since the last call.
 *
 * `calls <file.json>` replays `[{label, tool, arguments}]` against a *single* session,
 * which is the mode you need for anything that spans several tools - creating a document
 * and then drawing on it, say - because every other mode is one call, one process, and a
 * document that dies with it.
 *
 *   node scripts/mcp-call.mjs list
 *   node scripts/mcp-call.mjs call <tool> '<json args>'
 *   node scripts/mcp-call.mjs resources
 *   node scripts/mcp-call.mjs templates
 *   node scripts/mcp-call.mjs read <uri>
 *   node scripts/mcp-call.mjs prompts
 *   node scripts/mcp-call.mjs raw <method> '<json params>'
 *
 * `call` prints a PNG content block as `image/png <base64-bytes>` rather than dumping
 * megabytes of base64 into the terminal; pipe it through `preview-image.mjs` if you want
 * to look at it.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '..', 'packages', 'mcp', 'dist', 'cli.js');

const PROTOCOL_VERSION = '2025-06-18';

class Server {
  constructor() {
    this.child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.buffer = '';
    this.instructions = '';

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      if (process.env.MCP_CALL_DEBUG) process.stderr.write(chunk);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve: settle, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
        else settle(message.result);
      } else if (message.method) {
        this.notifications.push(message);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((settle, reject) => {
      this.pending.set(id, { resolve: settle, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 120_000).unref?.();
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async start() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcp-call', version: '1.0.0' },
    });
    this.instructions = result.instructions ?? '';
    this.notify('notifications/initialized', {});
    return result;
  }

  stop() {
    this.child.kill();
  }
}

/** Compact, readable rendering of a tool result. */
function render(result) {
  if (!result) return '(no result)';
  const lines = [];
  if (result.isError) lines.push('isError: true');
  for (const block of result.content ?? []) {
    if (block.type === 'text') {
      const raw = block.text;
      try {
        lines.push(JSON.stringify(JSON.parse(raw), null, 2));
      } catch {
        lines.push(raw);
      }
    } else if (block.type === 'image') {
      lines.push(`[image ${block.mimeType}, ${Math.round((block.data.length * 3) / 4)} bytes decoded]`);
    } else {
      lines.push(`[${block.type}]`);
    }
  }
  return lines.join('\n');
}

/**
 * How many `tools/list_changed` notifications arrived since the last call.
 *
 * That count is the signal that a command was promoted: a client that receives one
 * re-lists, and a single call here cannot, so the count is the honest thing to print.
 * The names themselves come back in the response's `promotedTools`.
 */
function listChangedNote(server) {
  const changed = server.notifications.filter((n) => n.method === 'notifications/tools/list_changed');
  server.notifications = server.notifications.filter((n) => n.method !== 'notifications/tools/list_changed');
  return changed.length > 0 ? `\n(${changed.length} tools/list_changed notification(s) received - re-run "list" to see them)` : '';
}

const [command, ...rest] = process.argv.slice(2);
const server = new Server();

try {
  const init = await server.start();
  if (process.env.MCP_CALL_DEBUG) {
    process.stderr.write(`connected to ${init.serverInfo?.name} ${init.serverInfo?.version}\n`);
  }

  if (command === 'instructions') {
    console.log(server.instructions);
  } else if (command === 'list') {
    const { tools } = await server.request('tools/list', {});
    console.log(`${tools.length} tools:`);
    for (const tool of tools) {
      const hints = Object.entries(tool.annotations ?? {})
        .filter(([, value]) => value === true)
        .map(([key]) => key.replace('Hint', ''))
        .join('+');
      const kind = tool._meta?.kind ?? '?';
      console.log(`  ${tool.name.padEnd(22)} ${kind.padEnd(8)} [${hints || '-'}] ${tool.title ?? ''}`);
    }
    console.log(listChangedNote(server));
  } else if (command === 'call') {
    const [name, argsJson = '{}'] = rest;
    if (!name) throw new Error('usage: mcp-call call <tool> <json args>');
    const result = await server.request('tools/call', { name, arguments: JSON.parse(argsJson) });
    console.log(render(result));
    console.log(listChangedNote(server));
  } else if (command === 'calls') {
    // One process, many advertised tool calls. Every other mode here runs a single
    // tools/call, which means a document created by one invocation is gone by the
    // next one - so "draw it, then export it" is impossible one call at a time.
    // This mode just replays a list of {tool, arguments} against one session, which
    // is what any real MCP client does.
    const [specPath] = rest;
    if (!specPath) throw new Error('usage: mcp-call calls <json file: [{tool, arguments}]>');
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    const before = new Set((await server.request('tools/list', {})).tools.map((t) => t.name));
    for (const [index, step] of spec.entries()) {
      const label = step.label ? `${step.label}: ` : '';
      console.log(`\n--- [${index}] ${label}${step.tool} ---`);
      try {
        const result = await server.request('tools/call', {
          name: step.tool,
          arguments: step.arguments ?? {},
        });
        console.log(render(result));
      } catch (error) {
        console.log(`REQUEST FAILED: ${error.message}`);
      }
    }
    const after = (await server.request('tools/list', {})).tools;
    const added = after.map((t) => t.name).filter((n) => !before.has(n));
    console.log(`\n(tool list: ${before.size} before, ${after.length} after; promoted: ${added.join(', ') || 'none'})`);
    console.log(listChangedNote(server));
  } else if (command === 'resources') {
    console.log(JSON.stringify(await server.request('resources/list', {}), null, 2));
  } else if (command === 'templates') {
    console.log(JSON.stringify(await server.request('resources/templates/list', {}), null, 2));
  } else if (command === 'read') {
    const [uri] = rest;
    const result = await server.request('resources/read', { uri });
    for (const block of result.contents ?? []) {
      if (block.text) console.log(block.text);
      else if (block.blob) console.log(`[blob ${block.mimeType}, ${Math.round((block.blob.length * 3) / 4)} bytes]`);
    }
  } else if (command === 'prompts') {
    console.log(JSON.stringify(await server.request('prompts/list', {}), null, 2));
  } else if (command === 'raw') {
    const [method, paramsJson = '{}'] = rest;
    console.log(JSON.stringify(await server.request(method, JSON.parse(paramsJson)), null, 2));
  } else {
    console.log(
      [
        'usage:',
        '  node scripts/mcp-call.mjs instructions',
        '  node scripts/mcp-call.mjs list',
        '  node scripts/mcp-call.mjs call <tool> <json args>',
        '  node scripts/mcp-call.mjs calls <json file: [{label, tool, arguments}]>',
        '  node scripts/mcp-call.mjs resources | templates | read <uri> | prompts',
        '  node scripts/mcp-call.mjs raw <method> <json params>',
      ].join('\n'),
    );
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  server.stop();
}
