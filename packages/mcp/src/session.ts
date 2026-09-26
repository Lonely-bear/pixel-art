/**
 * In-memory document store for the MCP server.
 *
 * An MCP session is conversational: the model opens a document, makes a dozen
 * small edits, looks at the result, and iterates. Making the model pass a file
 * path on every call would be noise, so documents live in memory and are
 * addressed by a short id. Exactly one document is *active*; tools that edit
 * pixels default to it, which keeps the common case to a single argument.
 *
 * The store deliberately owns nothing but the editor: every mutation still goes
 * through `Editor` so undo history, versioning and `expectedVersion` checks
 * apply to agent edits exactly as they do to GUI edits.
 */
import {
  allCommands,
  clipRect,
  createEditor,
  createMutableRegistry,
  createPalette,
  createSprite,
  deserializeSprite,
  makeId,
  serializeSprite,
  type Editor,
  type MutableCommandRegistry,
  type Palette,
  type Rect,
  type Sprite,
} from '@pixel/core';

/**
 * A region of the canvas the user has boxed in the app.
 *
 * Session state, never artwork: it is not part of `Sprite`, so it cannot reach the
 * `.pixel` file, an export, or a spritesheet. It lives on the document in this one
 * shared store precisely so that the window that drew it and the agent that has to
 * respect it are looking at the same object.
 */
export interface SelectionState {
  /** Canvas-pixel rect, always normalised so `w`/`h` are positive. */
  rect: { x: number; y: number; w: number; h: number };
  /** The layer the user was on when they drew the box. */
  layerId?: string;
  /** The frame the user was on. */
  frameId?: string;
  /**
   * `hint` tells the agent where the subject is and leaves it free to write just
   * outside when the edit needs room. `enforce` also confines its writes.
   *
   * The default is `hint` on purpose: "the head in my selection is too small, make it
   * bigger" is the case this feature exists for, and a hard clip would cut the edit off
   * at the box edge. `enforce` is there for the other case, cleaning up a known area
   * without touching anything else.
   */
  mode: 'hint' | 'enforce';
  updatedAt: number;
}

export interface PixelDocument {
  id: string;
  name: string;
  /** Where the document was loaded from / last saved to, if anywhere. */
  path?: string;
  editor: Editor;
  createdAt: number;
  updatedAt: number;
  /** True once a command has run since the last save. */
  dirty: boolean;
  /** The user's current box, if any. Session state; see {@link SelectionState}. */
  selection?: SelectionState;
}

export interface CreateDocumentOptions {
  width: number;
  height: number;
  name?: string;
  /** Layer names, bottom first. */
  layers?: string[];
  frames?: number;
  frameDurationMs?: number;
  /**
   * A palette object, a list of hex colours, or the name of a built-in palette
   * (see `BUILTIN_PALETTES`).
   */
  palette?: PaletteInput;
  background?: string | null;
  /** Snap every painted colour to the nearest palette swatch. */
  paletteLocked?: boolean;
  path?: string;
  id?: string;
  /** Make the new document active. Defaults to true. */
  select?: boolean;
}

export type PaletteInput = readonly string[] | Palette | string;

function isPalette(value: unknown): value is Palette {
  return typeof value === 'object' && value !== null && Array.isArray((value as Palette).colors);
}

function normalizePaletteInput(input: PaletteInput | undefined, name: string): Palette | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'string') {
    const preset = resolveBuiltinPalette(input);
    if (!preset) {
      throw new Error(
        `Unknown palette "${input}". Built-in palettes: ${Object.keys(BUILTIN_PALETTES).join(', ')}.`,
      );
    }
    return preset;
  }
  if (isPalette(input)) return input;
  return createPalette(name, input);
}

export interface DocumentSummary {
  id: string;
  name: string;
  path?: string;
  width: number;
  height: number;
  /** Number of layers in the stack. The layer *array* is on `describeSprite`, not here. */
  layerCount: number;
  /** Number of animation frames. */
  frameCount: number;
  /** Number of animation tags. */
  tagCount: number;
  version: number;
  dirty: boolean;
  active: boolean;
  /** The session's current focus; explicit document reads do not change it. */
  activeDocumentId: string | null;
}

/**
 * Built-in palettes an agent can ask for by name. Small, opinionated and
 * hand-picked for game art: they constrain the model to colours that already
 * look good together, which is worth more than any amount of prompting.
 */
