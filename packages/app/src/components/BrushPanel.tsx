import { useEditor } from '../editor-context.js';
import { useI18n } from '../i18n.js';

/** Dither patterns are the core's own vocabulary, shown verbatim. */
const DITHER_PATTERNS = [
  '',
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

/**
 * Everything that shapes a stroke.
 *
 * Moved out of the tool rail, where it competed with the tools for a 220px
 * column, into a section that can give each control a label.
 */
export function BrushPanel(): React.ReactNode {
  const editor = useEditor();
  const { t } = useI18n();

  return (
    <>
      <div className="field-row">
        <span>{t('brush.size')}</span>
        <span className="spacer" />
        <input
          type="range"
          min={1}
          max={8}
          value={editor.brushSize}
          aria-label={t('tools.brush')}
          onChange={(event) => editor.setBrushSize(Number(event.target.value))}
        />
        <span className="mono" style={{ minWidth: 30, textAlign: 'right' }}>
          {editor.brushSize} {t('tools.pixel')}
        </span>
      </div>

      <label className="switch-row">
        <input
          type="checkbox"
          checked={editor.fillShapes}
          onChange={(event) => editor.setFillShapes(event.target.checked)}
        />
        <span className="switch" />
        {t('brush.filled')}
      </label>

      <div className="field-row" title={t('tools.clipHint')}>
        <span>{t('brush.clip')}</span>
        <span className="spacer" />
        <select
          className="select"
          style={{ maxWidth: 150 }}
          value={editor.clip}
          aria-label={t('brush.clip')}
          onChange={(event) => editor.setClip(event.target.value as 'none' | 'cel' | 'composite')}
        >
          <option value="none">{t('brush.clipNone')}</option>
          <option value="cel">{t('brush.clipLayer')}</option>
          <option value="composite">{t('tools.composite')}</option>
        </select>
      </div>

      <div className="field-row" title={t('tools.ditherHint')}>
        <span>{t('brush.dither')}</span>
        <span className="spacer" />
        <select
          className="select"
          style={{ maxWidth: 150 }}
          value={editor.ditherPattern}
          aria-label={t('brush.dither')}
          onChange={(event) => editor.setDitherPattern(event.target.value)}
        >
          {DITHER_PATTERNS.map((pattern) => (
            <option key={pattern || 'off'} value={pattern}>
              {pattern === '' ? t('tools.ditherOff') : pattern.replaceAll('-', ' ')}
            </option>
          ))}
        </select>
      </div>

      {editor.ditherPattern ? (
        <div className="meter">
          <div className="meter-head">
            <span>{t('brush.level')}</span>
            <span className="meter-value">{Math.round(editor.ditherLevel * 100)}%</span>
          </div>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={editor.ditherLevel}
            aria-label={t('brush.level')}
            onChange={(event) => editor.setDitherLevel(Number(event.target.value))}
          />
        </div>
      ) : null}

      <div className="meter">
        <div className="meter-head">
          <span>{t('brush.alpha')}</span>
          <span className="meter-value">{Math.round((editor.primary.a / 255) * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={255}
          value={editor.primary.a}
          aria-label={t('brush.alpha')}
          onChange={(event) =>
            editor.setPrimary({ ...editor.primary, a: Number(event.target.value) })
          }
        />
      </div>
    </>
  );
}
