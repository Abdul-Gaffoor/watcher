import { Link } from 'react-router-dom';
import { GeneratedArt } from './GeneratedArt';
import { formatDuration } from '../lib/format';
import { courseStats, formatRuntime } from '../lib/course';
import { NoteList } from './NoteList';
import type { Collection, Note, Title } from '../lib/types';

/**
 * A course, presented as a syllabus rather than a pile of tiles.
 *
 * "Class - 1, Class - 2, Class - 3" filed under a named course is not a grid
 * of unrelated videos: it is an ordered thing with a beginning, a position and
 * an end. A grid states none of that. So: one billboard for the course, one
 * button that knows which lesson you are actually up to, and a numbered list
 * that shows what is done.
 */

const PLAY = 'M8 5.5v13l11-6.5z';
const TICK = 'M5 12.5 10 17.5 19 7';

export function CourseView({
  collection,
  titles,
  notes,
  trail,
}: {
  collection: Collection;
  titles: Title[];
  notes: Note[];
  trail: Collection[];
}) {
  const stats = courseStats(titles);
  const art = stats.resume?.title ?? titles[0];

  const buttonLabel =
    stats.intent === 'resume' ? `Resume lesson ${stats.resume?.number}`
    : stats.intent === 'restart' ? 'Watch again'
    : stats.total > 1 ? 'Start the course'
    : 'Watch';

  return (
    <main className="page course">
      <section className="course__hero">
        <div className="course__art" aria-hidden="true">
          {art?.backdrop || art?.poster ? (
            <img src={art.backdrop ?? art.poster} alt="" />
          ) : (
            art && <GeneratedArt seed={art.id} label={art.title} variant="backdrop" />
          )}
        </div>
        <div className="course__veil" aria-hidden="true" />

        <div className="course__intro">
          <nav className="course__trail" aria-label="Breadcrumb">
            <Link to="/">Home</Link>
            {trail.map((ancestor) => (
              <Link key={ancestor.id} to={`/c/${ancestor.id}`}>
                {ancestor.name}
              </Link>
            ))}
          </nav>

          <h1 className="course__title">{collection.name}</h1>

          <p className="course__facts">
            {[
              `${stats.total} ${stats.total === 1 ? 'lesson' : 'lessons'}`,
              formatRuntime(stats.runtimeSec),
              notes.length > 0 ? `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}` : '',
            ]
              .filter(Boolean)
              .join('   ·   ')}
          </p>

          {collection.description && <p className="course__blurb">{collection.description}</p>}

          <div className="course__actions">
            {stats.resume && (
              <Link className="button button--hero" to={`/watch/${stats.resume.title.id}`}>
                <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
                  <path d={PLAY} />
                </svg>
                {buttonLabel}
              </Link>
            )}
          </div>

          {/* Only once something has been watched. A bar reading zero on a
              course nobody has opened is a reproach, not information. */}
          {stats.completed > 0 && (
            <div className="course__progress">
              <span className="course__progress-track">
                <span className="course__progress-fill" style={{ width: `${stats.percent}%` }} />
              </span>
              <span className="course__progress-label">
                {stats.completed} of {stats.total} complete
              </span>
            </div>
          )}
        </div>
      </section>

      <ol className="syllabus">
        {stats.lessons.map((lesson) => (
          <li key={lesson.title.id} className={lesson.complete ? 'syllabus__row is-done' : 'syllabus__row'}>
            <Link className="syllabus__link" to={`/watch/${lesson.title.id}`}>
              <span className="syllabus__number" aria-hidden="true">
                {lesson.complete ? (
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d={TICK} />
                  </svg>
                ) : (
                  String(lesson.number).padStart(2, '0')
                )}
              </span>

              <span className="syllabus__thumb">
                {lesson.title.poster ? (
                  <img src={lesson.title.poster} alt="" loading="lazy" decoding="async" />
                ) : (
                  <GeneratedArt seed={lesson.title.id} label={lesson.title.title} variant="plain" />
                )}
                {/* Where you stopped, on the thumbnail rather than a separate
                    column, so the row reads in one glance. */}
                {lesson.percent > 0 && !lesson.complete && (
                  <span className="syllabus__resume" aria-hidden="true">
                    <span style={{ width: `${lesson.percent}%` }} />
                  </span>
                )}
              </span>

              <span className="syllabus__body">
                <span className="syllabus__name">{lesson.title.title}</span>
                {lesson.title.description && (
                  <span className="syllabus__blurb">{lesson.title.description}</span>
                )}
              </span>

              <span className="syllabus__meta">
                {lesson.started && !lesson.complete && (
                  <span className="syllabus__tag">{lesson.percent}%</span>
                )}
                {formatDuration(lesson.title.durationSec)}
              </span>
            </Link>
          </li>
        ))}
      </ol>

      {/* After the syllabus: the lessons are the course, and the notes are
          what you reach for alongside them. */}
      <NoteList notes={notes} heading="Course notes" />
    </main>
  );
}
