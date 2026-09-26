import { adminApi } from './api';
import type { Note } from './types';

/**
 * Uploading and reading notes.
 *
 * Three formats go in and two come out. Markdown is stored as written and
 * rendered on the way to the screen. A PDF is stored untouched and handed to
 * the browser's own viewer, which is better than anything worth building. A
 * .docx is converted to HTML here, in the admin's browser, at upload time --
 * no browser renders one, and converting once beforehand is cheaper than
 * shipping a two-megabyte converter to every reader forever.
 */

/** What the file picker should accept, and what the server will sign. */
export const NOTE_ACCEPT = '.md,.markdown,.txt,.pdf,.docx,text/markdown,application/pdf';

const MAX_BYTES = 40 * 1024 * 1024;

export interface PreparedNote {
  /** What gets stored and rendered. */
  body: Blob;
  extension: 'md' | 'pdf' | 'html';
  /** Kept beside it when the upload was converted, so the original survives. */
  original?: { blob: Blob; extension: string };
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export async function prepareNote(file: File): Promise<PreparedNote> {
  if (file.size > MAX_BYTES) {
    throw new Error(`That file is ${Math.round(file.size / 1024 / 1024)}MB. The limit is 40MB.`);
  }

  const extension = extensionOf(file.name);

  if (extension === 'pdf') return { body: file, extension: 'pdf' };
  if (extension === 'md' || extension === 'markdown' || extension === 'txt') {
    return { body: file, extension: 'md' };
  }

  if (extension === 'docx') {
    // Loaded only here. A reader never pays for it.
    const [{ default: mammoth }, { default: DOMPurify }] = await Promise.all([
      import('mammoth/mammoth.browser'),
      import('dompurify'),
    ]);

    const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    // Sanitised before it is stored as well as before it is rendered. Storing
    // something we would refuse to display is how a latent problem is made.
    const clean = DOMPurify.sanitize(value, { USE_PROFILES: { html: true } });

    return {
      body: new Blob([clean], { type: 'text/html; charset=utf-8' }),
      extension: 'html',
      original: { blob: file, extension: 'docx' },
    };
  }

  throw new Error('Notes can be Markdown, PDF or Word documents.');
}

async function put(noteId: string, extension: string, blob: Blob): Promise<string> {
  const signed = await adminApi.signUpload({ op: 'note', noteId, extension });
  const response = await fetch(signed.url, {
    method: 'PUT',
    headers: { 'content-type': signed.contentType },
    body: blob,
  });
  if (!response.ok) throw new Error(`Storage refused the upload (${response.status}).`);
  return signed.mediaPath;
}

/** Uploads a prepared note and returns the fields the catalog needs. */
export async function uploadNote(
  noteId: string,
  file: File,
  prepared: PreparedNote,
): Promise<Pick<Note, 'format' | 'source' | 'original' | 'originalName' | 'sizeBytes' | 'updatedAt'>> {
  const source = await put(noteId, prepared.extension, prepared.body);

  // Only after the rendered body is safely stored. A failed second upload
  // leaves a readable note without its original rather than a broken one.
  let original: string | undefined;
  if (prepared.original) {
    original = await put(noteId, prepared.original.extension, prepared.original.blob);
  }

  return {
    format: prepared.extension,
    source,
    ...(original ? { original, originalName: file.name } : {}),
    sizeBytes: file.size,
    updatedAt: new Date().toISOString(),
  };
}

/** Human size for a note's row, which is the only thing a reader can judge it by. */
export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
