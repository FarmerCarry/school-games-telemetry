#!/usr/bin/env node
/*
 * Writes server/dashboard/names.js, the game names the dashboard shows when the
 * games site does not publish js/catalog.js on its own (the fast build inlines the
 * catalog into its pages, so the published site answers 404 for it), with each game's
 * categories, players and input style (SG_GAME_INFO, with whether the game's own code
 * adapts its difficulty with Kit.dda, counts hits and reaction times with Kit.track and
 * shows a tutorial with Kit.stats.tutorial) and the category names (SG_CATEGORIES: the
 * catalog's Arabic label and the English one from CATEGORY_EN):
 *
 *   node server/dashboard/make-names.mjs
 *
 * Run it after a game is added or renamed in js/catalog.js;
 * tools/tests/dashboard-insights.test.mjs fails while names.js is out of date.
 * (A development script: .assetsignore keeps it out of the deployed files.)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = path.resolve(HERE, '../../js/catalog.js');
const GAMES = path.resolve(HERE, '../../games');
const OUT = path.join(HERE, 'names.js');

// English names of the catalog's categories (the catalog itself is Arabic only).
export const CATEGORY_EN = {
  challenge: 'Challenges', shooter: 'Shooting', running: 'Running', racing: 'Racing', 'two-player': 'Two players',
  sports: 'Sports', puzzle: 'Puzzles', strategy: 'Strategy', arcade: 'Arcade', idle: 'Build and manage', battle: 'Battle the bots'
};

// Whether a game's own scripts and page (games/<slug>/) match the pattern: 1 or 0.
function uses(slug, pattern) {
  const dir = path.join(GAMES, slug);
  let files = [];
  try { files = fs.readdirSync(dir).filter(name => /\.(?:js|html)$/.test(name)); } catch { return 0; }
  return files.some(name => pattern.test(fs.readFileSync(path.join(dir, name), 'utf8'))) ? 1 : 0;
}

// The file's text: slug -> [Arabic name, English name], sorted by slug, one game per line;
// slug -> { cats, players (the most at once), input, dda, track, tutorial }; category id ->
// [Arabic, English]. The names are the ones the page derives from a catalog entry
// (SGInsights.catalogName).
export function namesSource(catalogText = fs.readFileSync(CATALOG, 'utf8')) {
  const page = {}, site = {};
  vm.runInNewContext(fs.readFileSync(path.join(HERE, 'insights.js'), 'utf8'), { window: page });
  const { catalogName } = page.SGInsights;
  vm.runInNewContext(catalogText, { window: site });
  const games = site.GAMES.slice().sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const lines = games.map(g => '  ' + JSON.stringify(g.slug) + ': ' + JSON.stringify([catalogName(g, 'ar'), catalogName(g, 'en')]));
  const players = text => Math.max(...String(text || '1').split('-').map(Number).filter(Number.isFinite), 1);
  const info = games.map(g => '  ' + JSON.stringify(g.slug) + ': ' + JSON.stringify({ cats: g.cats || [], players: players(g.players), input: g.inputStyle || '',
    dda: uses(g.slug, /\bKit\.dda\b/), track: uses(g.slug, /\bKit\.track\b/), tutorial: uses(g.slug, /\bstats\.tutorial\b/) }));
  const cats = site.CATEGORIES.map(c => {
    if (!Object.hasOwn(CATEGORY_EN, c.id)) throw new Error('make-names: no English name for the category ' + c.id + ' (add it to CATEGORY_EN)');
    return '  ' + JSON.stringify(c.id) + ': ' + JSON.stringify([c.label, CATEGORY_EN[c.id]]);
  });
  return '// Game names from the games site\'s js/catalog.js, written by make-names.mjs (do not edit).\n' +
    '// The dashboard prefers the live site\'s catalog and falls back to these names.\n' +
    'window.SG_GAME_NAMES = {\n' + lines.join(',\n') + '\n};\n' +
    '// Each game\'s categories, the most players at once and its input style (js/catalog.js);\n' +
    '// dda, track, tutorial: its code adapts the difficulty to each child, counts hits and\n' +
    '// reaction times, shows a tutorial (games/<slug>/).\n' +
    'window.SG_GAME_INFO = {\n' + info.join(',\n') + '\n};\n' +
    '// Category names: [Arabic, English].\n' +
    'window.SG_CATEGORIES = {\n' + cats.join(',\n') + '\n};\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(OUT, namesSource());
  console.log(`make-names: wrote ${path.relative(process.cwd(), OUT)}`);
}
