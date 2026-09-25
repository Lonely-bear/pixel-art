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

/** `run()` prepends a wrapper line and `"use strict"` before caller source. */
const SCRIPT_SOURCE_LINE_OFFSET = 2;

export interface ScriptRuntimeOptions {
  /** Per-call execution budget. Defaults to {@link DEFAULT_SCRIPT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export type ScriptErrorPhase = 'parse' | 'runtime' | 'command' | 'timeout';

export interface ScriptErrorInfo {
  message: string;
  code?: string;
  phase: ScriptErrorPhase;
  /** 1-based location in the caller-provided source, never in the VM wrapper. */
  line?: number;
  /** 1-based column in the caller-provided source. */
  column?: number;
  sourceName?: string;
  /** Command name when the failure came through exec/tryExec. */
  command?: string;
  /**
   * The error's constructor name, e.g. `TypeError`.
   *
   * `TypeError: cannot read ...` already carries this, but a bare `undefined` or a
   * non-Error throw does not, and a model debugging a 9000-line generator needs to
   * know whether it threw a TypeError or a string.
   */
  name?: string;
  /**
   * The stack, with every frame remapped to the caller's line numbers and filename.
   *
   * The raw stack points at `pixel:script:12:86`, which is inside the VM wrapper and
   * means nothing to the caller. Remapping it is the difference between a stack that
   * locates the bug and one that has to be decoded first.
   */
  stack?: string;
  /** The offending line of the caller's own source, verbatim. */
  sourceLine?: string;
  /** The line above `sourceLine`, for reading a multi-line statement. */
  before?: string;
  /** The line below `sourceLine`. */
  after?: string;
}

export interface ScriptRunOptions {
  /**
   * Value exposed to the script as the global `params`.
   *
   * The point is that a script becomes a function of its inputs, so tuning a number
   * never means editing - and re-sending - the program. A script run without it still
   * sees `params`, as `{}`, so the same file works either way.
   */
  params?: unknown;
  /**
   * What to call the script in error messages.
   *
   * A file path here is worth more than any line offset: the caller recognises its own
   * filename, and a stack that names it needs no arithmetic to interpret.
   */
  sourceName?: string;
}

export interface ScriptRunResult {
  ok: boolean;
  /** The value the script returned (JSON-serialisable), or `null`. */
  result: unknown;
  logs: string[];
  /**
   * Distinct commands this script actually issued, in first-seen order.
   *
   * The MCP surface uses this to promote the commands a session really works in to
   * first-class tools, so the tool list tracks the work rather than the whole
   * catalogue. A dry run reports the same list, which is the point: a dry run is how
   * you find out what a script is going to touch.
   */
  commands: string[];
  /** Present only when `ok` is false. */
  error?: string;
  /** Machine-readable command/script error code when one is available. */
  code?: string;
  /** Structured source location and failure phase for diagnostics. */
  errorInfo?: ScriptErrorInfo;
}

export interface ScriptPluginResult {
  ok: boolean;
  name: string;
  /** Names of the commands the plugin registered. */
  commands: string[];
  logs: string[];
  error?: string;
  errorInfo?: ScriptErrorInfo;
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
      err.command = command;
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

  // High-level drawing helpers. These deliberately stay in the sandbox context and
  // go through exec, so they inherit command defaults, schema validation, transactions,
  // and the same undo/rollback behaviour as a script that spells out exec(...).
  function drawCommand(name) {
    return function (params) { return exec(name, params); };
  }
  var draw = {
    rect: drawCommand("draw_rect"),
    line: drawCommand("draw_line"),
    ellipse: drawCommand("draw_ellipse"),
    polygon: drawCommand("draw_polygon"),
    polyline: drawCommand("draw_polyline"),
    pixels: drawCommand("draw_pixels"),
    putPixels: globalThis.putPixels,
    tile: drawCommand("set_tile"),
    tilemap: drawCommand("stroke_tilemap"),
    bake: drawCommand("paint_tilemap"),
  };
  globalThis.draw = draw;
  globalThis.strokeTilemap = function (params) { return draw.tilemap(params); };
  globalThis.paintTilemap = function (params) { return draw.bake(params); };
  globalThis.tilemaps = function () { return call("tilemaps", null); };
  globalThis.mapObjects = function () { return exec("get_map_objects", {}).objects; };
  globalThis.tileProperties = function (tile) { return exec("get_tile_properties", { tile: tile }).properties; };

