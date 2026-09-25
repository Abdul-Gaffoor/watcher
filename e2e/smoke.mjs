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

    await page.waitForSelector('.grid .card');
    const titles = await page.$$eval('.grid .card__title', (els) => els.map((el) => el.textContent));
    assert.deepEqual(titles.sort(), ['Market Structure and Liquidity', 'Order Blocks and Fair Value Gaps']);

    // The breadcrumb has to offer the way back up, or a deep shelf is a dead end.
    const crumbs = await page.$$eval('.breadcrumb a', (els) => els.map((el) => el.textContent));
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
    await page.waitForSelector('.watch__title');
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

  await step('the layout does not overflow at phone width', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.fill('input[name="username"]', USERNAME);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.hero__title', { timeout: 15_000 });
    const { overflow, blame } = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth;
      // Naming the element is the difference between a number to reproduce and
      // a fix. Anything inside a horizontal scroller is meant to exceed it.
      const blame = [...document.querySelectorAll('body *')]
        .filter((el) => !el.closest('.row__scroller'))
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && box.right > limit + 1)
        .sort((a, b) => b.box.right - a.box.right)
        .slice(0, 3)
        .map(({ el, box }) => `${el.tagName.toLowerCase()}.${el.classList[0] ?? ''} → ${Math.round(box.right)}px`);

      return {
        overflow: document.documentElement.scrollWidth - limit,
        blame,
      };
    });
    assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px — ${blame.join(', ') || 'no element past the edge'}`);
    if (shotsDir) await page.screenshot({ path: `${shotsDir}/04-mobile.png` });
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
