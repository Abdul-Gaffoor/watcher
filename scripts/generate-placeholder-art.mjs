#!/usr/bin/env node
/**
 * Writes lightweight SVG poster/backdrop art for every title in the catalog so
 * the MVP looks like a real product before any real artwork exists. Safe to
 * re-run; it never overwrites a file that already exists.
 *
 *   node scripts/generate-placeholder-art.mjs
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(resolve(root, 'content/catalog.json'), 'utf8'));

/** One stable colour pair per genre so a row reads as a set. */
const palettes = {
  'harmonic-trading': ['#123a63', '#2b6fa8'],
  'elliott-waves': ['#1d3b2f', '#3f8f6b'],
  smc: ['#3a2350', '#7b4bb5'],
  cinema: ['#43202a', '#a8465f'],
  documentary: ['#2a2f3d', '#5c6784'],
};

/**
 * Deliberately text-free: an SVG used as a CSS background cannot load system
 * fonts, so any <text> renders as tofu boxes. The card and hero draw the title
 * in real DOM on top instead.
 */
function svg({ width, height, seed, colors }) {
  const [from, to] = colors;
  // Vary the polyline per title so a row does not look like one repeated tile.
  const points = Array.from({ length: 7 }, (_, index) => {
    const x = (index / 6) * width;
    const wobble = Math.sin(seed + index * 1.7) * 0.18 + Math.cos(seed * 2 + index) * 0.08;
    const y = height * (0.55 + wobble);
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${from}"/>
      <stop offset="100%" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <path d="M${points.join(' L')}" fill="none" stroke="#ffffff" stroke-opacity="0.22"
        stroke-width="${Math.max(2, width / 320)}" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${(width * 0.5).toFixed(1)}" cy="${(height * 0.5).toFixed(1)}" r="${(height * 0.22).toFixed(1)}"
          fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="${Math.max(1, width / 640)}"/>
</svg>
`;
}

/** Stable per-title seed so re-running produces identical art. */
function seedFor(id) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return hash / 997 * Math.PI * 2;
}

async function writeIfMissing(path, contents) {
  try {
    await access(path);
    return false;
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    return true;
  }
}

let written = 0;
for (const title of catalog.titles) {
  const colors = palettes[title.genreIds[0]] ?? ['#1d2333', '#2b2143'];

  for (const [field, width, height] of [
    ['poster', 640, 360],
    ['backdrop', 1600, 720],
  ]) {
    const relative = title[field];
    if (!relative) continue;
    const path = resolve(root, 'content', relative.replace(/^\/media\//, 'media/'));
    if (await writeIfMissing(path, svg({ width, height, seed: seedFor(title.id), colors }))) written += 1;
  }
}

console.log(`Placeholder art: ${written} file(s) written, ${catalog.titles.length} titles checked.`);
