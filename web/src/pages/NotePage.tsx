import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Spinner } from '../components/Spinner';
import { useCatalog } from '../lib/CatalogProvider';
import { formatBytes } from '../lib/notes';

/**
 * Reading a note.
 *
 * Markdown is parsed and sanitised here rather than at upload, so the stored
 * file stays the thing that was written -- editable, downloadable, and not a
 * rendering decision baked in months ago. HTML converted from a .docx was
 * already sanitised when it was stored; it is sanitised again on the way in,
 * because the store is not a trust boundary.
 *
 * A PDF is handed to the browser's own viewer. Nothing worth building beats
 * it, and every attempt costs a megabyte.
 */

/**
 * Drops a leading H1.
 *
 * Almost every note starts by naming itself, and the page has already printed
 * that name above -- so rendering it again is the title twice, a centimetre
 * apart. Only the first element, and only when it is a heading: a note that
 * opens with prose keeps everything it was written with.
 */
function withoutLeadingTitle(html: string): string {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const first = holder.firstElementChild;
  if (first?.tagName === 'H1') first.remove();
  return holder.innerHTML;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; html: string }
  | { kind: 'error'; message: string };

export function NotePage() {
  const { noteId = '' } = useParams();
  const { loading, noteById, collectionById, pathTo } = useCatalog();
  const note = noteById(noteId);

  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    if (!note || note.format === 'pdf') return;
    setState({ kind: 'loading' });

    try {
      const response = await fetch(note.source, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`This note could not be loaded (${response.status}).`);
      const text = await response.text();

      const { default: DOMPurify } = await import('dompurify');

      const raw =
        note.format === 'html'
          ? text
          : await (await import('marked')).marked.parse(text, { gfm: true, breaks: false });

      setState({ kind: 'ready', html: withoutLeadingTitle(DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })) });
    } catch (cause) {
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : 'Could not load' });
    }
  }, [note]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="page page--centered">
        <Spinner label="Loading" />
      </div>
    );
  }

  if (!note) {
    return (
      <div className="page page--centered">
        <p>That note is not in the library.</p>
        <Link className="button button--primary" to="/">
          Back to browse
        </Link>
      </div>
    );
  }

  const collection = collectionById(note.collectionId);
  const trail = pathTo(note.collectionId);

  return (
    <main className="page note">
      <header className="note__head">
        <nav className="note__trail" aria-label="Breadcrumb">
          <Link to="/">Home</Link>
          {trail.map((ancestor) => (
            <Link key={ancestor.id} to={`/c/${ancestor.id}`}>
              {ancestor.name}
            </Link>
          ))}
        </nav>

        <h1 className="note__title">{note.title}</h1>

        <p className="note__meta">
          {[
            note.format === 'pdf' ? 'PDF' : note.originalName ? 'Word document' : 'Markdown',
            formatBytes(note.sizeBytes),
            note.updatedAt ? new Date(note.updatedAt).toLocaleDateString() : '',
          ]
            .filter(Boolean)
            .join('   ·   ')}

          {/* The file as uploaded, when it is not the file being shown. */}
          <a className="note__download" href={note.original ?? note.source} download>
            Download {note.originalName ? 'original' : 'file'}
          </a>
        </p>
      </header>

      {note.format === 'pdf' ? (
        <object className="note__pdf" data={note.source} type="application/pdf">
          {/* iOS Safari will not embed a PDF, so it gets a link rather than a
              blank rectangle. */}
          <p className="note__fallback">
            This browser will not display a PDF inline.{' '}
            <a href={note.source} target="_blank" rel="noreferrer">
              Open it in a new tab
            </a>
            .
          </p>
        </object>
      ) : state.kind === 'loading' ? (
        <div className="page page--centered">
          <Spinner label="Loading the note" />
        </div>
      ) : state.kind === 'error' ? (
        <div className="page page--centered">
          <p role="alert">{state.message}</p>
          <button className="button button--primary" type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : (
        /* Sanitised above, twice for anything converted. */
        <article className="prose" dangerouslySetInnerHTML={{ __html: state.html }} />
      )}

      {collection && (
        <p className="note__back">
          <Link to={`/c/${collection.id}`}>‹ Back to {collection.name}</Link>
        </p>
      )}
    </main>
  );
}
