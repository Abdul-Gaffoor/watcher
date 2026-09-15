import { useCallback, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Spinner } from '../components/Spinner';
import { TitleRow } from '../components/TitleRow';
import { useCatalog } from '../lib/CatalogProvider';
import { formatDuration } from '../lib/format';
import { clearProgress, getProgress, resumePosition, saveProgress } from '../lib/progress';
import { HlsPlayer } from '../player/HlsPlayer';

export function WatchPage() {
  const { titleId = '' } = useParams();
  const { loading, byId, genreById, titlesInGenre } = useCatalog();
  const title = byId(titleId);

  // Read the resume point once on mount so later saves do not re-seek the video.
  const startAt = useMemo(() => resumePosition(getProgress(titleId)), [titleId]);

  const onProgress = useCallback(
    (positionSec: number, durationSec: number) => saveProgress(titleId, positionSec, durationSec),
    [titleId],
  );
  const onEnded = useCallback(() => clearProgress(titleId), [titleId]);

  if (loading) {
    return (
      <div className="page page--centered">
        <Spinner label="Loading" />
      </div>
    );
  }

  if (!title) {
    return (
      <div className="page page--centered">
        <p>That title is not in the catalog.</p>
        <Link className="button button--primary" to="/">
          Back to browse
        </Link>
      </div>
    );
  }

  const related = titlesInGenre(title.genreIds[0] ?? '').filter((other) => other.id !== title.id);
  const meta = [
    title.instructor,
    title.year,
    formatDuration(title.durationSec),
    title.level,
  ].filter(Boolean);

  return (
    <main className="page watch">
      <HlsPlayer title={title} startAt={startAt} onProgress={onProgress} onEnded={onEnded} />

      <div className="watch__details">
        <h1 className="watch__title">{title.title}</h1>
        <p className="watch__meta">{meta.join(' · ')}</p>
        <p className="watch__description">{title.description}</p>
        <p className="watch__genres">
          {title.genreIds.map((genreId) => {
            const genre = genreById(genreId);
            return genre ? (
              <Link key={genreId} className="chip" to={`/genre/${genreId}`}>
                {genre.name}
              </Link>
            ) : null;
          })}
        </p>
      </div>

      <TitleRow heading="More like this" titles={related} />
    </main>
  );
}
