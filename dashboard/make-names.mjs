#!/usr/bin/env node
/*
 * Writes server/dashboard/names.js, the game names the dashboard shows when the
 * games site does not publish js/catalog.js on its own (the fast build inlines the
 * catalog into its pages, so the published site answers 404 for it):
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
const OUT = path.join(HERE, 'names.js');

// The file's text: slug -> [Arabic name, English name], sorted by slug, one game per line.
// The names are the ones the page derives from a catalog entry (SGInsights.catalogName).
export function namesSource(catalogText = fs.readFileSync(CATALOG, 'utf8')) {
  const page = {}, site = {};
  vm.runInNewContext(fs.readFileSync(path.join(HERE, 'insights.js'), 'utf8'), { window: page });
  const { catalogName } = page.SGInsights;
  vm.runInNewContext(catalogText, { window: site });
  const games = site.GAMES.slice().sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const lines = games.map(g => '  ' + JSON.stringify(g.slug) + ': ' + JSON.stringify([catalogName(g, 'ar'), catalogName(g, 'en')]));
  return '// Game names from the games site\'s js/catalog.js, written by make-names.mjs (do not edit).\n' +
    '// The dashboard prefers the live site\'s catalog and falls back to these names.\n' +
    'window.SG_GAME_NAMES = {\n' + lines.join(',\n') + '\n};\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(OUT, namesSource());
  console.log(`make-names: wrote ${path.relative(process.cwd(), OUT)}`);
}
