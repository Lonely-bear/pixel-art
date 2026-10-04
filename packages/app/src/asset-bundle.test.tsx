/**
 * The asset-bundle panel: its decisions, its four states, and the i18n it depends on.
 *
 * There is no DOM test environment in this package, so the component is exercised
 * through `renderToStaticMarkup` with `AssetBundleReport` — the part that turns one
 * exporter result into what the user reads — and through `summariseBundle` for the
 * state machine that feeds it. Both are the decision surface; the surrounding
 * `<form>` is layout.
 *
 * Two things here are not testing convenience:
 *
 * - The i18n completeness check. `TranslationKey` is derived from `en`, so a key the
 *   *source* forgot to reference is invisible to `tsc` and only this catches it.
 * - The "no verdict" walk. A quality report was deleted in 0.3.1 because a model
 *   handed the number sanded a lake into a dark flat rectangle (AGENTS.md,
 *   "Do not show an agent a number to optimise"). This panel reports files, named
 *   defects and importer warnings; if a number ever appears in what it renders,
 *   this fails.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { APP_LOCALES, type AssetExportResult, type AssetNamingFinding } from '../shared/types.js';
import { I18nProvider, messages, type TranslationKey } from './i18n.js';
import {
  buildExportRequest,
  errorsOf,
  initialBundleForm,
  sortFindings,
  summariseBundle,
  warningsOf,
  type BundleForm,
  type BundleSummary,
} from './asset-bundle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string): string => readFileSync(path.join(here, file), 'utf8');

// The component reads `api`, which is `window.pixel` at module scope, so the
// bridge has to exist before the import. It is never called: these tests render
// the report from results the exporter has already produced.
const stubApi = {
  exportMeta: async () => null,
  exportEngine: async () => null,
  setLocale: async () => {},
  onUpdateEvent: () => () => {},
  onChanged: () => () => {},
  onCommand: () => () => {},
  onWindowState: () => () => {},
} as unknown as Window['pixel'];

(globalThis as { window?: unknown }).window = {
  pixel: stubApi,
  localStorage: undefined,
  navigator: { language: 'en' },
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
};

const { AssetBundleReport } = await import('./components/AssetBundleDialog.js');

function render(summary: BundleSummary): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <AssetBundleReport summary={summary} />
    </I18nProvider>,
  );
}

function written(overrides: Partial<AssetExportResult> = {}): AssetExportResult {
  return {
    written: true,
    metaPath: 'C:\\out\\hero\\meta.json',
    contentHash: 'sha256:' + 'a'.repeat(64),
    schemaVersion: 1,
    files: ['meta.json', 'hero/hero.tres'],
    naming: { ok: true, diagnostics: [] },
    engine: {
      engine: 'godot',
      root: 'hero',
      files: ['hero/hero.tres', 'hero/hero.directions.res'],
      warnings: ['Per-frame durations are flattened to one fps for SpriteFrames.'],
    },
    ...overrides,
  };
}

function finding(overrides: Partial<AssetNamingFinding> = {}): AssetNamingFinding {
  return {
    code: 'reserved-name',
    severity: 'error',
    path: 'outputs[0].path',
    message: '"hero/nul.png" is a reserved device name.',
    value: 'hero/nul.png',
    ...overrides,
  };
}

// ---------------------------------------------------------------- the four states

describe('the panel reports a cancelled dialog as nothing at all', () => {
  it('is a distinct outcome, with no error and no message', () => {
    // `null` is the save dialog being closed. Reporting it as a failure is the
    // failure mode this whole branch exists to prevent.
    const summary = summariseBundle(null);
    expect(summary.outcome).toBe('cancelled');
    expect(summary.failure).toBeUndefined();
    expect(summary.refusal).toBeUndefined();
    expect(summary.files).toEqual([]);
    expect(summary.findings).toEqual([]);
    expect(render(summary)).toBe('');
  });

  it('is not the same state as a failed call', () => {
    const failed = summariseBundle(null, new Error('EACCES'));
    expect(failed.outcome).toBe('failed');
    expect(failed.failure).toBe('EACCES');
    expect(render(failed)).toContain('EACCES');
    // A failed call still shows nothing about files, because nothing was written.
    expect(render(failed)).not.toContain('meta.json');
  });
});

describe('a successful export lists what was written', () => {
  it('shows the file list, the contract path, the hash and the importer notes', () => {
    const summary = summariseBundle(written());
    expect(summary.outcome).toBe('written');
    const html = render(summary);
    expect(html).toContain('meta.json');
    expect(html).toContain('hero/hero.tres');
    expect(html).toContain('hero/hero.directions.res');
    expect(html).toContain('sha256:');
    expect(html).toContain('Per-frame durations are flattened to one fps');
    expect(html).toContain('Written');
  });

  it('says so plainly when the exporter reported no defects at all', () => {
    const html = render(summariseBundle(written()));
    expect(html).toContain('No naming problems.');
    expect(html).not.toContain('naming warnings');
  });
});

describe('a naming warning is shown and is not blocking', () => {
  it('renders the warning and still reports the bundle as written', () => {
    const summary = summariseBundle(
      written({
        naming: {
          ok: true,
          diagnostics: [
            finding({
              code: 'name-camel-case',
              severity: 'warning',
              path: 'asset.name',
              message: 'Asset name is camelCase; most engines prefer kebab-case.',
              value: 'heroIdle',
            }),
          ],
        },
      }),
    );
    // A warning is reported *and* written, so the outcome must not be `refused`.
    expect(summary.outcome).toBe('written');
    expect(warningsOf(summary.findings)).toHaveLength(1);
    expect(errorsOf(summary.findings)).toHaveLength(0);

    const html = render(summary);
    expect(html).toContain('name-camel-case');
    expect(html).toContain('camelCase');
    expect(html).toContain('asset.name');
    expect(html).toContain('hero/hero.tres');
    expect(html).toContain('Written anyway');
  });
});

describe('a naming error refuses, and presents nothing as written', () => {
  it('shows the refusal and lists no files', () => {
    const result = written({
      written: false,
      metaPath: undefined,
      contentHash: undefined,
      files: [],
      engine: undefined,
      naming: { ok: false, diagnostics: [finding()] },
      refusal:
        'Asset naming refuses this bundle: 1 error(s) [reserved-name]. ' +
        'First: "outputs[0].path" - "hero/nul.png" is a reserved device name.',
    });
    const summary = summariseBundle(result);
    expect(summary.outcome).toBe('refused');
    expect(summary.files).toEqual([]);
    expect(summary.metaPath).toBeUndefined();
    expect(summary.contentHash).toBeUndefined();
    expect(summary.engine).toBeUndefined();

    const html = render(summary);
    expect(html).toContain('Nothing was written');
    expect(html).toContain('reserved-name');
    expect(html).toContain('Asset naming refuses this bundle');
    // The words that would tell the user a file exists.
    expect(html).not.toContain('Written ·');
    expect(html).not.toContain('hero/hero.tres');
    expect(html).not.toContain('sha256:');
  });
});

describe('the refusal sentence is framed by a translated key, not shown bare', () => {
  it('renders a localized heading beside the exporter’s English sentence', () => {
    const html = render(
      summariseBundle(written({ written: false, files: [], refusal: 'Case collision.' })),
    );
    expect(html).toContain('Nothing was written');
    expect(html).toContain('Reason reported by the exporter');
    expect(html).toContain('Case collision.');
  });

  it('has that key in all five locales', () => {
    // The sentence itself is English in `asset-export.ts` and always will be; what
    // the panel must not do is present it as the explanation on its own.
    for (const locale of APP_LOCALES) {
      const dictionary = messages[locale] as Record<TranslationKey, string>;
      for (const key of [
        'asset.refusedHeading',
        'asset.refusedBody',
        'asset.refusalDetail',
      ] as const) {
        expect(dictionary[key], `${locale} is missing ${key}`).toBeTruthy();
      }
    }
  });
});

// ------------------------------------------------------------------ the request

describe('what the panel asks the exporter for', () => {
  it('never guesses per-frame directions', () => {
    // A facing is a decision made where the artwork is drawn. Inferring one from
    // tag names would put a character in an engine facing the wrong way with
    // nothing in the contract to trace it back to, so the field is omitted.
    for (const engine of [null, 'godot', 'unity', 'phaser', 'excalidraw'] as const) {
      const request = buildExportRequest({ ...initialBundleForm(), engine });
      expect(Object.hasOwn(request, 'directions')).toBe(false);
    }
  });

  it('omits the sheet unless it is asked for, and omits empty optionals', () => {
    expect(buildExportRequest(initialBundleForm())).toEqual({});

    const withSheet = buildExportRequest({ ...initialBundleForm(), sheet: true, sheetScale: 2 });
    expect(withSheet.sheet).toEqual({ image: 'sprite.png', scale: 2 });
    // Zero columns means "let the packer choose", not "pack into zero columns".
    expect(Object.hasOwn(withSheet.sheet!, 'columns')).toBe(false);

    const named = buildExportRequest({ ...initialBundleForm(), directory: '  sprites/hero  ' });
    expect(named.directory).toBe('sprites/hero');
  });

  it('clamps a column count and a scale into something the packer can use', () => {
    const form: BundleForm = { ...initialBundleForm(), sheet: true, sheetColumns: -4, sheetScale: 0 };
    const request = buildExportRequest(form);
    expect(request.sheet).toEqual({ image: 'sprite.png', scale: 1 });
  });
});

describe('findings are ordered errors first, then by byte order', () => {
  it('never sorts with localeCompare', () => {
    // The contract's own diagnostics are sorted the same way, so a
    // locale-sensitive sort would make one bundle list in two orders.
    const sorted = sortFindings([
      finding({ code: 'b-code', severity: 'warning' }),
      finding({ code: 'a-code', severity: 'error' }),
      finding({ code: 'a-code', severity: 'warning', path: 'z' }),
      finding({ code: 'a-code', severity: 'warning', path: 'a' }),
    ]);
    expect(sorted.map((f) => `${f.severity}:${f.code}:${f.path}`)).toEqual([
      'error:a-code:outputs[0].path',
      'warning:a-code:a',
      'warning:a-code:z',
      'warning:b-code:outputs[0].path',
    ]);
  });
});

// --------------------------------------------------------------------- i18n

describe('every translation resolves in all five locales', () => {
  const keys = Object.keys(messages.en) as TranslationKey[];

  it('has the five locales the app ships', () => {
    expect([...APP_LOCALES]).toEqual(['en', 'ja', 'ko', 'zh-CN', 'zh-TW']);
    expect(Object.keys(messages).sort()).toEqual([...APP_LOCALES].sort());
  });

  for (const locale of APP_LOCALES) {
    it(`${locale}: no missing entry and no unreferenced one`, () => {
      const dictionary = messages[locale] as Record<string, string>;
      for (const key of keys) {
        // A blank label in production is what this catches; `tsc` only catches it
        // in the locale the compiler reads the dictionary from.
        expect(dictionary[key], `${locale} is missing ${key}`).toBeTypeOf('string');
        expect(dictionary[key]!.length, `${locale} has an empty ${key}`).toBeGreaterThan(0);
      }
      const extra = Object.keys(dictionary).filter((key) => !Object.hasOwn(messages.en, key));
      expect(extra, `${locale} carries keys the source no longer has`).toEqual([]);
    });
  }

  it('invents no placeholder the source does not have', () => {
    // A translation that invents `{error}` renders the literal word. Omitting a
    // placeholder is a different matter and is allowed: `frames.tagged` declares
    // `{plural}` for the English plural suffix, which `ja`, `ko` and both Chinese
    // dictionaries correctly leave out. So the rule is one-directional, and the
    // exact-parity check below covers the keys this panel added.
    const placeholders = (text: string): string[] =>
      [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
    for (const locale of APP_LOCALES) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const key of keys) {
        for (const name of placeholders(dictionary[key]!)) {
          expect(placeholders(messages.en[key]!), `${locale} ${key}`).toContain(name);
        }
      }
    }
  });

  it('keeps every placeholder of the panel’s own templates', () => {
    const placeholders = (text: string): string[] =>
      [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
    const own = keys.filter((key) => key.startsWith('asset.'));
    expect(own.length).toBeGreaterThan(0);
    for (const locale of APP_LOCALES) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const key of own) {
        expect(placeholders(dictionary[key]!), `${locale} ${key}`).toEqual(
          placeholders(messages.en[key]!),
        );
      }
    }
  });
});

// ------------------------------------------------------------------ no verdict

/**
 * Recursively collect every key name in a value, so a nested `score` cannot hide.
 * The same walk the CLI's export check uses: names, not values, because the
 * number is the thing that must not exist.
 */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, i) => keyPaths(entry, `${prefix}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
      `${prefix}.${key}`,
      ...keyPaths(entry, `${prefix}.${key}`),
    ]);
  }
  return [];
}

const FORBIDDEN = /score|grade|rating|percent|quality/i;

describe('the panel shows no verdict', () => {
  it('puts no such key in what the report renders', () => {
    // A score handed to anyone becomes the target instead of the artwork. This
    // panel reports named defects, paths and importer warnings, and that is all.
    for (const result of [
      written(),
      written({
        naming: {
          ok: false,
          diagnostics: [finding(), finding({ code: 'name-camel-case', severity: 'warning' })],
        },
      }),
      written({ written: false, files: [], refusal: 'Case collision.' }),
    ]) {
      for (const keyPath of keyPaths(summariseBundle(result))) {
        expect(FORBIDDEN.test(keyPath), `${keyPath} looks like a verdict`).toBe(false);
      }
    }
  });

  it('names no such thing in the panel’s own source', () => {
    // The walk above proves the data carries none; this proves nothing computes
    // one on the way to the screen.
    for (const file of ['asset-bundle.ts', 'components/AssetBundleDialog.tsx']) {
      const text = source(file);
      const hits = text
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => FORBIDDEN.test(line));
      expect(hits.map((h) => `${file}:${h.index + 1} ${h.line.trim()}`)).toEqual([]);
    }
  });

  it('shows only what the exporter reported', () => {
    const summary = summariseBundle(written());
    // Every rendered value is a path, a count or a string the exporter produced.
    for (const file of summary.files) expect(typeof file).toBe('string');
    expect(typeof summary.contentHash).toBe('string');
    expect(summary.engine!.warnings.every((w) => typeof w === 'string')).toBe(true);
  });
}, 15000);