import type { Collection, Note, Title } from './types';

/**
 * Finding things in a library whose names repeat.
 *
 * The old matcher took the raw query as one substring and looked for it in a
 * title's own text. That fails on this library in both directions at once:
 * the lessons are called "Class - 1" and "Class - 2", so searching "class"
 * returns everything in no order, while the things worth finding -- "SweeGlu
 * Elliott Wave", "Harmonic Trading", "Gaurdeer Mentorship" -- are collection
 * names, which it never looked at.
 *
 * So: collections are searchable in their own right, a title inherits the
 * words of every collection above it, terms match in any order, and results
 * are ranked rather than left in catalog order.
 */

export interface SearchResults {
  collections: Collection[];
  titles: Title[];
  notes: Note[];
}

/**
 * Lowercased, stripped of accents, punctuation reduced to spaces. "Class - 1"
 * and "class 1" have to be the same thing to search, and a hyphen is not a
 * word.
 */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function terms(query: string): string[] {
  const cleaned = normalise(query);
  return cleaned ? cleaned.split(' ') : [];
}

/** Every term must appear somewhere. Order is not meaningful in a query. */
function matchesAll(haystack: string, needles: string[]): boolean {
  return needles.every((needle) => haystack.includes(needle));
}

/**
 * Higher is better. The distinction that matters is where the words were
 * found: a title whose own name matches is a better answer than one that
 * merely sits in a course whose name matches, which is in turn better than one
 * that happens to use the word in a sentence.
 */
function scoreOf(name: string, path: string, rest: string, needles: string[]): number {
  if (!matchesAll(`${name} ${path} ${rest}`, needles)) return -1;

  const joined = needles.join(' ');
  if (name === joined) return 100;
  if (name.startsWith(joined)) return 80;
  if (matchesAll(name, needles)) return 60;
  if (matchesAll(path, needles)) return 40;
  return 20;
}

export function searchCatalog(
  query: string,
  titles: Title[],
  collections: Collection[],
  notes: Note[],
  pathTo: (collectionId: string) => Collection[],
): SearchResults {
  const needles = terms(query);
  if (needles.length === 0) return { collections: [], titles: [], notes: [] };

  // Computed once per search rather than per title: a title's ancestry is the
  // same for every one of its siblings.
  const pathText = new Map<string, string>();
  for (const collection of collections) {
    pathText.set(
      collection.id,
      normalise(pathTo(collection.id).map((ancestor) => ancestor.name).join(' ')),
    );
  }

  const rankedCollections = collections
    .map((collection) => ({
      collection,
      score: scoreOf(
        normalise(collection.name),
        pathText.get(collection.id) ?? '',
        normalise(collection.description ?? ''),
        needles,
      ),
    }))
    .filter((hit) => hit.score >= 0)
    .sort((a, b) => b.score - a.score);

  const rankedTitles = titles
    .map((title) => ({
      title,
      score: scoreOf(
        normalise(title.title),
        pathText.get(title.collectionId) ?? '',
        normalise([title.description, title.instructor, ...(title.tags ?? [])].filter(Boolean).join(' ')),
        needles,
      ),
    }))
    .filter((hit) => hit.score >= 0)
    .sort((a, b) => b.score - a.score);

  // Notes are findable by name and by the course they belong to, exactly as
  // videos are. A library where only half the shelf is searchable is worse
  // than one where none of it is, because the gap is invisible.
  const rankedNotes = notes
    .map((note) => ({
      note,
      score: scoreOf(normalise(note.title), pathText.get(note.collectionId) ?? '', '', needles),
    }))
    .filter((hit) => hit.score >= 0)
    .sort((a, b) => b.score - a.score);

  return {
    collections: rankedCollections.map((hit) => hit.collection),
    titles: rankedTitles.map((hit) => hit.title),
    notes: rankedNotes.map((hit) => hit.note),
  };
}
