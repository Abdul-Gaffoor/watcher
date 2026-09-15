import { Link } from 'react-router-dom';
import { formatDuration } from '../lib/format';
import { getProgress, percentWatched } from '../lib/progress';
import type { Title } from '../lib/types';

export function TitleCard({ title }: { title: Title }) {
  const progress = percentWatched(getProgress(title.id));

  return (
    <Link className="card" to={`/watch/${title.id}`} aria-label={`Play ${title.title}`}>
      <div className="card__art">
        {title.poster ? (
          <img src={title.poster} alt="" loading="lazy" decoding="async" />
        ) : (
          <div className="card__art--placeholder" aria-hidden="true">
            {title.title.slice(0, 1)}
          </div>
        )}
        <span className="card__duration">{formatDuration(title.durationSec)}</span>
        {progress > 0 && (
          <span className="card__progress" aria-hidden="true">
            <span className="card__progress-bar" style={{ width: `${progress}%` }} />
          </span>
        )}
      </div>
      <div className="card__meta">
        <h3 className="card__title">{title.title}</h3>
        {title.level && <span className={`badge badge--${title.level}`}>{title.level}</span>}
      </div>
    </Link>
  );
}
