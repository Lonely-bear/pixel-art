import type { Command, CommandSummary } from './commands/types.js';
import { cloneSpriteDeep, type Sprite } from './document.js';
import { Draft } from './draft.js';

/**
 * The command bus.
 *
 * Every mutation in the product funnels through `applyCommand`. That single choke point
 * is what makes undo/redo, replayable AI sessions, IPC validation and the MCP tool
 * surface all fall out of one mechanism instead of four parallel implementations.
 *
 * Undo entries hold *shallow structural snapshots*. Commands copy-on-write pixel data,
 * so an entry costs O(frames x layers) pointers — not a copy of every image.
 */

export interface UndoEntry {
  /** Human-readable label, e.g. `AI: drew the slime body`. */
  label: string;
  command: string;
  params: unknown;
  summary: CommandSummary;
  before: Sprite;
  after: Sprite;
  /** Document version the entry was created from. */
  version: number;
}

export interface EditorState {
  sprite: Sprite;
  /**
   * Monotonic counter, bumped by every mutation *including undo/redo*.
   * Clients pass the version they last saw to detect concurrent edits.
   */
  version: number;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
}

export interface CommandRegistry {
  get(name: string): Command | undefined;
  has(name: string): boolean;
  names(): string[];
  list(): Command[];
}

export function createRegistry(commands: readonly Command[]): CommandRegistry {
  const map = new Map<string, Command>();
  for (const command of commands) {
    if (map.has(command.name)) throw new Error(`Duplicate command name: ${command.name}`);
    map.set(command.name, command);
  }
  return {
    get: (name) => map.get(name),
    has: (name) => map.has(name),
    names: () => [...map.keys()],
    list: () => [...map.values()],
  };
}

/**
 * A registry that can grow at runtime, which is what plugins need.
 *
 * Every editor in a session shares one of these, so loading a plugin makes its
 * commands visible to the CLI catalogue, the MCP tool list and any in-flight
 * document at once — without rebuilding editors or reloading documents.
 */
export interface MutableCommandRegistry extends CommandRegistry {
  /** Add a command. Throws on a duplicate name, so a plugin cannot shadow a built-in. */
  register(command: Command): void;
  /** Remove a command by name. Returns whether it was there. */
  unregister(name: string): boolean;
}

export function createMutableRegistry(commands: readonly Command[] = []): MutableCommandRegistry {
  const map = new Map<string, Command>();
  const add = (command: Command): void => {
    if (map.has(command.name)) throw new Error(`Duplicate command name: ${command.name}`);
    map.set(command.name, command);
  };
  for (const command of commands) add(command);
  return {
    get: (name) => map.get(name),
    has: (name) => map.has(name),
    names: () => [...map.keys()],
    list: () => [...map.values()],
    register: add,
    unregister: (name) => map.delete(name),
  };
}

export const DEFAULT_HISTORY_LIMIT = 200;

export function createEditorState(sprite: Sprite): EditorState {
  return { sprite, version: 1, undoStack: [], redoStack: [] };
}

export type CommandErrorCode =
  | 'unknown_command'
  | 'invalid_params'
  | 'command_failed'
  | 'version_conflict';

/**
 * A command failure with a machine-readable code.
 *
 * These codes matter for AI agents: `unknown_command` means "re-read the tool list",
 * `invalid_params` means "fix your arguments", `command_failed` means "the operation
 * was rejected by the document" — three very different recovery strategies.
 */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: CommandErrorCode,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export interface ApplyOptions {
  label?: string;
  historyLimit?: number;
  /**
   * Optimistic concurrency guard. When set, the command is rejected with a
   * `version_conflict` error unless the document is exactly at this version.
   *
   * Concurrent clients (several agents, or an agent racing the GUI) read a
   * version with one call and pass it back with the next write, so a stale
   * edit is reported instead of silently clobbering someone else's work.
   */
  expectedVersion?: number;
}

/**
 * Turn a schema-validation failure into a short, readable line.
 *
 * A zod error's `message` is a JSON dump of every branch of every union it tried,
 * which is unreadable to an agent (and gets truncated to uselessness downstream).
 * The `issues` array, on the other hand, names the offending path and reason, so we
 * render a handful of those as `path: message` instead.
 */
