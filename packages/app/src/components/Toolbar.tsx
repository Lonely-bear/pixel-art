import { useEditor } from '../editor-context.js';
import type { ToolId } from '../../shared/types.js';
import { rgbaToCss, rgbaToHex, toColor } from '../color-utils.js';
import { useI18n, type TranslationKey } from '../i18n.js';
import { Icon, type IconName } from './Icon.js';

const TOOLS: Array<{ id: ToolId; icon: IconName; labelKey: TranslationKey; key: string }> = [
  { id: 'pencil', icon: 'pencil', labelKey: 'tools.pencil', key: 'B' },
  { id: 'eraser', icon: 'eraser', labelKey: 'tools.eraser', key: 'E' },
  { id: 'line', icon: 'line', labelKey: 'tools.line', key: 'L' },
  { id: 'rect', icon: 'rectangle', labelKey: 'tools.rect', key: 'R' },
  { id: 'ellipse', icon: 'ellipse', labelKey: 'tools.ellipse', key: 'O' },
  { id: 'fill', icon: 'fill', labelKey: 'tools.fill', key: 'F' },
  { id: 'replace', icon: 'replace', labelKey: 'tools.replace', key: 'X' },
  { id: 'eyedropper', icon: 'eyedropper', labelKey: 'tools.eyedropper', key: 'I' },
  { id: 'pan', icon: 'pan', labelKey: 'tools.pan', key: 'H' },
];

const DITHER_PATTERNS = [
  'checker',
  'checker-inv',
  'bayer4',
  'bayer8',
  'dots',
  'sparse',
  'dense',
  'horizontal',
  'vertical',
  'diagonal',
] as const;

export function Toolbar(): React.ReactNode {
  const editor = useEditor();
  const { t } = useI18n();
  const { tool, setTool, brushSize, setBrushSize, primary, setPrimary, secondary, setSecondary } =
    editor;
  const activeTool = TOOLS.find((entry) => entry.id === tool) ?? TOOLS[0];

  const swap = () => {
    setPrimary(secondary);
    setSecondary(primary);
  };

  return (
    <aside className="toolbar" aria-label={t('tools.tools')}>
      <section className="rail-section tool-section">
        <div className="rail-heading">
          <span>{t('tools.tools')}</span>
          <kbd>{activeTool.key}</kbd>
        </div>
        <div className="tool-grid">
          {TOOLS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`tool-button${tool === entry.id ? ' active' : ''}`}
              title={`${t(entry.labelKey)} (${entry.key})`}
              aria-label={t(entry.labelKey)}
              aria-pressed={tool === entry.id}
              onClick={() => setTool(entry.id)}
            >
              <Icon name={entry.icon} size={19} />
            </button>
          ))}
        </div>
        <div className="active-tool" aria-live="polite">
          <span><Icon name={activeTool.icon} size={16} /></span>
          <strong>{t(activeTool.labelKey)}</strong>
        </div>
      </section>

      <section className="rail-section">
        <div className="rail-heading">
          <span>{t('tools.drawSettings')}</span>
        </div>
        <label className="compact-field">
          <span>{t('tools.brush')}</span>
          <div className="slider-row">
            <input
              type="range"
              min={1}
              max={8}
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
            />
            <output>{brushSize}px</output>
          </div>
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={editor.fillShapes}
            onChange={(event) => editor.setFillShapes(event.target.checked)}
          />
          <span className="switch-track"><span /></span>
          <span>{t('tools.filledShapes')}</span>
        </label>
      </section>

      <section className="rail-section">
        <div className="rail-heading">
          <span>{t('tools.effects')}</span>
        </div>
        <label className="compact-field" title={t('tools.clipHint')}>
          <span>{t('tools.clip')}</span>
          <select
            className="doc-select"
            value={editor.clip}
            onChange={(event) => editor.setClip(event.target.value as 'none' | 'cel' | 'composite')}
          >
            <option value="none">{t('tools.clipNone')}</option>
            <option value="cel">{t('tools.clipLayer')}</option>
            <option value="composite">{t('tools.clipComposite')}</option>
          </select>
        </label>
        <label className="compact-field" title={t('tools.ditherHint')}>
          <span>{t('tools.dither')}</span>
          <select
            className="doc-select"
            value={editor.ditherPattern}
            onChange={(event) => editor.setDitherPattern(event.target.value)}
          >
            <option value="">{t('tools.off')}</option>
            {DITHER_PATTERNS.map((pattern) => (
              <option key={pattern} value={pattern}>
                {pattern.replaceAll('-', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="compact-field">
          <span>{t('tools.level')}</span>
          <div className="slider-row">
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={editor.ditherLevel}
              disabled={!editor.ditherPattern}
              onChange={(event) => editor.setDitherLevel(Number(event.target.value))}
            />
            <output>{Math.round(editor.ditherLevel * 100)}%</output>
          </div>
        </label>
      </section>

      <section className="rail-section color-section">
        <div className="rail-heading">
          <span>{t('tools.colors')}</span>
        </div>
        <div className="color-well">
          <div className="swatch-stack">
            <label className="swatch primary" title={t('tools.primary')}>
              <input
                type="color"
                value={rgbaToHex(primary).slice(0, 7)}
                onChange={(event) => setPrimary(toColor(event.target.value, primary))}
              />
              <span style={{ background: rgbaToCss(primary) }} />
              <em>1</em>
            </label>
            <label className="swatch secondary" title={t('tools.secondary')}>
              <input
                type="color"
                value={rgbaToHex(secondary).slice(0, 7)}
                onChange={(event) => setSecondary(toColor(event.target.value, secondary))}
              />
              <span style={{ background: rgbaToCss(secondary) }} />
              <em>2</em>
            </label>
          </div>
          <button
            type="button"
            className="icon-button color-swap"
            onClick={swap}
            title={`${t('tools.swap')} (Tab)`}
            aria-label={t('tools.swap')}
          >
            <Icon name="swap" size={16} />
          </button>
          <code className="hex">{rgbaToHex(primary)}</code>
        </div>
        <label className="compact-field alpha-field">
          <span>{t('tools.alpha')}</span>
          <input
            type="range"
            min={0}
            max={255}
            value={primary.a}
            onChange={(event) => setPrimary({ ...primary, a: Number(event.target.value) })}
          />
        </label>
      </section>
    </aside>
  );
}
