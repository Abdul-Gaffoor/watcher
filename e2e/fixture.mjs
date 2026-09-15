/**
 * Builds the throwaway assets the smoke test plays: a real VP8/WebM clip
 * recorded straight out of Chromium, plus a catalog that points one title at
 * it. Nothing here touches content/catalog.json.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const FIXTURE_TITLE_ID = 'night-shift';
const FIXTURE_DIR_NAME = '_e2e';

/** Records an 8-second canvas animation as WebM using the browser itself. */
export async function recordClip(browser, outputPath) {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(25), { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.start();

    const startedAt = performance.now();
    await new Promise((done) => {
      const draw = () => {
        const elapsed = (performance.now() - startedAt) / 1000;
        ctx.fillStyle = '#12203a';
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#4f8cff';
        ctx.fillRect(((elapsed / 8) * 640) % 640, 0, 24, 360);
        if (elapsed >= 8) return done();
        requestAnimationFrame(draw);
      };
      draw();
    });

    recorder.stop();
    const blob = await new Promise((done) => {
      recorder.onstop = () => done(new Blob(chunks, { type: 'video/webm' }));
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  await page.close();
  await writeFile(outputPath, Buffer.from(base64, 'base64'));
}

/**
 * Writes the clip under content/media/<FIXTURE_DIR_NAME>/ (gitignored) and
 * returns the path of a catalog that points FIXTURE_TITLE_ID at it.
 */
export async function buildFixtures(browser, repoRoot, scratchDir) {
  const mediaDir = resolve(repoRoot, 'content/media', FIXTURE_DIR_NAME);
  await mkdir(mediaDir, { recursive: true });
  await mkdir(scratchDir, { recursive: true });

  await recordClip(browser, resolve(mediaDir, 'clip.webm'));

  const catalog = JSON.parse(await readFile(resolve(repoRoot, 'content/catalog.json'), 'utf8'));
  const title = catalog.titles.find((entry) => entry.id === FIXTURE_TITLE_ID);
  if (!title) throw new Error(`Fixture title "${FIXTURE_TITLE_ID}" is missing from the catalog`);
  title.sources = { mp4: `/media/${FIXTURE_DIR_NAME}/clip.webm` };

  const catalogPath = resolve(scratchDir, 'catalog.e2e.json');
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2));
  return catalogPath;
}
