// A Cloudflare D1-style database over node:sqlite, for the Node host and the tests:
// db.prepare(sql).bind(...values).all() / .first(column) / .run() / .raw(), db.batch([...])
// (one transaction: all or nothing) and db.exec(sql), with D1's results
// ({ success, meta, results }) and D1's value rules: every number, and a boolean (1/0),
// binds as REAL, as on D1 (a STRICT INTEGER column still stores a whole number as an
// integer); undefined, BigInt and objects are refused. A query is one statement (D1 would
// run them all and answer with the last; node:sqlite would run only the first). Statements
// are compiled when they first run and cached.
// meta.rows_written is the rows changed (all tables here are WITHOUT ROWID and have no
// other index, so this is what D1 bills); meta.rows_read is only the rows returned,
// since node:sqlite cannot count the rows SQLite scanned.
import fs from 'node:fs';
import path from 'node:path';
import { hideSqliteWarning } from './warnings.mjs';

// Before node:sqlite loads, so its one ExperimentalWarning stays hidden.
hideSqliteWarning();
const { DatabaseSync } = await import('node:sqlite');

const CACHE = 256;

function d1Error(error) {
  return error instanceof Error && error.message.startsWith('D1_') ? error
    : new Error('D1_ERROR: ' + (error && error.message), { cause: error });
}

// node:sqlite binds a JS number as REAL, like D1.
function bindable(value, index) {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${String(value)}' at position ${index + 1}`);
}

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values) {
    return new Statement(this.db, this.sql, values.map(bindable));
  }
  async all() {
    return this.db.execute(this);
  }
  async run() {
    return this.db.execute(this);
  }
  async first(column) {
    const row = this.db.execute(this).results[0] ?? null;
    if (column === undefined || row === null) return column === undefined ? row : null;
    if (!Object.hasOwn(row, column)) throw new Error('D1_COLUMN_NOTFOUND: Column not found (' + column + ')');
    return row[column];
  }
  async raw({ columnNames = false } = {}) {
    const { results, columns } = this.db.execute(this, true);
    return columnNames ? [columns, ...results] : results;
  }
}

class Database {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.compiled = new Map();
    this.totalChanges = sqlite.prepare('SELECT total_changes() AS n, last_insert_rowid() AS id');
  }
  prepare(sql) {
    if (typeof sql !== 'string') throw new TypeError('D1_TYPE_ERROR: the query must be a string');
    return new Statement(this, sql);
  }
  compile(sql) {
    let entry = this.compiled.get(sql);
    if (!entry) {
      const statement = this.sqlite.prepare(sql);
      // What follows the first statement, without comments, must be empty.
      if (/\S/.test(sql.slice(statement.sourceSQL.length).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ''))) {
        throw new Error('D1_ERROR: one statement per query (use batch() for several)');
      }
      entry = { statement, rows: statement.columns().length > 0 };
      if (this.compiled.size >= CACHE) this.compiled.delete(this.compiled.keys().next().value);
      this.compiled.set(sql, entry);
    }
    return entry;
  }
  // Runs one statement synchronously and answers like D1: rows as plain objects, or as
  // arrays of values (with the column names) for raw().
  execute(statement, arrays = false) {
    const started = performance.now();
    let results = [], changes, lastRowId, columns = [];
    try {
      const { statement: compiled, rows } = this.compile(statement.sql);
      if (rows) {
        const before = this.totalChanges.get();
        if (arrays) {
          compiled.setReturnArrays(true);
          try { results = compiled.all(...statement.params); } finally { compiled.setReturnArrays(false); }
          columns = compiled.columns().map(c => c.name);
        } else {
          results = compiled.all(...statement.params).map(row => ({ ...row }));
        }
        const after = this.totalChanges.get();
        changes = after.n - before.n;
        lastRowId = after.id;
      } else {
        const info = compiled.run(...statement.params);
        changes = Number(info.changes);
        lastRowId = Number(info.lastInsertRowid);
      }
    } catch (error) {
      throw d1Error(error);
    }
    return {
      success: true, results, columns,
      meta: {
        served_by: 'sqlite-d1', duration: performance.now() - started, changes, last_row_id: lastRowId,
        changed_db: changes > 0, size_after: 0, rows_read: results.length, rows_written: changes
      }
    };
  }
  // Every statement in one transaction; the first failure rolls them all back.
  async batch(statements) {
    if (!Array.isArray(statements) || !statements.every(s => s instanceof Statement && s.db === this)) {
      throw new TypeError('D1_TYPE_ERROR: batch() takes an array of statements from this database');
    }
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map(statement => {
        const { columns: _columns, ...result } = this.execute(statement);
        return result;
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      try { this.sqlite.exec('ROLLBACK'); } catch { /* SQLite already rolled back */ }
      throw d1Error(error);
    }
  }
  async exec(sql) {
    const started = performance.now();
    try { this.sqlite.exec(sql); } catch (error) { throw d1Error(error); }
    return { count: sql.split(';').filter(part => part.trim()).length, duration: performance.now() - started };
  }
  // Not part of D1: write deleted pages back and empty the write-ahead log, so purged
  // rows leave the files (secure_delete has already overwritten them).
  compact() {
    this.sqlite.exec('PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE)');
  }
  close() {
    this.compiled.clear();
    this.sqlite.close();
  }
}

// Opens (and creates, with its folder) an SQLite file, or ':memory:'.
export function openDatabase(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new DatabaseSync(file);
  try {
    sqlite.exec('PRAGMA busy_timeout = 5000');
    // A new file gives the space of purged rows back to the file system.
    if (sqlite.prepare('PRAGMA page_count').get().page_count === 0) sqlite.exec('PRAGMA auto_vacuum = INCREMENTAL');
    // Deleted rows are overwritten, not just unlinked.
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA secure_delete = ON');
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return new Database(sqlite);
}