export const BUILTIN_PALETTES: Record<string, readonly string[]> = {
  dawnbringer16: [
    '#140c1c', '#442434', '#30346d', '#4e4a4e', '#854c30', '#346524', '#d04648', '#757161',
    '#597dce', '#d27d2c', '#8595a1', '#6daa2c', '#d2aa99', '#6dc2ca', '#dad45e', '#deeed6',
  ],
  // Aseprite's default "PICO-8"-style 16 colour ramp, useful for tiny sprites.
  pico8: [
    '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
    '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
  ],
  // A general-purpose 16 colour ramp: two greys, then saturated hues.
  gameboy: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  endesga16: [
    '#e4a672', '#b86f50', '#743f39', '#3f2832', '#9e2835', '#e53b44', '#fb922b', '#ffe762',
    '#63c64d', '#327345', '#193d3f', '#4f6781', '#afbfd2', '#ffffff', '#2ce8f4', '#0484d1',
  ],
};

export function resolveBuiltinPalette(name: string): Palette | undefined {
  const colors = BUILTIN_PALETTES[name.toLowerCase().replace(/[\s_-]/g, '')];
  return colors ? createPalette(name, colors) : undefined;
}

export class DocumentStore {
  private readonly documents = new Map<string, PixelDocument>();
  private activeId: string | null = null;
  private readonly changeListeners = new Set<() => void>();

  /**
   * One command registry for the whole session, shared by every document's editor.
   *
   * It is mutable so a plugin loaded at runtime makes its commands visible to the tool
   * list, the command catalogue and every open document at once — without rebuilding
   * editors or reloading documents.
   */
  readonly registry: MutableCommandRegistry = createMutableRegistry(allCommands);

  /** Create a blank sprite and register it. */
  create(options: CreateDocumentOptions): PixelDocument {
    const palette = normalizePaletteInput(
      options.palette,
      options.name ? `${options.name} palette` : 'Palette',
    );

    const sprite = createSprite({
      width: options.width,
      height: options.height,
      name: options.name,
      layers: options.layers,
      frames: options.frames,
      frameDurationMs: options.frameDurationMs,
      palette,
      background: options.background ?? null,
      paletteLocked: options.paletteLocked,
    });
    return this.add(sprite, { path: options.path, id: options.id, select: options.select });
  }

  /** Register an existing sprite (e.g. one just imported or deserialized). */
  add(sprite: Sprite, options: { path?: string; id?: string; select?: boolean } = {}): PixelDocument {
    const now = Date.now();
    const doc: PixelDocument = {
      id: options.id ?? makeId('doc'),
      name: sprite.name,
      path: options.path,
      editor: createEditor(sprite, this.registry),
      createdAt: now,
      updatedAt: now,
      dirty: false,
    };
    this.documents.set(doc.id, doc);
    if (options.select !== false) this.activeId = doc.id;
    this.announce();
    return doc;
  }

  /** Load a `.pixel` file from bytes. */
  load(bytes: Uint8Array, options: { path?: string; select?: boolean } = {}): PixelDocument {
    const sprite = deserializeSprite(bytes);
    return this.add(sprite, options);
  }

  /** Serialize a document back to `.pixel` bytes. */
  save(doc: PixelDocument): Uint8Array {
    const bytes = serializeSprite(doc.editor.sprite);
    this.markSaved(doc);
    return bytes;
  }

  /** Update session bookkeeping after an export plan has written every file successfully. */
  markSaved(doc: PixelDocument): void {
    doc.name = doc.editor.sprite.name;
    doc.dirty = false;
    doc.updatedAt = Date.now();
    this.announce();
  }

  list(): PixelDocument[] {
    return [...this.documents.values()];
  }

  get(id: string): PixelDocument | undefined {
    return this.documents.get(id);
  }

  get active(): PixelDocument | undefined {
    return this.activeId ? this.documents.get(this.activeId) : undefined;
  }

  get activeDocumentId(): string | null {
    return this.activeId;
  }