  // Structured inputs for the current run. The host reassigns both names before every
  // body runs, so a script always sees the params for *this* call and never the last one.
  globalThis.__params = {};
  globalThis.params = globalThis.__params;

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
    if (def.readOnly !== undefined && typeof def.readOnly !== "boolean") {
      throw new Error("defineCommand readOnly must be a boolean when provided");
    }
    globalThis.__defs.push(def);
    return def.name;
  };

  globalThis.__api = {
    log: log,
    exec: exec,
    tryExec: tryExec,
    draw: draw,
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
    strokeTilemap: globalThis.strokeTilemap,
    paintTilemap: globalThis.paintTilemap,
    tilemaps: globalThis.tilemaps,
    mapObjects: globalThis.mapObjects,
    tileProperties: globalThis.tileProperties,
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
  /**
   * Commands issued by the script currently running, first-seen order.
   *
   * Reset per `run` so a second script does not inherit the first one's footprint.
   * A failure still reports what it got through, which is what makes the list useful
   * for recovery: the command that threw is in it.
   */
  private issued: string[] = [];

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
  run(source: string, editor: Editor, options: ScriptRunOptions = {}): ScriptRunResult {
    const sourceName = options.sourceName ?? 'source';
    runInContext('globalThis.__logs = [];', this.context, { filename: 'pixel:log-reset' });
    // Assigned as a JSON literal rather than bridged, so `params` is a plain value with
    // no host reference anywhere in it. Assigned to both names: the bootstrap binds
    // `params` to whatever `__params` held when it ran, so updating only `__params`
    // would leave a script reading the first run's value forever.
    runInContext(
      `globalThis.__params = ${JSON.stringify(options.params ?? {})};\n` +
        'globalThis.params = globalThis.__params;',
      this.context,
      { filename: 'pixel:params-reset' },
    );
    this.issued = [];
    this.stack.push(editorExecutor(editor));
    try {
      // The transaction is what makes a 50-command script a single Ctrl+Z, and what rolls
      // the document back if the script throws halfway through.
      return editor.transaction('script', () => {
        const code = `globalThis.__result = (function () {\n"use strict";\n${source}\n})();`;
        runInContext(code, this.context, { filename: 'pixel:script', timeout: this.timeoutMs });
        return { ok: true, result: this.read('globalThis.__result'), logs: this.logs(), commands: [...this.issued] };
      });
    } catch (error) {
      const errorInfo = this.describeErrorInfo(error, {
        filename: 'pixel:script',
        lineOffset: SCRIPT_SOURCE_LINE_OFFSET,
        sourceName,
        source,
      });
      return {
        ok: false,
        result: null,
        logs: this.logs(),
        commands: [...this.issued],
        error: errorInfo.message,
        code: errorInfo.code,
        errorInfo,
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

      const commands: Command[] = [];
      for (let i = 0; i < defs.length; i += 1) {
        const index = definitionStart + i;
        commands.push(
          createPluginCommand(defs[i], (ctx, params) =>
            this.invokePlugin(index, ctx.draft, registry, params),
          ),
        );
      }
      // Build every command before registering any of them. A malformed second
      // definition must not leave the first half of a failed plugin live.
      for (const command of commands) registry.register(command);

      return { ok: true, name, commands: commands.map((command) => command.name), logs: this.logs() };
    } catch (error) {
      // Do not leave a failed plugin's definitions for the next load to capture.
      runInContext(`globalThis.__defs.length = ${definitionStart};`, this.context);
      const errorInfo = this.describeErrorInfo(error, {
        filename: `${name}.js`,
        lineOffset: 0,
        sourceName: name,
        source,
      });
      return {
        ok: false,
        name,
        commands: [],
        logs: this.logs(),
        error: errorInfo.message,
        errorInfo,
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
        if (!this.issued.includes(commandName)) this.issued.push(commandName);
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
      // Keep the listing metadata-only; get_tilemap may return a large rows payload.
      case 'tilemaps':
        return sprite
          ? (sprite.tilemaps ?? []).map((tilemap) => ({
              id: tilemap.id,
              name: tilemap.name,
              width: tilemap.width,
              height: tilemap.height,
            }))
          : [];
      case 'palette':
        return sprite
          ? {
              name: sprite.palette.name,
              colors: sprite.palette.colors.map((color) => colorToHex(color, true)),
              roles: sprite.palette.roles ?? {},
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
      rig: sprite.rig
        ? {
            restFrameId: sprite.rig.restFrameId,
            parts: sprite.rig.parts.map((part) => ({ ...part, layerIds: [...part.layerIds], pivot: { ...part.pivot } })),
            poses: sprite.rig.poses.map((pose) => ({ ...pose })),
            tweens: sprite.rig.tweens.map((tween) => ({ ...tween })),
            anchorCount: sprite.rig.anchors.length,
            hitboxCount: sprite.rig.hitboxes.length,
          }
        : null,
      tileset: sprite.tileset
        ? {
            id: sprite.tileset.id,
            name: sprite.tileset.name,
            tileWidth: sprite.tileset.tileWidth,
            tileHeight: sprite.tileset.tileHeight,
            columns: sprite.tileset.columns,
            tilePropertyCount: Object.keys(sprite.tileset.tileProperties ?? {}).length,
          }
        : null,
      tilemaps: (sprite.tilemaps ?? []).map((tilemap) => ({
        id: tilemap.id,
        name: tilemap.name,
        width: tilemap.width,
        height: tilemap.height,
      })),
      mapObjects: (sprite.mapObjects ?? []).map((object) => ({
        id: object.id,
        name: object.name,
        type: object.type,
        x: object.x,
        y: object.y,
        width: object.width,
        height: object.height,
        tile: object.tile ?? null,
        propertyCount: Object.keys(object.properties).length,
      })),
    };
  }

  private describeErrorInfo(
    error: unknown,
    location: { filename: string; lineOffset: number; sourceName: string; source?: string },
  ): ScriptErrorInfo {
    const candidate =
      typeof error === 'object' && error !== null
        ? (error as {
            name?: string;
            message?: string;
            stack?: string;
            code?: string;
            command?: string;
          })
        : null;
    if (!candidate || typeof candidate.message !== 'string') {
      return {
        message: String(error),
        // A non-Error throw still has to be branchable on, or a caller cannot tell
        // "the script threw a string" from "the command failed".
        code: 'script_threw',
        phase: 'runtime',
        name: candidate?.name,
        sourceName: location.sourceName,
      };
    }

    const code = candidate.code;
    const command = candidate.command;
    const timeout = code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
    const message = timeout ? `Script timed out after ${this.timeoutMs}ms` : candidate.message;
    const commandCode =
      code === 'unknown_command' || code === 'invalid_params' || code === 'command_failed' || code === 'version_conflict';
    const phase: ScriptErrorPhase = timeout
      ? 'timeout'
      : command || commandCode
        ? 'command'
        : candidate.name === 'SyntaxError'
          ? 'parse'
          : 'runtime';

    const marker = `${location.filename}:`;
    const stackLines = candidate.stack?.split('\n') ?? [];

    /**
     * Remap one stack frame onto the caller's own line numbering and filename.
     *
     * The raw frame points inside the VM wrapper, which is arithmetic the caller cannot
     * do and does not need to: a stack that says `gen.js:43` locates the bug outright.
     */
    const remap = (frame: string): string =>
      frame.replace(
        new RegExp(`${escapeRegExp(location.filename)}:(\\d+)(:(\\d+))?`, 'g'),
        (_whole, line: string, __maybeColumn: string, column: string | undefined) =>
          `${location.sourceName}:${Math.max(1, Number(line) - location.lineOffset)}${column ? `:${column}` : ''}`,
      );
    const remappedStack = stackLines.map(remap).join('\n');

    /**
     * The offending line and its neighbours, straight from the caller's source.
     *
     * A line number alone still leaves the caller comparing against their own text; the
     * three lines together are usually enough to confirm the bug without a second run.
     */
    const excerpt = (line: number | undefined) => {
      if (line === undefined || !location.source) return {};
      const lines = location.source.split('\n');
      const index = line - 1;
      if (index < 0 || index >= lines.length) return {};
      return {
        sourceLine: lines[index],
        ...(index > 0 ? { before: lines[index - 1] } : {}),
        ...(index < lines.length - 1 ? { after: lines[index + 1] } : {}),
      };
    };

    const common = {
      message,
      // Every failure carries a code. A plain TypeError used to arrive with none, which
      // put it in a different class from every command failure for no good reason.
      code: code ?? (phase === 'parse' ? 'script_parse_error' : 'script_threw'),
      phase,
      name: candidate.name,
      ...(remappedStack ? { stack: remappedStack } : {}),
      sourceName: location.sourceName,
      ...(command ? { command } : {}),
    };

    if (phase === 'parse' && stackLines[0]?.startsWith(marker)) {
      const match = stackLines[0].slice(marker.length).match(/^(\d+)(?::(\d+))?/);
      if (match) {
        const caret = stackLines.find((line, index) => index > 0 && /^\s*\^/.test(line));
        const line = Math.max(1, Number(match[1]) - location.lineOffset);
        return {
          ...common,
          line,
          column: caret ? caret.indexOf('^') + 1 : match[2] ? Math.max(1, Number(match[2])) : undefined,
          ...excerpt(line),
        };
      }
    }

    for (const stackLine of stackLines) {
      if (!/^\s*at\s/.test(stackLine)) continue;
      const markerAt = stackLine.indexOf(marker);
      if (markerAt < 0) continue;
      const match = stackLine.slice(markerAt + marker.length).match(/^(\d+):(\d+)/);
      if (!match) continue;
      const line = Math.max(1, Number(match[1]) - location.lineOffset);
      return {
        ...common,
        line,
        column: Math.max(1, Number(match[2])),
        ...excerpt(line),
      };
    }

    return common;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
