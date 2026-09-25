import { createContext, runInContext, type Context } from 'node:vm';
import {
  applyCommandToDraft,
  colorToHex,
  compositeFrame,
  CommandError,
  createPluginCommand,
  describeCommand,
  fillCommandDefaults,
  resolveFrame,
  resolveLayer,
  type Command,
  type CommandRegistry,
  type CommandSummary,
  type Draft,
  type Editor,
  type MutableCommandRegistry,
  type PluginCommandDefinition,
  type Sprite,
} from '@pixel/core';

/**
 * The constrained scripting runtime.
 *
 * Scripts and plugins are JavaScript, but they are not given `require`, `process`, `fetch`,
 * the filesystem or the network. They run in a restricted `node:vm` context whose intended
 * API is a single JSON bridge back into the command bus — the same bus the UI, the CLI and
 * MCP use. Every edit therefore lands in the normal undo history.
 *
 * `node:vm` is not a security mechanism. These restrictions are API and defence-in-depth
 * controls for trusted scripts, not an isolation boundary for hostile code.
 *
 * Two rules further reduce accidental escape:
 *
 *   1. `codeGeneration: { strings: false, wasm: false }` disables `eval` and the
 *      `Function` constructor *inside* the context, so a script cannot compile its way
 *      out of the restricted context.
 *   2. Every function the script sees (`exec`, `log`, `document`, ...) is defined in the
 *      bootstrap *inside* the context, not injected from the host. A host function's
 *      `.constructor` is the host's `Function`, which is the classic escape hatch; a
 *      context-native function's `.constructor` is the sandboxed one, which rule 1 has
 *      already neutered.
 *
 * All values crossing the boundary are JSON round-tripped, so a script can never hold a
 * live reference to engine internals.
 */

/** How long a script may run before it is killed, in milliseconds. */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 2000;

/** Upper bound on retained `log()` lines, so a runaway loop cannot exhaust memory. */
const MAX_LOGS = 1000;

export interface ScriptRuntimeOptions {
  /** Per-call execution budget. Defaults to {@link DEFAULT_SCRIPT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface ScriptRunResult {
  ok: boolean;
  /** The value the script returned (JSON-serialisable), or `null`. */
  result: unknown;
  logs: string[];
  /** Present only when `ok` is false. */
  error?: string;
  /** Machine-readable command/script error code when one is available. */
  code?: string;
}

export interface ScriptPluginResult {
  ok: boolean;
  name: string;
  /** Names of the commands the plugin registered. */
  commands: string[];
  logs: string[];
  error?: string;
}

export interface LoadPluginOptions {
  name: string;
  /** The registry the plugin's commands are added to. */
  registry: MutableCommandRegistry;
  /** Optional document for read-only calls the plugin makes while loading. */
  editor?: Editor;
}

/**
 * The bootstrap, evaluated once inside the context.
 *
 * It defines the context-native API over a single host bridge function, then deletes the
 * bridge from the global so scripts cannot reach it. The wrappers keep it alive in a
 * closure, which is not reachable from script code.
 */
