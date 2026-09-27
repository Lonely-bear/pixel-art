/**
 * Recipes -> bus commands.
 *
 * Every op in a corpus recipe becomes exactly one `Editor.execute` call, and nothing here reads
 * or writes the document model directly. That is the same rule `pixel demo` follows and for the
 * same reason: a sprite built by poking `draft.cel()` would be a sprite the command surface has
 * never been tested against, so the corpus would be measuring the analyzer on pixels the product
 * cannot produce. It would also fork the drawing semantics — a `draw_rect` with `fill: true` and
 * a hand-written `for` loop over a `PixelBuffer` disagree the moment either one of them changes.
 *
 * A layer is named by the recipe and resolved by the command, never by index: an op that said
 * "layer 2" would mean a different layer the moment a case added a layer above it, and the diff
 * would look like a one-line change to a case's meaning.
 */

import type { Editor, Point, Rect } from '../../packages/core/src/index.js';
import type { RecipeOp } from './format.js';

/**
 * Run one op, and fail loudly if it did not run.
 *
 * A corpus that silently swallowed a failed command would be a corpus measuring nothing: the case
 * would materialise as a nearly-empty canvas, the analyzer would confidently report on it, and
 * the expectation would then be "updated" to match. That is the failure `demo.ts` refuses, for
 * the same reason — a person looking at a picture has to be able to assume the engine drew it.
 *
 * The message names the op index, the op, and the command, because "corpus: a command failed" in
 * a sixty-case run is a needle in a haystack and a regeneration cost.
 */
function step(
  editor: Editor,
  index: number,
  op: RecipeOp['op'],
  command: string,
  params: Record<string, unknown>,
): void {
  const result = editor.tryExecute(command, params);
  if (!result.ok) {
    throw new Error(
      `corpus: ops[${index}] "${op}" -> ${command} failed (${result.code}): ${result.error}`,
    );
  }
}

function toPoint(pair: readonly [number, number]): Point {
  return { x: pair[0], y: pair[1] };
}

function toRect(rect: readonly [number, number, number, number]): Rect {
  return { x: rect[0], y: rect[1], w: rect[2], h: rect[3] };
}

/** The whole canvas as a rect, for the one op that needs a region and means all of it. */
function fullCanvas(editor: Editor): Rect {
  return { x: 0, y: 0, w: editor.sprite.width, h: editor.sprite.height };
}

/** `paint` is the shared shape of the five colour-carrying draw ops; a `switch` would repeat it five times. */
type PaintOp = Extract<RecipeOp, { color: unknown }>;

/**
 * Run every op in a recipe, in order.
 *
 * Order is the recipe's order and nothing reorders it, because a shading pass that lands before
 * its base is not a shading pass. A recipe is a sequence of edits an artist would recognise, and
 * reordering it silently would make a case mean something its spec does not say.
 */
export function applyRecipe(editor: Editor, ops: readonly RecipeOp[]): void {
  ops.forEach((op, index) => applyOp(editor, op, index));
}

/** One op. Exported so a test can drive a single op without a whole document. */
export function applyOp(editor: Editor, op: RecipeOp, index: number): void {
  if (op.op === 'duplicateFrame') {
    step(editor, index, op.op, 'duplicate_frame', {
      frame: op.frame ?? 0,
      ...(op.count === undefined ? {} : { count: op.count }),
    });
    return;
  }
  if (op.op === 'translate') {
    step(editor, index, op.op, 'translate', {
      layer: op.layer,
      frame: op.frame,
      dx: op.dx,
      dy: op.dy,
    });
    return;
  }
  if (op.op === 'tag') {
    step(editor, index, op.op, 'add_tag', {
      name: op.name,
      from: op.from,
      to: op.to,
      ...(op.direction === undefined ? {} : { direction: op.direction }),
      ...(op.repeat === undefined ? {} : { repeat: op.repeat }),
    });
    return;
  }
  if (op.op === 'quantize') {
    step(editor, index, op.op, 'quantize_to_palette', { dither: 'none' });
    return;
  }
  if (op.op === 'clear') {
    // `clear_region` over the whole canvas, named explicitly rather than relying on the command's
    // "omit the rect to clear everything" default: a recipe that depends on a default is a recipe
    // that silently changes meaning when the default does.
    step(editor, index, op.op, 'clear_region', { layer: op.layer, frame: op.frame ?? 0, rect: fullCanvas(editor) });
    return;
  }
  if (op.op === 'erase') {
    // `draw_rect` with a null colour, which is the product's own way of cutting a hole — a shape
    // with a transparent window in it rather than a shape drawn around one.
    step(editor, index, op.op, 'draw_rect', {
      layer: op.layer,
      frame: op.frame ?? 0,
      rect: toRect(op.rect),
      color: null,
      fill: true,
    });
    return;
  }

  const paint = op as PaintOp;
  const layer = paint.layer;
  const frame = paint.frame ?? 0;
  const color = paint.color;
  switch (paint.op) {
    case 'rect':
      step(editor, index, paint.op, 'draw_rect', {
        layer,
        frame,
        rect: toRect(paint.rect),
        color,
        ...(paint.fill === undefined ? {} : { fill: paint.fill }),
      });
      return;
    case 'ellipse':
      step(editor, index, paint.op, 'draw_ellipse', {
        layer,
        frame,
        rect: toRect(paint.rect),
        color,
        ...(paint.fill === undefined ? {} : { fill: paint.fill }),
      });
      return;
    case 'polygon':
      step(editor, index, paint.op, 'draw_polygon', {
        layer,
        frame,
        points: paint.points.map(toPoint),
        color,
        fill: true,
      });
      return;
    case 'polyline':
      step(editor, index, paint.op, 'draw_polyline', {
        layer,
        frame,
        points: paint.points.map(toPoint),
        color,
        ...(paint.width === undefined ? {} : { width: paint.width }),
      });
      return;
    case 'pixels':
      // One batched call rather than one per pixel: `draw_pixels` takes a sparse list, and 18
      // round trips to draw a diagonal is both slower and a worse description of what happened.
      step(editor, index, paint.op, 'draw_pixels', {
        layer,
        frame,
        pixels: paint.points.map(([x, y]) => ({ x, y, color })),
      });
      return;
    case 'outline':
      step(editor, index, paint.op, 'outline', {
        layer,
        frame,
        color,
        ...(paint.scope === undefined ? {} : { scope: paint.scope }),
        ...(paint.mode === undefined ? {} : { mode: paint.mode }),
      });
      return;
    case 'rows':
      // One filled rect per row rather than one polygon over the whole table. A polygon samples
      // scanlines at pixel centres, so a row table closed into a polygon loses its last row and
      // shifts both ends by half a pixel — which `demo.ts` compensates for with a sacrificial row,
      // and a corpus case must not have to think about. `rows` is the shape a case means and this
      // is the shape that draws it.
      for (const [left, right, y] of paint.rows) {
        step(editor, index, paint.op, 'draw_rect', {
          layer,
          frame,
          rect: { x: left, y, w: right - left + 1, h: 1 },
          color,
          fill: true,
        });
      }
      return;
  }
}
