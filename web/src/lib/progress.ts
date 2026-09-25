/**
 * Resume points are a per-browser convenience for the MVP, so localStorage is
 * enough. Moving them server-side later only changes this module.
 */
const STORAGE_KEY = 'watcher.progress.v1';
const COMPLETE_RATIO = 0.95;
const MIN_RESUME_SECONDS = 15;

export interface ProgressEntry {
  positionSec: number;
  durationSec: number;
  updatedAt: number;
  /**
   * Set when a lesson played to the end. Kept rather than deleted, because a
   * syllabus has to be able to tick it off -- "watched" and "never started"
   * are different things, and an absent entry cannot tell them apart.
   */
  completed?: boolean;
}

type ProgressMap = Record<string, ProgressEntry>;

function readAll(): ProgressMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ProgressMap) : {};
  } catch {
    return {};
  }
}

function writeAll(map: ProgressMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota — resume is best-effort */
  }
}

export function getProgress(titleId: string): ProgressEntry | undefined {
  return readAll()[titleId];
}

export function saveProgress(titleId: string, positionSec: number, durationSec: number): void {
  if (!Number.isFinite(positionSec) || !Number.isFinite(durationSec) || durationSec <= 0) return;
  const map = readAll();
  map[titleId] = { positionSec, durationSec, updatedAt: Date.now() };
  writeAll(map);
}

/**
 * Records a lesson as watched. Replaces the old behaviour of deleting the
 * entry on ended: that kept Continue watching tidy but threw away the only
 * evidence the lesson was ever finished, which is exactly what a course needs
 * to count.
 *
 * It still leaves Continue watching alone, because resumePosition treats
 * anything past COMPLETE_RATIO as nothing to resume.
 */
export function markComplete(titleId: string, durationSec: number): void {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return clearProgress(titleId);
  const map = readAll();
  map[titleId] = { positionSec: durationSec, durationSec, updatedAt: Date.now(), completed: true };
  writeAll(map);
}

export function isComplete(entry: ProgressEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.completed) return true;
  return entry.durationSec > 0 && entry.positionSec / entry.durationSec >= COMPLETE_RATIO;
}

/** Started, but not finished. What a "Resume" button is for. */
export function isInProgress(entry: ProgressEntry | undefined): boolean {
  return resumePosition(entry) > 0;
}

export function clearProgress(titleId: string): void {
  const map = readAll();
  delete map[titleId];
  writeAll(map);
}

export function percentWatched(entry: ProgressEntry | undefined): number {
  if (!entry || entry.durationSec <= 0) return 0;
  return Math.min(100, Math.round((entry.positionSec / entry.durationSec) * 100));
}

/** Only offer a resume point if it is meaningfully into the video and not at the end. */
export function resumePosition(entry: ProgressEntry | undefined): number {
  if (!entry) return 0;
  if (entry.positionSec < MIN_RESUME_SECONDS) return 0;
  if (entry.positionSec / entry.durationSec > COMPLETE_RATIO) return 0;
  return entry.positionSec;
}

/** Titles the viewer started but has not finished, most recent first. */
export function continueWatching(limit = 12): { titleId: string; entry: ProgressEntry }[] {
  return Object.entries(readAll())
    .filter(([, entry]) => resumePosition(entry) > 0)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, limit)
    .map(([titleId, entry]) => ({ titleId, entry }));
}