const BOOTSTRAP = `(function () {
  "use strict";
  var bridge = globalThis.__bridge;
  function call(method, payload) {
    return JSON.parse(bridge(method, JSON.stringify(payload === undefined ? null : payload)));
  }

  globalThis.__defs = [];
  globalThis.__logs = [];

  function log() {
    if (globalThis.__logs.length >= ${MAX_LOGS}) return;
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      if (typeof a === "string") { parts.push(a); continue; }
      try { parts.push(JSON.stringify(a)); } catch (e) { parts.push(String(a)); }
    }
    globalThis.__logs.push(parts.join(" "));
  }

  function exec(command, params) {
    var res = call("exec", { command: command, params: params === undefined ? {} : params });
    if (!res.ok) {
      var err = new Error(res.error);
      err.code = res.code;
      throw err;
    }
    return res.summary;
  }

  function tryExec(command, params) {
    return call("exec", { command: command, params: params === undefined ? {} : params });
  }

  globalThis.log = log;
  globalThis.exec = exec;
  globalThis.tryExec = tryExec;
  globalThis.putPixels = function (rect, data, options) {
    var params = options && typeof options === "object" ? Object.assign({}, options) : {};
    params.rect = rect;
    params.data = data;
    return exec("put_pixels", params);
  };
  globalThis.commands = function () { return call("commands", null); };
  globalThis.command = function (name) { return call("command", { name: name }); };
  globalThis.document = function () { return call("document", null); };
  globalThis.layers = function () { return call("layers", null); };
  globalThis.frames = function () { return call("frames", null); };
  globalThis.tags = function () { return call("tags", null); };
  globalThis.palette = function () { return call("palette", null); };
  globalThis.getPixel = function (x, y, layer, frame) {
    return call("getPixel", { x: x, y: y, layer: layer, frame: frame });
  };
  globalThis.sample = function (x, y, optionsOrFrame) {
    var options = optionsOrFrame !== null && typeof optionsOrFrame === "object"
      ? optionsOrFrame
      : { frame: optionsOrFrame };
    return call("sample", { x: x, y: y, frame: options.frame, layer: options.layer });
  };
  // Explicitly named alias: sample can be given a layer override, while this
  // spelling always means the composited frame and is harder to misread in a script.
  globalThis.sampleComposite = function (x, y, frame) {
    return call("sample", { x: x, y: y, frame: frame });
  };

  globalThis.defineCommand = function (def) {
    if (!def || typeof def !== "object" || typeof def.name !== "string" || typeof def.run !== "function") {
      throw new Error("defineCommand requires { name: string, run(api, params) }");
    }
    globalThis.__defs.push(def);
    return def.name;
  };

  globalThis.__api = {
    log: log,
    exec: exec,
    tryExec: tryExec,
    putPixels: globalThis.putPixels,
    commands: globalThis.commands,
    command: globalThis.command,
    document: globalThis.document,
    layers: globalThis.layers,
    frames: globalThis.frames,
    tags: globalThis.tags,
    palette: globalThis.palette,
    getPixel: globalThis.getPixel,
    sample: globalThis.sample,
    sampleComposite: globalThis.sampleComposite,
  };

  delete globalThis.__bridge;
})();`;

/** Where a script's commands run: the editor (a whole document) or a plugin's draft. */
interface Executor {
  registry: CommandRegistry;
  sprite(): Sprite;
  exec(
    name: string,
    params: unknown,
  ): { ok: true; summary: CommandSummary } | { ok: false; error: string; code: string };
}

function editorExecutor(editor: Editor): Executor {
  return {
    registry: editor.registry,
    sprite: () => editor.sprite,
    exec: (name, params) => editor.tryExecute(name, params),
  };
}

function draftExecutor(draft: Draft, registry: CommandRegistry): Executor {
  return {
    registry,
    sprite: () => draft.sprite,
    exec: (name, params) => {
      try {
        return { ok: true, summary: applyCommandToDraft(draft, registry, name, params) };
      } catch (error) {
        const code = error instanceof CommandError ? error.code : 'command_failed';
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code,
        };
      }
    },
  };
}

/**
 * The MCP command surface makes layer/frame optional and fills the obvious
 * defaults. Keep the script bridge on the same contract instead of making a
 * perfectly good `exec('draw_rect', { layer, rect, ... })` fail merely because
 * frame 0 was omitted.
 */
function fillScriptDefaults(command: Command, params: unknown, sprite: Sprite): unknown {
  return fillCommandDefaults(sprite, command, params);
}

/**
 * One sandboxed context.
 *
 * Reuse a runtime for a whole session: the context is created once (so plugins stay
 * loaded in it) while the executor underneath is swapped per call, which is what lets a
 * plugin command run against whichever document invoked it.
 */
export class ScriptRuntime {
  private readonly context: Context;
  private readonly timeoutMs: number;
  private readonly stack: Executor[] = [];

  constructor(options: ScriptRuntimeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    const sandbox = Object.create(null) as Record<string, unknown>;
    this.context = createContext(sandbox, {
      name: 'pixel-script',
      codeGeneration: { strings: false, wasm: false },
    });
    sandbox.__bridge = (method: string, payloadJson: string): string =>
      JSON.stringify(this.dispatch(method, JSON.parse(payloadJson || 'null')));
    runInContext(BOOTSTRAP, this.context, { filename: 'pixel:bootstrap' });
  }

  /** Run a script against a document. Every command it issues collapses into one undo step. */
  run(source: string, editor: Editor): ScriptRunResult {
    runInContext('globalThis.__logs = [];', this.context, { filename: 'pixel:log-reset' });
    this.stack.push(editorExecutor(editor));
    try {
      // The transaction is what makes a 50-command script a single Ctrl+Z, and what rolls
      // the document back if the script throws halfway through.
      return editor.transaction('script', () => {
        const code = `globalThis.__result = (function () {\n"use strict";\n${source}\n})();`;
        runInContext(code, this.context, { filename: 'pixel:script', timeout: this.timeoutMs });
        return { ok: true, result: this.read('globalThis.__result'), logs: this.logs() };
      });
    } catch (error) {
      return {
        ok: false,
        result: null,
        logs: this.logs(),
        error: this.describeError(error),
        code: (error as { code?: string } | null)?.code,
      };
    } finally {
      this.stack.pop();
    }
  }

