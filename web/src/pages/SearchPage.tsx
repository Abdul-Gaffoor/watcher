import { Link, useSearchParams } from 'react-router-dom';
import { GeneratedArt } from '../components/GeneratedArt';
import { TitleCard } from '../components/TitleCard';
import { useCatalog } from '../lib/CatalogProvider';
import { formatRuntime } from '../lib/course';

export function SearchPage() {
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const { search, loading, titlesBeneath, pathTo } = useCatalog();
  const { collections, titles } = loading ? { collections: [], titles: [] } : search(query);

  const total = collections.length + titles.length;

  return (
    <main className="page">
      <header className="page__header">
        <h1>{query ? `“${query}”` : 'Search'}</h1>
        {query && !loading && (
          <p className="page__subtitle">
            {total} {total === 1 ? 'result' : 'results'}
          </p>
        )}
      </header>

      {query && total === 0 && !loading && (
        <p className="row__empty">Nothing matched that. Try part of a course or lesson name.</p>
      )}

      {/* Collections first: someone typing "Elliott Wave" wants the course, not
          the eleven lessons inside it listed individually. */}
      {collections.length > 0 && (
        <section className="results">
          <h2 className="eyebrow">Courses and collections</h2>
          <ul className="results__list">
            {collections.map((collection) => {
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
            })}
          </ul>
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
