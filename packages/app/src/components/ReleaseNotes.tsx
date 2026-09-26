/**
 * Release notes as a disclosure.
 *
 * The body is Markdown — it is whatever the maintainer wrote in
 * `.github/release-notes.md` and GitHub generated on top of it — and this app
 * ships no Markdown renderer and no HTML injection point. So it is shown
 * preformatted and scrollable: readable, unclickable, and incapable of
 * interpreting anything the release happens to contain.
 *
 * Shared by the banner and the settings panel because the same text appears in
 * both, and a notes box that looked different in each would read as two
 * different releases.
 */
export function ReleaseNotes({ body, label }: { body: string; label: string }): React.ReactNode {
  return (
    <details className="update-notes">
      <summary>{label}</summary>
      <pre className="update-notes-body">{body}</pre>
    </details>
  );
}