  /**
   * Subscribe to every change in the store, whatever caused it.
   *
   * The store is deliberately shared, so a consumer that renders from it has to
   * hear about edits made by *any* client - a second window, an agent, a script,
   * a plugin. Announcing from the store rather than from each caller is what
   * makes that true: an agent used to write pixels into the live document with
   * no notification at all, so the window kept showing a stale canvas until the
   * file was reopened. Returns an unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Tell every subscriber that the store moved. A throwing subscriber must not
   * abort the mutation that triggered it, nor stop the other subscribers.
   */
  private announce(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch {
        // Deliberately ignored: a broken listener is not a failed edit.
      }
    }
  }

  select(id: string): PixelDocument {
    const doc = this.require(id);
    this.activeId = id;
    this.announce();
    return doc;
  }

  /**
   * Resolve a document reference. `undefined` means "the active document",
   * which is the common case; every tool therefore accepts an optional id.
   */
  require(id?: string): PixelDocument {
    if (id) {
      const doc = this.documents.get(id);
      if (!doc) {
        throw new Error(
          `Unknown document: ${id}. Known documents: ${this.list().map((d) => d.id).join(', ') || '(none)'}`,
        );
      }
      return doc;
    }
    const active = this.active;
    if (!active) {
      throw new Error('No active document. Create one with `create_document` or open one with `open_document`.');
    }
    return active;
  }

  remove(id: string): boolean {
    const existed = this.documents.delete(id);
    if (this.activeId === id) {
      const next = [...this.documents.keys()][0] ?? null;
      this.activeId = next;
    }
    if (existed) this.announce();
    return existed;
  }

  /** Mark a document as modified after a successful command. */
  touch(doc: PixelDocument, dirty = true): void {
    doc.updatedAt = Date.now();
    if (dirty) doc.dirty = true;
    this.announce();
  }

  /**
   * Record the box the user drew, clipped to the canvas. Pass `null` to clear it.
   *
   * The rect is normalised and clipped here rather than at each read, because it
   * arrives from a mouse drag that can run backwards and off the edge. A drag that
   * covered no pixel at all - a click, or a swipe that started outside the canvas -
   * clears the selection instead of storing a zero-area rect, so an agent never gets
   * handed a region it cannot draw into. A one-pixel drag is a real selection and is
   * kept.
   */
  setSelection(
    doc: PixelDocument,
    input: { rect: Rect; layerId?: string; frameId?: string; mode?: SelectionState['mode'] } | null,
  ): SelectionState | undefined {
    if (!input) {
      const had = doc.selection !== undefined;
      delete doc.selection;
      if (had) this.announce();
      return undefined;
    }
    const rect = clipRect(input.rect, doc.editor.sprite.width, doc.editor.sprite.height);
    if (rect.w <= 0 || rect.h <= 0) return this.setSelection(doc, null);
    const next: SelectionState = {
      rect,
      layerId: input.layerId,
      frameId: input.frameId,
      // An existing box keeps the mode the user chose for it; a new one starts as a
      // hint, which is the safe default because it cannot truncate an edit.
      mode: input.mode ?? doc.selection?.mode ?? 'hint',
      updatedAt: Date.now(),
    };
    doc.selection = next;
    this.announce();
    return next;
  }

  /**
   * The current box, or `undefined` when the user has not made one.
   *
   * Validated on the way out rather than on the way in, because a layer or frame can
   * be deleted by a command that never touches the store, and the reader is the only
   * place that is guaranteed to run. A box naming a layer that no longer exists is
   * worse than no box at all: an agent would act on the wrong pixels.
   */
  selection(doc: PixelDocument): SelectionState | undefined {
    const selection = doc.selection;
    if (!selection) return undefined;
    const { sprite } = doc.editor;
    const layerGone =
      selection.layerId !== undefined && !sprite.layers.some((l) => l.id === selection.layerId);
    const frameGone =
      selection.frameId !== undefined && !sprite.frames.some((f) => f.id === selection.frameId);
    if (layerGone || frameGone) {
      this.setSelection(doc, null);
      return undefined;
    }
    return selection;
  }

  summary(doc: PixelDocument): DocumentSummary {
    const sprite = doc.editor.sprite;
    return {
      id: doc.id,
      name: sprite.name,
      path: doc.path,
      width: sprite.width,
      height: sprite.height,
      layerCount: sprite.layers.length,
      frameCount: sprite.frames.length,
      tagCount: sprite.tags.length,
      version: doc.editor.version,
      dirty: doc.dirty,
      active: doc.id === this.activeId,
      activeDocumentId: this.activeId,
    };
  }

  clear(): void {
    this.documents.clear();
    this.activeId = null;
    this.announce();
  }
}
