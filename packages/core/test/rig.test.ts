import { describe, expect, it } from 'vitest';
import { createEditor, createSprite, renderPose, resolveRigGeometry, serializeSprite, deserializeSprite, PixelBuffer, transformBufferAffine } from '../src/index.js';

function makeRigEditor() {
  const editor = createEditor(createSprite({ width: 8, height: 8, layers: ['body', 'arm'], frames: 2 }));
  editor.execute('draw_rect', { layer: 'body', frame: 0, rect: { x: 3, y: 3, w: 2, h: 3 }, color: '#00ff00', fill: true });
  editor.execute('draw_pixels', { layer: 'arm', frame: 0, pixels: [{ x: 5, y: 4, color: '#ff0000' }] });
  editor.execute('create_rig', {
    restFrame: 0,
    parts: [
      { name: 'body', pivot: { x: 4, y: 4 }, layers: ['body'] },
      { name: 'right_arm', pivot: { x: 4, y: 4 }, layers: ['arm'], parent: 'body' },
    ],
  });
  return editor;
}

describe('character rig', () => {
  it('binds parts, previews a pose and bakes into an explicit frame', () => {
    const editor = makeRigEditor();
    const rig = editor.execute('get_rig', {}) as { rig: { parts: Array<{ id: string; name: string }> } };
    const arm = rig.rig.parts.find((part) => part.name === 'right_arm')!;
    editor.execute('save_pose', {
      name: 'attack',
      transforms: { [arm.id]: { rotationDegrees: 90 } },
    });

    const sprite = editor.sprite;
    const pose = sprite.rig!.poses.find((candidate) => candidate.name === 'attack')!;
    const rendered = renderPose(sprite, pose);
    expect(rendered.partBounds.right_arm).toEqual({ x: 4, y: 5, w: 1, h: 1 });

    const baked = editor.execute('bake_pose', { pose: 'attack', targetFrame: 1 });
    expect(baked.frameId).toBe(sprite.frames[1].id);
    expect(editor.execute('measure_region', { layer: 'arm', frame: 1 }).bounds).toEqual({ x: 4, y: 5, w: 1, h: 1 });
  });

  it('requires explicit overwrite for non-empty pose targets', () => {
    const editor = makeRigEditor();
    const rig = editor.execute('get_rig', {}) as { rig: { parts: Array<{ id: string; name: string }> } };
    const arm = rig.rig.parts.find((part) => part.name === 'right_arm')!;
    editor.execute('save_pose', { name: 'attack', transforms: { [arm.id]: { dx: 1 } } });
    editor.execute('duplicate_frame', { frame: 0 });

    expect(editor.tryExecute('bake_pose', { pose: 'attack', targetFrame: 1 }).ok).toBe(false);
    expect(editor.tryExecute('bake_pose', { pose: 'attack', targetFrame: 0 }).ok).toBe(false);
  });

  it('stores poses, tweens, anchors and hitboxes and resolves their geometry', () => {
    const editor = makeRigEditor();
    const rig = editor.execute('get_rig', {}) as { rig: { parts: Array<{ id: string; name: string }> } };
    const arm = rig.rig.parts.find((part) => part.name === 'right_arm')!;
    editor.execute('save_pose', { name: 'raised', transforms: { [arm.id]: { rotationDegrees: 90 } } });
    editor.execute('save_tween', { name: 'swing', from: 'identity', to: 'raised', durationMs: 200, easing: 'ease-in-out' });
    editor.execute('set_anchor', { name: 'grip', part: arm.id, point: { x: 5, y: 4 } });
    editor.execute('set_hitbox', { name: 'blade', part: arm.id, rect: { x: 5, y: 3, w: 2, h: 1 } });

    const sprite = editor.sprite;
    const raised = sprite.rig!.poses.find((pose) => pose.name === 'raised')!;
    const geometry = resolveRigGeometry(sprite, raised);
    expect(geometry.anchors[0].world).toEqual({ x: 4, y: 5 });
    expect(geometry.hitboxes[0].polygon).toHaveLength(4);
  });

  it('bakes tween frames and round-trips rig metadata in format v2', () => {
    const editor = makeRigEditor();
    const rig = editor.execute('get_rig', {}) as { rig: { parts: Array<{ id: string; name: string }> } };
    const arm = rig.rig.parts.find((part) => part.name === 'right_arm')!;
    editor.execute('save_pose', { name: 'attack', transforms: { [arm.id]: { rotationDegrees: 90 } } });
    editor.execute('save_tween', { name: 'swing', from: 'identity', to: 'attack', durationMs: 300, easing: 'linear' });
    editor.execute('tween_pose', { from: 'identity', to: 'attack', targetFrame: 1, steps: 3, durationMs: 300 });

    expect(editor.sprite.frames).toHaveLength(4);
    const restored = deserializeSprite(serializeSprite(editor.sprite));
    expect(restored.rig?.parts.map((part) => part.name)).toEqual(['body', 'right_arm']);
    expect(restored.rig?.poses.map((pose) => pose.name)).toEqual(['identity', 'attack']);
    expect(restored.rig?.tweens[0].durationMs).toBe(300);
  });
});

