import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { GeneratedArt } from '../components/GeneratedArt';
import { Spinner } from '../components/Spinner';
import { TitleRow } from '../components/TitleRow';
import { useCatalog } from '../lib/CatalogProvider';
import { courseStats } from '../lib/course';
import { formatDuration } from '../lib/format';
import { getProgress, markComplete, resumePosition, saveProgress } from '../lib/progress';
import { HlsPlayer } from '../player/HlsPlayer';

/** How long the up-next card counts down before it takes you there. */
const AUTOPLAY_SECONDS = 8;

export function WatchPage() {
  const { titleId = '' } = useParams();
  const navigate = useNavigate();
  const { loading, byId, titlesDirectlyIn, childrenOf, collectionById, pathTo } = useCatalog();
  const title = byId(titleId);

  const [countdown, setCountdown] = useState<number | null>(null);

  // Read the resume point once on mount so later saves do not re-seek the video.
  const startAt = useMemo(() => resumePosition(getProgress(titleId)), [titleId]);

  const onProgress = useCallback(
    (positionSec: number, durationSec: number) => saveProgress(titleId, positionSec, durationSec),
    [titleId],
  );

  const course = title ? collectionById(title.collectionId) : undefined;
  const siblings = title ? titlesDirectlyIn(title.collectionId) : [];
  // Only a leaf collection is a course; a category's loose videos are not a
  // sequence and must not pretend to be one.
  const isCourse = Boolean(course && childrenOf(course.id).length === 0 && siblings.length > 1);

  const stats = useMemo(() => (isCourse ? courseStats(siblings) : null), [isCourse, siblings]);
  const index = siblings.findIndex((other) => other.id === titleId);
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;
  const previous = index > 0 ? siblings[index - 1] : null;

  const goNext = useCallback(() => {
    if (next) navigate(`/watch/${next.id}`);
  }, [navigate, next]);

  const onEnded = useCallback(() => {
    // Recorded as watched rather than forgotten, so the syllabus can tick it
    // off. An absent entry cannot tell "finished" from "never opened".
    markComplete(titleId, title?.durationSec ?? getProgress(titleId)?.durationSec ?? 0);
    if (next) setCountdown(AUTOPLAY_SECONDS);
  }, [titleId, title, next]);

  // Leaving, or picking something else, cancels the hand-off.
  useEffect(() => setCountdown(null), [titleId]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      goNext();
      return;
    }
    const timer = window.setTimeout(() => setCountdown((value) => (value ?? 1) - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, goNext]);

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

  const meta = [
    title.instructor,
    title.year ? String(title.year) : '',
    formatDuration(title.durationSec),
    title.level,
  ].filter(Boolean);

  const related = siblings.filter((other) => other.id !== title.id);

  return (
    <main className="page theatre">
      <div className="theatre__stage">
        <HlsPlayer
          title={title}
          startAt={startAt}
          onProgress={onProgress}
          onEnded={onEnded}
          onNext={next ? goNext : undefined}
          nextLabel={next ? `Next: ${next.title}` : undefined}
        />

        {countdown !== null && next && (
          <div className="upnext" role="status">
            <p className="upnext__label">Up next in {countdown}</p>
            <p className="upnext__title">{next.title}</p>
            <div className="upnext__actions">
              <button className="button button--hero" type="button" onClick={goNext}>
                Play now
              </button>
              <button
                className="button button--hero-secondary"
                type="button"
                onClick={() => setCountdown(null)}
              >
                Stay here
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="theatre__body">
        <div className="theatre__main">
          {course && (
            <p className="theatre__eyebrow">
              {/* The whole path, so a viewer can climb back to any level. */}
              {pathTo(title.collectionId).map((ancestor, position) => (
                <span key={ancestor.id}>
                  {position > 0 && <span aria-hidden="true"> / </span>}
                  <Link to={`/c/${ancestor.id}`}>{ancestor.name}</Link>
                </span>
              ))}
              {isCourse && index >= 0 && (
                <span className="theatre__position">
                  Lesson {index + 1} of {siblings.length}
                </span>
              )}
            </p>
          )}

          <h1 className="theatre__title">{title.title}</h1>
          {meta.length > 0 && <p className="theatre__meta">{meta.join('   ·   ')}</p>}
          {title.description && <p className="theatre__description">{title.description}</p>}

          {(previous || next) && (
            <nav className="theatre__steps" aria-label="Lessons">
              {previous ? (
                <Link className="button button--hero-secondary" to={`/watch/${previous.id}`}>
                  ‹ Previous
                </Link>
              ) : (
                <span />
              )}
              {next && (
                <Link className="button button--hero-secondary" to={`/watch/${next.id}`}>
                  Next ›
                </Link>
              )}
            </nav>
          )}
        </div>

        {/* The rest of the course, beside the player rather than below it, so
            picking the next lesson never means leaving the one playing. */}
        {isCourse && stats && course && (
          <aside className="theatre__rail" aria-label={`Lessons in ${course.name}`}>
            <header className="theatre__rail-head">
              <Link to={`/c/${course.id}`}>{course.name}</Link>
              <span>
                {stats.completed}/{stats.total} watched
              </span>
            </header>

            <ol className="rail-list">
              {stats.lessons.map((lesson) => {
                const current = lesson.title.id === title.id;
                return (
                  <li key={lesson.title.id}>
                    <Link
                      className={current ? 'rail-item is-current' : 'rail-item'}
                      to={`/watch/${lesson.title.id}`}
                      aria-current={current ? 'true' : undefined}
                    >
                      <span className="rail-item__thumb">
                        {lesson.title.poster ? (
                          <img src={lesson.title.poster} alt="" loading="lazy" decoding="async" />
                        ) : (
                          <GeneratedArt seed={lesson.title.id} label={lesson.title.title} variant="plain" />
                        )}
                        {lesson.percent > 0 && (
                          <span className="rail-item__bar" aria-hidden="true">
                            <span style={{ width: `${lesson.percent}%` }} />
                          </span>
                        )}
                      </span>
                      <span className="rail-item__text">
                        <span className="rail-item__name">
                          {lesson.number}. {lesson.title.title}
                        </span>
                        <span className="rail-item__meta">
                          {lesson.complete ? 'Watched' : formatDuration(lesson.title.durationSec) || '—'}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </aside>
        )}
      </div>

      {!isCourse && <TitleRow heading="More like this" titles={related} />}
    </main>
  );
}
