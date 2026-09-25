import { strict as assert } from 'node:assert';
import test from 'node:test';

import { AdminError, isAdmin, readCatalog, signUpload, writeCatalog } from '../src/admin.mjs';
import { migrateFromV1, slugify, validateCatalog } from '../src/catalog.mjs';

process.env.AWS_ACCESS_KEY_ID ??= 'AKIAIOSFODNN7EXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY ??= 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

const config = { mediaBucket: 'watcher-media', mediaRegion: 'us-east-1' };

function catalogWith(overrides = {}) {
  return {
    version: 2,
    revision: 1,
    collections: [
      { id: 'trading', name: 'Trading', parentId: null },
      { id: 'elliott-wave', name: 'Elliott Wave', parentId: 'trading' },
      { id: 'sweeglu', name: 'SweeGlu Elliott Wave Course', parentId: 'elliott-wave' },
    ],
    titles: [
      {
        id: 'class-01',
        title: 'Class 01',
        collectionId: 'sweeglu',
        durationSec: 3600,
        sources: { mp4: '/media/titles/class-01/source.mp4' },
      },
    ],
    ...overrides,
  };
}

// ----------------------------------------------------------------- roles --

test('only an admin role opens the dashboard', () => {
  assert.equal(isAdmin({ roles: ['admin'] }), true);
  assert.equal(isAdmin({ roles: ['viewer', 'admin'] }), true);
  assert.equal(isAdmin({ roles: ['viewer'] }), false);
  assert.equal(isAdmin({ roles: [] }), false);
  assert.equal(isAdmin({}), false);
  assert.equal(isAdmin(null), false);
});

// ------------------------------------------------------------- the tree --

test('accepts a tree of mixed depth', () => {
  const catalog = catalogWith();
  catalog.collections.push({ id: 'movies', name: 'Movies', parentId: null });
  catalog.collections.push({ id: 'telugu', name: 'Telugu', parentId: 'movies' });
  catalog.titles.push({
    id: 'a-film',
    title: 'A Film',
    collectionId: 'telugu',
    durationSec: 7200,
    sources: { mp4: '/media/titles/a-film/source.mp4' },
  });

  // Four levels on one branch and three on another is the whole point.
  assert.deepEqual(validateCatalog(catalog), []);
});

test('refuses a collection whose parent does not exist', () => {
  const catalog = catalogWith();
  catalog.collections.push({ id: 'orphan', name: 'Orphan', parentId: 'nowhere' });

  assert.match(validateCatalog(catalog).join(' '), /names a parent that does not exist/);
});

test('refuses a cycle rather than hanging on it later', () => {
  const catalog = catalogWith();
  catalog.collections[0].parentId = 'sweeglu';

  assert.match(validateCatalog(catalog).join(' '), /is inside itself/);
});

test('refuses a title filed under a collection that does not exist', () => {
  const catalog = catalogWith();
  catalog.titles[0].collectionId = 'nowhere';

  assert.match(validateCatalog(catalog).join(' '), /not in a collection that exists/);
});

test('refuses duplicate ids, which would make one unreachable', () => {
  const catalog = catalogWith();
  catalog.collections.push({ id: 'trading', name: 'Trading again', parentId: null });

  assert.match(validateCatalog(catalog).join(' '), /share the id/);
});

test('refuses a source pointing off our own media path', () => {
  const catalog = catalogWith();
  catalog.titles[0].sources = { mp4: 'https://elsewhere.example/evil.mp4' };

  assert.match(validateCatalog(catalog).join(' '), /must be a \/media\/ path/);
});

test('refuses a title with no video at all', () => {
  const catalog = catalogWith();
  catalog.titles[0].sources = {};

  assert.match(validateCatalog(catalog).join(' '), /no video source/);
});

test('slugify produces ids the schema accepts', () => {
  assert.equal(slugify('SweeGlu Elliott Wave Course'), 'sweeglu-elliott-wave-course');
  assert.equal(slugify('  Telugu / Movies!  '), 'telugu-movies');
});

