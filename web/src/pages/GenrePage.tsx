import { Link, useParams } from 'react-router-dom';
import { Spinner } from '../components/Spinner';
import { TitleCard } from '../components/TitleCard';
import { useCatalog } from '../lib/CatalogProvider';

export function GenrePage() {
  const { genreId = '' } = useParams();
  const { loading, genreById, titlesInGenre } = useCatalog();

  if (loading) {
    return (
      <div className="page page--centered">
        <Spinner label="Loading catalog" />
      </div>
    );
  }

  const genre = genreById(genreId);
  if (!genre) {
    return (
      <div className="page page--centered">
        <p>That genre does not exist.</p>
        <Link className="button button--primary" to="/">
          Back to browse
        </Link>
      </div>
    );
  }

  const titles = titlesInGenre(genreId);

  return (
    <main className="page">
      <header className="page__header">
        <h1>{genre.name}</h1>
        {genre.description && <p className="page__subtitle">{genre.description}</p>}
      </header>
      {titles.length === 0 ? (
        <p className="row__empty">Nothing here yet.</p>
      ) : (
        <div className="grid">
          {titles.map((title) => (
            <TitleCard key={title.id} title={title} />
          ))}
        </div>
      )}
    </main>
  );
}
