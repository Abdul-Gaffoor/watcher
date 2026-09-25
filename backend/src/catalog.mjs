/**
 * The catalog, as a tree.
 *
 * A flat genre list cannot express "Trading > Elliott Wave > a named course >
 * the class videos" alongside "Movies > Telugu > the films", because the two
 * are different depths. Collections are an adjacency list instead: each one
 * names its parent, or null at the root, so any shape is expressible and the
 * shape is the librarian's to choose rather than the schema's.
 *
 * This module is the gatekeeper for writes. The catalog is now runtime state
 * edited from the dashboard, so a malformed one would break browsing for
 * everybody, and it is cheaper to refuse it than to repair it.
 */

export const CATALOG_VERSION = 2;

/** Ids appear in URLs and in S3 keys, so they are deliberately narrow. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const MAX_COLLECTIONS = 500;
const MAX_TITLES = 5000;
const MAX_DEPTH = 6;

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a list of problems, empty when the catalog is safe to store. Every
 * message names what to fix rather than only what is wrong, because these
 * surface in the dashboard.
 */
export function validateCatalog(catalog) {
  const errors = [];

  if (!isPlainObject(catalog)) return ['The catalog must be an object.'];
  if (catalog.version !== CATALOG_VERSION) {
    errors.push(`Catalog version must be ${CATALOG_VERSION}.`);
  }
  if (!Array.isArray(catalog.collections)) errors.push('collections must be an array.');
  if (!Array.isArray(catalog.titles)) errors.push('titles must be an array.');
  if (errors.length > 0) return errors;

  const { collections, titles } = catalog;
  if (collections.length > MAX_COLLECTIONS) errors.push(`At most ${MAX_COLLECTIONS} collections.`);
  if (titles.length > MAX_TITLES) errors.push(`At most ${MAX_TITLES} titles.`);

  const byId = new Map();
  for (const collection of collections) {
    if (!isPlainObject(collection)) {
      errors.push('Every collection must be an object.');
      continue;
    }
    if (!ID_PATTERN.test(collection.id ?? '')) {
      errors.push(`Collection id "${collection.id}" must be lowercase letters, digits and hyphens.`);
      continue;
    }
    if (byId.has(collection.id)) {
      errors.push(`Two collections share the id "${collection.id}".`);
      continue;
    }
    if (typeof collection.name !== 'string' || collection.name.trim() === '') {
      errors.push(`Collection "${collection.id}" needs a name.`);
    }
    byId.set(collection.id, collection);
  }

  // A parent that does not exist would hide the whole branch from browsing.
  for (const collection of byId.values()) {
    const parentId = collection.parentId ?? null;
    if (parentId !== null && !byId.has(parentId)) {
      errors.push(`Collection "${collection.id}" names a parent that does not exist.`);
    }
  }

  // A cycle would hang any walk of the tree, so it is refused rather than
  // defended against at every read.
  for (const collection of byId.values()) {
    const seen = new Set([collection.id]);
    let current = collection.parentId ?? null;
    let depth = 1;
    while (current !== null) {
      if (seen.has(current)) {
        errors.push(`Collection "${collection.id}" is inside itself.`);
        break;
      }
      seen.add(current);
      const parent = byId.get(current);
      if (!parent) break;
      current = parent.parentId ?? null;
      if ((depth += 1) > MAX_DEPTH) {
        errors.push(`Collection "${collection.id}" is nested deeper than ${MAX_DEPTH} levels.`);
        break;
      }
    }
  }

  const titleIds = new Set();
  for (const title of titles) {
    if (!isPlainObject(title)) {
      errors.push('Every title must be an object.');
      continue;
    }
    if (!ID_PATTERN.test(title.id ?? '')) {
      errors.push(`Title id "${title.id}" must be lowercase letters, digits and hyphens.`);
      continue;
    }
    if (titleIds.has(title.id)) {
      errors.push(`Two titles share the id "${title.id}".`);
      continue;
    }
    titleIds.add(title.id);

    if (typeof title.title !== 'string' || title.title.trim() === '') {
      errors.push(`Title "${title.id}" needs a name.`);
    }
    if (!byId.has(title.collectionId ?? '')) {
      errors.push(`Title "${title.id}" is not in a collection that exists.`);
    }
    if (!isPlainObject(title.sources) || (!title.sources.hls && !title.sources.mp4)) {
      errors.push(`Title "${title.id}" has no video source.`);
    }
    if (typeof title.durationSec !== 'number' || !Number.isFinite(title.durationSec)) {
      errors.push(`Title "${title.id}" needs a numeric durationSec.`);
    }
    for (const [field, value] of Object.entries(title.sources ?? {})) {
      // Everything is served from our own media path; an absolute URL here
      // would be a way to point the player at somebody else's server.
      if (typeof value === 'string' && value !== '' && !value.startsWith('/media/')) {
        errors.push(`Title "${title.id}" source ${field} must be a /media/ path.`);
      }
    }
  }

  return errors;
}

/** The storage key for one uploaded source file, derived rather than accepted. */
export function sourceKeyFor(titleId, extension) {
  return `media/titles/${titleId}/source.${extension}`;
}

/** Guards a key handed back by a client mid-upload. */
export function isOwnedMediaKey(key) {
  const match = /^media\/titles\/([a-z0-9-]+)\/[a-z0-9._-]+$/.exec(String(key ?? ''));
  return Boolean(match) && ID_PATTERN.test(match[1]);
}

/**
 * Brings a version 1 catalog forward. Each genre becomes a root collection and
 * each title joins the first one it listed, which preserves what was there
 * without guessing at a hierarchy nobody has described yet.
 */
export function migrateFromV1(old) {
  const collections = (old.genres ?? []).map((genre) => ({
    id: genre.id,
    name: genre.name,
    parentId: null,
    description: genre.description,
  }));

  const known = new Set(collections.map((collection) => collection.id));
  const titles = (old.titles ?? []).map((title) => {
    const { genreIds, ...rest } = title;
    const collectionId = (genreIds ?? []).find((id) => known.has(id)) ?? collections[0]?.id;
    return { ...rest, collectionId };
  });

  return {
    version: CATALOG_VERSION,
    revision: 1,
    updatedAt: new Date().toISOString(),
    collections,
    titles,
  };
}
