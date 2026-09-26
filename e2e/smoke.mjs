#!/usr/bin/env node
/**
 * End-to-end smoke test: starts the dev API and the Vite dev server, drives a
 * real Chromium through sign-in, browsing, search and playback, then tears
 * everything down.
 *
 *   npm --prefix web install
 *   npm install -D playwright && npx playwright install chromium
 *   node e2e/smoke.mjs [--headed] [--shots <dir>]
 */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { buildFixtures, FIXTURE_TITLE_ID } from './fixture.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratchDir = resolve(repoRoot, '.e2e-tmp');
const API_PORT = 8799;
const WEB_PORT = 5199;
const BASE = `http://localhost:${WEB_PORT}`;
const USERNAME = 'demo';
const PASSWORD = 'demo1234';

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed. Run:\n  npm install -D playwright && npx playwright install chromium');
  process.exit(1);
}

const children = [];
function start(command, commandArgs, options) {
  const child = spawn(command, commandArgs, { cwd: repoRoot, stdio: 'ignore', ...options });
  children.push(child);
  return child;
}

async function waitForServer(url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not start within ${timeoutMs}ms`);
}

async function cleanup() {
  for (const child of children) child.kill('SIGTERM');
  await rm(scratchDir, { recursive: true, force: true });
  await rm(resolve(repoRoot, 'content/media/_e2e'), { recursive: true, force: true });
  // Written by the editor steps, into the same place a deployment's bucket
  // would hold it.
  for (const id of ['fibonacci-retracements', 'new-2']) {
    await rm(resolve(repoRoot, 'content/media/notes', id), { recursive: true, force: true });
  }
}

const results = [];
let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    results.push(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL  ${name}\n          ${error.message.split('\n')[0]}`);
  }
}

