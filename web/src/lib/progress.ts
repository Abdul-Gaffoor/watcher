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
