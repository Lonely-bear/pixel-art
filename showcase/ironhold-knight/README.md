# ironhold-knight

A 64×64 armoured hero: cape, tabard, belt, and a greatsword shouldered on the right. Three-quarter
view, light from the top left. One frame, four layers, 20 colours.

![the piece at 4x](out/ironhold-knight@4x.png)

`out/ironhold-knight.png` is the asset — scale 1, transparent. `out/ironhold-knight@4x.png` is an
upscale for reading, not for shipping.

## Reproduce it

From the repository root:

```bash
node scripts/showcase-build.mjs run ironhold-knight --verify
```

14 advertised tool calls against a fresh server, ~150 ms, and `--verify` proves a second replay
lands on the same bytes. The recipe is [`ops.json`](ops.json); the measurements are
[`manifest.json`](manifest.json).

## Measured, not estimated

Everything in this section came out of a run, not out of prose.

| | |
| --- | --- |
| Canvas | 64 × 64, opaque bounds x 6–58 / y 0–62, 2 110 solid pixels of 4 096 |
| Tool calls | 14 — `create_document` ×1, `apply_ops` ×12, `finalize_document` ×1 |
| Advertised tools at session start | 36 |
| Advertised tools at session end | 43 (7 promoted: `add_palette_ramp`, `draw_polygon`, `draw_ellipse`, `draw_rect`, `draw_pixels`, `dither_fill`, `outline`) |
| Payload in | 19 134 argument bytes — byte-identical on all 14 runs |
| Payload out | ~16 566 result bytes — **not** stable, see below |
| Wall clock | 135.3 – 411.5 ms across 14 runs, median ~185 ms; the spread is machine noise, not work |
| Output | `out/ironhold-knight.png` 1 044 bytes, `out/ironhold-knight@4x.png` 7 328 bytes |
| Colour | 20 distinct colours on the composite, 11 luminance levels spanning 17–243 |
| Source | `ironhold-knight.pixel`, ~3 830 bytes, **not** byte-stable (session-generated frame ids) |

Two things in that table move, and both are the same cause: **the server assigns ids per session and
the response envelope echoes them.** `resultBytes` drifted over 16 537 – 16 567 across the runs
because the `document.id` string it carries varies in length, and the `.pixel` container's bytes
move because the frame id goes inside it. The artwork moves in neither case — both PNGs kept the
same SHA-256 on every single run and under both harnesses, which is what `--verify` gates on.

Colour distribution, from `histogram` — 1 493 of 2 110 opaque pixels (71%) sit on the steel ramp,
which is what makes the piece read as one material lit from one direction:

| slot | hex | px | % |
| --- | --- | --- | --- |
| 1 | `#313d6c` steel dark | 517 | 24.5 |
| 3 | `#8cacd4` steel light | 423 | 20.0 |
| 0 | `#141628` steel deepest / contour | 360 | 17.1 |
| 4 | `#d2e3f0` steel specular | 148 | 7.0 |
| 19 | `#362e4b` cape dark | 103 | 4.9 |
| 18 | `#151527` cape deepest | 91 | 4.3 |
| 6 | `#761b38` crimson dark | 81 | 3.8 |
| 21 | `#846c88` cape light | 68 | 3.2 |
| 7 | `#a3222a` crimson | 58 | 2.7 |
| 2 | `#4a6db5` steel | 45 | 2.1 |
| 8 | `#d24b28` crimson light | 42 | 2.0 |
| 12 | `#f4b42b` gold light | 38 | 1.8 |
| 10 | `#5c2010` gold deepest | 27 | 1.3 |
| 15 | `#492816` leather | 26 | 1.2 |
| 11 | `#b25b14` gold | 22 | 1.0 |
| 16 | `#6b5125` leather light | 22 | 1.0 |
| 14 | `#240c09` leather darkest | 21 | 1.0 |
| 20 | `#5d4b6b` cape | 12 | 0.6 |
| 23 | `#60c7ed` glow | 3 | 0.1 |
| 24 | `#c9fffc` glow core | 3 | 0.1 |

## The palette

Six `add_palette_ramp` calls, 25 slots, each anchored so its two ends stay close on the hue wheel.
`add_palette_ramp`'s own guide is blunt about this: hue interpolates along the shorter arc, so a
plum-to-tan pair spends the middle of the ramp in magenta. Every anchor pair here is under 30°
apart, which is why none of them turned purple.

