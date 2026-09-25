import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from '../components/Spinner';
import { TitleRow } from '../components/TitleRow';
import { useCatalog } from '../lib/CatalogProvider';
import { formatDuration } from '../lib/format';
import { continueWatching } from '../lib/progress';

export function BrowsePage() {
  const { catalog, loading, error, reload, featured, titlesInGenre, byId } = useCatalog();
  const [synopsisOpen, setSynopsisOpen] = useState(false);

  const resumable = useMemo(
    () =>
      continueWatching()
        .map(({ titleId }) => byId(titleId))
        .filter((title): title is NonNullable<typeof title> => Boolean(title)),
    [byId],
  );

  if (loading) {
    return (
      <div className="page page--centered">
        <Spinner label="Loading catalog" />
      </div>
    );
  }

  if (error || !catalog) {
    return (
      <div className="page page--centered">
        <p role="alert">{error ?? 'Catalog unavailable.'}</p>
        <button className="button button--primary" type="button" onClick={reload}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <main className="page">
      {featured && (
        <section
          className="hero"
          style={featured.backdrop ? { backgroundImage: `url(${featured.backdrop})` } : undefined}
        >
          <div className="hero__scrim" />
          <div className="hero__content">
            <p className="hero__eyebrow">Featured</p>
            <h1 className="hero__title">{featured.title}</h1>
            <p className="hero__meta">
              {[featured.instructor, featured.year, formatDuration(featured.durationSec)]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <p
              className={
                synopsisOpen ? 'hero__description' : 'hero__description hero__description--clamped'
              }
            >
              {featured.description}
            </p>
            <div className="hero__actions">
              <Link className="button button--hero" to={`/watch/${featured.id}`}>
                <span aria-hidden="true">▶</span> Play
              </Link>
              <button
                type="button"
                className="button button--hero-secondary"
                aria-expanded={synopsisOpen}
                onClick={() => setSynopsisOpen((open) => !open)}
              >
                <span aria-hidden="true">ⓘ</span> {synopsisOpen ? 'Less info' : 'More info'}
              </button>
            </div>
          </div>
        </section>
      )}

      <TitleRow heading="Continue watching" titles={resumable} />

      {catalog.genres.map((genre) => (
        <TitleRow
          key={genre.id}
          heading={genre.name}
          titles={titlesInGenre(genre.id)}
          moreHref={`/genre/${genre.id}`}
        />
      ))}
    </main>
  );
}
