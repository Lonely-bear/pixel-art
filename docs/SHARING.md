# Sharing a piece - PNG provenance and share templates

> Two things a person can actually send to another person: a PNG that says where it came from, and
> a bundle that says what is wrong with it. Neither may contain a number.

`dotloom-mcp` ships a build-time gallery (`scripts/build-gallery.mjs`, `docs/ROADMAP.md` Phase 2)
and a share bundle builder (`scripts/build-share.mjs`). The gallery publishes a page; this publishes
a **bundle**, per piece, from a template. Everything here is a build artifact driven through the
advertised MCP tool surface.

---

## S1. What goes into a PNG's text chunks

`encodePNG(buffer, { metadata })` writes PNG `tEXt` chunks. Nothing else changed: `decodePNG` of a
badged file returns byte-identical RGBA, which is the whole reason it is safe
(`packages/core/test/png-metadata.test.ts`).

### The rule

**A text chunk is a declaration *about* the file, so it may carry only what is (a) true of these
bytes and (b) the same on every machine.** This is `ASSET-CONTRACT` S4.2's line - "a direction is a
declaration *about* the asset", which is why `asset.name`, `pivot` and `license` sit outside the
content hash - applied to the one place a declaration can travel inside an image.

### The vocabulary, `PNG_PROVENANCE_KEYS`

| key | carries | why it belongs |
| --- | --- | --- |
| `Software` | `dotloom-mcp` | The PNG spec's own keyword for the producing software. The `made with` badge, in the form the format already provides. **No version**: S10 rejected a generated-by block with a version because it makes every committed artifact a diff on upgrade. |
| `dotloom:asset` | `sha256:...` | The asset identity from the contract. Lets a consumer recognise the file without re-compositing every frame, and it moves exactly when the artwork does. |
| `dotloom:name` | the asset name | A lookup key, outside the hash by S4.1 so a rename invalidates no cache. A chunk invalidates nothing, because no chunk is hashed. |
| `dotloom:contract` | `dotloom-mcp/asset-meta` | The S5 `format` role: says this is an asset contract rather than an export manifest or an Aseprite sheet JSON. |
| `dotloom:schema` | the contract `schemaVersion` | Additive within a major version (S3 rule 2), so it moves only when the digest could. |
| `dotloom:license` | an SPDX id | The one declaration the document model cannot hold. **Written only when the caller supplied one**, never inferred - S11, "never invent what the document does not know". Absent is not public domain. |
| `dotloom:defects` | sorted defect **codes**, comma-separated | The honest channel. Names survive being ignored; see S3. |

### What does not go in, and why

| absent | why |
| --- | --- |
| Any score, grade, rating, percentage, verdict | The most expensive lesson in this repository's history. `AGENTS.md` records the model that was told a lake was clean and sanded it into a dark flat rectangle; `quality_report` was deleted in 0.3.1. **Enforced on the writer** - `assertPngMetadata` throws - not by a review, because a text chunk is the last place a number can hide: it survives being pasted, mailed and re-saved by a person who never opens the file. |
| A bare number under any key but `dotloom:schema` | A number is the thing that becomes a target. `dotloom:schema` is exempt because it is a spec revision integer and measures nothing. |
| A timestamp, hostname, absolute path, session id | S11 rule 1. A generated file must be byte-identical for the same document, and this repository has already shipped a `.pixel` archive that differed on every save because of exactly this. |
| The engine or generator **version** | S10, by name. It changes on every release, so every committed PNG becomes a diff on upgrade. The gallery's page reports the engine version in its footer, where a release *should* show up; a sprite should not. |
| Document ids, layer names, order, opacity, blend mode, the rig | S4.2 and S10: these describe how the artwork was made, not what it is. Two layers that composite identically are the same asset. Ids are clock-plus-entropy, so they would also break determinism. |
| Sheet geometry, frame paths, the bundle's file list | S4.2: one asset ships as a sheet, as PNGs, or at 3x. `meta.json` already carries this, in UTF-8, where it belongs. |

### Two refusals that are not about verdicts

- **Non-Latin-1.** `tEXt` is Latin-1 by specification. An asset named in Japanese or emoji would
  otherwise fail deep inside the encoder, at the last possible moment, with a message naming a
  chunk. `meta.json` is UTF-8 and is where such a value belongs.
- **A control character**, and a keyword outside the spec's 1..79.

Both are checked by code point rather than by a `\uXXXX` regex range, because an escape sequence in
a source literal is one tool away from becoming the character it names.

### Reading it back

`readPNGMetadata(bytes)` is the mirror of `encodePNG({metadata})`. A badge nobody can read back is
a badge nobody can check, and the recipient of a shared file has neither this repository nor
`evaluate`.

---

## S2. The badge is metadata, not pixels

**Carried as a `tEXt` chunk; never composited into the artwork.**

