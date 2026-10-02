/**
 * `showcase-build` - generate and re-generate a showcase piece through the *advertised*
 * MCP tool surface, over stdio, as a child process.
 *
 * The point of this script is the same as the point of `mcp-call.mjs`: it imports nothing
 * from `@pixel/core` and reaches the engine only through `tools/call`. A showcase piece that
 * could only be made with a library import would prove nothing about the product, and the
 * ops JSON would not replay anywhere. Everything here is a raw JSON-RPC client.
 *
 * Three jobs, one connection shape:
 *
 *   node scripts/showcase-build.mjs tools                       # advertised tool list
 *   node scripts/showcase-build.mjs probe <file.json>           # ad-hoc [{tool, arguments}]
 *   node scripts/showcase-build.mjs run <piece> [--verify]      # replay showcase/<piece>/ops.json
 *
 * `run` is the reproducible path. It reads `showcase/<piece>/ops.json` - an ordered
 * `[{label, tool, arguments}]` list, the same shape `mcp-call.mjs calls` replays - executes it
 * against one fresh server, writes the outputs the ops ask for, and records the per-call
 * measurements T-007 aggregates later in `manifest.json`.
 *
 * Three files, and which of them are stable matters:
 *
 *   - `ops.json` and `out/*` are **deterministic**: same repo, same bytes. `--verify` replays a
 *     second time and byte-compares every output, so a piece that does not reproduce fails
 *     loudly instead of quietly writing different bytes.
 *   - `manifest.json` is a *measurement*. `wallClockMs` moves run to run, and `resultBytes` moves
 *     with it because the response envelope echoes a session-assigned `document.id`. Its
 *     `argumentBytes` and `files` blocks are byte-identical every run.
 *
 * No `Math.random`, no timestamps, no locale-dependent formatting anywhere: the ordering,
 * the byte counts and the output bytes have to survive a rerun on another machine.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = resolve(root, 'packages', 'mcp', 'dist', 'cli.js');
const showcaseRoot = resolve(root, 'showcase');

const PROTOCOL_VERSION = '2025-06-18';

/**
 * Byte length of a value as it travels on the wire.
 *
 * `JSON.stringify` is the same encoder the request used, so this is the argument payload
 * the server actually parsed and the result payload it actually wrote. Not a re-render of
 * the original object: it measures what was sent.
 */
function wireBytes(value) {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Lowercase hex SHA-256, used for the integrity block and the PNG comparison. */
async function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

class Server {
  constructor() {
    // `cwd: root` so a recorded op's relative path resolves against the repository root no
    // matter where the harness was invoked from. `mcp-call.mjs` inherits the caller's cwd
    // instead, which is why every documented replay command says "from the repo root".
    this.child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], cwd: root });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.buffer = '';
    this.instructions = '';
    this.stderr = '';

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
      if (process.env.SHOWCASE_DEBUG) process.stderr.write(chunk);
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
      }, 180_000).unref?.();
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
      clientInfo: { name: 'showcase-build', version: '1.0.0' },
    });
    this.instructions = result.instructions ?? '';
    this.serverInfo = result.serverInfo ?? {};
    this.notify('notifications/initialized', {});
    return result;
  }

  stop() {
    this.child.kill();
  }
}

/** Decode a `tools/call` result into the JSON envelope the surface actually returns. */
function envelope(result) {
  const block = (result?.content ?? []).find((b) => b.type === 'text');
  if (!block) return null;
  try {
    return JSON.parse(block.text);
  } catch {
    return { raw: block.text };
  }
}

/**
 * Pull the document id out of whatever a call returned.
 *
 * Sessions are in-memory, so ids are assigned by the server and differ between runs - which
 * is exactly why the recorded ops never contain one. The harness binds it at replay time and
 * substitutes the `${DOC}` placeholder, so a recorded ops file stays valid against a fresh
 * server.
 */
function findDocumentId(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  if (typeof value.id === 'string' && typeof value.name === 'string' && value.layers) return value.id;
  for (const child of Object.values(value)) {
    const found = findDocumentId(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Rewrite `${DOC}` against the live document id.
 *
 * Only the `document` argument is substituted. Everything else in the ops file is the literal
 * arguments the piece was drawn with, byte for byte.
 */
function bindDocument(args, documentId) {
  if (!documentId) return args;
  const walk = (value) => {
    if (typeof value === 'string') return value.replaceAll('${DOC}', documentId);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, walk(v)]));
    }
    return value;
  };
  return walk(args);
}

