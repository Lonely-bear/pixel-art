import { useEditor } from '../editor-context.js';
import type { ToolId } from '../../shared/types.js';
import { rgbaToCss, rgbaToHex, toColor } from '../color-utils.js';
import { useI18n, type TranslationKey } from '../i18n.js';
import { Icon, type IconName } from './Icon.js';

const TOOLS: { id: ToolId; icon: IconName; label: TranslationKey; key: string }[] = [
  { id: 'pencil', icon: 'pencil', label: 'tools.pencil', key: 'B' },
  { id: 'eraser', icon: 'eraser', label: 'tools.eraser', key: 'E' },
  { id: 'line', icon: 'line', label: 'tools.line', key: 'L' },
  { id: 'rect', icon: 'rectangle', label: 'tools.rect', key: 'R' },
  { id: 'ellipse', icon: 'ellipse', label: 'tools.ellipse', key: 'O' },
  { id: 'fill', icon: 'fill', label: 'tools.fill', key: 'F' },
  { id: 'replace', icon: 'replace', label: 'tools.replace', key: 'X' },
  { id: 'eyedropper', icon: 'eyedropper', label: 'tools.eyedropper', key: 'I' },
  { id: 'select', icon: 'selection', label: 'tools.select', key: 'M' },
  { id: 'pan', icon: 'hand', label: 'tools.pan', key: 'H' },
];

const MAX_BRUSH = 8;

/**
 * The tool rail.
 *
 * Deliberately narrow: tools, the two colours and the brush size — the things
 * you reach for while drawing. Everything else (clip, dither, alpha, blend)
 * lives in the sidebar's Brush section, where it has room for a label.
 */
export function ToolRail(): React.ReactNode {
  const editor = useEditor();
  const { t } = useI18n();
  const { tool, setTool, brushSize, setBrushSize, primary, setPrimary, secondary, setSecondary } =
    editor;

  const swap = () => {
    setPrimary(secondary);
    setSecondary(primary);
  };

  return (
    <aside className="rail" aria-label={t('tools.tools')}>
      {TOOLS.map((entry) => {
        const active = entry.id === tool;
        return (
          <div key={entry.id} className={`rail-tool${active ? ' is-active' : ''}`}>
            <span className="rail-ind" aria-hidden="true" />
            <button
              type="button"
              className="rail-button"
              title={`${t(entry.label)} (${entry.key})`}
              aria-label={t(entry.label)}
              aria-pressed={active}
              onClick={() => setTool(entry.id)}
            >
              <Icon name={entry.icon} size={18} />
            </button>
          </div>
        );
      })}

      {/* Pushes the colour block to the bottom of the rail, where the hand is. */}
      <div className="rail-fill" />

      <div className="rail-sep" />

      <div className="rail-foot">
        <div className="swatch-well">
          <label
            className="swatch is-secondary"
            style={{ background: rgbaToCss(secondary) }}
            title={t('tools.secondary')}
          >
            <input
              type="color"
              value={rgbaToHex(secondary).slice(0, 7)}
              onChange={(event) => setSecondary(toColor(event.target.value, secondary))}
            />
          </label>
          <label
            className="swatch is-primary"
            style={{ background: rgbaToCss(primary) }}
            title={t('tools.primary')}
          >
            <input
              type="color"
              value={rgbaToHex(primary).slice(0, 7)}
              onChange={(event) => setPrimary(toColor(event.target.value, primary))}
            />
          </label>
        </div>

        <button
          type="button"
          className="rail-slot"
          onClick={swap}
          title={`${t('tools.swap')} (Tab)`}
          aria-label={t('tools.swap')}
        >
          <Icon name="swap" size={14} />
        </button>

        <div className="rail-slot rail-stepper" title={`${t('tools.brush')}: ${brushSize}px`}>
          <button
            type="button"
            className="icon-button"
            disabled={brushSize <= 1}
            onClick={() => setBrushSize(Math.max(1, brushSize - 1))}
            title={`${t('tools.brush')} -1`}
            aria-label={`${t('tools.brush')} -1`}
          >
            <Icon name="minus" size={11} />
          </button>
          <span className="rail-stepper-value">{brushSize}</span>
          <button
            type="button"
            className="icon-button"
            disabled={brushSize >= MAX_BRUSH}
            onClick={() => setBrushSize(Math.min(MAX_BRUSH, brushSize + 1))}
            title={`${t('tools.brush')} +1`}
            aria-label={`${t('tools.brush')} +1`}
          >
            <Icon name="plus" size={11} />
          </button>
        </div>
      </div>
    </aside>
  );
}
