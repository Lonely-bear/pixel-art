import { useState } from 'react';
import { useEditor } from '../editor-context.js';

export function FramesPanel(): React.ReactNode {
  const editor = useEditor();
  const detail = editor.detail;
  const [tagName, setTagName] = useState('');

  if (!detail) return null;

  const index = detail.frameList.findIndex((frame) => frame.id === editor.frameId);

  // A whole-frame nudge, so a bob is one click instead of a redraw.
  const nudge = (dx: number, dy: number) =>
    editor.execute('translate', { layer: '*', frame: editor.frameId, dx, dy });

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

      <div className="playback">
        <h3>Playback</h3>
        <div className="panel-actions">
          <button
            type="button"
            className={editor.playing ? 'tool-button active' : 'tool-button'}
            title={editor.playing ? 'Pause' : 'Play'}
            onClick={() => editor.setPlaying(!editor.playing)}
          >
            {editor.playing ? '❚❚' : '▶'}
          </button>
          <select
            className="doc-select"
            value={editor.playTag}
            title="Animation tag to play"
            onChange={(event) => editor.setPlayTag(event.target.value)}
          >
            <option value="">All frames</option>
            {detail.tagList.map((tag) => (
              <option key={tag.id} value={tag.name}>
                {tag.name} ({tag.direction})
              </option>
            ))}
          </select>
          <label className="field">
            Speed
            <input
              type="number"
              min={0.25}
              max={4}
              step={0.25}
              value={editor.playSpeed}
              onChange={(event) => editor.setPlaySpeed(Math.max(0.25, Number(event.target.value) || 1))}
            />
          </label>
        </div>
        <div className="panel-actions">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={editor.onionSkin}
              onChange={(event) => editor.setOnionSkin(event.target.checked)}
            />
            Onion skin
          </label>
          <label className="field">
            Before
            <input
              type="number"
              min={0}
              max={4}
              value={editor.onionBefore}
              disabled={!editor.onionSkin}
              onChange={(event) => editor.setOnionBefore(Math.max(0, Number(event.target.value) || 0))}
            />
          </label>
          <label className="field">
            After
            <input
              type="number"
              min={0}
              max={4}
              value={editor.onionAfter}
              disabled={!editor.onionSkin}
              onChange={(event) => editor.setOnionAfter(Math.max(0, Number(event.target.value) || 0))}
            />
          </label>
        </div>
      </div>

      <div className="motion">
        <h3>Move this frame</h3>
        <div className="panel-actions">
          <button type="button" title="Nudge up" disabled={!editor.frameId} onClick={() => void nudge(0, -1)}>
            ↑
          </button>
          <button type="button" title="Nudge down" disabled={!editor.frameId} onClick={() => void nudge(0, 1)}>
            ↓
          </button>
          <button type="button" title="Nudge left" disabled={!editor.frameId} onClick={() => void nudge(-1, 0)}>
            ←
          </button>
          <button type="button" title="Nudge right" disabled={!editor.frameId} onClick={() => void nudge(1, 0)}>
            →
          </button>
          <button
            type="button"
            title="Squash: shorter and wider, pivoting on the bottom"
            disabled={!editor.frameId}
            onClick={() =>
              void editor.execute('squash', {
                layer: '*',
                frame: editor.frameId,
                scaleY: 0.9,
                scaleX: 1.08,
                pivot: 'bottom',
              })
            }
          >
            Squash
          </button>
          <button
            type="button"
            title="Stretch: taller and narrower, pivoting on the bottom"
            disabled={!editor.frameId}
            onClick={() =>
              void editor.execute('squash', {
                layer: '*',
                frame: editor.frameId,
                scaleY: 1.1,
                scaleX: 0.94,
                pivot: 'bottom',
              })
            }
          >
            Stretch
          </button>
        </div>
      </div>

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