A burned badge destroys pixels that the content hash covers and that every downstream engine
resamples, scales and recolours, so the shared file stops being the asset it claims to be - and it
is unrecoverable by anyone who did not watch it happen. A `tEXt` chunk carries the same claim
losslessly, is ignored by every renderer, and can be dropped by any tool without touching a pixel;
the *visible* mark is drawn on the HTML card, which is presentation and costs nothing.

The claim is measured, not asserted. `packages/core/test/share-templates.test.ts` renders the same
`.pixel` a second time in a **separate process** (`mcp-call.mjs`, `open_document` + `export_png`,
scale 8, no badge and no knowledge this repository exists) and compares the two decodes pixel for
pixel:

```
expect([...shared.data], 'the badge must not have touched a pixel').toEqual([...plain.data]);
```

and the positive half, because either assertion alone would pass a weaker design:

```
expect(readFileSync(join(dir('bare', SPRITE), `${SPRITE}.png`)).length).not.toBe(readFileSync(plainPath).length);
```

`encodePNG(decodePNG(badged))` yields a file with **no** chunks and identical pixels: un-badging is
a decode and a re-encode, because there is nothing to un-burn.

---

## S3. No score, anywhere

A share bundle is the most dangerous place in this repository to put a number, because it is
*designed* to be looked at and circulated. The rule the whole design follows: **named defects, or
nothing.**

What travels instead is, per defect: `code`, the `dimensions` that found it, `rect`, `blocking`, the
`message`, the `guidance` from `fix`, and a `disposition` of `safe-repair-available` or
`needs-a-decision`. `severity` is **dropped**, even though it is only 0..1 - it is a number, and a
number in a file that gets forwarded is the thing this repository has already paid for.

Three independent guards, because the artifact has three surfaces:

1. `share.json` - a recursive walk over **key names**, the same idiom
   `packages/cli/test/contract.test.ts` and `packages/core/test/gallery.test.ts` use. `evaluate`
   returns `score` and `scoreQ` on every dimension; copying one field would be enough to
   reintroduce the deleted tool.
2. The card HTML - matched over its own text, no whitelist and no disclaimer carve-out, so the part
   of the page that explains why the numbers are absent is covered too.
3. The PNG's text chunks - `assertPngMetadata` refuses a verdict-shaped key at the point of
   writing, so it cannot reach a file in the first place.

### An unmeasured dimension is not a clean one

Every abstention is carried in its own block with its `ExcludedReason` spelled out, and **never**
folded into the list of dimensions that measured the piece. `ExcludedReason` exists because
"nothing wrong here" and "nobody looked" both arrive as an absent number, and only one of them is a
compliment.

A **partly** absent dimension goes in the same block: `QualityDimension.unmeasured` names the
sub-scores that could not be taken, and to a reader "part of this claim was not checked" is the same
fact as "none of it was". Two committed pieces exercise both halves:

- `autumn-dusk-lake-256` - a full-bleed scene, where `silhouette` and `outline` abstain with
  `no-subject`. This is the case the repository has already got wrong once: `silhouette` was
  confidently reporting a blocking `shape-clipped` on all ten full-bleed artworks, because the
  alpha boundary of a scene *is* the canvas.
- `verify/lantern-keeper` - a single-frame sprite measured by five dimensions, where `motion`
  abstains with `single-frame`. The near-miss on the other side of the same gate: a bundle that
  reported *nothing* would look like the abstention case.

---

## S4. Templates: what they are, and where they live

### A share template is a presentation preset

Not a shape, not a rendered card: a small JSON document naming **what goes in a bundle and what the
card says about it** - which outputs, whether a card is rendered, whether the asset contract and
one engine's files are written, and an optional licence. The card is an *output* of a template, not
the template.

### `share-templates/`, not `recipes/`

Because a recipe and a share template answer different questions to different readers:

| | recipe | share template |
| --- | --- | --- |
| question | "what does this class of asset keep getting wrong?" | "what do I send, and what does the card say?" |
| audience | an agent deciding what to draw | a person deciding what to forward |
| consumed by | `describe_recipe`, `pixel://recipe/{id}` | `scripts/build-share.mjs` |
| changes | the pixels | nothing in the document |

Conflating them would put a per-audience presentation choice (`bare` vs `review`) into the
vocabulary an agent reads to decide what kind of art to make, and every future template would become
something `describe_recipe` had to know about. Two directories, two audiences. The format is
`dotloom-mcp/share-template`, `schemaVersion 1`, with a **closed** field set - a typo in a template
is an error, not a default, which is `ASSET-CONTRACT` S3's rule that tolerance for the future must
not become tolerance for typos.

### The schema is the command's

`shareTemplateSchema` on the `share_bundle` command (`packages/core/src/commands/share.ts`) owns the
field set, the checked `format` and the output union. The build script does not validate anything:
it reads `share-templates/*.share.json` and hands each object straight to the command, so a template
the script has never seen is checked by exactly the code that builds it. A second list of known
fields is a second place for the two to drift, and a template is presentation *policy* - the one
thing that must not be silently reinterpreted.

