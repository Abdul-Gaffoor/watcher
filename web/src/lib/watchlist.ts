/**
 * The saved list, kept in the browser like resume positions are.
 *
 * Deliberately local: making it follow a viewer across devices means storing it
 * server side, which is a real feature with a real API behind it. Until that
 * exists, a list that silently only works on one device is the honest version,
 * and the storage shape matches progress.ts so both can move together later.
 */

const KEY = 'watcher.list.v1';

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // Private browsing and cleared storage both land here; an empty list is
    // the right answer for both.
    return [];
  }
}

function write(ids: string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* Nothing useful to do if storage is unavailable. */
  }
}

export function savedIds(): string[] {
  return read();
}

export function isSaved(titleId: string): boolean {
  return read().includes(titleId);
}

/** Returns the new state, so a caller can render without re-reading. */
export function toggleSaved(titleId: string): boolean {
  const ids = read();
  const index = ids.indexOf(titleId);
  if (index === -1) {
    // Most recent first, which is the order the row should show.
    write([titleId, ...ids]);
    return true;
  }
  ids.splice(index, 1);
  write(ids);
  return false;
}
