/**
 * Ids, made from names.
 *
 * An id is the URL and the S3 prefix, so it is derived once from what somebody
 * typed and then never changes -- renaming a note or a collection later leaves
 * its id alone, because the alternative is moving stored objects around to keep
 * a string tidy.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * The same id, made unique.
 *
 * A clash has to be resolved rather than silently merged: two collections
 * called "Class 1" are two shelves, and two notes with one id would overwrite
 * each other's stored file.
 */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;

  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