`outputs` is the same union `finalize_document` offers - `png`, `frames`, `sheet`, `gif`, `contact`,
`pose`, `meta`, `engine`. `meta` and `engine` are spelled
`finalize_document`'s way, so the two surfaces cannot describe different bundles; the top-level
`assetContract` and `engine` fields are shorthand that expands into them, and expanding is idempotent,
so `handoff` naming its engine in both places gets one contract rather than two.

### The four that ship

| id | what it is |
| --- | --- |
| `bare` | The artwork and its provenance, nothing else. No card, no rendered judgement layer - for handing a sprite to someone who wants the sprite and will run `evaluate` themselves. |
| `card` | The default. PNG with provenance chunks, a self-contained HTML card carrying every named defect and every abstention, and a `share.json` a machine can read. |
| `review` | `card` plus every frame as one strip, because a request for a second pair of eyes is about the motion and a still frame cannot show it. |
| `handoff` | `card` plus the asset contract and one engine's files, so what is being shown and what is being shipped are described by the same hash. |

`handoff` is **opt-in in exactly the way `finalize_document`, the CLI and the app already are**: the
target engine is the caller's choice and a tool cannot know it. The test asserts `meta.json` exists
for `handoff` and for no other template.

The engine is named in the template so a bundle is reproducible for everybody sharing that piece, and
**overridable at the call** - `share_bundle {engine: "phaser"}`, or `node scripts/build-share.mjs
--engine phaser`. The override wins over both the output's own `engine` and the template's, which is
the point: a caller sending the same artwork into a Phaser project says so rather than forking the
preset. `meta.json` is reachable on its own too, through `{type: "meta"}`, for a bundle that wants
the contract and no engine files.

### The bundle

```
share/<template>/<slug>/
  <slug>.png            the engine's render, plus tEXt chunks; every pixel is the engine's
  card.html             self-contained, no CDN, no client-side JavaScript (templates with a card)
  meta.json             the asset contract                      (handoff only)
  <asset name>/*.tres   one engine's files                     (handoff only)
  <slug>_sheet.png/json the sheet the contract describes       (review, handoff)
  <slug>.pixel          the editable source                    (handoff only)
  share.json            the machine-readable record
```

Every path in `share.json` is **relative and forward-slashed**. `finalize_document` reports absolute,
platform-native paths, and a record holding `share\handoff\...` cannot travel to a Linux build
machine - which is what `ASSET-CONTRACT` S5.1 exists to prevent. The rule is that the *record* of a
bundle is as portable as the bundle.

### Determinism

`--verify` generates the whole tree twice and byte-compares every file: no clock, no randomness, no
locale-dependent formatting, no session id. `share.json` records each PNG's sha256, so a diff shows
a real change when the artwork changed and nothing at all when it did not.

```
$ pnpm verify:share
share: 44 bundle(s) across 4 template(s)
  ...
  verified: a second generation produced byte-identical output for 210 file(s)
```

---

## S5. Usage

```bash
pnpm build:share                              # every template over every committed piece
pnpm verify:share                             # the same, byte-compared across two generations
node scripts/build-share.mjs --template card  # one template
node scripts/build-share.mjs --list           # the templates and what each contains
```

`build:libs` is a prerequisite - the usual trap in `AGENTS.md`: the script reaches the engine only
by spawning `packages/mcp/dist/cli.js`, exactly as `build-gallery.mjs` does, so a card in a bundle
is evidence about the product rather than about a library shortcut.

The script itself no longer builds a bundle. It is two advertised calls per piece - `open_document`,
then one `apply_ops` carrying `share_bundle` - and everything after that is decoding base64 and
writing files, because `packages/core` has no filesystem and somebody has to place them. The render,
the badge, the contract and the card are all inside the command.

**There is no `fast-png` import here any more.** The badge used to be stamped by decoding the file the
engine had written and re-encoding the same RGBA with chunks attached: three lines of duplication,
and a second place for the provenance vocabulary to drift from the one the engine enforces. The
engine now writes the chunks in the pass that renders the pixels, so `assertPngMetadata` is the only
writer and there is no window in which the file on disk disagrees with the record describing it.

---

## S6. Limitations

- **No licence is ever inferred.** `dotloom:license` appears only if a template sets `license`, and
  none of the four does. A user who wants one adds it to their own template. Absent is not public
  domain (`ASSET-CONTRACT` S11).
- **The card is HTML, not a composited PNG.** That is the badge decision (S2) applied to the whole
  card: the card is presentation and is regenerated, while the sprite is the artefact. It does mean
  a recipient who wants a single image file has to screenshot it.
- **The card's footer still names the build script**, not the command, because the script is what
  runs it and the sentence is true either way. Moving it would change every card's bytes for no
  gain a recipient can see.
- **`share/` is not committed and has no `--check-stale` gate**, unlike `showcase/gallery/`. A share
  bundle is per-recipient and per-template, so the gallery's "committed but stale" failure mode does
  not apply; the cost is that there is no CI gate proving a *committed* bundle is current, because
  none is committed.