test('a version 1 catalog comes forward with its titles intact', () => {
  const migrated = migrateFromV1({
    version: 1,
    genres: [{ id: 'cinema', name: 'Cinema' }],
    titles: [
      {
        id: 'night-shift',
        title: 'Night Shift',
        genreIds: ['cinema'],
        durationSec: 10,
        sources: { mp4: '/media/titles/night-shift/source.mp4' },
      },
    ],
  });

  assert.equal(migrated.version, 2);
  assert.equal(migrated.collections[0].parentId, null);
  assert.equal(migrated.titles[0].collectionId, 'cinema');
  assert.equal('genreIds' in migrated.titles[0], false);
  assert.deepEqual(validateCatalog(migrated), []);
});

// ------------------------------------------------------------- uploading --

test('begin derives the key rather than trusting the client', () => {
  const signed = signUpload(config, {
    op: 'begin',
    titleId: 'class-01',
    filename: 'whatever the browser called it.MP4',
  });

  assert.equal(signed.key, 'media/titles/class-01/source.mp4');
  assert.equal(signed.mediaPath, '/media/titles/class-01/source.mp4');
  assert.ok(signed.url.includes('uploads='));
  assert.ok(signed.url.includes('X-Amz-Signature='));
});

test('a poster is signed as one PUT beside the video it came from', () => {
  // Multipart would be wrong for a couple of hundred kilobytes: S3 requires
  // five-megabyte parts.
  const signed = signUpload(config, { op: 'poster', titleId: 'class-01' });

  assert.equal(signed.key, 'media/titles/class-01/poster.jpg');
  assert.equal(signed.mediaPath, '/media/titles/class-01/poster.jpg');
  assert.equal(signed.contentType, 'image/jpeg');
  assert.ok(signed.url.includes('X-Amz-Signature='));
  // A single PUT carries no upload id and no part number.
  assert.equal(signed.url.includes('uploadId='), false);
  assert.equal(signed.url.includes('partNumber='), false);
});

test('a poster key is derived, never taken from the request', () => {
  for (const titleId of ['../etc', 'Class 01', 'a/b', '']) {
    assert.throws(
      () => signUpload(config, { op: 'poster', titleId }),
      AdminError,
      `expected ${titleId} to be refused`,
    );
  }

  // A key smuggled alongside a valid id is ignored rather than honoured.
  const signed = signUpload(config, {
    op: 'poster',
    titleId: 'class-01',
    key: 'media/catalog.json',
  });
  assert.equal(signed.key, 'media/titles/class-01/poster.jpg');
});

test('a title id that could escape the layout is refused', () => {
  for (const titleId of ['../etc', 'Class 01', 'a/b', '']) {
    assert.throws(
      () => signUpload(config, { op: 'begin', titleId, filename: 'v.mp4' }),
      AdminError,
      `expected ${titleId} to be refused`,
    );
  }
});

test('an unsupported file type is refused before anything is signed', () => {
  assert.throws(
    () => signUpload(config, { op: 'begin', titleId: 'x', filename: 'payload.exe' }),
    /not supported/,
  );
});

test('a tampered key is never signed', () => {
  for (const key of [
    'media/catalog.json',
    'index.html',
    'media/titles/../../secret',
    'media/titles/x/../../../etc/passwd',
  ]) {
    assert.throws(
      () => signUpload(config, { op: 'parts', key, uploadId: 'u', partNumbers: [1] }),
      /not an upload this service started/,
      `expected ${key} to be refused`,
    );
  }
});

test('part URLs are signed per part and carry the upload they belong to', () => {
  const { urls } = signUpload(config, {
    op: 'parts',
    key: 'media/titles/class-01/source.mp4',
    uploadId: 'UPLOAD-1',
    partNumbers: [1, 2],
  });

  assert.equal(urls.length, 2);
  assert.equal(urls[0].partNumber, 1);
  assert.ok(urls[0].url.includes('partNumber=1'));
  assert.ok(urls[1].url.includes('partNumber=2'));
  assert.ok(urls[0].url.includes('uploadId=UPLOAD-1'));
});

