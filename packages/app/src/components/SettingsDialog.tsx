import { useEffect, useId, useRef, useState } from 'react';
import { useEditor } from '../editor-context.js';
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STOPS,
  FONT_STACKS,
  usePrefs,
  type FontSize,
  type ThemeMode,
} from '../prefs.js';
import { LOCALES, useI18n, type TranslationKey } from '../i18n.js';
import { Icon, type IconName } from './Icon.js';

type SectionId = 'appearance' | 'language' | 'shortcuts' | 'about';

const SECTIONS: { id: SectionId; icon: IconName; title: TranslationKey }[] = [
  { id: 'appearance', icon: 'contrast', title: 'settings.appearance' },
  { id: 'language', icon: 'globe', title: 'settings.language' },
  { id: 'shortcuts', icon: 'keyboard', title: 'settings.shortcuts' },
  { id: 'about', icon: 'info', title: 'settings.about' },
];

/** A font stack is either one of the presets or a family the user typed. */
function fontIdOf(css: string): string {
  return FONT_STACKS.find((stack) => stack.css === css)?.id ?? 'custom';
}

function cssOfFontId(id: string, custom: string): string {
  if (id === 'custom') return custom.trim() || FONT_STACKS[0].css;
  return FONT_STACKS.find((stack) => stack.id === id)?.css ?? FONT_STACKS[0].css;
}

/**
 * The settings dialog: a menu on the left, the selected section on the right.
 *
 * Edits are staged locally and written on Save, so Cancel genuinely cancels.
 * The preview strip renders at the *pending* values, which is what lets the font
 * choice be judged without the rest of the app flickering while you drag.
 */
