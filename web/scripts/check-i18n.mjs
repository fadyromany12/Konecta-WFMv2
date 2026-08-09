/**
 * Keep the dictionary honest.
 *
 * Because the keys are the English strings themselves, editing a piece of
 * English copy silently orphans its translation — the screen keeps working and
 * quietly reverts to English, which is the kind of regression nobody files a
 * bug about. This finds both directions:
 *
 *   - dictionary entries no longer used by any `t()` call, which are dead
 *     weight and usually mean the English changed underneath them;
 *   - `t()` calls with no Arabic, which is expected while a screen is still
 *     being translated but should be a number somebody has looked at.
 *
 * Run: node scripts/check-i18n.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !f.includes('/locales/'));

// Only single-quoted literals — a template literal is not a key this can check
// statically, and pretending otherwise would report noise.
const CALL = /\bt\(\s*'((?:[^'\\]|\\.)*)'/g;

// Comments are stripped first. A doc comment that *describes* the call — as
// i18n.tsx's own does — would otherwise register as a use, and the checker
// would report a key nobody had written as missing a translation.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}

const used = new Set();
for (const file of files) {
  const text = stripComments(readFileSync(file, 'utf8'));
  for (const match of text.matchAll(CALL)) used.add(match[1].replace(/\\'/g, "'"));
}

/*
 * Keys reached through a variable rather than a literal, which a static scan
 * cannot see. Every entry needs a reason, because an allowlist without one is
 * how a genuinely dead string survives forever.
 */
const DYNAMIC = new Map([
  ['Dashboard', 'App.tsx renders the tab bar with t(tab.label)'],
  ['Time & Attendance', 'App.tsx tab label'],
  ['Scheduling', 'App.tsx tab label'],
  ['My Shifts', 'App.tsx tab label'],
  ['Admin', 'App.tsx tab label'],
  ['Reports', 'App.tsx tab label'],
]);
for (const key of DYNAMIC.keys()) used.add(key);

const arSource = readFileSync(join(SRC, 'locales/ar.ts'), 'utf8');
const KEY = /^\s*(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$]*))\s*:/gm;
const translated = new Set();
for (const match of arSource.matchAll(KEY)) {
  translated.add((match[1] ?? match[2]).replace(/\\'/g, "'"));
}

const orphans = [...translated].filter((k) => !used.has(k)).sort();
const untranslated = [...used].filter((k) => !translated.has(k)).sort();

console.log(`t() calls:        ${used.size}`);
console.log(`Arabic entries:   ${translated.size}`);
console.log(`Translated:       ${used.size - untranslated.length}/${used.size}`);

if (untranslated.length) {
  console.log(`\nNot yet in Arabic (${untranslated.length}):`);
  for (const key of untranslated) console.log('  · ' + key);
}

if (orphans.length) {
  console.log(`\nOrphaned — in the dictionary, used by nothing (${orphans.length}):`);
  for (const key of orphans) console.log('  ✗ ' + key);
  console.log('\nEnglish copy probably changed without its translation following.');
}

// Orphans are a real defect; an untranslated string is honest work in progress.
process.exit(orphans.length > 0 ? 1 : 0);
