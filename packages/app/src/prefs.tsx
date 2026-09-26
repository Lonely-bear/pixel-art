/**
 * Appearance preferences: theme, UI font and UI text scale.
 *
 * One store, one source of truth, applied by writing three things onto
 * `<html>`: `data-theme`, `--ui-font` and `--ui-scale`. Everything else in the
 * UI is written against those, so a preference change needs no re-render of any
 * component beyond the few that read `resolvedTheme` to redraw a canvas.
 *
 * `readPrefs` / `applyPrefs` are exported so `main.tsx` can apply the stored
 * state before the first render — otherwise a user who chose 22px or the light
 * theme would get one frame of defaults while React mounts.
 *
 * Deliberately not synced to the main process: the window is frameless and draws
 * its own buttons, so there is no OS chrome whose appearance has to follow.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'dark' | 'light';
/** `system` is the default: the app follows the OS until a choice is recorded. */
export type ThemeMode = Theme | 'system';

const STORAGE_KEY = 'pixel-art.prefs';

/** The default is the system font stack — no webfont, no download, no override. */
export const SYSTEM_FONT =
  "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans', 'Malgun Gothic', 'Noto Sans CJK SC', sans-serif";

export interface FontStack {
  id: string;
  /** Null means "use the localised name for the system stack". */
  label: string | null;
  css: string;
}

/**
 * Stacks the operating system already has, so choosing one never triggers a
 * download. `Roboto`, `Georgia` and `Consolas` ship with the major platforms;
 * every CJK entry is a font the matching OS already uses for that script.
 */
export const FONT_STACKS: readonly FontStack[] = [
  { id: 'system', label: null, css: SYSTEM_FONT },
  { id: 'inter', label: 'Inter', css: "'Inter', 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { id: 'helvetica', label: 'Helvetica', css: "'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { id: 'georgia', label: 'Georgia', css: "Georgia, 'Times New Roman', 'Songti SC', SimSun, 'Yu Mincho', serif" },
  { id: 'mono', label: 'Consolas', css: "Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Sarasa Mono SC', monospace" },
];

/**
 * The base the pixel sizes in `styles.css` were authored against: `body` is
 * `13px` and every other size is a multiple of it, so `--ui-scale` is simply
 * `chosen size / 13`. The user picks 12–22px and the whole interface keeps its
 * proportions instead of only the root growing.
 */
const CSS_BASE_PX = 13;

/**
 * The only sizes the settings dialog offers. Deliberately a short list: a
 * free slider lets people land on 13.7px, which is neither readable nor
 * predictable, and the steps below are the sizes the layout is checked at.
 */
export const FONT_SIZE_STOPS = [12, 14, 16, 18, 22] as const;
export type FontSize = (typeof FONT_SIZE_STOPS)[number];
export const DEFAULT_FONT_SIZE: FontSize = 14;

export interface Prefs {
  themeMode: ThemeMode;
  fontFamily: string;
  fontSize: FontSize;
}

export const DEFAULT_PREFS: Prefs = {
  themeMode: 'system',
  fontFamily: SYSTEM_FONT,
  fontSize: DEFAULT_FONT_SIZE,
};

/**
 * Snaps to the nearest offered size, so a stored value from an older build — or
 * anything hand-edited into localStorage — can never produce a size the control
 * does not offer.
 */
export function nearestFontSize(value: number): FontSize {
  let best: FontSize = FONT_SIZE_STOPS[0];
  for (const stop of FONT_SIZE_STOPS) {
    if (Math.abs(stop - value) < Math.abs(best - value)) best = stop;
  }
  return best;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system';
}

/** Tolerant reader: a corrupt or hand-edited value falls back per field. */
export function readPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFS };
    return {
      themeMode: isThemeMode(parsed.themeMode) ? parsed.themeMode : DEFAULT_PREFS.themeMode,
      fontFamily:
        typeof parsed.fontFamily === 'string' && parsed.fontFamily.trim()
          ? parsed.fontFamily
          : DEFAULT_PREFS.fontFamily,
      fontSize:
        typeof parsed.fontSize === 'number'
          ? nearestFontSize(parsed.fontSize)
          : DEFAULT_PREFS.fontSize,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function resolveTheme(mode: ThemeMode): Theme {
  return mode === 'system' ? systemTheme() : mode;
}

/** Applies without recording, so a first run keeps following the OS. */
export function applyPrefs(prefs: Prefs, theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty('--ui-font', prefs.fontFamily);
  root.style.setProperty('--ui-scale', String(prefs.fontSize / CSS_BASE_PX));
}

/** Applies *and* records, which is what an explicit choice does. */
export function savePrefs(prefs: Prefs, theme: Theme): void {
  applyPrefs(prefs, theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // The choice simply will not survive a restart.
  }
}

interface PrefsValue {
  prefs: Prefs;
  /** What `themeMode` resolves to right now. */
  theme: Theme;
  setPrefs(next: Partial<Prefs>): void;
}

const PrefsContext = createContext<PrefsValue | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }): ReactNode {
  const [prefs, setState] = useState<Prefs>(readPrefs);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(readPrefs().themeMode));

  const commit = useCallback((next: Prefs) => {
    const resolved = resolveTheme(next.themeMode);
    setState(next);
    setTheme(resolved);
    savePrefs(next, resolved);
  }, []);

  useEffect(() => {
    applyPrefs(prefs, theme);
  }, [prefs, theme]);

  // Only follow the OS while the theme is still set to `system`.
  useEffect(() => {
    if (prefs.themeMode !== 'system') return;
    const media = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!media) return;
    const onChange = () => setTheme(systemTheme());
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [prefs.themeMode]);

  const setPrefs = useCallback(
    (patch: Partial<Prefs>) => commit({ ...prefs, ...patch }),
    [prefs, commit],
  );

  const value = useMemo(() => ({ prefs, theme, setPrefs }), [prefs, theme, setPrefs]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsValue {
  const value = useContext(PrefsContext);
  if (!value) throw new Error('usePrefs must be used inside <PrefsProvider>');
  return value;
}

/** Just the resolved theme, for the two components that redraw a canvas. */
export function useResolvedTheme(): Theme {
  return usePrefs().theme;
}