  /**
   * Evaluate a plugin and register the commands it defines.
   *
   * The plugin's `run` functions stay in this context; each registered command invokes
   * its `run` through the sandbox so the timeout still applies, and passes the *draft* of
   * whatever command is being expanded, so a plugin command is a single undo step.
   */
  loadPlugin(source: string, options: LoadPluginOptions): ScriptPluginResult {
    const { name, registry } = options;
    if (options.editor) this.stack.push(editorExecutor(options.editor));
    const definitionStart = (this.read('globalThis.__defs.length') as number | null) ?? 0;
    runInContext('globalThis.__logs = [];', this.context, { filename: 'pixel:plugin-log-reset' });
    try {
      // Keep definitions from earlier plugins in the context. A plugin command's
      // closure captures its absolute slot; resetting this array made a later plugin
      // silently replace the implementation of an earlier one.
      runInContext(source, this.context, {
        filename: `${name}.js`,
        timeout: this.timeoutMs,
      });

      const definitionEnd = (this.read('globalThis.__defs.length') as number | null) ?? definitionStart;
      const defs: PluginCommandDefinition[] = [];
      for (let i = definitionStart; i < definitionEnd; i += 1) {
        defs.push(this.readDef(i));
      }

      const seen = new Set<string>();
      for (const def of defs) {
        if (seen.has(def.name)) throw new Error(`Duplicate plugin command: ${def.name}`);
        if (registry.has(def.name)) throw new Error(`Command already exists: ${def.name}`);
        seen.add(def.name);
      }

      const commands: string[] = [];
      for (let i = 0; i < defs.length; i += 1) {
        const index = definitionStart + i;
        const command = createPluginCommand(defs[i], (ctx, params) =>
          this.invokePlugin(index, ctx.draft, registry, params),
        );
        registry.register(command);
        commands.push(command.name);
      }

      return { ok: true, name, commands, logs: this.logs() };
    } catch (error) {
      // Do not leave a failed plugin's definitions for the next load to capture.
      runInContext(`globalThis.__defs.length = ${definitionStart};`, this.context);
      return {
        ok: false,
        name,
        commands: [],
        logs: this.logs(),
        error: this.describeError(error),
      };
    } finally {
      if (options.editor) this.stack.pop();
    }
  }

  /** Invoke a plugin command's `run` inside the sandbox, bound to the caller's draft. */
  private invokePlugin(
    index: number,
    draft: Draft,
    registry: CommandRegistry,
    params: unknown,
  ): CommandSummary {
    this.stack.push(draftExecutor(draft, registry));
    try {
      const paramsJson = JSON.stringify(params === undefined ? {} : params);
      const code =
        `globalThis.__callParams = ${paramsJson};\n` +
        `globalThis.__callResult = globalThis.__defs[${index}].run(globalThis.__api, globalThis.__callParams);\n` +
        `JSON.stringify(globalThis.__callResult === undefined ? null : globalThis.__callResult)`;
      const json = runInContext(code, this.context, {
        filename: 'pixel:plugin-run',
        timeout: this.timeoutMs,
      }) as string;
      return (JSON.parse(json) ?? {}) as CommandSummary;
    } finally {
      this.stack.pop();
    }
  }

  private readDef(index: number): PluginCommandDefinition {
    return this.read(
      `({ name: globalThis.__defs[${index}].name, description: globalThis.__defs[${index}].description, ` +
        `readOnly: globalThis.__defs[${index}].readOnly, params: globalThis.__defs[${index}].params })`,
    ) as PluginCommandDefinition;
  }

  private read(expression: string, timeoutMs = this.timeoutMs): unknown {
    const json = runInContext(
      `(JSON.stringify((${expression}) === undefined ? null : (${expression})) ?? "null")`,
      this.context,
      { filename: 'pixel:read', timeout: timeoutMs },
    ) as string;
    return JSON.parse(json);
  }

  private logs(): string[] {
    return (this.read('globalThis.__logs') as string[]) ?? [];
  }

