import { useState } from 'react';
import { useEditor } from '../editor-context.js';

export function FramesPanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const [tagName, setTagName] = useState('');

  if (!detail) return null;

  const index = detail.frameList.findIndex((frame) => frame.id === editor.frameId);

  return (
    <section className="panel frames-panel">
      <header className="panel-header">
        <h2>
          Frames
          <span className="muted">
            {' '}
            {detail.durationMs}ms total · {detail.frames} frame{detail.frames === 1 ? '' : 's'}
          </span>
        </h2>
        <div className="panel-actions">
          <button
            type="button"
            title="Add empty frame"
            onClick={() => void editor.execute('add_frame', {})}
          >
            +
          </button>
          <button
            type="button"
            title="Duplicate frame"
            disabled={!editor.frameId}
            onClick={() => void editor.execute('duplicate_frame', { frame: editor.frameId, count: 1 })}
          >
            ⧉
          </button>
          <button
            type="button"
            title="Move left"
            disabled={index <= 0}
            onClick={() => void editor.execute('reorder_frame', { frame: editor.frameId, index: index - 1 })}
          >
            ←
          </button>
          <button
            type="button"
            title="Move right"
            disabled={index < 0 || index === detail.frameList.length - 1}
            onClick={() => void editor.execute('reorder_frame', { frame: editor.frameId, index: index + 1 })}
          >
            →
          </button>
          <button
            type="button"
            title="Delete frame"
            disabled={detail.frameList.length <= 1}
            onClick={() => void editor.execute('remove_frame', { frame: editor.frameId })}
          >
            ✕
          </button>
        </div>
      </header>

      <ul className="frame-strip">
        {detail.frameList.map((frame) => {
          const selected = frame.id === editor.frameId;
          const url = editor.thumbnails.get(frame.id);
          return (
            <li key={frame.id} className={selected ? 'selected' : undefined}>
              <button
                type="button"
                className="frame-thumb"
                onClick={() => editor.setFrameId(frame.id)}
                title={`Frame ${frame.index + 1}`}
              >
                {url ? <img src={url} alt="" draggable={false} /> : <span className="placeholder" />}
                <span className="frame-index">{frame.index + 1}</span>
              </button>
              <input
                className="duration"
                type="number"
                min={10}
                step={10}
                value={frame.durationMs}
                title="Frame duration in milliseconds"
                onChange={(event) =>
                  void editor.execute('update_frame', {
                    frame: frame.id,
                    durationMs: Math.max(10, Number(event.target.value) || 10),
                  })
                }
              />
            </li>
          );
        })}
      </ul>

      <div className="tags">
        <h3>Animation tags</h3>
        {detail.tagList.length === 0 && <p className="muted">No tags yet.</p>}
        <ul>
          {detail.tagList.map((tag) => (
            <li key={tag.id}>
              <strong>{tag.name}</strong>
              <span className="muted">
                {tag.from}–{tag.to} · {tag.direction}
                {tag.repeat > 0 ? ` ×${tag.repeat}` : ' · loop'}
              </span>
              <button
                type="button"
                title="Delete tag"
                onClick={() => void editor.execute('remove_tag', { tag: tag.id })}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <form
          className="tag-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!tagName.trim()) return;
            void editor.execute('add_tag', {
              name: tagName.trim(),
              from: 0,
              to: detail.frameList.length - 1,
            });
            setTagName('');
          }}
        >
          <input
            value={tagName}
            placeholder="idle, run, attack…"
            onChange={(event) => setTagName(event.target.value)}
          />
          <button type="submit" disabled={detail.frameList.length === 0}>
            Tag all frames
          </button>
        </form>
      </div>
    </section>
  );
}