export function describeParseError(error: unknown): string {
  const issues = (
    error as { issues?: Array<{ path?: Array<string | number>; message?: string; code?: string }> }
  )?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const parts = issues.slice(0, 4).map((issue) => {
      const path = issue.path && issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message ?? issue.code ?? 'invalid'}`;
    });
    const extra = issues.length > 4 ? ` (+${issues.length - 4} more)` : '';
    return parts.join('; ') + extra;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Apply a command and hand back both the new state and the command's summary.
 *
 * Read-only commands return the state unchanged: asking a question must not push an
 * undo entry, bump the version, or discard the redo stack.
 */
export function applyCommandWithSummary(
  state: EditorState,
  registry: CommandRegistry,
  name: string,
  params: unknown,
  opts: ApplyOptions = {},
): { state: EditorState; summary: CommandSummary } {
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== state.version) {
    throw new CommandError(
      `Version conflict: expected version ${opts.expectedVersion} but the document is at ${state.version}`,
      'version_conflict',
      { expected: opts.expectedVersion, actual: state.version },
    );
  }

  const command = registry.get(name);
  if (!command) {
    throw new CommandError(`Unknown command: ${name}`, 'unknown_command', {
      available: registry.names(),
    });
  }

  let parsed: unknown;
  try {
    parsed = command.params.parse(params ?? {});
  } catch (error) {
    throw new CommandError(
      `Invalid parameters for ${name}: ${describeParseError(error)}`,
      'invalid_params',
      error,
    );
  }

  const draft = new Draft(state.sprite);
  let summary: CommandSummary;
  try {
    summary = command.apply({ draft, sprite: draft.sprite }, parsed) ?? {};
  } catch (error) {
    throw new CommandError(
      `Command ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      'command_failed',
      error,
    );
  }

  // A read-only command is a question, not an edit. Answering it must not push an
  // undo entry, bump the version, or discard the redo stack.
  if (command.readOnly) {
    return { state, summary };
  }

  const limit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const entry: UndoEntry = {
    label: opts.label ?? name,
    command: name,
    params: parsed,
    summary,
    before: draft.before,
    after: draft.sprite,
    version: state.version,
  };

  const undoStack = [...state.undoStack, entry];
  if (undoStack.length > limit) undoStack.splice(0, undoStack.length - limit);

  return {
    state: { sprite: draft.sprite, version: state.version + 1, undoStack, redoStack: [] },
    summary,
  };
}

/** Convenience wrapper for callers that only care about the new state. */
export function applyCommand(
  state: EditorState,
  registry: CommandRegistry,
  name: string,
  params: unknown,
  opts: ApplyOptions = {},
): EditorState {
  return applyCommandWithSummary(state, registry, name, params, opts).state;
}

/**
 * Apply a command onto an *existing* draft, without touching undo or versioning.
 *
 * This is how a plugin command expands into built-in commands: the plugin runs inside
 * the same `Draft` as the command that invoked it, so one undo entry covers the whole
 * expansion. It is not a public editing entry point — the editor is.
 */