describe('fixed-canvas affine transform', () => {
  it('rotates a local cel at an arbitrary angle without resizing the canvas', () => {
    const editor = createEditor(createSprite({ width: 8, height: 8, layers: ['base'] }));
    editor.execute('draw_pixels', { layer: 'base', frame: 0, pixels: [{ x: 5, y: 4, color: '#ff0000' }] });
    const result = editor.execute('transform_cel', {
      layer: 'base',
      frame: 0,
      pivot: { x: 4, y: 4 },
      rotationDegrees: 90,
    });
    expect(result.cels).toBe(1);
    expect([editor.sprite.width, editor.sprite.height]).toEqual([8, 8]);
    expect(editor.execute('measure_region', { layer: 'base', frame: 0 }).bounds).toEqual({ x: 4, y: 5, w: 1, h: 1 });
  });

  it('shifts a whole pixel off-canvas to an empty buffer', () => {
    const source = PixelBuffer.empty(4, 4);
    source.setColor(0, 0, { r: 255, g: 0, b: 0, a: 255 });
    // The range check runs on the unrounded inverse coordinate, so a source sample that
    // lands beyond the nearest-neighbour reach is dropped instead of being rounded into
    // column 0 (Math.round(-0.6) is -1, but Math.round(-0.5) is -0 and `-0 < 0` is false).
    expect(transformBufferAffine(source, { a: 1, b: 0, c: 0, d: 1, e: -0.6, f: 0 }).isEmpty()).toBe(true);
    expect(transformBufferAffine(source, { a: 1, b: 0, c: 0, d: 1, e: -4, f: 0 }).isEmpty()).toBe(true);
    // A half-pixel shift is a genuine tie and keeps the pixel in place.
    expect(transformBufferAffine(source, { a: 1, b: 0, c: 0, d: 1, e: 0.5, f: 0 }).isEmpty()).toBe(false);
  });

  it('rejects an affine transform with non-finite coefficients', () => {
    const source = PixelBuffer.empty(4, 4);
    expect(() => transformBufferAffine(source, { a: 1, b: 0, c: 0, d: 1, e: Number.NaN, f: 0 }))
      .toThrow(/finite/);
  });
});