/**
 * Replay an ops file against one fresh server, measuring every call.
 *
 * Returns the per-call records plus the counts a benchmark needs, and throws on the first
 * failing tool call: a showcase piece that needed a retry is not the piece on the page.
 */
async function replay(spec, { verbose }) {
  const server = new Server();
  const calls = [];
  let documentId = null;

  try {
    const init = await server.start();
    if (verbose) {
      process.stderr.write(`connected to ${init.serverInfo?.name} ${init.serverInfo?.version}\n`);
    }

    for (const [index, step] of spec.entries()) {
      const tool = step.tool;
      const args = bindDocument(step.arguments ?? {}, documentId);
      const startedAt = process.hrtime.bigint();
      let result;
      try {
        result = await server.request('tools/call', { name: tool, arguments: args });
      } catch (error) {
        throw new Error(`step ${index} (${step.label ?? tool}) failed at the JSON-RPC layer: ${error.message}`);
      }
      const wallClockMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      const payload = envelope(result);
      if (result?.isError || payload?.ok === false) {
        const detail = payload?.error ?? JSON.stringify(payload ?? result);
        throw new Error(
          `step ${index} (${step.label ?? tool}) failed: ${tool} -> ${detail}` +
            (payload?.remediation ? ` | remediation: ${payload.remediation}` : ''),
        );
      }

      if (!documentId) documentId = findDocumentId(payload);

      const record = {
        index,
        label: step.label ?? tool,
        tool,
        wallClockMs: Math.round(wallClockMs * 1000) / 1000,
        argumentBytes: wireBytes(args),
        resultBytes: wireBytes(payload),
      };
      calls.push(record);
      if (verbose) {
        process.stderr.write(
          `  [${String(index).padStart(3)}] ${record.wallClockMs.toFixed(1).padStart(8)} ms  ` +
            `${String(record.argumentBytes).padStart(7)} in  ${String(record.resultBytes).padStart(7)} out  ${tool}\n`,
        );
      }
    }

    const tools = await server.request('tools/list', {});
    return {
      calls,
      documentId,
      instructions: server.instructions,
      serverInfo: init.serverInfo ?? {},
      promotedTools: tools.tools.map((t) => t.name),
    };
  } finally {
    server.stop();
  }
}

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const positional = rest.filter((a) => !a.startsWith('--'));
const verbose = flags.has('--verbose') || Boolean(process.env.SHOWCASE_DEBUG);

