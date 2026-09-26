import { useEditor } from '../editor-context.js';
import { rgbaToCss, rgbaToHex } from '../color-utils.js';
import { useI18n } from '../i18n.js';

/**
 * Read-only telemetry along the bottom edge.
 *
 * Everything here is a fact about the current edit, nothing to click — which is
 * why it is plain text on the panel colour rather than a set of chips.
 */
export function StatusBar(): React.ReactNode {
  const editor = useEditor();
  const { detail, cursor, hoverColor, zoom, layerId, status } = editor;
  const { t } = useI18n();
  const layer = detail?.layerList.find((entry) => entry.id === layerId);

  return (
    <footer className="status-bar">
      <span className="status-cell is-mono" title={t('status.cursor')}>
        <span className="status-led" aria-hidden="true" />
        {cursor ? `${cursor.x}, ${cursor.y}` : '–, –'}
      </span>
      <span className="status-divider" />

      <span className="status-cell is-mono">
        {hoverColor ? (
          <>
            <span className="status-chip" style={{ background: rgbaToCss(hoverColor) }} />
            <span className="status-value">{rgbaToHex(hoverColor)}</span>
          </>
        ) : (
          <span>{t('status.noColour')}</span>
        )}
      </span>
      <span className="status-divider" />

      <span className="status-cell is-mono hide-narrow">
        {detail ? `${detail.width} × ${detail.height}` : '–'}
      </span>
      <span className="status-cell is-mono">
        <span className="status-value">{zoom}×</span>
      </span>
      <span className="status-divider" />

      <span className="status-cell hide-narrow">
        <span className="status-layer" aria-hidden="true" />
        {layer ? t('status.layer', { name: layer.name }) : t('status.noLayer')}
      </span>

      <span className="spacer" />

      <span className="status-cell is-mono hide-narrow">
        {detail ? `v${detail.version}` : ''}
        {detail?.dirty ? ` · ${t('status.unsaved')}` : detail ? ` · ${t('status.saved')}` : ''}
      </span>

      {status?.mcp.running ? (
        <span
          className="mcp-badge is-on"
          title={t('status.mcpRunning', { url: status.mcp.url ?? '' })}
        >
          <span className="status-led" style={{ background: 'var(--success)' }} />
          MCP {status.mcp.url?.replace('http://', '')}
        </span>
      ) : (
        <span className="mcp-badge" title={status?.mcp.error ?? t('status.mcpStopped')}>
          {t('status.mcpOff')}
        </span>
      )}
    </footer>
  );
}
