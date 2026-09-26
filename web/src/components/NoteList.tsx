import { Link } from 'react-router-dom';
import { formatBytes } from '../lib/notes';
import type { Note } from '../lib/types';

/**
 * Notes belonging to a collection, listed under whatever else is in it.
 *
 * Deliberately a list and not a grid of cards. A note has no artwork and never
 * will, so a tile would be a coloured rectangle with a filename on it -- the
 * name and the format are the whole of what there is to choose by.
 */

const GLYPHS: Record<Note['format'], { path: string; label: string }> = {
  md: { path: 'M4 5h16v14H4zM7 16V9l3 3 3-3v7M17 9v5m0 0-2-2m2 2 2-2', label: 'Markdown' },
  html: { path: 'M6 4h8l4 4v12H6zM14 4v4h4M9 13h6M9 16h4', label: 'Document' },
  pdf: { path: 'M6 4h8l4 4v12H6zM14 4v4h4M9 14h2a1 1 0 0 0 0-2H9v4M14 12h2M14 12v4', label: 'PDF' },
};

export function NoteList({ notes, heading = 'Notes' }: { notes: Note[]; heading?: string }) {
  if (notes.length === 0) return null;

  return (
    <section className="notes">
      <h2 className="eyebrow">{heading}</h2>
      <ul className="notes__list">
        {notes.map((note) => {
          const glyph = GLYPHS[note.format] ?? GLYPHS.md;
          return (
            <li key={note.id}>
              <Link className="note-row" to={`/notes/${note.id}`}>
                <span className="note-row__glyph" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d={glyph.path} />
                  </svg>
                </span>
                <span className="note-row__text">
                  <span className="note-row__name">{note.title}</span>
                  <span className="note-row__meta">
                    {[glyph.label, formatBytes(note.sizeBytes)].filter(Boolean).join('   ·   ')}
                  </span>
                </span>
                <span className="note-row__go" aria-hidden="true">
                  Read
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