try {
  if (command === 'tools') {
    const server = new Server();
    try {
      await server.start();
      const { tools } = await server.request('tools/list', {});
      process.stdout.write(`${tools.length} advertised tools\n`);
      for (const tool of tools) {
        process.stdout.write(`  ${tool.name.padEnd(24)} ${(tool._meta?.kind ?? '?').padEnd(8)} ${tool.title ?? ''}\n`);
      }
    } finally {
      server.stop();
    }
  } else if (command === 'probe') {
    const specPath = positional[0];
    if (!specPath) throw new Error('usage: showcase-build probe <file.json: [{tool, arguments}]>');
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    const server = new Server();
    try {
      await server.start();
      let documentId = null;
      for (const [index, step] of spec.entries()) {
        const args = bindDocument(step.arguments ?? {}, documentId);
        const result = await server.request('tools/call', {
          name: step.tool,
          arguments: args,
        });
        const payload = envelope(result);
        if (!documentId) documentId = findDocumentId(payload);
        if (flags.has('--quiet')) {
          const note = payload?.ok === false ? ` FAILED: ${payload.error}` : '';
          process.stdout.write(`[${index}] ${step.tool}${note}\n`);
          continue;
        }
        process.stdout.write(`\n--- [${index}] ${step.label ?? ''} ${step.tool} ---\n`);
        for (const block of result.content ?? []) {
          if (block.type === 'text') {
            try {
              process.stdout.write(`${JSON.stringify(JSON.parse(block.text), null, 2)}\n`);
            } catch {
              process.stdout.write(`${block.text}\n`);
            }
          } else if (block.type === 'image') {
            process.stdout.write(`[image ${block.mimeType}, ~${Math.round((block.data.length * 3) / 4)} bytes]\n`);
          }
        }
      }
    } finally {
      server.stop();
    }
  } else if (command === 'run') {
    const piece = positional[0];
    if (!piece) throw new Error('usage: showcase-build run <piece-name> [--verify] [--verbose]');
    const pieceDir = resolve(showcaseRoot, piece);
    const opsPath = join(pieceDir, 'ops.json');
    const spec = JSON.parse(await readFile(opsPath, 'utf8'));
    const outDir = join(pieceDir, 'out');

    // Snapshot `out/` after a replay. Content-addressed, so a later `git diff` shows a real
    // change when the artwork changed and nothing at all when it did not.
    async function snapshotOut() {
      const files = {};
      for (const name of (await readdir(outDir)).sort()) {
        const bytes = await readFile(join(outDir, name));
        files[name] = { bytes: bytes.length, sha256: await sha256(bytes) };
      }
      return files;
    }

    if (verbose) process.stderr.write(`replaying ${spec.length} ops from ${piece}/ops.json\n`);
    await rm(outDir, { recursive: true, force: true });
    const result = await replay(spec, { verbose });
    const integrity = await snapshotOut();

    const totals = result.calls.reduce(
      (acc, c) => ({
        calls: acc.calls + 1,
        wallClockMs: acc.wallClockMs + c.wallClockMs,
        argumentBytes: acc.argumentBytes + c.argumentBytes,
        resultBytes: acc.resultBytes + c.resultBytes,
      }),
      { calls: 0, wallClockMs: 0, argumentBytes: 0, resultBytes: 0 },
    );

    const source = { path: `${piece}.pixel`, byteStable: false };
    try {
      const sourceBytes = await readFile(join(pieceDir, source.path));
      source.bytes = sourceBytes.length;
    } catch {
      // No editable source was written; leave `bytes` off rather than recording a zero.
    }
    source.note =
      'the .pixel container embeds session-generated frame and document ids, so its bytes ' +
      'move between runs even when the artwork does not. Everything under out/ is byte-stable.';

    const manifest = {
      piece,
      ops: 'ops.json',
      opsCount: spec.length,
      server: result.serverInfo,
      session: {
        // The document id is deliberately absent: it is assigned per session and would make
        // the manifest unreplayable. Only the promoted tool count, which is stable text.
        promotedToolCount: result.promotedTools.length,
      },
      totals: {
        calls: totals.calls,
        wallClockMs: Math.round(totals.wallClockMs * 1000) / 1000,
        argumentBytes: totals.argumentBytes,
        resultBytes: totals.resultBytes,
        meanWallClockMs: Math.round((totals.wallClockMs / totals.calls) * 1000) / 1000,
      },
      source,
      files: integrity,
      calls: result.calls,
    };

    const manifestPath = join(pieceDir, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${piece}: ${totals.calls} ops, ${Object.keys(integrity).length} file(s)\n`);
    for (const [name, info] of Object.entries(integrity)) {
      process.stdout.write(`  out/${name}  ${info.bytes} bytes  sha256:${info.sha256.slice(0, 16)}\n`);
    }
    process.stdout.write(
      `  totals: ${totals.wallClockMs.toFixed(1)} ms wall, ` +
        `${totals.argumentBytes} argument bytes in, ${totals.resultBytes} result bytes out\n`,
    );
    process.stdout.write(`  wrote ${piece}/manifest.json\n`);

    if (flags.has('--verify')) {
      // Replay a second time and byte-compare every recorded output. Determinism is an
      // acceptance criterion here, so it is checked rather than asserted in prose.
      //
      // The second replay writes to the same paths, because an op's destination is part of
      // the recipe - the comparison is against the snapshot taken above, not against a
      // scratch tree.
      if (verbose) process.stderr.write(`verifying: second replay of ${spec.length} ops\n`);
      await replay(spec, { verbose: false });
      const second = await snapshotOut();
      const names = [...new Set([...Object.keys(integrity), ...Object.keys(second)])].sort();
      const mismatches = [];
      const missing = [];
      for (const name of names) {
        if (!integrity[name] || !second[name]) missing.push(name);
        else if (integrity[name].sha256 !== second[name].sha256) mismatches.push(name);
      }
      if (missing.length) {
        process.stderr.write(`NOT REPRODUCIBLE (missing on one run): ${missing.join(', ')}\n`);
        process.exitCode = 1;
      } else if (mismatches.length) {
        process.stderr.write(`NOT REPRODUCIBLE: ${mismatches.join(', ')}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(
          `  verified: a second replay produced byte-identical output for ${names.length} file(s)\n`,
        );
      }
    }
  } else {
    process.stdout.write(
      [
        'usage:',
        '  node scripts/showcase-build.mjs tools',
        '  node scripts/showcase-build.mjs probe <file.json: [{label, tool, arguments}]> [--quiet]',
        '  node scripts/showcase-build.mjs run <piece-name> [--verify] [--verbose]',
        '',
        `pieces live in showcase/<piece-name>/ with ops.json, manifest.json and out/*.png`,
      ].join('\n'),
    );
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