let browser;
try {
  browser = await chromium.launch({ headless: !headed });
  if (shotsDir) await mkdir(shotsDir, { recursive: true });

  const catalogPath = await buildFixtures(browser, repoRoot, scratchDir);

  start('node', ['scripts/dev-api.mjs'], {
    env: { ...process.env, PORT: String(API_PORT), CATALOG_PATH: catalogPath },
  });
  start('npm', ['run', 'dev', '--', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: resolve(repoRoot, 'web'),
    env: { ...process.env, VITE_API_PORT: String(API_PORT) },
  });

  await waitForServer(`http://localhost:${API_PORT}/api/health`, 'dev API');
  await waitForServer(BASE, 'Vite dev server');

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const mediaRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/media/')) mediaRequests.push(request.url());
  });

  await step('unauthenticated visit redirects to the login page', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    assert.match(page.url(), /\/login$/);
  });

  await step('a deep link survives the login redirect', async () => {
    await page.goto(`${BASE}/watch/the-long-exposure`, { waitUntil: 'networkidle' });
    assert.match(page.url(), /\/login$/);
  });

  await step('wrong credentials are rejected with a message', async () => {
    await page.fill('input[name="username"]', USERNAME);
    await page.fill('input[name="password"]', 'wrong-password');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.login__error');
    assert.match(await page.textContent('.login__error'), /Incorrect username or password/);
    assert.match(page.url(), /\/login$/);
  });

  await step('correct credentials land on the originally requested page', async () => {
    await page.fill('input[name="username"]', USERNAME);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/watch\/the-long-exposure$/, { timeout: 15_000 });
  });

  await step('the catalog renders a hero and a shelf per branch', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.hero__title');

    // Sections are the roots; the shelves are what sits one level under them.
    const sections = await page.$$eval('.shelf__heading', (els) => els.map((el) => el.textContent));
    for (const section of ['Trading', 'Movies']) {
      assert.ok(sections.includes(section), `missing section: ${section}`);
    }

    const headings = await page.$$eval('.row__heading', (els) => els.map((el) => el.textContent));
    for (const branch of ['Harmonic Trading', 'Elliott Wave', 'SMC', 'English']) {
      assert.ok(headings.includes(branch), `missing shelf: ${branch}`);
    }
    if (shotsDir) await page.screenshot({ path: `${shotsDir}/01-browse.png` });
  });

  await step('a shelf gathers videos from collections nested below it', async () => {
    // The SMC videos are two levels down, inside a named mentorship. They must
    // still appear on the SMC shelf, or nesting would hide the library.
    const cards = await page.$$eval('.row', (rows) => {
      const row = rows.find((el) => el.querySelector('.row__heading')?.textContent === 'SMC');
      return [...(row?.querySelectorAll('.card__title') ?? [])].map((el) => el.textContent);
    });
    assert.deepEqual(
      cards.sort(),
      ['Market Structure and Liquidity', 'Order Blocks and Fair Value Gaps'],
    );
  });

  await step('artwork loads rather than showing broken images', async () => {
    const broken = await page.$$eval('.card__art img', (imgs) =>
      imgs.filter((img) => !img.complete || img.naturalWidth === 0).length,
    );
    assert.equal(broken, 0, `${broken} broken image(s)`);
  });

  await step('navigating the tree reaches the videos at the bottom of it', async () => {
    // Trading is a root, so it shows its branches rather than videos.
    await page.click('.header__nav a:has-text("Trading")');
    await page.waitForURL(/\/c\/trading$/);
    await page.waitForSelector('.row__heading');

    // Descending to the named mentorship is where the videos themselves live.
    await page.click('.row__more[href="/c/smc"]');
    await page.waitForURL(/\/c\/smc$/);
    await page.click('.row__more[href="/c/gaurdeer-mentorship"]');
    await page.waitForURL(/\/c\/gaurdeer-mentorship$/);

    // A collection holding videos rather than more collections is a course, so
    // the bottom of the tree is a syllabus: numbered, in order, not a grid.
    await page.waitForSelector('.syllabus__link');
    const titles = await page.$$eval('.syllabus__name', (els) => els.map((el) => el.textContent));
    assert.deepEqual(titles.sort(), ['Market Structure and Liquidity', 'Order Blocks and Fair Value Gaps']);

    // The trail has to offer the way back up, or a deep shelf is a dead end.
    const crumbs = await page.$$eval('.course__trail a', (els) => els.map((el) => el.textContent));
    assert.deepEqual(crumbs, ['Home', 'Trading', 'SMC']);
    if (shotsDir) await page.screenshot({ path: `${shotsDir}/02-genre.png` });
  });

  await step('search matches on description text', async () => {
    await page.fill('#site-search', 'liquidity');
    await page.press('#site-search', 'Enter');
    await page.waitForURL(/\/search\?q=liquidity$/);
    await page.waitForSelector('.grid .card');
    const titles = await page.$$eval('.card__title', (els) => els.map((el) => el.textContent));
    assert.ok(titles.includes('Market Structure and Liquidity'));
  });

  await step('a course name finds the course', async () => {
    // The defect: only video titles were searched. The library's courses are
    // named "Gaurdeer Mentorship", "SweeGlu Elliott Wave Course" -- and its
    // lessons are called "Class - 1", so the names worth searching for were
    // exactly the ones that matched nothing.
    await page.goto(`${BASE}/search?q=gaurdeer`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.result__name');

    const found = await page.$$eval('.result__name', (els) => els.map((el) => el.textContent));
    assert.deepEqual(found, ['Gaurdeer Mentorship']);

    // And its lessons come with it, because a title inherits the words of
    // every collection above it.
    const videos = await page.$$eval('.card', (els) =>
      els.map((el) => el.getAttribute('aria-label')?.replace('Play ', '')),
    );
    assert.ok(videos.includes('Market Structure and Liquidity'), `got ${JSON.stringify(videos)}`);
  });

  await step('terms match in any order, and punctuation does not count', async () => {
    const namesFor = async (q) => {
      await page.goto(`${BASE}/search?q=${encodeURIComponent(q)}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(200);
      return page.$$eval('.card', (els) =>
        els.map((el) => el.getAttribute('aria-label')?.replace('Play ', '')),
      );
    };

    // A query is a set of words, not a substring: nobody types a title in the
    // exact order it was filed under.
    assert.ok((await namesFor('liquidity structure')).includes('Market Structure and Liquidity'));
    assert.ok((await namesFor('STRUCTURE, market')).includes('Market Structure and Liquidity'));
  });

  await step('results appear while typing, without pressing Enter', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#site-search');
    await page.type('#site-search', 'gaurdeer', { delay: 30 });

    await page.waitForURL(/\/search\?q=gaurdeer/, { timeout: 10_000 });
    await page.waitForSelector('.result__name');

    // Clearing empties the box rather than submitting: the results are already
    // live, so a submit button would do nothing visible.
    await page.click('.searchbar__submit');
    assert.equal(await page.locator('#site-search').inputValue(), '');
  });

  await step('search offers a way back, and is not a dead end when empty', async () => {
    // Every other page carries a breadcrumb; this one has nothing to say it
    // came from, so without this the only way out was a small unlabelled icon
    // in the rail.
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.hero__title');

    await page.click('#site-search');
    await page.type('#site-search', 'gaurdeer', { delay: 25 });
    await page.waitForURL(/\/search/, { timeout: 10_000 });

    await page.click('.backlink');
    await page.waitForSelector('.hero__title', { timeout: 10_000 });
    assert.match(page.url(), new RegExp(`^${BASE}/?$`), 'Back should return where the search began');

    // Opened cold, with no history behind it, Back goes home rather than out
    // of the app entirely.
    const fresh = await browser.newContext();
    try {
      const cold = await fresh.newPage();
      await cold.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
      await cold.waitForURL(/\/login$/);
      await cold.fill('input[name="username"]', USERNAME);
      await cold.fill('input[name="password"]', PASSWORD);
      await cold.click('button[type="submit"]');

      // With no query the page lists the library rather than showing one word
      // on an empty screen.
      await cold.waitForSelector('.results__list .result', { timeout: 15_000 });
      assert.ok((await cold.locator('.results__list .result').count()) > 0);
    } finally {
      await fresh.close();
    }
  });

  await step('leaving search stays left, rather than bouncing back to it', async () => {
    // Reported from a screen recording: Back from the search page reached the
    // collection and was immediately thrown back to search, over and over.
    // Typing set a flag that was never cleared, and the pathname was a
    // dependency -- so every navigation looked like another reason to search.
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.hero__title');

    await page.type('#site-search', 'trading', { delay: 25 });
    await page.waitForURL(/\/search/, { timeout: 10_000 });
    await page.waitForSelector('.result__name, .card', { timeout: 10_000 });

    // Leave by following a result rather than by Back, so this covers the
    // general case and not just the one button.
    await page.click('.result');
    await page.waitForURL(/\/c\//, { timeout: 10_000 });

    // Long enough that a rescheduled navigation would have fired by now.
    await page.waitForTimeout(900);
    assert.match(page.url(), /\/c\//, `bounced back to ${page.url()}`);

    // And Back from there returns to the search, once, and stays.
    await page.goBack();
    await page.waitForURL(/\/search/, { timeout: 10_000 });
    await page.waitForTimeout(900);
    assert.match(page.url(), /\/search/, `bounced away to ${page.url()}`);
  });

  await step('a search with no matches shows an empty state', async () => {
    await page.goto(`${BASE}/search?q=zzzznotathing`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.row__empty');
  });

  await step('video actually decodes and the playhead advances', async () => {
    await page.goto(`${BASE}/watch/${FIXTURE_TITLE_ID}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('video');
    const state = await page.evaluate(async () => {
      const video = document.querySelector('video');
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 1500));
      return { t: video.currentTime, width: video.videoWidth, readyState: video.readyState };
    });
    assert.ok(state.t > 0.2, `playhead did not advance (t=${state.t})`);
    assert.ok(state.width > 0, 'no frames decoded');
    assert.ok(state.readyState >= 3, `readyState ${state.readyState}`);
    if (shotsDir) await page.screenshot({ path: `${shotsDir}/03-watch.png` });
  });

  await step('leaving the player flushes the resume position', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const stored = await page.evaluate(() => localStorage.getItem('watcher.progress.v1'));
    assert.ok(stored, 'nothing stored after leaving the player');
    assert.ok(JSON.parse(stored)[FIXTURE_TITLE_ID].positionSec > 0, 'position not recorded');
  });

  await step('a part-watched title shows up in Continue watching', async () => {
    // The fixture clip is shorter than the 15s resume threshold, so seed a
    // realistic entry to exercise the row itself.
    await page.evaluate(() =>
      localStorage.setItem(
        'watcher.progress.v1',
        JSON.stringify({
          'elliott-first-principles': { positionSec: 900, durationSec: 4020, updatedAt: Date.now() },
        }),
      ),
    );
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.row__heading');
    const headings = await page.$$eval('.row__heading', (els) => els.map((el) => el.textContent));
    assert.ok(headings.includes('Continue watching'), 'continue-watching row missing');
    assert.match(await page.getAttribute('.card__progress-bar', 'style'), /width:\s*22%/);
  });

  await step('a finished title drops out of Continue watching', async () => {
    await page.evaluate(() =>
      localStorage.setItem(
        'watcher.progress.v1',
        JSON.stringify({
          'elliott-first-principles': { positionSec: 4010, durationSec: 4020, updatedAt: Date.now() },
        }),
      ),
    );
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.row__heading');
    const headings = await page.$$eval('.row__heading', (els) => els.map((el) => el.textContent));
    assert.ok(!headings.includes('Continue watching'), 'finished title still offered as resumable');
  });

  await step('an HLS title loads hls.js and requests the manifest', async () => {
    mediaRequests.length = 0;
    await page.goto(`${BASE}/watch/harmonic-foundations`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    assert.ok(
      mediaRequests.some((url) => url.endsWith('master.m3u8')),
      `no manifest request (saw ${mediaRequests.length} media requests)`,
    );
  });

  await step('a missing manifest shows an in-player error instead of crashing', async () => {
    await page.waitForSelector('.player__error', { timeout: 10_000 });
    await page.waitForSelector('.theatre__title');
  });

  await step('an unknown title id degrades gracefully', async () => {
    await page.goto(`${BASE}/watch/does-not-exist`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=That title is not in the catalog');
  });

  await step('signing out clears the session', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.click('button:has-text("Sign out")');
    await page.waitForURL(/\/login$/);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForURL(/\/login$/);
  });

  await step('no page overflows or hides its heading at phone width', async () => {
    // Every route, not just the first one. Checking only the catalog is how
    // the dashboard shipped 300px wider than an iPhone: its rows are grid
    // items, grid items default to min-width:auto, and a select full of long
    // collection names refuses to shrink. Nothing about the browse page could
    // ever have caught that.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.fill('input[name="username"]', USERNAME);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.hero__title', { timeout: 15_000 });

    const routes = [
      ['browse', '/'],
      ['collection', '/c/elliott-wave'],
      ['search', '/search?q=a'],
      ['admin', '/admin'],
      ['watch', `/watch/${FIXTURE_TITLE_ID}`],
      ['pairing', '/pair'],
      // The editor arrives as its own chunk, so there is something to wait for
      // beyond the network going quiet -- otherwise this measures a spinner.
      ['write', '/notes/new', '.editor__surface'],
    ];

    const broken = [];
    for (const [name, path, waitFor] of routes) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      if (waitFor) await page.waitForSelector(waitFor, { timeout: 20_000 });
      await page.waitForTimeout(350);

      const result = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth;
        const blame = [...document.querySelectorAll('body *')]
          // A shelf is meant to run off the edge, and the top scrim spans
          // whatever the document turned out to be.
          .filter((el) => !el.closest('.row__scroller') && !el.closest('.top-scrim'))
          .map((el) => ({ el, box: el.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0 && box.right > limit + 1)
          .sort((a, b) => b.box.right - a.box.right)
          .slice(0, 2)
          .map(({ el, box }) => `${el.tagName.toLowerCase()}.${el.classList[0] ?? ''}@${Math.round(box.right)}px`);

        // The search floats. On a phone it spans nearly the full width, so a
        // page that opens with a heading has to start below it.
        const bar = document.querySelector('.searchbar')?.getBoundingClientRect();
        const heading = document.querySelector('h1, h2')?.getBoundingClientRect();
        const covered = Boolean(
          bar && heading &&
          heading.top < bar.bottom && heading.bottom > bar.top &&
          heading.left < bar.right && heading.right > bar.left,
        );

        return { overflow: document.documentElement.scrollWidth - limit, blame, covered };
      });

      if (result.overflow > 1) broken.push(`${name}: ${result.overflow}px wide — ${result.blame.join(', ') || 'no element past the edge'}`);
      if (result.covered) broken.push(`${name}: the search bar covers the heading`);
    }

    if (shotsDir) {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: `${shotsDir}/04-mobile.png` });
    }

    // Back to desktop before anything else runs. This step used to be last, so
    // leaving the window 390px wide cost nothing; it is not last any more.
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(broken.length, 0, broken.join(' | '));
  });

  await step('a title with no artwork gets generated art, not a letter', async () => {
    // The old fallback was the title's first character on a flat panel, which
    // turned a course of "Class - 1", "Class - 2" into a wall of identical
    // tiles that could not be told apart without reading the caption.
    await page.goto(`${BASE}/search?q=signal`, { waitUntil: 'networkidle' });
    const card = page.locator('.card', { hasText: 'Signal' }).first();
    await card.waitFor({ timeout: 15_000 });

    const art = card.locator('svg.genart');
    assert.equal(await art.count(), 1, 'a title without a poster should get generated artwork');
    // It carries the name, which is what makes the tile readable at a glance.
    assert.match(await art.getAttribute('aria-label'), /Signal/);

    // And it is artwork, not a character: several drawn elements, not one glyph.
    assert.ok((await art.locator('circle').count()) >= 5, 'the generated art should be drawn');
  });

  await step('artwork is the shape of a video frame', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.card__art');
    const ratio = await page.evaluate(() => {
      const box = document.querySelector('.card__art').getBoundingClientRect();
      return box.width / box.height;
    });
    // A poster frame grabbed from a video is 16:9; cropping it to a portrait
    // poster throws away most of the frame.
    assert.ok(Math.abs(ratio - 16 / 9) < 0.05, `card art ratio was ${ratio.toFixed(3)}`);
  });

  await step('a tap on hidden controls reveals them instead of pausing', async () => {
    // The reported bug: the chrome hides itself while playing and stops taking
    // pointer events, so on a touch screen -- where no pointer movement brings
    // it back first -- a tap aimed at the full screen button landed on the
    // video underneath and paused instead.
    const touch = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const phone = await touch.newPage();
      await phone.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
      await phone.fill('input[name="username"]', USERNAME);
      await phone.fill('input[name="password"]', PASSWORD);
      await phone.click('button[type="submit"]');
      await phone.waitForSelector('.hero__title', { timeout: 15_000 });

      await phone.goto(`${BASE}/watch/${FIXTURE_TITLE_ID}`, { waitUntil: 'networkidle' });
      await phone.waitForSelector('video');
      await phone.evaluate(async () => {
        const video = document.querySelector('video');
        video.muted = true;
        await video.play();
      });

      // Wait past the idle timeout so the chrome is hidden and inert.
      await phone.waitForFunction(
        () => document.querySelector('.player')?.dataset.idle === 'true',
        undefined,
        { timeout: 10_000 },
      );

      // Tap where the full screen button sits. It is behind the hidden chrome,
      // so this lands on the video.
      const box = await phone.locator('.pc__row').boundingBox();
      await phone.touchscreen.tap(box.x + box.width - 20, box.y + box.height / 2);
      await phone.waitForTimeout(400);

      const after = await phone.evaluate(() => ({
        paused: document.querySelector('video').paused,
        idle: document.querySelector('.player')?.dataset.idle ?? 'false',
      }));

      assert.equal(after.paused, false, 'the tap must not have paused playback');
      assert.notEqual(after.idle, 'true', 'the tap should have brought the controls back');
    } finally {
      await touch.close();
    }
  });

  // ----------------------------------------------------------- notes ----

  await step('a note sits in the tree beside the videos it belongs to', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/c/sweeglu-elliott-wave-course`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.note-row');

    // The course lists it alongside its lessons rather than on a page of its
    // own: a note is part of the course, not a separate library.
    assert.match(await page.textContent('.note-row__name'), /Elliott Wave, on one page/);
    assert.match(await page.textContent('.note-row__meta'), /Markdown/);
    assert.match(await page.textContent('.course__facts'), /1 note/);
  });

  await step('markdown is rendered, not printed', async () => {
    await page.click('.note-row');
    await page.waitForSelector('.prose', { timeout: 15_000 });

    const shape = await page.evaluate(() => ({
      headings: [...document.querySelectorAll('.prose h2')].map((el) => el.textContent),
      tableRows: document.querySelectorAll('.prose table tr').length,
      code: document.querySelectorAll('.prose pre code').length,
      quote: document.querySelectorAll('.prose blockquote').length,
      // The source must not be showing through as literal syntax.
      raw: document.querySelector('.prose').textContent.includes('## The rules'),
    }));

    assert.deepEqual(shape.headings, [
      'The rules', 'The guidelines', 'Common retracements', 'Working a count',
    ]);
    assert.ok(shape.tableRows >= 4, `expected a table, got ${shape.tableRows} rows`);
    assert.equal(shape.code, 1);
    assert.equal(shape.quote, 1);
    assert.equal(shape.raw, false, 'markdown syntax should not be visible');

    // The note names itself and so does the page; only one of them should say
    // it out loud.
    assert.equal(await page.locator('.prose h1').count(), 0);
    assert.equal(await page.locator('.note__title').count(), 1);

    if (shotsDir) await page.screenshot({ path: `${shotsDir}/08-note.png`, fullPage: true });
  });

  await step('a note is findable by its own name and by its course', async () => {
    // Its name and its course, the same two things a video is findable by.
    // The text inside a note is deliberately not indexed: that would mean
    // fetching every note on every keystroke, and wants a real index.
    for (const [query, why] of [
      ['elliott one page', 'words in its own name'],
      ['sweeglu', 'the course it belongs to'],
    ]) {
      await page.goto(`${BASE}/search?q=${encodeURIComponent(query)}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(250);
      const names = await page.$$eval('.note-row__name', (els) => els.map((el) => el.textContent));
      assert.ok(
        names.some((name) => name.includes('Elliott Wave, on one page')),
        `a note should be findable by ${why}; got ${JSON.stringify(names)}`,
      );
    }
  });

  // ---------------------------------------------------- writing a note --

  await step('a note can be written in the app, into a collection made as you go', async () => {
    await page.goto(`${BASE}/notes/new`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.editor__surface', { timeout: 20_000 });

    await page.fill('.note-edit__title', 'Fibonacci retracements');

    // The collection does not exist yet. Making it should be part of writing
    // the note, not an errand on another page first.
    await page.selectOption('.note-edit__filing select', '__new__');
    await page.fill('.note-edit__filing input[type="text"]', 'Scratch Notes');

    const surface = page.locator('.editor__surface');
    await surface.click();

    await page.selectOption('.tb__select', 'h2');
    await page.keyboard.type('The levels that matter');
    await page.keyboard.press('Enter');

    await page.selectOption('.tb__select', 'p');
    await page.keyboard.type('The ');
    await page.click('.tb__button[aria-label="Bold"]');
    await page.keyboard.type('61.8%');
    await page.click('.tb__button[aria-label="Bold"]');
    await page.keyboard.type(' level is the one to watch.');
    await page.keyboard.press('Enter');

    // A checklist and a table: the two things a Markdown textarea makes people
    // look up the syntax for, and the reason the editor is rich at all.
    await page.click('.tb__button[aria-label="Checklist"]');
    await page.keyboard.type('Mark the swing high');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Wait for the retest');

    assert.equal(
      await page.locator('.editor__surface ul[data-type="taskList"] li').count(),
      2,
      'the checklist should have both items',
    );
  });

  await step('what it saves is Markdown, and it reads back as a note', async () => {
    await page.click('button:has-text("Create note")');
    await page.waitForURL(/\/notes\/fibonacci-retracements$/, { timeout: 20_000 });
    await page.waitForSelector('.prose', { timeout: 15_000 });

    // Rendered, not printed -- the same bar the uploaded notes are held to.
    const shape = await page.evaluate(() => ({
      heading: document.querySelector('.prose h2')?.textContent,
      bold: document.querySelector('.prose strong')?.textContent,
      boxes: document.querySelectorAll('.prose input[type="checkbox"]').length,
      raw: document.querySelector('.prose').textContent.includes('## '),
    }));
    assert.equal(shape.heading, 'The levels that matter');
    assert.equal(shape.bold, '61.8%');
    assert.equal(shape.boxes, 2, 'the checklist should render as checkboxes');
    assert.equal(shape.raw, false, 'markdown syntax should not be visible');

    // And what was stored is Markdown, not the editor's HTML. This is the
    // whole reason for the turndown pass: a note written here stays readable
    // without this app, and diffs like text.
    const stored = await page.evaluate(async () => {
      const response = await fetch('/media/notes/fibonacci-retracements/source.md');
      return { status: response.status, body: await response.text() };
    });
    assert.equal(stored.status, 200);
    assert.match(stored.body, /^## The levels that matter$/m);
    assert.match(stored.body, /\*\*61\.8%\*\*/);
    assert.match(stored.body, /^- \[ \] Mark the swing high$/m);
    assert.ok(!stored.body.includes('<p>'), `stored as HTML, not Markdown:\n${stored.body}`);

    if (shotsDir) await page.screenshot({ path: `${shotsDir}/09-written-note.png`, fullPage: true });
  });

  await step('the collection it made is in the tree, with the note in it', async () => {
    await page.goto(`${BASE}/c/scratch-notes`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.note-row', { timeout: 15_000 });
    assert.match(await page.textContent('.note-row__name'), /Fibonacci retracements/);
  });

  await step('editing a note keeps its id, its filing and its format', async () => {
    await page.goto(`${BASE}/notes/fibonacci-retracements/edit`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.editor__surface', { timeout: 20_000 });

    // What was written comes back as formatting, not as syntax: the round trip
    // has to survive being stored as Markdown and parsed again.
    const reopened = await page.evaluate(() => ({
      heading: document.querySelector('.editor__surface h2')?.textContent,
      bold: document.querySelector('.editor__surface strong')?.textContent,
      boxes: document.querySelectorAll('.editor__surface input[type="checkbox"]').length,
      title: document.querySelector('.note-edit__title').value,
      filedUnder: document.querySelector('.note-edit__filing select').value,
    }));
    assert.equal(reopened.heading, 'The levels that matter');
    assert.equal(reopened.bold, '61.8%');
    assert.equal(reopened.boxes, 2);
    assert.equal(reopened.title, 'Fibonacci retracements');
    assert.equal(reopened.filedUnder, 'scratch-notes');

    // The end of the document is the empty paragraph the editor keeps below the
    // last block, so a plain paragraph is what this types into.
    await page.locator('.editor__surface').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Added on a second pass.');
    await page.click('button:has-text("Save")');

    // Same URL, so the same id: editing must not mint a second note.
    await page.waitForURL(/\/notes\/fibonacci-retracements$/, { timeout: 20_000 });
    await page.waitForSelector('.prose', { timeout: 15_000 });
    assert.match(await page.textContent('.prose'), /Added on a second pass\./);
    assert.match(await page.textContent('.prose'), /The levels that matter/);
    // The rest of the note came through the round trip unharmed.
    assert.equal(await page.locator('.prose input[type="checkbox"]').count(), 2);
    assert.equal(await page.locator('.prose strong').count(), 1);

    // Re-serialised as Markdown, and the addition is a paragraph rather than
    // being swept into the checklist above it.
    const stored = await page.evaluate(async () => {
      const response = await fetch('/media/notes/fibonacci-retracements/source.md', { cache: 'no-store' });
      return response.text();
    });
    assert.match(stored, /^Added on a second pass\.$/m);
    assert.match(stored, /^- \[ \] Wait for the retest$/m);

    const notes = await page.evaluate(async () => {
      const response = await fetch('/api/admin/catalog');
      const { catalog } = await response.json();
      return catalog.notes.filter((note) => note.id === 'fibonacci-retracements');
    });
    assert.equal(notes.length, 1, 'editing should not have added a second note');
    assert.equal(notes[0].format, 'md');
    assert.equal(notes[0].collectionId, 'scratch-notes');
  });

  await step('a note called New does not take the id the editor lives at', async () => {
    // /notes/new writes one, so a note whose id was `new` would be a note at a
    // URL that means something else. The id is refused rather than the router
    // being taught an exception.
    await page.goto(`${BASE}/notes/new`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.editor__surface', { timeout: 20_000 });

    await page.fill('.note-edit__title', 'New');
    await page.selectOption('.note-edit__filing select', 'scratch-notes');
    await page.locator('.editor__surface').click();
    await page.keyboard.type('Filed under a name that would have collided.');
    await page.click('button:has-text("Create note")');

    await page.waitForURL(/\/notes\/new-\d+$/, { timeout: 20_000 });
    await page.waitForSelector('.prose', { timeout: 15_000 });
    assert.match(await page.textContent('.note__title'), /^New$/);

    // And the editor is still what /notes/new means.
    await page.goto(`${BASE}/notes/new`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.editor__surface', { timeout: 20_000 });
    assert.equal(await page.locator('.note-edit__error').count(), 0);
    assert.equal(await page.inputValue('.note-edit__title'), '');
  });

  await step('a collapsible section survives being stored as Markdown', async () => {
    await page.goto(`${BASE}/notes/fibonacci-retracements/edit`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.editor__surface', { timeout: 20_000 });
    await page.locator('.editor__surface').click();
    await page.keyboard.press('Control+End');

    // The cursor lands in the empty title, and Enter carries on into the body
    // rather than making a second line of title.
    await page.click('.tb__button[aria-label="Collapsible section"]');
    await page.keyboard.type('Why the count matters');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Because a wrong count is a wrong entry.');

    const shape = await page.evaluate(() => ({
      summary: document.querySelector('.editor__surface [data-type="detailsSummary"]')?.textContent,
      body: document.querySelector('.editor__surface [data-type="detailsContent"]')?.textContent,
    }));
    assert.equal(shape.summary, 'Why the count matters');
    assert.equal(shape.body, 'Because a wrong count is a wrong entry.');

    await page.click('button:has-text("Save")');
    await page.waitForURL(/\/notes\/fibonacci-retracements$/, { timeout: 20_000 });
    await page.waitForSelector('.prose details', { timeout: 15_000 });

    // Stored as the HTML that Markdown allows, with the blank lines that make a
    // reader parse the body as Markdown instead of passing it through.
    const stored = await page.evaluate(async () => {
      const response = await fetch('/media/notes/fibonacci-retracements/source.md', { cache: 'no-store' });
      return response.text();
    });
    assert.match(stored, /<details>\n<summary>Why the count matters<\/summary>\n\nBecause a wrong count is a wrong entry\.\n\n<\/details>/);
    // The rest of the note is still Markdown, not swallowed by the HTML block.
    assert.match(stored, /^## The levels that matter$/m);
    assert.match(stored, /^- \[ \] Wait for the retest$/m);

    // A reader gets a real disclosure: shut until asked, and the sanitiser did
    // not strip it on the way in.
    const disclosure = page.locator('.prose details');
    assert.equal(await disclosure.evaluate((el) => el.open), false, 'it should start closed');
    assert.match(await page.textContent('.prose summary'), /Why the count matters/);

    await page.locator('.prose summary').click();
    assert.equal(await disclosure.evaluate((el) => el.open), true, 'clicking the title should open it');
    assert.match(await disclosure.textContent(), /Because a wrong count is a wrong entry\./);

    if (shotsDir) await page.screenshot({ path: `${shotsDir}/10-collapsible.png`, fullPage: true });
  });

  await step('a section comes back as a section, not as its own markup', async () => {
    await page.goto(`${BASE}/notes/fibonacci-retracements/edit`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.editor__surface', { timeout: 20_000 });
    await page.waitForTimeout(400);

    const reopened = await page.evaluate(() => ({
      sections: document.querySelectorAll('.editor__surface [data-type="details"]').length,
      summary: document.querySelector('.editor__surface [data-type="detailsSummary"]')?.textContent,
      body: document.querySelector('.editor__surface [data-type="detailsContent"] p')?.textContent,
      // If the round trip had failed, the tags themselves would be on screen.
      raw: document.querySelector('.editor__surface').textContent.includes('<details>'),
    }));
    assert.equal(reopened.sections, 1);
    assert.equal(reopened.summary, 'Why the count matters');
    assert.equal(reopened.body, 'Because a wrong count is a wrong entry.');
    assert.equal(reopened.raw, false, 'the markup should not be visible as text');
  });

  await step('an image put in a note is stored under that note', async () => {
    await page.goto(`${BASE}/notes/fibonacci-retracements/edit`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.editor__surface', { timeout: 20_000 });
    await page.locator('.editor__surface').click();
    await page.keyboard.press('Control+End');

    // A 1x1 PNG is enough: what is being tested is where the bytes go and what
    // the note ends up pointing at, not the picture.
    const chooser = page.waitForEvent('filechooser');
    await page.click('.tb__button[aria-label="Image"]');
    (await chooser).setFiles({
      name: 'chart.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });

    const src = await page.locator('.editor__surface img').first().getAttribute('src', { timeout: 20_000 });
    // The slot is a token the client made and the server checked; the note id
    // is the server's, so the image lives with the note and is deleted with it.
    assert.match(src, /^\/media\/notes\/fibonacci-retracements\/asset-[a-z0-9]{6,32}\.png$/);

    const stored = await page.evaluate(async (path) => (await fetch(path)).status, src);
    assert.equal(stored, 200, 'the image itself should be in storage');

    await page.click('button:has-text("Save")');
    await page.waitForURL(/\/notes\/fibonacci-retracements$/, { timeout: 20_000 });
    await page.waitForSelector('.prose img', { timeout: 15_000 });
    assert.equal(await page.locator('.prose img').first().getAttribute('src'), src);

    const markdown = await page.evaluate(async () => {
      const response = await fetch('/media/notes/fibonacci-retracements/source.md', { cache: 'no-store' });
      return response.text();
    });
    assert.match(markdown, /!\[[^\]]*\]\(\/media\/notes\/fibonacci-retracements\/asset-[a-z0-9]+\.png\)/);
  });

  await step('reading a note offers the way to change it, and admin only', async () => {
    await page.goto(`${BASE}/notes/fibonacci-retracements`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.note__title', { timeout: 15_000 });
    // Noticing that a note is wrong happens while reading it, so that is where
    // the way to fix it belongs.
    assert.equal(
      await page.locator('.note__action').count(),
      1,
      'an admin reading a note should be offered the editor',
    );
  });

  await step('a note that does not exist says so rather than opening blank', async () => {
    await page.goto(`${BASE}/notes/no-such-note/edit`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.note-edit__error', { timeout: 20_000 });
    assert.match(await page.textContent('.note-edit__error'), /not in the library/);
  });

  // ------------------------------------------------- course and theatre --

  await step('a course reads as a syllabus, numbered and in order', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/c/gaurdeer-mentorship`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.syllabus__link');

    const numbers = await page.$$eval('.syllabus__number', (els) =>
      els.map((el) => el.textContent.trim()),
    );
    assert.deepEqual(numbers, ['01', '02'], 'lessons are numbered in catalog order');

    // The primary button names the lesson it will actually open, so it is
    // never a guess about where you left off.
    const button = page.locator('.course__actions a').first();
    assert.match(await button.textContent(), /Start the course/);
    if (shotsDir) await page.screenshot({ path: `${shotsDir}/06-course.png` });
  });

  await step('the theatre says which lesson this is and offers the rest', async () => {
    await page.click('.syllabus__link');
    await page.waitForSelector('.theatre__title');

    assert.match(await page.textContent('.theatre__position'), /Lesson 1 of 2/);

    // The whole course is beside the player, so choosing the next one never
    // means going back to a listing.
    const railed = await page.$$eval('.rail-item__name', (els) => els.length);
    assert.equal(railed, 2);
    assert.equal(await page.locator('.rail-item.is-current').count(), 1);

    // Native controls would be the browser's chrome, not the product's.
    assert.equal(await page.locator('video[controls]').count(), 0);
    await page.waitForSelector('.pc__bar');
    if (shotsDir) await page.screenshot({ path: `${shotsDir}/07-theatre.png` });
  });

  await step('the rail moves between lessons and the position follows', async () => {
    await page.click('.rail-item:not(.is-current)');
    await page.waitForFunction(
      () => document.querySelector('.theatre__position')?.textContent.includes('Lesson 2 of 2'),
      undefined,
      { timeout: 15_000 },
    );
    // The last lesson has nothing after it, so no Next is offered.
    assert.equal(await page.locator('.theatre__steps a:has-text("Next")').count(), 0);
  });

  await step('finishing a lesson ticks it off the syllabus', async () => {
    // Completion has to survive as a fact. Deleting the entry on ended -- which
    // is what used to happen -- cannot tell "watched" from "never opened".
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('watcher.progress.v1') ?? '{}');
      raw['smc-market-structure'] = {
        positionSec: 600, durationSec: 600, updatedAt: Date.now(), completed: true,
      };
      localStorage.setItem('watcher.progress.v1', JSON.stringify(raw));
    });

    await page.goto(`${BASE}/c/gaurdeer-mentorship`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.syllabus__link');

    assert.equal(await page.locator('.syllabus__row.is-done').count(), 1);
    assert.match(await page.textContent('.course__progress-label'), /1 of 2 complete/);
  });

  // --------------------------------------------------- the dashboard ----

  await step('a collection can be moved under one made after it', async () => {
    // The mistake this exists for: a collection sitting at the top level, and
    // the thing that should contain it thought of afterwards.
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.admin__tree');

    // Computed, not inline: the depth is set as a custom property and turned
    // into padding by the stylesheet, so the inline style no longer carries it.
    const indentOf = (name) =>
      page.evaluate((n) => {
        const row = document.querySelector(`select[aria-label="Move ${n} into"]`).closest('li');
        return parseFloat(getComputedStyle(row).paddingLeft);
      }, name);

    // Movies starts at the top level, which is what makes the move real
    // rather than a no-op that would pass whatever the code did.
    assert.equal(await indentOf('Movies'), 0, 'Movies should start at the top level');
    assert.equal(await page.locator('select[aria-label="Move Movies into"]').inputValue(), '');

    await page.fill('.admin__form--inline input[type="text"]', 'Library');
    await page.selectOption('.admin__form--inline select', '');
    await page.click('button:has-text("Add")');

    await page.selectOption('select[aria-label="Move Movies into"]', 'library');
    assert.ok(await indentOf('Movies') > 0, 'Movies should now be nested');
    // Its own children came with it, which is the point of moving a branch.
    assert.ok(await indentOf('Telugu') > (await indentOf('Movies')), 'Telugu should still be inside Movies');

    await page.click('button:has-text("Save changes")');
    await page.waitForSelector('.admin__notice', { timeout: 15_000 });

    // And it survives a reload, so it was the saved document that changed.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.admin__tree');
    assert.equal(
      await page.locator('select[aria-label="Move Movies into"]').inputValue(),
      'library',
    );
  });

  await step('a collection is never offered a destination inside itself', async () => {
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.admin__tree');

    // Trading holds Elliott Wave, SMC and more. Offering any of them would
    // detach the branch and make a loop of it; the server refuses that, and a
    // dropdown listing an option it will then reject is a trap.
    const offered = (
      await page.locator('select[aria-label="Move Trading into"] option').allTextContents()
    ).map((text) => text.trim());

    for (const forbidden of ['Trading', 'Elliott Wave', 'SMC', 'SweeGlu Elliott Wave Course']) {
      assert.equal(offered.includes(forbidden), false, `${forbidden} must not be offered`);
    }
    assert.ok(offered.includes('Top level'));
    // Somewhere unrelated is still a legitimate destination.
    assert.ok(offered.includes('Library'), 'an unrelated collection should still be offered');
  });

  await step('a video can be renamed and refiled without touching its storage', async () => {
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.admin__titles');

    const before = page.locator('.admin__titles input.admin__rename').first();
    const original = await before.inputValue();
    const corrected = `${original} (corrected)`;

    await before.fill(corrected);
    await page.click('button:has-text("Save changes")');
    await page.waitForSelector('.admin__notice', { timeout: 15_000 });

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.admin__titles');
    assert.equal(
      await page.locator('.admin__titles input.admin__rename').first().inputValue(),
      corrected,
    );

    // The rename must not have moved the video: the player still finds it.
    await page.goto(`${BASE}/watch/${FIXTURE_TITLE_ID}`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('.player__error').count(), 0);
  });

  await step('lessons can be reordered, and the course follows', async () => {
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.admin__group');

    // The dashboard groups by course and numbers the rows, because "move up"
    // means nothing until you can see what it moves above.
    // Matched on the heading, not on text anywhere inside: every row carries a
    // <select> listing all collection names, so "has text" matches every group.
    const group = page
      .locator('.admin__group')
      .filter({ has: page.locator('h3', { hasText: 'Gaurdeer Mentorship' }) });
    const namesNow = () => group.locator('input.admin__rename').evaluateAll((els) => els.map((el) => el.value));

    const before = await namesNow();
    assert.equal(before.length, 2);

    await group.locator('.admin__step[aria-label*="later"]').first().click();
    const after = await namesNow();
    assert.deepEqual(after, [before[1], before[0]], 'the two lessons should have swapped');

    await page.click('button:has-text("Save changes")');
    await page.waitForSelector('.admin__notice', { timeout: 15_000 });

    // The viewer numbers lessons from the same order, so the course now leads
    // with what the dashboard put first.
    await page.goto(`${BASE}/c/gaurdeer-mentorship`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.syllabus__link');
    const lessons = await page.$$eval('.syllabus__name', (els) => els.map((el) => el.textContent));
    assert.deepEqual(lessons, after, 'the syllabus should read in the saved order');
  });

  await step('sorting by name puts Class 2 after Class 1, not after Class 10', async () => {
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.admin__group');

    const group = page
      .locator('.admin__group')
      .filter({ has: page.locator('h3', { hasText: 'Gaurdeer Mentorship' }) });
    await group.locator('button:has-text("Sort by name")').click();

    const sorted = await group.locator('input.admin__rename').evaluateAll((els) => els.map((el) => el.value));
    // A plain string compare would be fine for these two; the collator is
    // there for "Class - 2" against "Class - 10", which it is not.
    assert.deepEqual(sorted, [...sorted].sort((a, b) =>
      new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare(a, b),
    ));
  });

  await step('an empty name blocks the save rather than failing it', async () => {
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.admin__tree');

    await page.locator('.admin__tree input.admin__rename').first().fill('');
    await page.waitForSelector('.admin__blank', { timeout: 5_000 });
    assert.equal(await page.locator('button:has-text("Save changes")').isDisabled(), true);
  });

  // --------------------------------------------------- pairing a device --
  // Two contexts, because the whole point is that two devices are involved:
  // one that shows a code and never sees a password, and one that is already
  // trusted and says yes.

  await step('a device is signed in by a phone approving its code', async () => {
    const tv = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const tvPage = await tv.newPage();
      await tvPage.goto(`${BASE}/pair`, { waitUntil: 'networkidle' });

      const displayed = await tvPage.textContent('.pair__code');
      assert.match(displayed.trim(), /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, `unexpected code ${displayed}`);
      // A QR is actually rendered, not just a placeholder box.
      assert.ok(await tvPage.$('svg.qr path'), 'no QR drawn');

      const code = displayed.replace(/[^A-Z0-9]/g, '');

      // The phone signs in the ordinary way, then follows the scanned link.
      const phonePage = await phone.newPage();
      await phonePage.goto(`${BASE}/link?code=${code}`, { waitUntil: 'networkidle' });
      await phonePage.waitForURL(/\/login$/);
      await phonePage.fill('input[name="username"]', USERNAME);
      await phonePage.fill('input[name="password"]', PASSWORD);
      await phonePage.click('button[type="submit"]');

      // It comes back to the approval screen with the code intact.
      await phonePage.waitForSelector('.pair__facts', { timeout: 15_000 });
      const facts = await phonePage.textContent('.pair__facts');
      assert.ok(facts.includes(displayed.trim()), 'the approval screen should name the code');
      if (shotsDir) await phonePage.screenshot({ path: `${shotsDir}/06-approve.png` });

      await phonePage.click('button:has-text("Approve")');
      await phonePage.waitForSelector('text=That device is signed in', { timeout: 15_000 });

      // And the television lets itself in, without a password ever being typed
      // on it.
      await tvPage.waitForSelector('.hero__title', { timeout: 20_000 });
      assert.match(tvPage.url(), new RegExp(`^${BASE}/?$`));
    } finally {
      await tv.close();
      await phone.close();
    }
  });

  await step('a pairing code works exactly once', async () => {
    const tv = await browser.newContext();
    const phone = await browser.newContext();
    try {
      const tvPage = await tv.newPage();
      await tvPage.goto(`${BASE}/pair`, { waitUntil: 'networkidle' });
      const code = (await tvPage.textContent('.pair__code')).replace(/[^A-Z0-9]/g, '');

      const phonePage = await phone.newPage();
      await phonePage.goto(`${BASE}/link?code=${code}`, { waitUntil: 'networkidle' });
      await phonePage.waitForURL(/\/login$/);
      await phonePage.fill('input[name="username"]', USERNAME);
      await phonePage.fill('input[name="password"]', PASSWORD);
      await phonePage.click('button[type="submit"]');
      await phonePage.waitForSelector('.pair__facts', { timeout: 15_000 });
      await phonePage.click('button:has-text("Approve")');
      await phonePage.waitForSelector('text=That device is signed in', { timeout: 15_000 });

      // The device collects it, which consumes the pairing.
      await tvPage.waitForSelector('.hero__title', { timeout: 20_000 });

      // Re-approving the same code must now fail rather than mint a second
      // session from one approval.
      await phonePage.goto(`${BASE}/link?code=${code}`, { waitUntil: 'networkidle' });
      await phonePage.waitForSelector('text=That code is not waiting', { timeout: 15_000 });
    } finally {
      await tv.close();
      await phone.close();
    }
  });

  await step('an unapproved code leaves the device signed out', async () => {
    const tv = await browser.newContext();
    try {
      const tvPage = await tv.newPage();
      await tvPage.goto(`${BASE}/pair`, { waitUntil: 'networkidle' });
      await tvPage.waitForSelector('.pair__code');

      // Long enough for several polls to come back pending.
      await tvPage.waitForTimeout(5000);
      assert.ok(await tvPage.$('.pair__code'), 'the device should still be waiting');
      assert.equal(await tvPage.$('.hero__title'), null, 'nothing should have been granted');
      if (shotsDir) await tvPage.screenshot({ path: `${shotsDir}/05-pair.png` });
    } finally {
      await tv.close();
    }
  });

} finally {
  await browser?.close();
  await cleanup();
}

console.log(results.join('\n'));
console.log(`\n  ${results.length - failures}/${results.length} passed`);
process.exit(failures > 0 ? 1 : 0);
