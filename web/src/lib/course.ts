import type { Collection, Title } from './types';
import { getProgress, isComplete, isInProgress, percentWatched } from './progress';

/**
 * A course is not a new kind of thing in the catalog — it is a shape the
 * catalog already has. A collection that holds videos rather than more
 * collections is a course, and the videos in it are its lessons, in the order
 * they were filed.
 *
 * Deriving it rather than declaring it means the library the owner already
 * built becomes a set of courses without re-entering any of it, and a
 * collection stops being one the moment it grows a sub-collection.
 */

export interface Lesson {
  title: Title;
  /** 1-based, which is how a syllabus is read and spoken about. */
  number: number;
  percent: number;
  complete: boolean;
  started: boolean;
}

export interface CourseStats {
  lessons: Lesson[];
  total: number;
  completed: number;
  /** Whole percent of lessons finished, for the ring and the progress bar. */
  percent: number;
  runtimeSec: number;
  /**
   * What the primary button should do: the lesson in progress if there is one,
   * otherwise the first unwatched, otherwise the first. Never nothing, so the
   * button never has to be disabled.
   */
  resume: Lesson | null;
  /** Whether that button says Resume, Start, or Watch again. */
  intent: 'start' | 'resume' | 'restart';
}

export function isCourse(children: Collection[], ownTitles: Title[]): boolean {
  return children.length === 0 && ownTitles.length > 0;
}

export function courseStats(titles: Title[]): CourseStats {
  const lessons: Lesson[] = titles.map((title, index) => {
    const entry = getProgress(title.id);
    return {
      title,
      number: index + 1,
      percent: percentWatched(entry),
      complete: isComplete(entry),
      started: isInProgress(entry),
    };
  });

  const completed = lessons.filter((lesson) => lesson.complete).length;
  const inProgress = lessons.find((lesson) => lesson.started) ?? null;
  const firstUnwatched = lessons.find((lesson) => !lesson.complete) ?? null;

  const resume = inProgress ?? firstUnwatched ?? lessons[0] ?? null;
  const intent =
    inProgress ? 'resume'
    : completed === lessons.length && lessons.length > 0 ? 'restart'
    : 'start';

  return {
    lessons,
    total: lessons.length,
    completed,
    percent: lessons.length === 0 ? 0 : Math.round((completed / lessons.length) * 100),
    runtimeSec: titles.reduce((sum, title) => sum + (title.durationSec || 0), 0),
    resume,
    intent,
  };
}

/** Total runtime as a course page states it: "4 lessons · 2h 10m". */
export function formatRuntime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}
