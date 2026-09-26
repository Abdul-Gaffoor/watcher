import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { GeneratedArt } from '../components/GeneratedArt';
import { TitleCard } from '../components/TitleCard';
import { useCatalog } from '../lib/CatalogProvider';
import { formatRuntime } from '../lib/course';
import type { Collection } from '../lib/types';

export function SearchPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const query = searchParams.get('q') ?? '';
  const { search, loading, roots, titlesBeneath, pathTo } = useCatalog();
  const { collections, titles } = loading ? { collections: [], titles: [] } : search(query);

  const total = collections.length + titles.length;

  /**
   * Every other page carries a breadcrumb; this one has nowhere to say it came
   * from, so it needs a way out of its own. React Router marks the first entry
   * of a session 'default', which is how we know whether there is anything
   * behind us -- opening /search from a bookmark must not step out of the app.
   */
  const goBack = () => {
    if (location.key === 'default') navigate('/');
    else navigate(-1);
  };

  // Only roots that hold something. An entry reading "0 videos" is a door
  // into an empty room, which is worse than no door.
  const browsable = roots.filter((root) => titlesBeneath(root.id).length > 0);

  const collectionRow = (collection: Collection) => {
    const inside = titlesBeneath(collection.id);
    const trail = pathTo(collection.id).slice(0, -1);
    return (
      <li key={collection.id}>
        <Link className="result" to={`/c/${collection.id}`}>
          <span className="result__art">
            {inside[0]?.poster ? (
              <img src={inside[0].poster} alt="" loading="lazy" decoding="async" />
            ) : (
              <GeneratedArt
                seed={inside[0]?.id ?? collection.id}
                label={collection.name}
                variant="plain"
              />
            )}
          </span>
          <span className="result__text">
            <span className="result__name">{collection.name}</span>
            <span className="result__meta">
              {[
                trail.map((ancestor) => ancestor.name).join(' / '),
                `${inside.length} ${inside.length === 1 ? 'video' : 'videos'}`,
                formatRuntime(inside.reduce((sum, title) => sum + (title.durationSec || 0), 0)),
              ]
                .filter(Boolean)
                .join('   ·   ')}
            </span>
          </span>
        </Link>
      </li>
    );
  };

  return (
    <main className="page">
      <header className="page__header">
        <button className="backlink" type="button" onClick={goBack}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 6 8 12l6 6" />
          </svg>
          Back
        </button>

        <h1>{query ? `“${query}”` : 'Search'}</h1>
        {query && !loading && (
          <p className="page__subtitle">
            {total} {total === 1 ? 'result' : 'results'}
          </p>
        )}
        {!query && <p className="page__subtitle">Find a course, a lesson, or a film.</p>}
      </header>

      {query && total === 0 && !loading && (
        <p className="row__empty">Nothing matched that. Try part of a course or lesson name.</p>
      )}

      {/* With no query this page used to be one word on an empty screen, which
          is a dead end as well as a waste of it. The library's top level is the
          obvious thing to offer instead. */}
      {!query && !loading && browsable.length > 0 && (
        <section className="results">
          <h2 className="eyebrow">Browse the library</h2>
          <ul className="results__list">{browsable.map(collectionRow)}</ul>
        </section>
      )}

      {/* Collections first: someone typing "Elliott Wave" wants the course, not
          the eleven lessons inside it listed individually. */}
      {collections.length > 0 && (
        <section className="results">
          <h2 className="eyebrow">Courses and collections</h2>
          <ul className="results__list">{collections.map(collectionRow)}</ul>
        </section>
      )}

      {titles.length > 0 && (
        <section className="results">
          {collections.length > 0 && <h2 className="eyebrow">Videos</h2>}
          <div className="grid">
            {titles.map((title) => (
              <TitleCard key={title.id} title={title} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
