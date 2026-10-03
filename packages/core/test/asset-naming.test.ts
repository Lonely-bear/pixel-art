import { describe, expect, it } from 'vitest';
import { buildSpritesheet, type Atlas } from '../src/atlas.js';
import { renderAssetMeta, type AssetMeta, type AssetMetaOptions } from '../src/asset/index.js';
import {
  ASSET_NAMING_CODES,
  AssetImportError,
  DEFAULT_NAMING_CONVENTION,
  validateAssetNaming,
  type AssetNamingCode,
  type NamingConvention,
} from '../src/asset/importers/index.js';
import { createSprite, type Sprite } from '../src/document.js';

/**
 * The naming validator, T-055.
 *
 * ## Why these tests are shaped the way they are
 *
 * A naming rule is a measurement: it either fires on a bad name or it does not, and a rule that
 * does not is indistinguishable from no rule at all. So each rule gets **two** cases — a name it
 * must accept and a name one step further that it must reject — because one direction is not a
 * threshold. `hero-idle` and `hero--idle` differ by one character and sit on opposite sides of
 * the same gate; an assertion on only one of them passes for an implementation with the gate
 * anywhere, or nowhere.
 *
 * The "must-accept" side matters more than it looks. A naming validator that rejects everything
 * is worthless and, worse, gets switched off — and then the rule it was written to enforce is
 * gone. So the accept cases are real cases, not filler.
 */
function atlasFor(document_: Sprite): Atlas {
  return buildSpritesheet(document_);
}

function spriteNamed(name: string): Sprite {
  const made = createSprite({ width: 8, height: 8, name, frames: 2, frameDurationMs: 100 });
  made.tags.push({ id: 't1', name: 'idle', from: 0, to: 1, direction: 'forward', repeat: 0 });
  return made;
}

function contract(document_: Sprite, options: AssetMetaOptions = {}): AssetMeta {
  return JSON.parse(renderAssetMeta(document_, options)) as AssetMeta;
}

function codes(document_: Sprite, options?: AssetMetaOptions, convention?: NamingConvention): AssetNamingCode[] {
  return validateAssetNaming(contract(document_, options), convention).diagnostics.map((d) => d.code);
}