test('an absurd part request is refused rather than signed', () => {
  const key = 'media/titles/class-01/source.mp4';
  assert.throws(() => signUpload(config, { op: 'parts', key, uploadId: 'u', partNumbers: [] }), /between 1 and/);
  assert.throws(
    () => signUpload(config, { op: 'parts', key, uploadId: 'u', partNumbers: [0] }),
    /whole numbers/,
  );
  assert.throws(
    () => signUpload(config, { op: 'parts', key, uploadId: 'u', partNumbers: [99999] }),
    /whole numbers/,
  );
});

test('complete and abort sign the matching S3 verbs', () => {
  const key = 'media/titles/class-01/source.mp4';
  const complete = signUpload(config, { op: 'complete', key, uploadId: 'U' });
  const abort = signUpload(config, { op: 'abort', key, uploadId: 'U' });

  assert.ok(complete.url.includes('uploadId=U'));
  assert.ok(abort.url.includes('uploadId=U'));
  // Different verbs sign differently, so the two URLs cannot be interchangeable.
  assert.notEqual(complete.url, abort.url);
});

test('a deployment without storage says so instead of signing nothing', () => {
  // The dev server is exactly this case: structure editing works against a
  // local file, and uploading has nowhere to put the bytes.
  assert.throws(
    () => signUpload({}, { op: 'begin', titleId: 'x', filename: 'v.mp4' }),
    /needs object storage/,
  );
});

// ------------------------------------------------------- catalog writing --

function fakeS3({ current, putStatus = 200 }) {
  const puts = [];
  const fetchImpl = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'PUT') {
      puts.push(JSON.parse(init.body));
      return { ok: putStatus === 200, status: putStatus, text: async () => '' };
    }
    if (current === null) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(current) };
  };
  return { fetchImpl, puts };
}

test('an empty library reads as an empty catalog, not an error', async () => {
  const { fetchImpl } = fakeS3({ current: null });

  const catalog = await readCatalog(config, { fetchImpl });

  assert.equal(catalog.revision, 0);
  assert.deepEqual(catalog.collections, []);
});

test('a stored version 1 catalog is migrated on read', async () => {
  const { fetchImpl } = fakeS3({
    current: { version: 1, genres: [{ id: 'cinema', name: 'Cinema' }], titles: [] },
  });

  const catalog = await readCatalog(config, { fetchImpl });

  assert.equal(catalog.version, 2);
  assert.equal(catalog.collections[0].id, 'cinema');
});

test('a write bumps the revision and stamps the time', async () => {
  const { fetchImpl, puts } = fakeS3({ current: catalogWith({ revision: 4 }) });

  const saved = await writeCatalog(
    config,
    { catalog: catalogWith(), baseRevision: 4 },
    { fetchImpl },
  );

  assert.equal(saved.revision, 5);
  assert.equal(puts[0].revision, 5);
  assert.ok(Date.parse(saved.updatedAt) > 0);
});

test('a concurrent edit is refused rather than silently overwritten', async () => {
  const { fetchImpl, puts } = fakeS3({ current: catalogWith({ revision: 7 }) });

  await assert.rejects(
    () => writeCatalog(config, { catalog: catalogWith(), baseRevision: 4 }, { fetchImpl }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.extra.revision, 7);
      return true;
    },
  );
  assert.equal(puts.length, 0, 'nothing should have been written');
});

test('an invalid catalog is refused before S3 is touched', async () => {
  const broken = catalogWith();
  broken.titles[0].collectionId = 'nowhere';
  const { fetchImpl, puts } = fakeS3({ current: catalogWith() });

  await assert.rejects(
    () => writeCatalog(config, { catalog: broken, baseRevision: 1 }, { fetchImpl }),
    (error) => {
      assert.equal(error.status, 422);
      assert.ok(error.extra.errors.length > 0);
      return true;
    },
  );
  assert.equal(puts.length, 0);
});