export function SettingsDialog({ onClose }: { onClose(): void }): React.ReactNode {
  const { t } = useI18n();
  const { prefs, setPrefs } = usePrefs();
  const [section, setSection] = useState<SectionId>('appearance');

  // Staged copies, seeded from the saved values each time the dialog opens.
  const [themeMode, setThemeMode] = useState<ThemeMode>(prefs.themeMode);
  const [fontId, setFontId] = useState(() => fontIdOf(prefs.fontFamily));
  const [customFont, setCustomFont] = useState(() =>
    fontIdOf(prefs.fontFamily) === 'custom' ? prefs.fontFamily : '',
  );
  const [fontSize, setFontSize] = useState<FontSize>(prefs.fontSize);

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const pressedOnBackdrop = useRef(false);

  // A modal that opens without taking focus leaves the caret in whatever the
  // title bar had, so the first Tab still walks the toolbar behind the scrim.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  // Escape closes; the backdrop click is handled by the wrapper.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const pendingFont = cssOfFontId(fontId, customFont);
  const dirty =
    themeMode !== prefs.themeMode ||
    pendingFont !== prefs.fontFamily ||
    fontSize !== prefs.fontSize;

  const save = () => {
    setPrefs({ themeMode, fontFamily: pendingFont, fontSize });
    onClose();
  };

  const previewStyle = {
    fontFamily: pendingFont,
    // Already one of the five stops, so it cannot be set to something odd.
    fontSize: `${fontSize}px`,
  } as const;

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(event) => {
        // Remember where the press began, so a drag that ends on the backdrop
        // does not dismiss. This has to be tracked rather than handled with
        // `preventDefault()` on mousedown: suppressing the default is exactly
        // what lets a control inside the dialog act, and cancelling it stops
        // the select opening, stops the slider dragging, and stops text fields
        // taking focus.
        pressedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={() => {
        if (pressedOnBackdrop.current) onClose();
        pressedOnBackdrop.current = false;
      }}
    >
      <div
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <nav className="settings-nav" aria-label={t('settings.title')}>
          <div className="settings-nav-head">
            <h2 id={titleId}>{t('settings.title')}</h2>
          </div>
          <ul>
            {SECTIONS.map((entry, index) => (
              <li key={entry.id} style={{ animationDelay: `${40 + index * 35}ms` }}>
                <button
                  type="button"
                  className={`settings-nav-item${section === entry.id ? ' is-active' : ''}`}
                  onClick={() => setSection(entry.id)}
                  aria-current={section === entry.id ? 'page' : undefined}
                >
                  <Icon name={entry.icon} size={15} />
                  <span>{t(entry.title)}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* `key` restarts the entry animation whenever the section changes. */}
        <div className="settings-content" key={section}>
          {section === 'appearance' && (
            <AppearanceSection
              themeMode={themeMode}
              onThemeMode={setThemeMode}
              fontId={fontId}
              onFontId={(next) => {
                setFontId(next);
                if (next !== 'custom') setCustomFont(cssOfFontId(next, customFont));
              }}
              customFont={customFont}
              onCustomFont={setCustomFont}
              fontSize={fontSize}
              onFontSize={setFontSize}
              previewStyle={previewStyle}
              onReset={() => {
                setThemeMode('system');
                setFontId('system');
                setCustomFont('');
                setFontSize(DEFAULT_FONT_SIZE);
              }}
            />
          )}
          {section === 'language' && <LanguageSection />}
          {section === 'shortcuts' && <ShortcutsSection />}
          {section === 'about' && <AboutSection />}
        </div>

        <footer className="settings-actions">
          <button type="button" className="text-button" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            className="text-button is-primary"
            onClick={save}
            disabled={!dirty}
          >
            <Icon name="check" size={15} />
            {t('settings.save')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function AppearanceSection({
  themeMode,
  onThemeMode,
  fontId,
  onFontId,
  customFont,
  onCustomFont,
  fontSize,
  onFontSize,
  previewStyle,
  onReset,
}: {
  themeMode: ThemeMode;
  onThemeMode(mode: ThemeMode): void;
  fontId: string;
  onFontId(id: string): void;
  customFont: string;
  onCustomFont(value: string): void;
  fontSize: FontSize;
  onFontSize(value: FontSize): void;
  previewStyle: { fontFamily: string; fontSize: string };
  onReset(): void;
}): React.ReactNode {
  const { t } = useI18n();

  return (
    <>
      <header className="settings-section-head">
        <h3>{t('settings.appearance')}</h3>
        <p>{t('settings.appearanceHint')}</p>
      </header>

      <div className="settings-body">
        <div className="setting">
          <div className="setting-label">
            <span>{t('settings.theme')}</span>
          </div>
          <div className="theme-choices" role="radiogroup" aria-label={t('settings.theme')}>
            {(
              [
                { id: 'system', icon: 'display' },
                { id: 'dark', icon: 'moon' },
                { id: 'light', icon: 'sun' },
              ] as const
            ).map((choice) => (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={themeMode === choice.id}
                className={`theme-choice${themeMode === choice.id ? ' is-active' : ''}`}
                onClick={() => onThemeMode(choice.id)}
              >
                <Icon name={choice.icon} size={16} />
                <span>{t(`settings.theme_${choice.id}` as TranslationKey)}</span>
                {themeMode === choice.id && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>
          <p className="setting-hint">{t('settings.themeHint')}</p>
        </div>

        <div className="setting">
          <div className="setting-label">
            <span>{t('settings.font')}</span>
          </div>
          <div className="font-row">
            <select
              className="select"
              style={{ width: 170 }}
              value={fontId}
              aria-label={t('settings.font')}
              onChange={(event) => onFontId(event.target.value)}
            >
              {FONT_STACKS.map((stack) => (
                <option key={stack.id} value={stack.id}>
                  {stack.label ?? t('settings.fontSystem')}
                </option>
              ))}
              <option value="custom">{t('settings.fontCustom')}</option>
            </select>
            {fontId === 'custom' ? (
              <input
                className="input"
                style={{ flex: 1 }}
                value={customFont}
                spellCheck={false}
                placeholder="'My Font', sans-serif"
                aria-label={t('settings.fontCustom')}
                onChange={(event) => onCustomFont(event.target.value)}
              />
            ) : (
              <code className="font-stack" title={cssOfFontId(fontId, customFont)}>
                {cssOfFontId(fontId, customFont).split(',')[0]?.trim()}
              </code>
            )}
          </div>
          <p className="setting-hint">{t('settings.fontHint')}</p>
        </div>

        <div className="setting">
          <div className="setting-label">
            <span>{t('settings.fontSize')}</span>
          </div>
          <FontSizeScale value={fontSize} onChange={onFontSize} label={t('settings.fontSize')} />
          <p className="setting-hint">{t('settings.fontSizeHint')}</p>
        </div>

        <div className="setting">
          <div className="setting-label">
            <span>{t('settings.preview')}</span>
          </div>
          <div className="settings-preview" style={previewStyle}>
            <b>{t('settings.previewTitle')}</b>
            <span>{t('settings.previewBody')}</span>
          </div>
        </div>

        <button type="button" className="text-button settings-reset" onClick={onReset}>
          {t('settings.reset')}
        </button>
      </div>
    </>
  );
}

/**
 * Text size as five fixed stops rather than a free slider.
 *
 * The stops are spaced evenly, not proportionally to their pixel value, so every
 * one is an equally large target and 12px does not end up crowded against 14px.
 * The track is draggable, the labels are the radio buttons themselves, and arrow
 * keys step between them — so the control works by pointer and by keyboard.
 */
function FontSizeScale({
  value,
  onChange,
  label,
}: {
  value: FontSize;
  onChange(next: FontSize): void;
  label: string;
}): React.ReactNode {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const last = FONT_SIZE_STOPS.length - 1;
  const selected = FONT_SIZE_STOPS.indexOf(value);
  const offsetOf = (index: number) => (index / last) * 100;

  const pick = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onChange(FONT_SIZE_STOPS[Math.round(ratio * last)]);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = Math.min(last, Math.max(0, selected + step));
    onChange(FONT_SIZE_STOPS[next]);
  };

  return (
    <div className="size-scale" role="radiogroup" aria-label={label} data-dragging={dragging}>
      {/* `touch-action: none` in the stylesheet keeps a drag from scrolling. */}
      <div
        className="size-track"
        ref={trackRef}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          pick(event.clientX);
        }}
        onPointerMove={(event) => {
          if (dragging) pick(event.clientX);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(false);
        }}
        onPointerCancel={() => setDragging(false)}
      >
        <span className="size-rail" />
        <span className="size-fill" style={{ width: `${offsetOf(selected)}%` }} />
        {FONT_SIZE_STOPS.map((stop, index) => (
          <span
            key={stop}
            className={`size-tick${index <= selected ? ' is-passed' : ''}`}
            style={{ left: `${offsetOf(index)}%` }}
          />
        ))}
        <span className="size-knob" style={{ left: `${offsetOf(selected)}%` }} />
      </div>

      <div className="size-stops">
        {FONT_SIZE_STOPS.map((stop, index) => (
          <button
            key={stop}
            type="button"
            role="radio"
            aria-checked={stop === value}
            // Roving tabindex: one stop in the tab order, arrows move within.
            tabIndex={stop === value ? 0 : -1}
            className={`size-stop${stop === value ? ' is-active' : ''}`}
            style={{ left: `${offsetOf(index)}%` }}
            onClick={() => onChange(stop)}
            onKeyDown={onKeyDown}
          >
            {stop}px
          </button>
        ))}
      </div>
    </div>
  );
}

function LanguageSection(): React.ReactNode {
  const { t, locale, setLocale } = useI18n();
  return (
    <>
      <header className="settings-section-head">
        <h3>{t('settings.language')}</h3>
        <p>{t('settings.languageHint')}</p>
      </header>
      <div className="settings-body">
        <div className="language-choices" role="radiogroup" aria-label={t('settings.language')}>
          {LOCALES.map((entry) => (
            <button
              key={entry.code}
              type="button"
              role="radio"
              aria-checked={entry.code === locale}
              className={`language-choice${entry.code === locale ? ' is-active' : ''}`}
              onClick={() => setLocale(entry.code)}
            >
              <span className="language-native">{entry.native}</span>
              <span className="language-tag mono">{entry.tag}</span>
              {entry.code === locale && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function ShortcutsSection(): React.ReactNode {
  const { t } = useI18n();
  const rows: [string, string][] = [
    ['B / E / L / R / O', 'settings.shortcutDraw'],
    ['F / X / I / H', 'settings.shortcutTools'],
    ['Tab', 'tools.swap'],
    ['[ / ]', 'tools.brush'],
    ['+ / -', 'settings.shortcutZoom'],
    ['Ctrl + Z', 'top.undo'],
    ['Ctrl + Shift + Z', 'top.redo'],
    ['Ctrl + \\', 'top.toggleSidebar'],
    ['Ctrl + ,', 'settings.open'],
    ['Ctrl + N / O / S', 'top.new'],
    ['Ctrl + E', 'top.exportPng'],
  ];
  return (
    <>
      <header className="settings-section-head">
        <h3>{t('settings.shortcuts')}</h3>
        <p>{t('settings.shortcutsHint')}</p>
      </header>
      <div className="settings-body">
        <dl className="shortcut-list">
          {rows.map(([keys, label]) => (
            <div key={keys} className="shortcut-row">
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{t(label as TranslationKey)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}

function AboutSection(): React.ReactNode {
  const { t } = useI18n();
  const { status } = useEditor();
  return (
    <>
      <header className="settings-section-head">
        <h3>{t('settings.about')}</h3>
        <p>{t('settings.aboutHint')}</p>
      </header>
      <div className="settings-body">
        <dl className="about-list">
          <div className="about-row">
            <dt>{t('settings.aboutName')}</dt>
            <dd>dotloom-mcp</dd>
          </div>
          <div className="about-row">
            <dt>{t('settings.aboutMcp')}</dt>
            <dd className="mono">
              {status?.mcp.running
                ? `http://${status.mcp.url?.replace('http://', '')}`
                : t('status.mcpOff')}
            </dd>
          </div>
          <div className="about-row">
            <dt>{t('settings.aboutDocuments')}</dt>
            <dd className="mono">{status?.documents.length ?? 0}</dd>
          </div>
        </dl>
        <p className="setting-hint">{t('settings.aboutStack')}</p>
      </div>
    </>
  );
}
