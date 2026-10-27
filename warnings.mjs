// node:sqlite prints an ExperimentalWarning on Node 22. hideSqliteWarning() hides
// exactly that one and hands every other warning to Node's own printer. Call it
// before node:sqlite loads (sqlite-d1.mjs does, before it imports node:sqlite);
// calling it again changes nothing.
let hidden = false;

export function hideSqliteWarning() {
  if (hidden) return;
  hidden = true;
  const printers = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', warning => {
    if (warning.name === 'ExperimentalWarning' && /\bSQLite\b/.test(warning.message)) return;
    for (const print of printers) print.call(process, warning);
  });
}