  private current(): Executor | undefined {
    return this.stack[this.stack.length - 1];
  }

  private dispatch(method: string, payload: Record<string, unknown> | null): unknown {
    const executor = this.current();
    const sprite = executor ? executor.sprite() : null;
    switch (method) {
      case 'exec': {
        if (!executor) return { ok: false, error: 'No document is available', code: 'no_document' };
        const commandName = String(payload?.command ?? '');
        const command = executor.registry.get(commandName);
        const params = command
          ? fillScriptDefaults(command, payload?.params ?? {}, executor.sprite())
          : payload?.params ?? {};
        return executor.exec(commandName, params);
      }
      case 'commands':
        return (executor?.registry.list() ?? []).map((command) => ({
          name: command.name,
          description: command.description,
          readOnly: command.readOnly === true,
        }));
      case 'command': {
        const command = executor?.registry.get(String(payload?.name ?? ''));
        return command ? describeCommand(command) : null;
      }
      case 'document':
        return sprite ? this.describeDocument(sprite) : null;
      case 'layers':
        return sprite ? describeLayers(sprite) : [];
      case 'frames':
        return sprite
          ? sprite.frames.map((frame, index) => ({
              id: frame.id,
              index,
              durationMs: frame.durationMs,
            }))
          : [];
      case 'tags':
        return sprite ? sprite.tags.map((tag) => ({ ...tag })) : [];
      case 'palette':
        return sprite
          ? {
              name: sprite.palette.name,
              colors: sprite.palette.colors.map((color) => colorToHex(color, true)),
            }
          : null;
      case 'getPixel': {
        if (!sprite) return null;
        const layer = safeResolve(() =>
          resolveLayer(sprite, (payload?.layer as string | number) ?? 0),
        );
        const frame = safeResolve(() => resolveFrame(sprite, (payload?.frame as string | number) ?? 0));
        if (!layer || !frame) return null;
        const color = frame.cels.get(layer.id)?.getColor(Number(payload?.x), Number(payload?.y));
        // Fully transparent reads as "nothing there". Returning the zeroed colour
        // instead would be a truthy object, so every `if (getPixel(...))` emptiness
        // test in a script would silently be wrong.
        return color && color.a > 0 ? { ...color } : null;
      }
      case 'sample': {
        if (!sprite) return null;
        const frame = safeResolve(() => resolveFrame(sprite, (payload?.frame as string | number) ?? 0));
        if (!frame) return null;
        const x = Number(payload?.x);
        const y = Number(payload?.y);
        if (payload?.layer !== undefined && payload?.layer !== null) {
          const layer = safeResolve(() => resolveLayer(sprite, payload.layer as string | number));
          if (!layer) return null;
          const color = frame.cels.get(layer.id)?.getColor(x, y);
          return color && color.a > 0 ? { ...color } : null;
        }
        const buffer = compositeFrame(sprite, frame.id, { background: null });
        const color = buffer.getColor(x, y);
        return color && color.a > 0 ? { ...color } : null;
      }
      default:
        return { error: `Unknown bridge method: ${method}` };
    }
  }

  private describeDocument(sprite: Sprite): Record<string, unknown> {
    return {
      name: sprite.name,
      width: sprite.width,
      height: sprite.height,
      layers: describeLayers(sprite),
      frames: sprite.frames.map((frame, index) => ({
        id: frame.id,
        index,
        durationMs: frame.durationMs,
      })),
      tags: sprite.tags.map((tag) => ({ ...tag })),
      palette: {
        name: sprite.palette.name,
        colors: sprite.palette.colors.map((color) => colorToHex(color, true)),
      },
      paletteLocked: sprite.paletteLocked === true,
      tileset: sprite.tileset
        ? {
            id: sprite.tileset.id,
            name: sprite.tileset.name,
            tileWidth: sprite.tileset.tileWidth,
            tileHeight: sprite.tileset.tileHeight,
            columns: sprite.tileset.columns,
          }
        : null,
      tilemaps: (sprite.tilemaps ?? []).map((tilemap) => ({
        id: tilemap.id,
        name: tilemap.name,
        width: tilemap.width,
        height: tilemap.height,
      })),
    };
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        return `Script timed out after ${this.timeoutMs}ms`;
      }
      return error.message;
    }
    return String(error);
  }
}

function describeLayers(sprite: Sprite): Record<string, unknown>[] {
  return sprite.layers.map((layer, index) => ({
    id: layer.id,
    name: layer.name,
    index,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
  }));
}

function safeResolve<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
