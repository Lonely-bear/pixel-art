/**
 * Engine importers and the naming validator — every consumer of `meta.json`.
 *
 * One contract, four engines, five consumers. The importers are deliberately separate modules
 * with one exported entry point each rather than a table of closures over a shared template:
 * the four lossless mappings are genuinely different problems (Godot wants a `SpriteFrames`
 * resource, Unity wants a `TextureImporter` script, Phaser wants a loader config, Excalidraw
 * wants a scene), and a table would hide that behind a switch on a format name.
 *
 * Every importer takes `unknown` rather than `AssetMeta` and validates first. That is not
 * ceremony: an importer handed a contract with four frames and three durations produces an
 * engine file that opens cleanly and drops a frame, and the symptom appears two systems away
 * from the cause. `readAssetMeta` is shared so the refusal is the same refusal everywhere.
 *
 * `docs/IMPORTERS.md` is the long form, including what each mapping loses.
 */

export * from './types.js';
export * from './naming.js';
export * from './godot.js';
export * from './unity.js';
export * from './phaser.js';
export * from './excalidraw.js';
