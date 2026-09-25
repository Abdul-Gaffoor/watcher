import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Spinner } from '../components/Spinner';
import { TitleRow } from '../components/TitleRow';
import { useCatalog } from '../lib/CatalogProvider';
import { formatDuration } from '../lib/format';
import { continueWatching } from '../lib/progress';
import { isSaved, savedIds, toggleSaved } from '../lib/watchlist';
import { BookmarkIcon } from '../components/icons';
import { GeneratedArt } from '../components/GeneratedArt';

export function BrowsePage() {
  const {
    catalog,
    loading,
    error,
    reload,
    featured,
    roots,
    childrenOf,
    titlesBeneath,
    titlesDirectlyIn,
    byId,
    pathTo,
  } = useCatalog();
  const [synopsisOpen, setSynopsisOpen] = useState(false);
  const [saved, setSaved] = useState<string[]>(() => savedIds());

  const resumable = useMemo(
    () =>
      continueWatching()
        .map(({ titleId }) => byId(titleId))
        .filter((title): title is NonNullable<typeof title> => Boolean(title)),
    [byId],
  );

  const breadcrumb = useMemo(
    () => (featured ? pathTo(featured.collectionId) : []),
    [featured, pathTo],
  );

  /** Only the facts this title actually has. The rest is not rendered at all. */
  const heroFacts = useMemo(
    () =>
      featured
        ? [
            featured.instructor,
            featured.year ? String(featured.year) : '',
            featured.level,
            formatDuration(featured.durationSec),
            ...(featured.tags ?? []).slice(0, 2),
          ].filter(Boolean)
        : [],
    [featured],
  );

  const savedTitles = useMemo(
    () => saved.map((id) => byId(id)).filter((title): title is NonNullable<typeof title> => Boolean(title)),
    [saved, byId],
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
        <section className="hero">
          {/* The artwork is a panel anchored right and faded out to the left,
              rather than a background behind everything. That is what lets the
              subject bleed off the edge while the text keeps a flat, readable
              field to sit on. */}
          {featured.backdrop ? (
            <div
              className="hero__art"
              style={{ backgroundImage: `url(${featured.backdrop})` }}
              aria-hidden="true"
            />
          ) : (
            // A billboard with no artwork is a void with a headline in it.
            // Anything uploaded before frame capture existed has none, so it
            // gets the same generated art its tile does.
            <div className="hero__art hero__art--generated" aria-hidden="true">
              <GeneratedArt seed={featured.id} label={featured.title} variant="backdrop" />
            </div>
          )}
          <div className="hero__scrim" />
          <div className="hero__content">
            {/* Where it sits, when it has nothing else to say for itself.
                An uploaded lesson has a name and a video and no year, level or
                synopsis -- but it does have a place in the library, and
                "Trading / Harmonic Trading / HTM by Krishna" is real
                information the tree already knows. */}
            {breadcrumb.length > 0 && (
              <p className="hero__meta hero__meta--top hero__crumbs">
                {breadcrumb.map((crumb, index) => (
                  <span key={crumb.id}>
                    {index > 0 && <span className="hero__crumb-sep" aria-hidden="true">/</span>}
                    <Link to={`/c/${crumb.id}`}>{crumb.name}</Link>
                  </span>
                ))}
              </p>
            )}

            <h1 className="hero__title">{featured.title}</h1>

            {/* Every one of these is optional, and an empty paragraph is a gap
                the eye reads as a mistake. Rendered only when there is
                something in it. */}
            {heroFacts.length > 0 && <p className="hero__meta">{heroFacts.join('   ·   ')}</p>}

            {featured.description && (
              <p
                className={
                  synopsisOpen ? 'hero__description' : 'hero__description hero__description--clamped'
                }
              >
                {featured.description}
              </p>
            )}
            <div className="hero__actions">
              <Link className="button button--hero" to={`/watch/${featured.id}`}>
                <span aria-hidden="true">▶</span> Watch now
              </Link>
              {/* Only when there is a synopsis to expand. A button that
                  visibly does nothing is worse than no button. */}
              {featured.description && (
                <button
                  type="button"
                  className="button button--hero-secondary"
                  aria-expanded={synopsisOpen}
                  onClick={() => setSynopsisOpen((open) => !open)}
                >
                  {synopsisOpen ? 'Less' : 'Details'}
                </button>
              )}
            </div>
          </div>

          {/* One action, not three. A heart, a bookmark and a plus would be
              three controls for one idea, and two of them would do nothing. */}
          <div className="hero__aside">
            <button
              type="button"
              className={isSaved(featured.id) ? 'circle-button is-on' : 'circle-button'}
              aria-pressed={isSaved(featured.id)}
              onClick={() => {
                toggleSaved(featured.id);
                setSaved(savedIds());
              }}
              title={isSaved(featured.id) ? 'Remove from your list' : 'Save to your list'}
            >
              <BookmarkIcon filled={isSaved(featured.id)} />
              <span className="visually-hidden">
                {isSaved(featured.id) ? 'Remove from your list' : 'Save to your list'}
              </span>
            </button>
          </div>
        </section>
      )}

      <TitleRow heading="Continue watching" titles={resumable} />
      <TitleRow heading="My list" titles={savedTitles} />

      {/* A shelf per branch rather than per root: "Trading" is a section, and
          what a viewer scans is "Elliott Wave" and "Harmonic Trading" inside
          it. Each shelf gathers everything beneath it, however deep. */}
      {roots.map((root) => {
        // Only branches that actually hold something. A collection made in the
        // dashboard before anything was uploaded into it would otherwise
        // render as a heading with nothing under it, and a whole root made of
        // those -- "Movies", with an empty "Telugu" inside -- rendered as a
        // section title floating over blank page.
        const branches = childrenOf(root.id).filter((branch) => titlesBeneath(branch.id).length > 0);
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
