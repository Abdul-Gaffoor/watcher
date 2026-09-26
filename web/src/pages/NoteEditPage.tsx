import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Spinner } from '../components/Spinner';
import { useAuth } from '../auth/AuthProvider';
import { adminApi } from '../lib/api';
import { useCatalog } from '../lib/CatalogProvider';
import { fromEditorHtml, isEditable, toEditorHtml } from '../lib/note-editing';
import { slugify, uniqueId } from '../lib/slug';
import type { Catalog, Note } from '../lib/types';

/** The editor is a large chunk, and only ever wanted by the person writing. */
const NoteEditor = lazy(() =>
  import('../components/NoteEditor').then((module) => ({ default: module.NoteEditor })),
);

/**
 * Writing a note, new or existing.
 *
 * It reads the catalog through the admin API rather than the viewer's copy,
 * because saving needs the revision that copy does not carry — and because
 * every one of those calls is refused by the server unless the session is an
 * admin, which is the actual boundary.
 */

type Phase = 'loading' | 'ready' | 'saving';

export function NoteEditPage() {
  const { noteId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  // The page this one navigates to reads the viewer's copy of the catalog,
  // which will not have the note in it until it is refetched.
  const { reload } = useCatalog();

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [html, setHtml] = useState('');
  const [dirty, setDirty] = useState(false);

  /** Filled in when "New collection…" is chosen, rather than on another page. */
  const [newCollection, setNewCollection] = useState('');
  const [newParent, setNewParent] = useState('');

  const editing = Boolean(noteId);

  /**
   * A new note needs an id before it has been saved, because an image dropped
   * into it is stored under that id. Settled once, here, so the id a draft's
   * images were filed under is the id the note keeps.
   */
  const [draftId] = useState(() => `note-${Math.random().toString(36).slice(2, 10)}`);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const { catalog: loaded } = await adminApi.catalog();
      setCatalog(loaded);

      if (noteId) {
        const note = (loaded.notes ?? []).find((entry) => entry.id === noteId);
        if (!note) throw new Error('That note is not in the library.');
        if (!isEditable(note)) throw new Error('A PDF cannot be edited here. Upload a new file instead.');
        setTitle(note.title);
        setCollectionId(note.collectionId);
        setHtml(await toEditorHtml(note));
      } else if (loaded.collections.length > 0) {
        setCollectionId(loaded.collections[0].id);
      }
      setPhase('ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open the editor');
      setPhase('ready');
    }
  }, [noteId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A closed tab is the one way to lose a note that the app cannot undo, so it
   * is the one worth interrupting. In-app navigation is not blocked: a router
   * prompt on every link is the kind of guard people learn to click through.
   */
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const rows = useMemo(() => {
    if (!catalog) return [];
    const walk = (parentId: string | null, depth: number): { id: string; name: string; depth: number }[] =>
      catalog.collections
        .filter((collection) => (collection.parentId ?? null) === parentId)
        .flatMap((collection) => [
          { id: collection.id, name: collection.name, depth },
          ...walk(collection.id, depth + 1),
        ]);
    return walk(null, 0);
  }, [catalog]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!catalog) return;

    const name = title.trim();
    if (!name) return setError('Give the note a title.');

    setPhase('saving');
    setError(null);
    try {
      let collections = catalog.collections;
      let target = collectionId;

      // Creating the collection as part of saving the note, rather than making
      // somebody go and make it first and come back.
      if (collectionId === '__new__') {
        const wanted = newCollection.trim();
        if (!wanted) throw new Error('Name the new collection.');

        const slug = slugify(wanted);
        if (!slug) throw new Error('That collection name has no letters or digits to make an id from.');
        const id = uniqueId(slug, collections.map((collection) => collection.id));

        collections = [...collections, { id, name: wanted, parentId: newParent || null }];
        target = id;
      }

      if (!target) throw new Error('Choose where the note goes.');

      const existing = (catalog.notes ?? []).find((entry) => entry.id === noteId);
      const id = existing?.id ?? uniqueNoteId(name, catalog, draftId);
      const format = existing?.format === 'html' ? 'html' : 'md';

      const { blob, extension } = await fromEditorHtml(html, format);

      const signed = await adminApi.signUpload({ op: 'note', noteId: id, extension });
      const stored = await fetch(signed.url, {
        method: 'PUT',
        headers: { 'content-type': signed.contentType },
        body: blob,
      });
      if (!stored.ok) throw new Error(`Storage refused the note (${stored.status}).`);

      const note: Note = {
        ...existing,
        id,
        title: name,
        collectionId: target,
        format: extension,
        source: signed.mediaPath,
        sizeBytes: blob.size,
        updatedAt: new Date().toISOString(),
      };

      const notes = existing
        ? (catalog.notes ?? []).map((entry) => (entry.id === id ? note : entry))
        : [...(catalog.notes ?? []), note];

      await adminApi.saveCatalog({ ...catalog, collections, notes }, catalog.revision);
      setDirty(false);
      reload();
      navigate(`/notes/${id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The note could not be saved');
      setPhase('ready');
    }
  };

  if (user && !user.roles.includes('admin')) return <Navigate to="/" replace />;

  if (phase === 'loading') {
    return (
      <div className="page page--centered">
        <Spinner label="Opening the editor" />
      </div>
    );
  }

  return (
    <main className="page note-edit">
      <form onSubmit={save}>
        <header className="note-edit__head">
          <div className="note-edit__where">
            <input
              className="note-edit__title"
              aria-label="Note title"
              placeholder="Untitled note"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setDirty(true);
              }}
              onKeyDown={(event) => {
                // The title is one line, and the form would otherwise save on
                // Enter. Carrying on into the body is what pressing it means.
                if (event.key !== 'Enter') return;
                event.preventDefault();
                document.querySelector<HTMLElement>('.editor__surface')?.focus();
              }}
            />

            <div className="note-edit__filing">
              <label className="field">
                <span className="field__label">Goes in</span>
                <select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
                  {rows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {'  '.repeat(row.depth)}
                      {row.name}
                    </option>
                  ))}
                  <option value="__new__">＋ New collection…</option>
                </select>
              </label>

              {collectionId === '__new__' && (
                <>
                  <label className="field">
                    <span className="field__label">Called</span>
                    <input
                      type="text"
                      placeholder="Risk management"
                      value={newCollection}
                      onChange={(event) => setNewCollection(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Inside</span>
                    <select value={newParent} onChange={(event) => setNewParent(event.target.value)}>
                      <option value="">Top level</option>
                      {rows.map((row) => (
                        <option key={row.id} value={row.id}>
                          {'  '.repeat(row.depth)}
                          {row.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
          </div>

          <div className="note-edit__actions">
            <Link className="button button--ghost" to={editing && noteId ? `/notes/${noteId}` : '/admin'}>
              Cancel
            </Link>
            <button className="button button--primary" type="submit" disabled={phase === 'saving'}>
              {phase === 'saving' ? 'Saving…' : editing ? 'Save' : 'Create note'}
            </button>
          </div>
        </header>

        {error && (
          <p className="note-edit__error" role="alert">
            {error}
          </p>
        )}

        <Suspense
          fallback={
            <div className="page page--centered">
              <Spinner label="Loading the editor" />
            </div>
          }
        >
          <NoteEditor
            noteId={noteId ?? draftId}
            initialHtml={html}
            onChange={(next) => {
              setHtml(next);
              setDirty(true);
            }}
            onError={setError}
          />
        </Suspense>
      </form>
    </main>
  );
}

/**
 * Slug of the title, kept unique against everything already filed.
 *
 * The draft id is the fallback rather than the first choice, so a note called
 * "Fibonacci retracements" is filed under that and not under a random token --
 * but a title made only of punctuation still gets a usable id.
 */
function uniqueNoteId(name: string, catalog: Catalog, fallback: string): string {
  return uniqueId(slugify(name) || fallback, (catalog.notes ?? []).map((note) => note.id));
}
