import { useSearchParams } from 'react-router-dom';
import { TitleCard } from '../components/TitleCard';
import { useCatalog } from '../lib/CatalogProvider';

export function SearchPage() {
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const { search, loading } = useCatalog();
  const results = loading ? [] : search(query);

  return (
    <main className="page">
      <header className="page__header">
        <h1>{query ? `Results for “${query}”` : 'Search'}</h1>
        {query && (
          <p className="page__subtitle">
            {results.length} {results.length === 1 ? 'title' : 'titles'}
          </p>
        )}
      </header>
      {query && results.length === 0 && !loading ? (
        <p className="row__empty">No titles matched that search.</p>
      ) : (
        <div className="grid">
          {results.map((title) => (
            <TitleCard key={title.id} title={title} />
          ))}
        </div>
      )}
    </main>
  );
}
