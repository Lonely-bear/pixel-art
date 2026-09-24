import { useEditor } from '../editor-context.js';
import { rgbaToCss, rgbaToHex } from '../color-utils.js';
import { useI18n } from '../i18n.js';

export function StatusBar(): React.ReactNode {
  const editor = useEditor();
  const { detail, cursor, hoverColor, zoom, layerId, status } = editor;
  const { t } = useI18n();
  const layer = detail?.layerList.find((entry) => entry.id === layerId);

  return (
    <footer className="status-bar">
      <span className="status-cell mono cursor-status" title={t('status.cursor')}>
        <span className="status-led" />
        {cursor ? `${cursor.x}, ${cursor.y}` : '–, –'}
      </span>
      <span className="status-divider" />
      <span className="status-cell">
        {hoverColor ? (
          <>
            <i className="inline-swatch" style={{ background: rgbaToCss(hoverColor) }} />
            <code>{rgbaToHex(hoverColor)}</code>
          </>
        ) : (
          <span className="muted">{t('status.noColour')}</span>
        )}
      </span>
      <span className="status-divider" />
      <span className="status-cell mono">
        {detail ? `${detail.width}×${detail.height}` : '–'}
      </span>
      <span className="status-cell mono zoom-status">{zoom}x</span>
      <span className="status-divider" />
      <span className="status-cell layer-status">
        <span className="status-layer-dot" />
        {layer ? t('status.layer', { name: layer.name }) : t('status.noLayer')}
      </span>
      <span className="status-cell mono version-status">
        {detail ? `v${detail.version}${detail.dirty ? ' •' : ''}` : ''}
      </span>
      <span className="status-cell grow" />
      <span className="status-cell">
        {status?.mcp.running ? (
          <span className="mcp-badge on" title={t('status.mcpRunning', { url: status.mcp.url ?? '' })}>
            <span className="mcp-dot" />
            MCP {status.mcp.url?.replace('http://', '')}
          </span>
        ) : (
          <span className="mcp-badge off" title={status?.mcp.error ?? t('status.mcpStopped')}>
            <span className="mcp-dot" />
            {t('status.mcpOff')}
          </span>
        )}
      </span>
    </footer>
  );
}