| role | anchors | steps | used |
| --- | --- | --- | --- |
| metal | `#141628` → `#d2def0` | 5 | 5 |
| cloth | `#4a1226` → `#e0714f` | 5 | 4 |
| accent | `#5c2d10` → `#ffef7a` | 4 | 3 |
| leather | `#241109` → `#8a7038` | 4 | 4 |
| cape | `#191527` → `#7d6c88` | 4 | 4 |
| glow | `#2a6ea8` → `#c9fbff` | 3 | 2 |

Five slots (5, 9, 13, 17, 22) are built and never used. See *What is weak*.

## How it was made

The recipe is 14 calls, and the order is the argument:

1. **`create_document`** — 64×64 with a `cape` / `body` / `shade` / `outline` stack. The cape gets
   its own layer for a specific reason: `clip: {layer: "cape"}` confines its shading to cape pixels.
   On one shared layer, the violet bands would have bled onto the steel.
2. **Six ramp calls** — one per material, before anything is drawn, so every later op names a ramp
   step (`pal:2`) instead of a hand-picked hex.
3. **Block the cape**, then **block the body** — one flat colour per material, every shape a
   `draw_polygon` / `draw_rect` / `draw_ellipse`. This is the silhouette pass and it is the one that
   mattered: the silhouette took five blocked versions before the figure read, and the sword arm
   two more after that.
4. **Shade** — 66 band-shaped ops on `shade` out of 101 in the whole recipe, every one carrying
   `clip: "composite"` so paint can never spill past the silhouette. Boundaries are diagonals
   running from the top left; the pauldrons, the gorget shadow under the helm, and the tassets all
   share one light direction.
5. **One dither seam** — the helm's specular-to-light step, 3 px, `bayer4` at 0.5.
6. **Break one straight line** — six pixels that stop the tasset hem reading as a printed rule.
7. **`outline {scope: "composite"}`**, then a `draw_pixels` with `color: null` at 158 coordinates
   that open the contour along the lit edges. A closed contour on every edge reads as a sticker;
   this one is dark on the shadow side and gone where the light hits.
8. **`finalize_document`** — the editable `.pixel`, a scale-1 PNG and a scale-4 PNG.

### Verification during drawing

Not in `ops.json`, because none of it changes state — but it is how the piece was actually steered:

- `read_grid {view: "mask", scope: "cel", layer: "cape"}` for the silhouette, `{view: "index"}` for the
  material map, `{view: "value"}` for the light. `read_grid` diffs itself, so an edit reported which
  rows moved and what they were before.
- `get_preview` at three gates: after the silhouette was blocked, after shading, and once at the end
  at `scale: 1`. Between them, `read_grid` only.

Reproduce a check yourself by appending it to the recipe and replaying — the document state carries
over within one session:

```bash
node -e "const fs=require('fs');const o=JSON.parse(fs.readFileSync('showcase/ironhold-knight/ops.json','utf8'));o.push({label:'value',tool:'read_grid',arguments:{view:'value',diff:false}});fs.writeFileSync('tmp-ops.json',JSON.stringify(o))"
node scripts/mcp-call.mjs calls tmp-ops.json
rm tmp-ops.json
```

## What is weak

Honest, and worth reading before trusting the piece.

- **The cape is the weakest element.** It is the one part that does not clearly say what it is. The
  hem is scalloped and there are fold lines, but the folds are near-vertical and roughly evenly
  spaced, which is the "hedge" failure the guide warns about — and at 64 px the whole mass reads
  closer to a torn shadow than to cloth. A cape wants fewer, larger, less regular folds and a lit
  edge along its outer contour; that is the first thing I would change.
- **No bounced warm light anywhere.** A crimson tabard would throw red onto the steel beside it.
  Instead every seam around the tabard is a cool dark, which keeps the image clean and keeps it
  monochrome: roughly 71% of opaque pixels sit on one blue ramp. One crimson-tinted reflected edge
  on the breastplate would give the piece a temperature it currently does not have.
- **The legs are two cylinders.** A 3 px gap, a dark sole line, no knee and no boot cuff. It reads
  at this size, but it is the part that would fall apart the moment the sprite is animated.
- **The helm's gold ridge runs crown to chin** and splits the face down the middle. It reads as a
  moulded crest, which is what it is, but it competes with the visor for attention.
- **The blade is 8 px wide and 34 px long** — heavier than a real sword against a 20 px-wide body.
  A deliberate choice for silhouette at a glance, and it is why the sword reads instantly; but the
  knight is armed with a slab.
- **Five palette slots are dead** (5, 9, 13, 17, 22). 20 colours on a 64×64 sprite is disciplined
  but not strict, and a real asset contract would want those ramps trimmed to what is painted.
- **It is one static frame.** The engine does rigs, frames, tags and GIF export, and this showcase
  exercises none of it. That is the obvious next piece.
