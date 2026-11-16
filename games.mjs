// The games the school site can report. Each line is the `slug` of one entry in the
// site's catalog (js/catalog.js in https://github.com/FarmerCarry/school-games).
// An event for any other slug is dropped, so a made-up game never reaches the database
// or the dashboard.
//
// When a game is added to the site, add its slug here too, in alphabetical order.
// Until you do, that game's events are ignored and the rest of the batch is kept.
// The list is the 44 games on the site, plus the six from school-games pull request 99
// (Splat Catapult, Recess Kitchen, Desk Karts, Toy Castle Clash, Magic Crayon, Juicy Drop),
// whose slugs are splat-catapult, recess-kitchen, desk-karts, toy-castle, magic-crayon
// and juicy-drop.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const GAME_SLUGS = [
  'air-hockey',
  'beat-dash',
  'blob-battle',
  'block-burst',
  'block-world',
  'bubble-bop',
  'cake-guards',
  'candy-rope',
  'chaos-island',
  'connect-four',
  'critter-mart',
  'desk-karts',
  'dino-3d',
  'drift-king',
  'egg-rush',
  'fire-and-ice',
  'hoop-heads',
  'juicy-drop',
  'key-runner',
  'keyboard-obby',
  'lucky-lake',
  'magic-crayon',
  'math-gates',
  'maze-dash',
  'merge-2048',
  'moto-madness',
  'neon-slope',
  'paint-grab',
  'pizza-clicker',
  'pool-party',
  'rail-rush',
  'recess-kitchen',
  'road-hopper',
  'seek-zoom',
  'shortcut-factory',
  'skybound-golf',
  'snake-arena',
  'splat-catapult',
  'splat-strike',
  'steady-hand',
  'sumo-bonk',
  'swing-hook',
  'tank-splat',
  'tic-tac-toe',
  'toy-castle',
  'troll-level',
  'tunnel-blitz',
  'typing-test',
  'wacky-soccer',
  'word-garden'
];

const seen = new Set();
for (const slug of GAME_SLUGS) {
  if (seen.has(slug)) throw new Error('games.mjs lists ' + slug + ' twice');
  if (!SLUG.test(slug) || slug.length > 40) throw new Error('games.mjs slug is not a game slug: ' + slug);
  seen.add(slug);
}
const sorted = [...GAME_SLUGS].sort();
if (GAME_SLUGS.some((slug, i) => slug !== sorted[i])) throw new Error('games.mjs must stay in alphabetical order');
