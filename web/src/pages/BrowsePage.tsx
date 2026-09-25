import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from '../components/Spinner';
import { TitleRow } from '../components/TitleRow';
import { useCatalog } from '../lib/CatalogProvider';
import { formatDuration } from '../lib/format';
import { continueWatching } from '../lib/progress';

export function BrowsePage() {
  const { catalog, loading, error, reload, featured, roots, childrenOf, titlesBeneath, titlesDirectlyIn, byId } =
    useCatalog();
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

      {/* A shelf per branch rather than per root: "Trading" is a section, and
          what a viewer scans is "Elliott Wave" and "Harmonic Trading" inside
          it. Each shelf gathers everything beneath it, however deep. */}
      {roots.map((root) => {
        const branches = childrenOf(root.id);
        const loose = titlesDirectlyIn(root.id);
        if (branches.length === 0 && loose.length === 0) return null;

        return (
          <section className="shelf" key={root.id}>
            <h2 className="shelf__heading">{root.name}</h2>
            {loose.length > 0 && (
              <TitleRow heading={root.name} titles={loose} moreHref={`/c/${root.id}`} />
            )}
            {branches.map((branch) => (
              <TitleRow
                key={branch.id}
                heading={branch.name}
                titles={titlesBeneath(branch.id)}
                moreHref={`/c/${branch.id}`}
              />
            ))}
          </section>
        );
      })}
    </main>
  );
}