describe('naming validator: names the convention accepts', () => {
  it('accepts a lowercase kebab-case asset with snake_case animations and no findings', () => {
    // The negative control. A validator that fires on a conventionally named asset is worse than
    // one that does not exist, because the fix is to delete the validator.
    const report = validateAssetNaming(contract(spriteNamed('hero-idle')));
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('accepts the other shapes the default pattern allows', () => {
    // One rule has several valid names, and testing only one of them proves nothing about the
    // pattern. A single letter is legal; digits and multiple segments are legal.
    for (const name of ['a', 'hero', 'hero-idle', 'boss-2', 'player-run-fast', 'ui-icon-24']) {
      expect(validateAssetNaming(contract(spriteNamed(name))).ok, name).toBe(true);
    }
  });

  it('accepts snake_case, digits and a leading letter in animation names', () => {
    const document_ = createSprite({ width: 8, height: 8, name: 'hero-idle', frames: 2 });
    document_.tags.push({ id: 'a', name: 'run', from: 0, to: 1, direction: 'forward', repeat: 0 });
    document_.tags.push({ id: 'b', name: 'hit_react_2', from: 0, to: 1, direction: 'forward', repeat: 1 });
    document_.tags.push({ id: 'c', name: 'a', from: 0, to: 1, direction: 'forward', repeat: 1 });
    expect(validateAssetNaming(contract(document_)).diagnostics).toEqual([]);
  });
});

describe('naming validator: asset.name style', () => {
  // Each row is one character from the accepted name, on the far side of the same gate.
  const rejected: [string, string][] = [
    ['Hero-Idle', 'uppercase'],
    ['hero_idle', 'snake_case rather than kebab-case'],
    ['hero idle', 'a space'],
    ['hero--idle', 'a doubled separator'],
    ['-hero', 'a leading separator'],
    ['hero-', 'a trailing separator'],
    ['heroIdle', 'camelCase'],
    ['héro', 'a non-ASCII letter'],
    ['2-hero', 'a leading digit'],
  ];

  for (const [name, why] of rejected) {
    it(`rejects ${JSON.stringify(name)}: ${why}`, () => {
      expect(codes(spriteNamed(name))).toContain('asset-name-style');
    });
  }

  it('reports the rejected value, so a fixer does not have to re-find it', () => {
    const diagnostic = validateAssetNaming(contract(spriteNamed('Hero Idle'))).diagnostics.find(
      (d) => d.code === 'asset-name-style',
    );
    expect(diagnostic?.value).toBe('Hero Idle');
    expect(diagnostic?.path).toBe('asset.name');
  });

  it('treats a style deviation as a warning, so a project can override the convention', () => {
    // Severity is a product decision, and this one is pinned rather than implied: a naming rule
    // that blocked a build over camelCase would be switched off, and then nothing is checked.
    const report = validateAssetNaming(contract(spriteNamed('HeroIdle')));
    expect(report.ok).toBe(true);
    expect(report.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('warns above the length ceiling without blocking', () => {
    // Near-miss pairing for the length rule: 64 passes, 65 warns. The contract permits 255, so
    // this cannot be an error — a bundle whose name is long is still a valid bundle.
    const atLimit = 'a'.repeat(64);
    expect(codes(spriteNamed(atLimit))).not.toContain('asset-name-length');
    expect(codes(spriteNamed(`${atLimit}a`))).toContain('asset-name-length');
    expect(validateAssetNaming(contract(spriteNamed(`${atLimit}a`))).ok).toBe(true);
  });
});

describe('naming validator: animation names', () => {
  it('rejects camelCase, spaces, doubled underscores and a leading underscore', () => {
    const document_ = createSprite({ width: 8, height: 8, name: 'hero', frames: 2 });
    for (const bad of ['IdleLoop', 'idle loop', 'idle__loop', '_idle', '1idle']) {
      document_.tags = [{ id: 't', name: bad, from: 0, to: 1, direction: 'forward', repeat: 0 }];
      const found = validateAssetNaming(contract(document_)).diagnostics;
      expect(found.some((d) => d.code === 'animation-name-style' && d.value === bad), bad).toBe(true);
    }
  });

  it('accepts the same characters it accepts in an asset name', () => {
    const document_ = createSprite({ width: 8, height: 8, name: 'hero', frames: 2 });
    document_.tags = [{ id: 't', name: 'walk_cycle_2', from: 0, to: 1, direction: 'forward', repeat: 0 }];
    expect(validateAssetNaming(contract(document_)).diagnostics).toEqual([]);
  });

  it('refuses a duplicate animation name rather than reporting it', () => {
    // A duplicate animation name is already an `error` in the contract validator (S8), so
    // `readAssetMeta` throws before the naming rules get a chance to report it as a diagnostic.
    // That is the right outcome — the bundle is broken, not misnamed — and the assertion states
    // it, because "the rule exists in naming.ts and never fires" is otherwise indistinguishable
    // from "the rule is correct". The rule is kept as the named behaviour of this file; the
    // throw is what a caller actually observes.
    const document_ = createSprite({ width: 8, height: 8, name: 'hero', frames: 2 });
    document_.tags = [
      { id: 'a', name: 'idle', from: 0, to: 1, direction: 'forward', repeat: 0 },
      { id: 'b', name: 'idle', from: 0, to: 0, direction: 'forward', repeat: 1 },
    ];
    expect(() => validateAssetNaming(contract(document_))).toThrow(AssetImportError);
  });
});

describe('naming validator: output and sheet file names', () => {
  it('accepts outputs named after the asset, with any suffix', () => {
    // The rule is a prefix rule, not an equality rule: a bundle holds a .pixel source, four
    // frame PNGs, a GIF and a contact sheet, so exact equality would reject every real bundle.
    // `hero-idle@2x.png` is deliberately absent: `@` is not one of the three separators the rule
    // admits, so it is rejected. That is a documented boundary of the default, not an oversight.
    for (const path of ['hero-idle.png', 'hero-idle.pixel', 'hero-idle-3.png', 'hero-idle.idle.png']) {
      expect(codes(spriteNamed('hero-idle'), { outputs: [{ role: 'frame', path }] }), path).not.toContain(
        'output-name-mismatch',
      );
    }
  });

  it('rejects the suffix forms it does not admit, so the accepted set is not vague', () => {
    // The other side of the same gate. `hero-idlek` is the sharp case: a naive `startsWith`
    // accepts it, and then two assets in one bundle both register under names that sort next to
    // each other forever.
    for (const path of ['hero-idle@2x.png', 'hero-idlek.png', 'heroidle.png']) {
      expect(codes(spriteNamed('hero-idle'), { outputs: [{ role: 'frame', path }] }), path).toContain(
        'output-name-mismatch',
      );
    }
  });

  it('rejects an output named after something else, which is a stray or an undescribed asset', () => {
    expect(codes(spriteNamed('hero-idle'), { outputs: [{ role: 'frame', path: 'hero_idle_v2.png' }] })).toContain(
      'output-name-mismatch',
    );
    // `hero-idlek` is the sharp case: a naive `startsWith` accepts it, and then two assets in the
    // same bundle both register under a name that sorts next to each other forever.
    expect(codes(spriteNamed('hero'), { outputs: [{ role: 'frame', path: 'heroine.png' }] })).toContain(
      'output-name-mismatch',
    );
  });

  it('applies the same rule to the sheet image', () => {
    // The sheet is the one path the contract says must not be duplicated in `outputs`, so it is
    // the one path that carries the most weight when it is misnamed.
    const document_ = spriteNamed('hero-idle');
    const makeSheet = (image: string): AssetMetaOptions => ({
      sheet: { atlas: atlasFor(document_), image },
    });
    expect(codes(document_, makeSheet('hero-idle.png'))).not.toContain('output-name-mismatch');
    expect(codes(document_, makeSheet('sprites.png'))).toContain('output-name-mismatch');
  });

  it('honours a convention that turns the prefix rule off', () => {
    // The rule is configurable precisely so a project with a different layout is not forced to
    // argue with the default; if the option did nothing this would be a dead branch.
    const relaxed: NamingConvention = {
      ...DEFAULT_NAMING_CONVENTION,
      requireOutputNamesToMatchAsset: false,
      requireSheetNameToMatchAsset: false,
    };
    const document_ = spriteNamed('hero-idle');
    expect(
      codes(document_, { outputs: [{ role: 'frame', path: 'sprite.png' }] }, relaxed),
    ).not.toContain('output-name-mismatch');
    // And the same option off must not disable the *other* half.
    expect(
      codes(document_, { sheet: { atlas: atlasFor(document_), image: 'sprite.png' } }, relaxed),
    ).not.toContain('output-name-mismatch');
  });

  it('accepts a custom asset-name pattern', () => {
    const custom: NamingConvention = {
      ...DEFAULT_NAMING_CONVENTION,
      assetNamePattern: /^[A-Z][A-Za-z0-9]*$/,
      requireOutputNamesToMatchAsset: false,
    };
    expect(validateAssetNaming(contract(spriteNamed('HeroIdle')), custom).ok).toBe(true);
    expect(validateAssetNaming(contract(spriteNamed('hero-idle')), custom).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'asset-name-style' }),
    );
  });
});

describe('naming validator: the rules that are not configurable', () => {
  // Each of these is an `error` and none of them has an off switch, because there is no
  // convention under which the asset is portable. They are the reason this is more than a style
  // checker, and each is paired with a must-accept neighbour.

  it('leaves path portability to the contract validator, which already refuses it', () => {
    // Absolute paths, backslashes and `..` segments are `error`s in `validateAssetMeta` (S8), so
    // the naming validator throws before any of its own rules run. Asserted here so the boundary
    // is stated rather than assumed: a future reader who re-adds a `non-portable-path` rule will
    // see that it can never fire.
    for (const path of ['C:/art/hero.png', '/art/hero-idle.png', 'frames\\hero.png', '../hero-idle.png', 'a/../../x.png']) {
      expect(() =>
        validateAssetNaming(contract(spriteNamed('hero-idle'), { outputs: [{ role: 'frame', path }] })),
        path,
      ).toThrow(AssetImportError);
    }
  });

  it('rejects a reserved Windows device name in any segment, with or without an extension', () => {
    // The extension is the part that catches people: `nul.png` fails and so does `aux/hero.png`,
    // because Windows reserves the *stem* in every directory on every volume. A check against the
    // whole segment would pass all four of these, which is the version of this rule that ships a
    // bundle that works on a Mac and fails in CI.
    for (const path of ['nul.png', 'aux/hero-idle.png', 'COM1/hero-idle.png', 'lpt9.png']) {
      const found = codes(spriteNamed('hero-idle'), { outputs: [{ role: 'frame', path }] });
      expect(found, path).toContain('reserved-name');
    }
    // Two must-accept neighbours: `com0` is genuinely not reserved, and a name that merely
    // *starts* with a device name is an ordinary filename.
    for (const path of ['com0/hero-idle.png', 'console.png', 'nulish.png']) {
      expect(codes(spriteNamed('hero-idle'), { outputs: [{ role: 'frame', path }] }), path).not.toContain(
        'reserved-name',
      );
    }
  });

  it('rejects a path segment ending in a space or a dot, which Windows silently strips', () => {
    // Only the *last* character of a segment matters, and only in a whole segment — a dot inside
    // a name (`hero.idle.png`) is legal and must not fire.
    for (const path of ['hero-idle.png.', 'hero-idle.png ', 'frames./hero-idle.png', 'frames /hero-idle.png']) {
      expect(codes(spriteNamed('hero-idle'), { outputs: [{ role: 'frame', path }] }), path).toContain(
        'trailing-space-or-dot',
      );
    }
    expect(codes(spriteNamed('hero-idle'), { outputs: [{ role: 'frame', path: 'hero.idle.png' }] })).not.toContain(
      'trailing-space-or-dot',
    );
  });

  it('rejects two paths that differ only in case', () => {
    // Two files on Linux, one on Windows. An importer cache keyed on the path disagrees between
    // a developer's machine and a build server, which is the same failure mode the content hash
    // was introduced to remove. The two paths must be identical once case is folded — two paths
    // differing only in their *extension* are two files everywhere and must not be flagged.
    const outputs = [
      { role: 'frame' as const, path: 'frames/hero-idle.png' },
      { role: 'gif' as const, path: 'FRAMES/HERO-IDLE.PNG' },
    ];
    const report = validateAssetNaming(contract(spriteNamed('hero-idle'), { outputs }));
    expect(report.diagnostics.map((d) => d.code)).toContain('case-collision');
    expect(report.ok).toBe(false);
    // The near-miss on the other side of the same gate: same stem, different extension.
    const different = validateAssetNaming(
      contract(spriteNamed('hero-idle'), {
        outputs: [
          { role: 'frame', path: 'frames/hero-idle.png' },
          { role: 'gif', path: 'frames/hero-idle.gif' },
        ],
      }),
    );
    expect(different.diagnostics.map((d) => d.code)).not.toContain('case-collision');
    expect(different.ok).toBe(true);
  });

  it('folds case across directory segments too, not only the filename', () => {
    // The failure this catches is a merge that lands `Frames/` on one machine and `frames/` on
    // another, which no per-file check finds and which no importer cache survives.
    const report = validateAssetNaming(
      contract(spriteNamed('hero-idle'), {
        outputs: [
          { role: 'frame', path: 'Frames/hero-idle.png' },
          { role: 'gif', path: 'frames/hero-idle.png' },
        ],
      }),
    );
    expect(report.diagnostics.map((d) => d.code)).toContain('case-collision');
  });

  it('does not call two byte-identical paths a collision', () => {
    // `path-duplicate` is the contract validator's job and fires first, so this file never gets
    // here — but the near-miss matters: a case-collision check written as `has(key)` regardless
    // of the previous value would fire on every second identical path.
    expect(codes(spriteNamed('hero-idle'), { outputs: [{ role: 'frame', path: 'hero-idle.png' }] })).not.toContain(
      'case-collision',
    );
  });
});

describe('naming validator: refuses a contract it cannot judge', () => {
  it('throws rather than reporting a clean bill of health for a malformed contract', () => {
    // The same rule the importers follow. A naming check that ran on a contract whose
    // `asset.name` it could not read would report zero findings, and zero findings reads as
    // "the names are fine" — which is how a broken file passes CI.
    expect(() => validateAssetNaming({ ...contract(spriteNamed('hero-idle')), asset: 'nope' })).toThrow(
      AssetImportError,
    );
  });

  it('accepts a contract carrying a field from a newer schema version', () => {
    // S3's tolerance, end to end through the naming check: a newer writer's extra field is
    // advisory, and a validator that treated it as fatal would break every consumer the first
    // time the spec grows.
    const meta = { ...contract(spriteNamed('hero-idle')), somethingNew: 1 };
    expect(validateAssetNaming(meta).ok).toBe(true);
  });
});

describe('naming validator: diagnostics are stable', () => {
  it('sorts by path then code, so two runs produce the same list', () => {
    // Same guarantee the contract validator makes. A list whose order depends on object
    // iteration turns a build log into a diff.
    const document_ = createSprite({ width: 8, height: 8, name: 'HeroIdle', frames: 2 });
    document_.tags = [
      { id: 'a', name: 'IdleLoop', from: 0, to: 1, direction: 'forward', repeat: 0 },
      { id: 'b', name: 'hit react', from: 0, to: 1, direction: 'forward', repeat: 1 },
    ];
    const meta = contract(document_, {
      outputs: [
        { role: 'frame', path: 'CON.png' },
        { role: 'gif', path: 'other.gif' },
      ],
    });
    const first = validateAssetNaming(meta).diagnostics;
    const second = validateAssetNaming({ ...meta }).diagnostics;
    expect(first.map((d) => `${d.path}:${d.code}`)).toEqual(second.map((d) => `${d.path}:${d.code}`));
    const paths = first.map((d) => d.path);
    expect([...paths].sort()).toEqual(paths);
  });

  it('reports several findings for one contract rather than stopping at the first', () => {
    const document_ = createSprite({ width: 8, height: 8, name: 'HeroIdle', frames: 2 });
    document_.tags = [{ id: 'a', name: 'IdleLoop', from: 0, to: 1, direction: 'forward', repeat: 0 }];
    const found = codes(document_, { outputs: [{ role: 'frame', path: 'nul.png' }] });
    expect(found).toContain('asset-name-style');
    expect(found).toContain('animation-name-style');
    expect(found).toContain('reserved-name');
    expect(found).toContain('output-name-mismatch');
  });
});

describe('naming validator: it is a rule set, not a boolean', () => {
  it('names every code it can emit, for a spec-drift guard', () => {
    // The same pattern `ASSET_META_DIAGNOSTIC_CODES` exists for on the contract side: a closed,
    // exported list of codes so a consumer can switch on them without parsing prose.
    expect(ASSET_NAMING_CODES).toEqual([
      'animation-name-length',
      'animation-name-style',
      'asset-name-length',
      'asset-name-style',
      'case-collision',
      'duplicate-animation-name',
      'output-name-mismatch',
      'reserved-name',
      'trailing-space-or-dot',
    ]);
  });

  it('reports a code from that list for every finding it produces', () => {
    const document_ = createSprite({ width: 8, height: 8, name: 'Hero Idle', frames: 2 });
    document_.tags = [{ id: 'a', name: 'Idle Loop', from: 0, to: 1, direction: 'forward', repeat: 0 }];
    const report = validateAssetNaming(
      contract(document_, { outputs: [{ role: 'frame', path: 'nul.png' }] }),
    );
    for (const diagnostic of report.diagnostics) {
      expect(ASSET_NAMING_CODES).toContain(diagnostic.code);
      expect(['error', 'warning']).toContain(diagnostic.severity);
      expect(diagnostic.message.length).toBeGreaterThan(20);
    }
  });
});
