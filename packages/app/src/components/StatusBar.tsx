import { useEditor } from '../editor-context.js';
import { rgbaToCss, rgbaToHex } from '../color-utils.js';

export function StatusBar(): React.ReactNode {
  const editor = useEditor();
  const { detail, cursor, hoverColor, zoom, layerId, status } = editor;
  const layer = detail?.layerList.find((entry) => entry.id === layerId);

  return (
    <footer className="status-bar">
      <span className="status-cell mono">
        {cursor ? `${cursor.x}, ${cursor.y}` : '–, –'}
      </span>
      <span className="status-cell">
        {hoverColor ? (
          <>
            <i className="inline-swatch" style={{ background: rgbaToCss(hoverColor) }} />
            <code>{rgbaToHex(hoverColor)}</code>
          </>
        ) : (
          <span className="muted">no colour</span>
        )}
      </span>
      <span className="status-cell">
        {detail ? `${detail.width}×${detail.height}` : '–'}
      </span>
      <span className="status-cell">{zoom}x</span>
      <span className="status-cell">
        {layer ? `layer: ${layer.name}` : 'no layer'}
      </span>
      <span className="status-cell">
        {detail ? `v${detail.version}${detail.dirty ? ' •' : ''}` : ''}
      </span>
      <span className="status-cell grow" />
      <span className="status-cell">
        {status?.mcp.running ? (
          <span className="mcp-badge on" title={`MCP server at ${status.mcp.url}`}>
            MCP {status.mcp.url?.replace('http://', '')}
          </span>
        ) : (
          <span className="mcp-badge off" title={status?.mcp.error ?? 'MCP server not running'}>
            MCP off
          </span>
        )}
      </span>
    </footer>
  );
}
