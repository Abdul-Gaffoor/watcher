import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { Navigate } from 'react-router-dom';
import { Spinner } from '../components/Spinner';
import { useAuth } from '../auth/AuthProvider';
import { adminApi } from '../lib/api';
import { capturePoster } from '../lib/poster';
import { uploadPoster, uploadVideo } from '../lib/uploads';
import type { Catalog, Collection, Title } from '../lib/types';

/**
 * The library manager.
 *
 * Two things happen here: the shape of the library is edited, and videos are
 * put into it. Both end in the same place, a single catalog document saved as
 * a whole, which is why there is one Save rather than a save per row.
 *
 * Nothing here is a security boundary. Every call it makes is refused by the
 * server unless the session carries the admin role; this only decides what is
 * worth showing to somebody who already has it.
 */

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Matches MAX_DEPTH in backend/src/catalog.mjs, which refuses anything deeper. */
const MAX_DEPTH = 6;

/**
 * A collection and everything under it. Moving one into its own descendant
 * would detach that whole branch from the tree and make a loop out of it, so
 * those are never offered as destinations -- the server refuses it too, but a
 * dropdown that lists an option it will then reject is a trap.
 */
function descendantIds(collections: Collection[], rootId: string): Set<string> {
  const inside = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const collection of collections) {
      const parent = collection.parentId ?? null;
      if (parent && inside.has(parent) && !inside.has(collection.id)) {
        inside.add(collection.id);
        grew = true;
      }
    }
  }
  return inside;
}

/** How deep the branch under this collection runs, counting itself as one. */
function branchHeight(collections: Collection[], rootId: string): number {
  const children = collections.filter((collection) => (collection.parentId ?? null) === rootId);
  return children.length === 0
    ? 1
    : 1 + Math.max(...children.map((child) => branchHeight(collections, child.id)));
}

/** Depth-first, so the list reads as the tree it represents. */
function flatten(collections: Collection[], parentId: string | null = null, depth = 0): {
  collection: Collection;
  depth: number;
}[] {
  return collections
    .filter((collection) => (collection.parentId ?? null) === parentId)
    .flatMap((collection) => [
      { collection, depth },
      ...flatten(collections, collection.id, depth + 1),
    ]);
}