export function applyCommandToDraft(
  draft: Draft,
  registry: CommandRegistry,
  name: string,
  params: unknown,
): CommandSummary {
  const command = registry.get(name);
  if (!command) {
    throw new CommandError(`Unknown command: ${name}`, 'unknown_command', {
      available: registry.names(),
    });
  }
  let parsed: unknown;
  try {
    parsed = command.params.parse(params ?? {});
  } catch (error) {
    throw new CommandError(
      `Invalid parameters for ${name}: ${describeParseError(error)}`,
      'invalid_params',
      error,
    );
  }
  try {
    return command.apply({ draft, sprite: draft.sprite }, parsed) ?? {};
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(
      `Command ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      'command_failed',
      error,
    );
  }
}

export function canUndo(state: EditorState): boolean {
  return state.undoStack.length > 0;
}

export function canRedo(state: EditorState): boolean {
  return state.redoStack.length > 0;
}

export function undo(state: EditorState): EditorState {
  if (!state.undoStack.length) return state;
  const entry = state.undoStack[state.undoStack.length - 1];
  return {
    sprite: entry.before,
    version: state.version + 1,
    undoStack: state.undoStack.slice(0, -1),
    redoStack: [...state.redoStack, entry],
  };
}

export function redo(state: EditorState): EditorState {
  if (!state.redoStack.length) return state;
  const entry = state.redoStack[state.redoStack.length - 1];
  return {
    sprite: entry.after,
    version: state.version + 1,
    undoStack: [...state.undoStack, entry],
    redoStack: state.redoStack.slice(0, -1),
  };
}

/**
 * An editing session: a sprite, a version counter and an undo history.
 *
 * The Electron renderer, the CLI and the MCP server each hold one of these. Because the
 * version counter is bumped by every mutation, a client can pass the version it last saw
 * and be told to re-read rather than silently clobbering a concurrent edit.
 */
export class Editor {
  private current: EditorState;

  constructor(
    sprite: Sprite,
    readonly registry: CommandRegistry,
    private readonly options: { historyLimit?: number } = {},
  ) {
    this.current = createEditorState(sprite);
  }

  get state(): EditorState {
    return this.current;
  }

  get sprite(): Sprite {
    return this.current.sprite;
  }

  get version(): number {
    return this.current.version;
  }

  /** Run a command. Throws `CommandError` when the command or its parameters are bad. */
  execute(name: string, params: unknown = {}, opts: ApplyOptions = {}): CommandSummary {
    const { state, summary } = applyCommandWithSummary(
      this.current,
      this.registry,
      name,
      params,
      {
        ...opts,
        historyLimit: opts.historyLimit ?? this.options.historyLimit,
      },
    );
    this.current = state;
    return summary;
  }

  /** Run a command, returning the failure instead of throwing — the shape a tool result wants. */
  tryExecute(
    name: string,
    params: unknown = {},
    opts: ApplyOptions = {},
  ): { ok: true; summary: CommandSummary } | { ok: false; error: string; code: CommandErrorCode } {
    try {
      return { ok: true, summary: this.execute(name, params, opts) };
    } catch (error) {
      const code: CommandErrorCode =
        error instanceof CommandError ? error.code : 'command_failed';
      return { ok: false, error: error instanceof Error ? error.message : String(error), code };
    }
  }

  /**
   * Run a batch of work as a single undo step.
   *
   * A script may issue dozens of commands; the user should undo the whole script with one
   * Ctrl+Z, not step back through every draw. Every command the callback runs through
   * `execute` is collapsed into one entry, and the redo stack is dropped — exactly as if
   * the whole batch were one command. If the callback throws, the document is rolled back
   * to where it started, so a half-finished script never leaves a partial edit behind.
   */
  transaction<T>(label: string, fn: () => T): T {
    const before = this.current;
    const depth = before.undoStack.length;

    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.current = before;
      throw error;
    }

    const after = this.current;
    // Nothing mutated: leave the history alone, so a read-only script does not create an
    // empty undo step or discard the redo stack.
    if (after.sprite === before.sprite && after.undoStack.length === depth) return result;

    const entry: UndoEntry = {
      label,
      command: 'transaction',
      params: {},
      summary: { steps: Math.max(0, after.undoStack.length - depth) },
      before: before.sprite,
      after: after.sprite,
      version: before.version,
    };

    const limit = this.options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    const undoStack = [...before.undoStack, entry];
    if (undoStack.length > limit) undoStack.splice(0, undoStack.length - limit);

    this.current = {
      sprite: after.sprite,
      version: after.version,
      undoStack,
      redoStack: [],
    };
    return result;
  }

  undo(): this {
    this.current = undo(this.current);
    return this;
  }

  redo(): this {
    this.current = redo(this.current);
    return this;
  }

  canUndo(): boolean {
    return canUndo(this.current);
  }

  canRedo(): boolean {
    return canRedo(this.current);
  }

  history(): { label: string; command: string; summary: CommandSummary }[] {
    return this.current.undoStack.map((entry) => ({
      label: entry.label,
      command: entry.command,
      summary: entry.summary,
    }));
  }

  /** Swap in a different sprite (e.g. after opening a file). Resets history. */
  load(sprite: Sprite): this {
    this.current = createEditorState(sprite);
    return this;
  }

  /** Deep copy of the current sprite, safe to serialise or hand to another thread. */
  snapshot(): Sprite {
    return cloneSpriteDeep(this.current.sprite);
  }
}
