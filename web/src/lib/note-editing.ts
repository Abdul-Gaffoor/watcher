import { adminApi } from './api';
import { renderMarkdown, sanitiseHtml } from './markdown';
import type { Note } from './types';

/**
 * Turning what the editor holds into what gets stored, and back.
 *
 * The editor is rich — headings, tables, checklists, images — but what it
 * produces is stored as **Markdown**, not as the editor's HTML. Markdown is
 * portable, diffable, readable without this app, and every one of the
 * toolbar's features maps onto GitHub-flavoured Markdown. Storing the
 * editor's own HTML would tie every note written here to whichever editor
 * happened to be installed the day it was written.
 *
 * The one exception is a note that is already HTML — anything converted from a
 * .docx. Editing it keeps it as HTML rather than quietly rewriting somebody's
 * imported document into a different format behind their back.
 */

/** The formats this editor can open at all. A PDF is a picture of a document. */
export function isEditable(note: Note): boolean {
  return note.format === 'md' || note.format === 'html';
}

/** Loads a stored note into the HTML the editor works in. */
export async function toEditorHtml(note: Note): Promise<string> {
  const response = await fetch(note.source, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`That note could not be opened (${response.status}).`);
  const text = await response.text();

  return note.format === 'html' ? sanitiseHtml(text) : renderMarkdown(text);
}

/** Turns the editor's HTML into the bytes to store, in the note's own format. */
export async function fromEditorHtml(
  html: string,
  format: 'md' | 'html',
): Promise<{ blob: Blob; extension: 'md' | 'html' }> {
  if (format === 'html') {
    const clean = await sanitiseHtml(html);
    return { blob: new Blob([clean], { type: 'text/html; charset=utf-8' }), extension: 'html' };
  }

  const { default: TurndownService } = await import('turndown');
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });

  // Turndown knows nothing about the three things the editor adds on top of
  // ordinary prose, and all three have a GitHub-flavoured spelling.
  turndown.addRule('strikethrough', {
    filter: ['del', 's'],
    replacement: (content) => `~~${content}~~`,
  });

  turndown.addRule('taskListItem', {
    filter: (node) =>
      node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem',
    replacement: (content, node) => {
      const done = (node as HTMLElement).getAttribute('data-checked') === 'true';
      // The checkbox itself is an input the editor renders; only its state matters.
      const text = content.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '').replace(/\n/g, '\n  ');
      return `- [${done ? 'x' : ' '}] ${text}\n`;
    },
  });

  turndown.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => `\n\n${tableToMarkdown(node as HTMLTableElement)}\n\n`,
  });

  return {
    blob: new Blob([turndown.turndown(html)], { type: 'text/markdown; charset=utf-8' }),
    extension: 'md',
  };
}

/**
 * Turndown's own table handling flattens cells into a paragraph. A table is
 * one of the reasons to have a rich editor at all, so it is written out by
 * hand in the GitHub spelling instead.
 */
function tableToMarkdown(table: HTMLTableElement): string {
  const rows = [...table.rows].map((row) =>
    [...row.cells].map((cell) => (cell.textContent ?? '').trim().replace(/\|/g, '\\|') || ' '),
  );
  if (rows.length === 0) return '';

  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => [...row, ...Array(width - row.length).fill(' ')];

  const [head, ...body] = rows;
  return [
    `| ${pad(head).join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...body.map((row) => `| ${pad(row).join(' | ')} |`),
  ].join('\n');
}

/** A short token for one image. The server refuses anything that is not one. */
export function assetSlot(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0').replace(/[^a-z0-9]/g, '0');
}

/** Uploads one pasted or chosen image and returns the path to reference it by. */
export async function uploadNoteImage(noteId: string, file: File): Promise<string> {
  const extension = (file.name.split('.').pop() ?? '').toLowerCase() || 'png';
  const signed = await adminApi.signUpload({
    op: 'note-asset',
    noteId,
    slot: assetSlot(),
    extension,
  });

  const response = await fetch(signed.url, {
    method: 'PUT',
    headers: { 'content-type': signed.contentType },
    body: file,
  });
  if (!response.ok) throw new Error(`That image could not be uploaded (${response.status}).`);
  return signed.mediaPath;
}
