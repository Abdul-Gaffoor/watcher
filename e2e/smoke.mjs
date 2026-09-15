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

  await step('the catalog renders a hero and one row per genre', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('.hero__title');
    const headings = await page.$$eval('.row__heading', (els) => els.map((el) => el.textContent));
    for (const genre of ['Harmonic Trading', 'Elliott Waves', 'Smart Money Concepts', 'Cinema']) {
      assert.ok(headings.includes(genre), `missing row: ${genre}`);
    }
    if (shotsDir) await page.screenshot({ path: `${shotsDir}/01-browse.png` });
  });

  await step('artwork loads rather than showing broken images', async () => {
    const broken = await page.$$eval('.card__art img', (imgs) =>
      imgs.filter((img) => !img.complete || img.naturalWidth === 0).length,
    );
    assert.equal(broken, 0, `${broken} broken image(s)`);
  });

  await step('genre navigation filters the grid', async () => {
    await page.click('.header__nav a:has-text("Smart Money Concepts")');
    await page.waitForURL(/\/genre\/smc$/);
    await page.waitForSelector('.grid .card');
    const titles = await page.$$eval('.card__title', (els) => els.map((el) => el.textContent));
    assert.deepEqual(titles.sort(), ['Market Structure and Liquidity', 'Order Blocks and Fair Value Gaps']);
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
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px`);
    if (shotsDir) await page.screenshot({ path: `${shotsDir}/04-mobile.png` });
  });
} finally {
  await browser?.close();
  await cleanup();
}

console.log(results.join('\n'));
console.log(`\n  ${results.length - failures}/${results.length} passed`);
process.exit(failures > 0 ? 1 : 0);
