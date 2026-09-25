import { Link } from 'react-router-dom';
import { formatDuration } from '../lib/format';
import { getProgress, percentWatched } from '../lib/progress';
import type { Title } from '../lib/types';
import { GeneratedArt } from './GeneratedArt';

export function TitleCard({ title }: { title: Title }) {
  const progress = percentWatched(getProgress(title.id));
  // Generated artwork has the name typeset into it, the way a real poster
  // does. Repeating it underneath is the caption saying what the picture
  // already says.
  const artNamesItself = !title.poster;

  return (
    <Link className="card" to={`/watch/${title.id}`} aria-label={`Play ${title.title}`}>
      <div className="card__art">
        {title.poster ? (
          <img src={title.poster} alt="" loading="lazy" decoding="async" />
        ) : (
          <GeneratedArt seed={title.id} label={title.title} />
        )}

        {/* A play affordance on the art itself. Without one a thumbnail is a
            picture; with one it is obviously a thing you start. */}
        <span className="card__play" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M8 5.5v13l11-6.5z" />
          </svg>
        </span>

        {title.durationSec > 0 && (
          <span className="card__duration">{formatDuration(title.durationSec)}</span>
        )}
        {progress > 0 && (
          <span className="card__progress" aria-hidden="true">
            <span className="card__progress-bar" style={{ width: `${progress}%` }} />
          </span>
        )}
      </div>
      <div className="card__meta">
        {/* No visually-hidden heading in the other branch: .visually-hidden is
            position:absolute, so inside the row its containing block is .row
            rather than the scroller, and it escapes the scroller's clipping to
            stretch the page. The link's aria-label and the artwork's own
            aria-label already carry the name. */}
        {!artNamesItself && <h3 className="card__title">{title.title}</h3>}
        {title.level && <span className={`badge badge--${title.level}`}>{title.level}</span>}
      </div>
    </Link>
  );
}