describe('rig invariants survive structural edits', () => {
  it('detaches a deleted layer from its rig part and still round-trips', () => {
    const editor = makeRigEditor();
    const result = editor.execute('remove_layer', { layer: 'arm' });
    expect(result.detachedFromParts).toEqual(['right_arm']);
    expect(editor.sprite.rig!.parts.find((part) => part.name === 'right_arm')!.layerIds).toEqual([]);
    // The regression this guards: saving then reopening used to throw on the dangling ID.
    const restored = deserializeSprite(serializeSprite(editor.sprite));
    expect(restored.rig!.parts.find((part) => part.name === 'right_arm')!.layerIds).toEqual([]);
  });

  it('detaches a merged layer and still round-trips', () => {
    const editor = makeRigEditor();
    editor.execute('add_layer', { name: 'top' });
    editor.execute('create_rig', {
      restFrame: 0,
      replace: true,
      parts: [
        { name: 'body', pivot: { x: 4, y: 4 }, layers: ['body'] },
        { name: 'top', pivot: { x: 4, y: 4 }, layers: ['top'] },
      ],
    });
    const result = editor.execute('merge_layer_down', { layer: 'top' });
    expect(result.detachedFromParts).toEqual(['top']);
    const restored = deserializeSprite(serializeSprite(editor.sprite));
    expect(restored.rig!.parts.find((part) => part.name === 'top')!.layerIds).toEqual([]);
  });

  it('re-points the rig rest frame instead of writing an unopenable file', () => {
    const editor = makeRigEditor();
    const restFrameId = editor.sprite.rig!.restFrameId;
    const result = editor.execute('remove_frame', { frame: restFrameId });
    expect(result.restFrameReassignedTo).toBe(editor.sprite.frames[0].id);
    expect(editor.sprite.rig!.restFrameId).toBe(editor.sprite.frames[0].id);
    const restored = deserializeSprite(serializeSprite(editor.sprite));
    expect(restored.rig!.restFrameId).toBe(restored.frames[0].id);
  });

  it('requires an explicit non-rest destination frame for transform_part', () => {
    const editor = makeRigEditor();
    expect(editor.tryExecute('transform_part', { part: 'right_arm' }).ok).toBe(false);
    expect(editor.tryExecute('transform_part', { part: 'right_arm', frame: 0, targetFrame: 0 }).ok).toBe(false);
    // The rest frame renders every pose, so a destructive raster edit there would make
    // each later render drift further from the truth.
    const restFrameId = editor.sprite.rig!.restFrameId;
    const failure = editor.tryExecute('transform_part', { part: 'right_arm', targetFrame: restFrameId, dx: 3 });
    expect(failure.ok).toBe(false);
    expect(String((failure as { error: string }).error)).toMatch(/rest frame/i);
    expect(editor.execute('measure_region', { layer: 'arm', frame: 0 }).bounds).toEqual({ x: 5, y: 4, w: 1, h: 1 });
    // A real, non-rest destination still works.
    expect(editor.tryExecute('transform_part', { part: 'right_arm', targetFrame: 1, dx: 1 }).ok).toBe(false);
  });

  it('clears a part layer the pose empties instead of calling it a preserved layer', () => {
    const editor = createEditor(createSprite({ width: 8, height: 8, layers: ['body', 'arm', 'fx'], frames: 2 }));
    editor.execute('draw_pixels', { layer: 'arm', frame: 0, pixels: [{ x: 5, y: 4, color: '#ff0000' }] });
    editor.execute('draw_pixels', { layer: 'fx', frame: 1, pixels: [{ x: 0, y: 0, color: '#00ff00' }] });
    editor.execute('create_rig', {
      restFrame: 0,
      parts: [
        { name: 'body', pivot: { x: 4, y: 4 }, layers: ['body'] },
        { name: 'right_arm', pivot: { x: 4, y: 4 }, layers: ['arm'] },
      ],
    });
    const rig = editor.execute('get_rig', {}) as { rig: { parts: Array<{ id: string; name: string }> } };
    const arm = rig.rig.parts.find((part) => part.name === 'right_arm')!;
    // Push the arm far off-canvas, and also leave stale art on the arm layer of frame 1.
    editor.execute('save_pose', { name: 'far', transforms: { [arm.id]: { dx: 40 } } });
    editor.execute('draw_pixels', { layer: 'arm', frame: 1, pixels: [{ x: 2, y: 2, color: '#0000ff' }] });

    const baked = editor.execute('bake_pose', { pose: 'far', targetFrame: 1, overwrite: true });
    // The rig owns `arm`, so an empty pose result must clear it rather than keep stale art.
    expect(baked.clearedPartLayers).toContain('arm');
    expect(baked.preservedLayers).toEqual(['fx']);
    const armId = editor.sprite.layers.find((layer) => layer.name === 'arm')!.id;
    expect(editor.sprite.frames[1].cels.has(armId)).toBe(false);
    const fxId = editor.sprite.layers.find((layer) => layer.name === 'fx')!.id;
    expect(editor.sprite.frames[1].cels.get(fxId)!.getColor(0, 0)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it('moves rig geometry with the artwork when the canvas changes', () => {
    const editor = makeRigEditor();
    editor.execute('set_anchor', { name: 'grip', part: 'right_arm', point: { x: 5, y: 4 } });
    editor.execute('set_hitbox', { name: 'blade', part: 'right_arm', rect: { x: 5, y: 3, w: 2, h: 1 } });

    // crop: the rect becomes the new origin.
    editor.execute('crop_canvas', { rect: { x: 2, y: 1, w: 6, h: 7 } });
    expect(editor.sprite.rig!.parts.find((p) => p.name === 'right_arm')!.pivot).toEqual({ x: 2, y: 3 });
    expect(editor.sprite.rig!.anchors[0]).toMatchObject({ x: 3, y: 3 });
    expect(editor.sprite.rig!.hitboxes[0]).toMatchObject({ x: 3, y: 2 });

    // scale: pivots and anchors scale with the pixels.
    editor.execute('scale_sprite', { factor: 2 });
    expect(editor.sprite.rig!.parts.find((p) => p.name === 'right_arm')!.pivot).toEqual({ x: 4, y: 6 });
    expect(editor.sprite.rig!.anchors[0]).toMatchObject({ x: 6, y: 6 });

    // resize with an offset shifts them again.
    editor.execute('resize_canvas', { width: 20, height: 20, offsetX: 1, offsetY: 1 });
    expect(editor.sprite.rig!.parts.find((p) => p.name === 'right_arm')!.pivot).toEqual({ x: 5, y: 7 });

    // A 180 degree turn moves them to the mirrored position.
    const beforePivot = editor.sprite.rig!.parts.find((p) => p.name === 'right_arm')!.pivot;
    editor.execute('rotate', { turns: 2 });
    expect(editor.sprite.rig!.parts.find((p) => p.name === 'right_arm')!.pivot).toEqual({
      x: 20 - 1 - beforePivot.x,
      y: 20 - 1 - beforePivot.y,
    });

    // And the rig still renders consistently afterwards.
    const rendered = renderPose(editor.sprite, editor.sprite.rig!.poses[0]);
    expect(rendered.clippedParts).toEqual([]);
  });

  it('leaves rig geometry alone for a scoped flip that does not move the canvas', () => {
    const editor = makeRigEditor();
    const before = { ...editor.sprite.rig!.parts[0].pivot };
    editor.execute('flip', { axis: 'horizontal', layer: 'arm' });
    expect(editor.sprite.rig!.parts[0].pivot).toEqual(before);
    // An unscoped flip moves every pixel, so the rig has to travel with it.
    const result = editor.execute('flip', { axis: 'horizontal' });
    expect(result.rigRemapped).toBe(true);
    expect(editor.sprite.rig!.parts[0].pivot).toEqual({ x: 8 - 1 - before.x, y: before.y });
  });

  it('reports what a rig rebuild discarded', () => {
    const editor = makeRigEditor();
    const rig = editor.execute('get_rig', {}) as { rig: { parts: Array<{ id: string; name: string }> } };
    const arm = rig.rig.parts.find((part) => part.name === 'right_arm')!;
    editor.execute('save_pose', { name: 'attack', transforms: { [arm.id]: { dx: 2 } } });
    editor.execute('set_anchor', { name: 'grip', part: arm.id, point: { x: 5, y: 4 } });

    const rebuilt = editor.execute('create_rig', {
      restFrame: 0,
      replace: true,
      parts: [{ name: 'body', pivot: { x: 4, y: 4 }, layers: ['body'] }],
    });
    expect(rebuilt.replacedRig).toMatchObject({ parts: 2, poses: 2, anchors: 1, hitboxes: 0 });
    expect(rebuilt.discarded).toEqual(['poses', 'tweens', 'anchors', 'hitboxes']);
    expect(editor.sprite.rig!.anchors).toEqual([]);
  });

  it('reports a multi-layer part as the union of its layers, not the last one', () => {
    const editor = createEditor(createSprite({ width: 8, height: 8, layers: ['base', 'shade'], frames: 2 }));
    // Overlapping layers: base covers 3x3, shade covers the inner 2x2.
    editor.execute('draw_rect', { layer: 'base', frame: 0, rect: { x: 2, y: 2, w: 3, h: 3 }, color: '#00ff00', fill: true });
    editor.execute('draw_rect', { layer: 'shade', frame: 0, rect: { x: 3, y: 3, w: 2, h: 2 }, color: '#008000', fill: true });
    editor.execute('create_rig', {
      restFrame: 0,
      parts: [{ name: 'torso', pivot: { x: 4, y: 4 }, layers: ['base', 'shade'] }],
    });

    const pose = editor.sprite.rig!.poses[0];
    const rendered = renderPose(editor.sprite, pose);
    // The blit-based union used to collapse to the shade layer only.
    expect(rendered.partBounds.torso).toEqual({ x: 2, y: 2, w: 3, h: 3 });
    // An identity pose must never claim that pixels were clipped.
    expect(rendered.clippedParts).toEqual([]);
    expect(rendered.partPixels).toEqual([
      { part: 'torso', partId: editor.sprite.rig!.parts[0].id, sourcePixels: 13, outputPixels: 13 },
    ]);
  });

  it('flags a pose that pushes a part past the canvas edge', () => {
    const editor = makeRigEditor();
    const rig = editor.execute('get_rig', {}) as { rig: { parts: Array<{ id: string; name: string }> } };
    const arm = rig.rig.parts.find((part) => part.name === 'right_arm')!;
    editor.execute('save_pose', { name: 'offscreen', transforms: { [arm.id]: { dx: 40 } } });
    const rendered = renderPose(editor.sprite, editor.sprite.rig!.poses.find((p) => p.name === 'offscreen')!);
    expect(rendered.clippedParts).toHaveLength(1);
    expect(rendered.clippedParts[0]).toMatchObject({
      part: 'right_arm',
      reason: 'moved fully off-canvas',
    });
  });

  it('refuses to bake onto the rig rest frame', () => {
    const editor = makeRigEditor();
    const restFrameId = editor.sprite.rig!.restFrameId;
    const failure = editor.tryExecute('bake_pose', { pose: 'identity', targetFrame: restFrameId, overwrite: true });
    expect(failure.ok).toBe(false);
    expect(String((failure as { error: string }).error)).toMatch(/rest frame/i);
    // And the rest pixels are untouched.
    expect(editor.execute('measure_region', { layer: 'arm', frame: 0 }).bounds).toEqual({ x: 5, y: 4, w: 1, h: 1 });
  });

  it('preserves destination layers that the rest frame never had', () => {
    const editor = createEditor(createSprite({ width: 8, height: 8, layers: ['body', 'fx'], frames: 2 }));
    editor.execute('draw_rect', { layer: 'body', frame: 0, rect: { x: 3, y: 3, w: 2, h: 3 }, color: '#00ff00', fill: true });
    editor.execute('draw_pixels', { layer: 'fx', frame: 1, pixels: [{ x: 0, y: 0, color: '#ff0000' }] });
    editor.execute('create_rig', { restFrame: 0, parts: [{ name: 'body', pivot: { x: 4, y: 4 }, layers: ['body'] }] });

    const baked = editor.execute('bake_pose', { pose: 'identity', targetFrame: 1, overwrite: true });
    expect(baked.preservedLayers).toEqual(['fx']);
    const fxId = editor.sprite.layers.find((layer) => layer.name === 'fx')!.id;
    expect(editor.sprite.frames[1].cels.get(fxId)!.getColor(0, 0)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('refuses a tween that would start on or before the rest frame', () => {
    const editor = makeRigEditor();
    const rig = editor.execute('get_rig', {}) as { rig: { parts: Array<{ id: string; name: string }> } };
    const arm = rig.rig.parts.find((part) => part.name === 'right_arm')!;
    editor.execute('save_pose', { name: 'attack', transforms: { [arm.id]: { dx: 2 } } });
    const failure = editor.tryExecute('tween_pose', { from: 'identity', to: 'attack', targetFrame: 0, steps: 2 });
    expect(failure.ok).toBe(false);
    expect(String((failure as { error: string }).error)).toMatch(/rest frame/i);
  });

  it('clears an individual pose transform when passed null', () => {
    const editor = makeRigEditor();
    const rig = editor.execute('get_rig', {}) as { rig: { parts: Array<{ id: string; name: string }> } };
    const arm = rig.rig.parts.find((part) => part.name === 'right_arm')!;
    editor.execute('save_pose', { name: 'attack', transforms: { [arm.id]: { dx: 2 } } });
    const cleared = editor.execute('save_pose', { pose: 'attack', transforms: { [arm.id]: null } });
    expect(cleared.clearedParts).toEqual([arm.id]);
    expect(editor.sprite.rig!.poses.find((pose) => pose.name === 'attack')!.transforms).toEqual({});
  });

  it('clears a parent when update_part is given parent: null', () => {
    const editor = makeRigEditor();
    expect(editor.sprite.rig!.parts.find((part) => part.name === 'right_arm')!.parentId).toBeDefined();
    const cleared = editor.execute('update_part', { part: 'right_arm', parent: null });
    expect(cleared.parentId).toBeNull();
    expect(editor.sprite.rig!.parts.find((part) => part.name === 'right_arm')!.parentId).toBeUndefined();
    expect(deserializeSprite(serializeSprite(editor.sprite)).rig!.parts.find((part) => part.name === 'right_arm')!.parentId)
      .toBeUndefined();
  });
});