export function AdminPage() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [newName, setNewName] = useState('');
  const [newParent, setNewParent] = useState('');

  const [file, setFile] = useState<File | null>(null);
  const [videoTitle, setVideoTitle] = useState('');
  const [videoCollection, setVideoCollection] = useState('');
  const [progress, setProgress] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { catalog: loaded } = await adminApi.catalog();
      setCatalog(loaded);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => flatten(catalog?.collections ?? []), [catalog]);

  /**
   * Names are editable in place, so they can be emptied in place. The server
   * refuses a blank one, but finding that out from a failed save after five
   * other edits is a poor way to learn it.
   */
  const blank = useMemo(() => {
    const collections = (catalog?.collections ?? []).filter((c) => c.name.trim() === '').length;
    const titles = (catalog?.titles ?? []).filter((t) => t.title.trim() === '').length;
    return collections + titles;
  }, [catalog]);
  const titleCount = useCallback(
    (collectionId: string) =>
      (catalog?.titles ?? []).filter((title) => title.collectionId === collectionId).length,
    [catalog],
  );

  // The dashboard is hidden rather than merely unlinked, but the real refusal
  // happens on the server for every request this page makes.
  if (user && !user.roles.includes('admin')) return <Navigate to="/" replace />;

  if (loading) {
    return (
      <div className="page page--centered">
        <Spinner label="Loading the library" />
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="page page--centered">
        <p role="alert">{error ?? 'The library is unavailable.'}</p>
        <button className="button button--primary" type="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  const mutate = (next: Partial<Catalog>) => {
    setCatalog({ ...catalog, ...next });
    setDirty(true);
    setNotice(null);
  };

  const save = async (overrides?: Partial<Catalog>) => {
    const next = { ...catalog, ...overrides };
    setSaving(true);
    setError(null);
    try {
      const { catalog: saved } = await adminApi.saveCatalog(next, next.revision);
      setCatalog(saved);
      setDirty(false);
      setNotice('Saved.');
      return saved;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save');
      throw cause;
    } finally {
      setSaving(false);
    }
  };

  const addCollection = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;

    let id = slugify(name);
    if (!id) {
      setError('That name has no letters or digits to make an id from.');
      return;
    }
    // Ids are the URL and the S3 prefix, so a clash has to be resolved rather
    // than silently merged into the existing shelf.
    const taken = new Set(catalog.collections.map((collection) => collection.id));
    if (taken.has(id)) {
      let suffix = 2;
      while (taken.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }

    mutate({
      collections: [...catalog.collections, { id, name, parentId: newParent || null }],
    });
    setNewName('');
  };

  const rename = (id: string, name: string) =>
    mutate({
      collections: catalog.collections.map((collection) =>
        collection.id === id ? { ...collection, name } : collection,
      ),
    });

  /**
   * Moves a whole branch. Everything under it comes along, because a child
   * names its parent rather than the other way round -- so one field changes
   * and the shelf it was on moves with it.
   */
  const reparent = (id: string, parentId: string | null) =>
    mutate({
      collections: catalog.collections.map((collection) =>
        collection.id === id ? { ...collection, parentId } : collection,
      ),
    });

  /**
   * Destinations this collection could actually move to: not itself, not
   * anything already inside it, and nothing so deep that its own branch would
   * be pushed past the limit.
   */
  const destinationsFor = (id: string) => {
    const forbidden = descendantIds(catalog.collections, id);
    const height = branchHeight(catalog.collections, id);
    return rows.filter(
      ({ collection, depth }) => !forbidden.has(collection.id) && depth + 1 + height <= MAX_DEPTH,
    );
  };

  const remove = (id: string) => {
    const hasChildren = catalog.collections.some((collection) => collection.parentId === id);
    if (hasChildren || titleCount(id) > 0) {
      setError('Empty a collection before removing it, so nothing is orphaned.');
      return;
    }
    mutate({ collections: catalog.collections.filter((collection) => collection.id !== id) });
  };

  const removeTitle = (id: string) =>
    mutate({ titles: catalog.titles.filter((title) => title.id !== id) });

  /**
   * Renames what a viewer reads. The id is deliberately left alone: it is the
   * S3 prefix the video and its poster already live under, so changing it
   * would point the title at nothing. A name typed wrong at upload is fixed
   * here; the storage key keeps whatever it was born with, and no viewer sees
   * it.
   */
  const renameTitle = (id: string, name: string) =>
    mutate({
      titles: catalog.titles.map((title) => (title.id === id ? { ...title, title: name } : title)),
    });

  /** Refiles a video. Also just one field: the video itself does not move. */
  const moveTitle = (id: string, collectionId: string) =>
    mutate({
      titles: catalog.titles.map((title) =>
        title.id === id ? { ...title, collectionId } : title,
      ),
    });

  /**
   * Upload, then record. The file lands in S3 first and the catalog is saved
   * only once it is there, so a failed upload never leaves a title pointing at
   * a video that does not exist.
   */
  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !videoTitle.trim() || !videoCollection) return;

    const name = videoTitle.trim();
    let id = slugify(name);
    const taken = new Set(catalog.titles.map((title) => title.id));
    if (taken.has(id)) {
      let suffix = 2;
      while (taken.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }

    setError(null);
    setNotice(null);
    setProgress(0);
    try {
      // Before the upload, because the file is already here and the same pass
      // reads the duration off it — which is otherwise a number somebody has
      // to type, and therefore a number that stays zero.
      setNotice('Taking a poster frame…');
      const captured = await capturePoster(file);

      setNotice(null);
      const { promise } = uploadVideo(file, id, setProgress);
      const { mediaPath } = await promise;

      const poster = captured ? await uploadPoster(id, captured.blob) : null;

      const title: Title = {
        id,
        title: name,
        collectionId: videoCollection,
        durationSec: captured?.durationSec ?? 0,
        sources: { mp4: mediaPath },
        ...(poster ? { poster, backdrop: poster } : {}),
      };
      await save({ titles: [...catalog.titles, title] });

      setFile(null);
      setVideoTitle('');
      setNotice(
        poster
          ? `Uploaded “${name}”.`
          : `Uploaded “${name}”. This browser could not decode a poster frame from it, so it will use generated artwork.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The upload failed');
    } finally {
      setProgress(null);
    }
  };

  return (
    <main className="page admin">
      <header className="page__header">
        <h1>Manage library</h1>
        <p className="page__subtitle">
          Revision {catalog.revision} · {catalog.collections.length} collections ·{' '}
          {catalog.titles.length} videos
        </p>
      </header>

      {error && (
        <p className="admin__error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="admin__notice">{notice}</p>}

      <section className="admin__panel">
        <h2>Upload a video</h2>
        <form className="admin__form" onSubmit={upload}>
          <label className="field">
            <span className="field__label">Video file</span>
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm"
              required
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <span className="field__hint">
              Uploaded straight to storage in 16&nbsp;MB parts, so a dropped connection costs one
              part rather than the whole file.
            </span>
          </label>

          <label className="field">
            <span className="field__label">Title</span>
            <input
              type="text"
              required
              value={videoTitle}
              onChange={(event) => setVideoTitle(event.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">Goes in</span>
            <select
              required
              value={videoCollection}
              onChange={(event) => setVideoCollection(event.target.value)}
            >
              <option value="">Choose a collection…</option>
              {rows.map(({ collection, depth }) => (
                <option key={collection.id} value={collection.id}>
                  {'  '.repeat(depth)}
                  {collection.name}
                </option>
              ))}
            </select>
          </label>

          <button
            className="button button--primary"
            type="submit"
            disabled={progress !== null || saving}
          >
            {progress !== null ? `Uploading… ${Math.round(progress * 100)}%` : 'Upload'}
          </button>

          {progress !== null && (
            <span className="admin__progress" aria-hidden="true">
              <span className="admin__progress-bar" style={{ width: `${progress * 100}%` }} />
            </span>
          )}
        </form>
      </section>

      <section className="admin__panel">
        <h2>Structure</h2>
        <form className="admin__form admin__form--inline" onSubmit={addCollection}>
          <label className="field">
            <span className="field__label">New collection</span>
            <input
              type="text"
              placeholder="Elliott Wave"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Inside</span>
            <select value={newParent} onChange={(event) => setNewParent(event.target.value)}>
              <option value="">Top level</option>
              {rows.map(({ collection, depth }) => (
                <option key={collection.id} value={collection.id}>
                  {'  '.repeat(depth)}
                  {collection.name}
                </option>
              ))}
            </select>
          </label>
          <button className="button button--ghost" type="submit">
            Add
          </button>
        </form>

        <ul className="admin__tree">
          {rows.map(({ collection, depth }) => (
            <li key={collection.id} style={{ '--depth': depth } as CSSProperties}>
              <input
                className="admin__rename"
                aria-label={`Rename ${collection.name}`}
                value={collection.name}
                onChange={(event) => rename(collection.id, event.target.value)}
              />

              {/* Moving a collection moves everything under it. This is how a
                  "Trading" created after the fact collects the courses that
                  were made at the top level before it existed. */}
              <select
                className="admin__move"
                aria-label={`Move ${collection.name} into`}
                value={collection.parentId ?? ''}
                onChange={(event) => reparent(collection.id, event.target.value || null)}
              >
                <option value="">Top level</option>
                {destinationsFor(collection.id).map(({ collection: option, depth: optionDepth }) => (
                  <option key={option.id} value={option.id}>
                    {'\u00a0\u00a0'.repeat(optionDepth)}
                    {option.name}
                  </option>
                ))}
              </select>

              <span className="admin__count">
                {titleCount(collection.id)} {titleCount(collection.id) === 1 ? 'video' : 'videos'}
              </span>
              <button className="admin__remove" type="button" onClick={() => remove(collection.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="admin__panel">
        <h2>Videos</h2>
        {catalog.titles.length === 0 ? (
          <p className="row__empty">Nothing uploaded yet.</p>
        ) : (
          <ul className="admin__titles">
            {catalog.titles.map((title) => (
              <li key={title.id}>
                {/* The name only. The id underneath is the storage key the
                    video and its poster already live under, so it stays as it
                    was uploaded -- a typo in the name is fixed here without
                    moving a byte. */}
                <input
                  className="admin__rename"
                  aria-label={`Rename ${title.title}`}
                  value={title.title}
                  onChange={(event) => renameTitle(title.id, event.target.value)}
                />

                <select
                  className="admin__move"
                  aria-label={`Move ${title.title} into`}
                  value={title.collectionId}
                  onChange={(event) => moveTitle(title.id, event.target.value)}
                >
                  {rows.map(({ collection, depth }) => (
                    <option key={collection.id} value={collection.id}>
                      {'\u00a0\u00a0'.repeat(depth)}
                      {collection.name}
                    </option>
                  ))}
                </select>

                <button className="admin__remove" type="button" onClick={() => removeTitle(title.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="admin__actions">
        <button
          className="button button--primary"
          type="button"
          disabled={!dirty || saving || blank > 0}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button className="button button--ghost" type="button" onClick={() => void load()}>
          Discard and reload
        </button>
        {blank > 0 ? (
          <span className="admin__blank" role="alert">
            {blank === 1 ? 'One name is empty' : `${blank} names are empty`} — fill it in to save.
          </span>
        ) : (
          dirty && <span className="admin__count">Unsaved changes</span>
        )}
      </div>
    </main>
  );
}
