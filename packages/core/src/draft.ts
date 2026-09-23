import { PixelBuffer } from './buffer.js';
import { cloneSpriteStructure, getFrame, type Sprite } from './document.js';
import type { Palette } from './palette.js';
import type { FrameId, LayerId, TilemapId } from './types.js';

/**
 * The mutable view a command operates on, plus the machinery that makes undo cheap.
 *
 * Constructing a `Draft` takes a shallow structural snapshot (`before`) and a working
 * copy (`sprite`). Commands mutate `sprite` freely — arrays, layer objects, palette
 * entries, tags — because the snapshot owns its own copies of all of those.
 *
 * The **only** thing commands must not mutate in place is pixel data, because buffers
 * are shared by reference between `before` and `sprite`. Use `cel()`, `tilesetImage()`
 * and `tilemapData()` to get copy-on-write access.
 */
export class Draft {
  /** Snapshot taken before any mutation. Becomes the undo state. */
  readonly before: Sprite;
  /** The working copy that commands mutate. */
  readonly sprite: Sprite;

  private readonly ownedBuffers = new WeakSet<PixelBuffer>();
  private readonly ownedTilemapData = new WeakSet<Int32Array>();

  constructor(sprite: Sprite) {
    this.before = cloneSpriteStructure(sprite);
    this.sprite = cloneSpriteStructure(sprite);
  }

  /**
   * Copy-on-write access to a cel. Creates a transparent cel when absent.
   *
   * Repeated calls for the same cel return the same buffer, so a command can hold onto
   * it across several draw operations without cloning each time.
   */
  cel(layerId: LayerId, frameId: FrameId, create = true): PixelBuffer | undefined {
    const frame = getFrame(this.sprite, frameId);
    const existing = frame.cels.get(layerId);
    if (!existing) {
      if (!create) return undefined;
      const buf = new PixelBuffer(this.sprite.width, this.sprite.height);
      frame.cels.set(layerId, buf);
      this.ownedBuffers.add(buf);
      return buf;
    }
    if (this.ownedBuffers.has(existing)) return existing;
    const copy = existing.clone();
    frame.cels.set(layerId, copy);
    this.ownedBuffers.add(copy);
    return copy;
  }

  /** Copy-on-write access to one layer's cel on *every* frame it exists on. */
  celsAllFrames(layerId: LayerId): { frameId: FrameId; buffer: PixelBuffer }[] {
    const result: { frameId: FrameId; buffer: PixelBuffer }[] = [];
    for (const frame of this.sprite.frames) {
      const buf = this.cel(layerId, frame.id, false);
      if (buf) result.push({ frameId: frame.id, buffer: buf });
    }
    return result;
  }

  /** Every existing cel across all layers and frames, copy-on-write. */
  allCels(): { layerId: LayerId; frameId: FrameId; buffer: PixelBuffer }[] {
    const result: { layerId: LayerId; frameId: FrameId; buffer: PixelBuffer }[] = [];
    for (const frame of this.sprite.frames) {
      for (const layer of this.sprite.layers) {
        const buf = this.cel(layer.id, frame.id, false);
        if (buf) result.push({ layerId: layer.id, frameId: frame.id, buffer: buf });
      }
    }
    return result;
  }

  /** The palette is already a private copy; mutate it directly. */
  palette(): Palette {
    return this.sprite.palette;
  }

  /** Copy-on-write access to the tileset image. */
  tilesetImage(): PixelBuffer | undefined {
    const tileset = this.sprite.tileset;
    if (!tileset) return undefined;
    if (this.ownedBuffers.has(tileset.image)) return tileset.image;
    const copy = tileset.image.clone();
    tileset.image = copy;
    this.ownedBuffers.add(copy);
    return copy;
  }

  /** Copy-on-write access to a tilemap's tile-index array. */
  tilemapData(tilemapId: TilemapId): Int32Array | undefined {
    const tilemap = this.sprite.tilemaps?.find((t) => t.id === tilemapId);
    if (!tilemap) return undefined;
    if (this.ownedTilemapData.has(tilemap.data)) return tilemap.data;
    const copy = tilemap.data.slice();
    tilemap.data = copy;
    this.ownedTilemapData.add(copy);
    return copy;
  }
}
