// A Cloudflare D1-style database over node:sqlite, for the Node host and the tests:
// db.prepare(sql).bind(...values).all() / .first(column) / .run() / .raw(), db.batch([...])
// (one transaction: all or nothing) and db.exec(sql), with D1's results
// ({ success, meta, results }) and D1's value rules: every number, and a boolean (1/0),
// binds as REAL, as on D1 (a STRICT INTEGER column still stores a whole number as an
// integer); undefined, BigInt and objects are refused. A query is one statement (D1 would
// run them all and answer with the last; node:sqlite would run only the first). Statements
// are compiled when they first run and cached.
// meta.rows_written bills what D1 bills: every row changed by an INSERT, UPDATE, DELETE or
// upsert counts once for the table and once for each of its secondary indexes (an upper
// bound: an UPDATE that leaves an indexed column alone writes no index entry); the index
// count of a table is read from the schema once and kept until a statement changes the
// schema. meta.size_after is the database size (page_count x page_size). meta.rows_read
// is only the rows returned, since node:sqlite cannot count the rows SQLite scanned; the
// tests check read costs through query plans instead.
// D1's limits on one query are refused here as D1 refuses them when it prepares the
// statement (node:sqlite cannot set SQLite's limits): see D1_LIMITS.
import fs from 'node:fs';
import path from 'node:path';
import { hideSqliteWarning } from './warnings.mjs';

// Before node:sqlite loads, so its one ExperimentalWarning stays hidden.
hideSqliteWarning();
const { DatabaseSync } = await import('node:sqlite');

const CACHE = 256;
// The table a write statement changes, after any leading comments.
const TARGET = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?(\w+)/i;
const DDL = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:CREATE|DROP|ALTER)\b/i;

// D1's documented limits on one query: the bytes of its SQL, bound parameters, arguments
// of one SQL function, columns of a result, and terms of one compound SELECT (workerd's
// D1 refuses a sixth UNION term). node:sqlite allows far more of each, so without this a
// statement that D1 refuses would pass every test.
export const D1_LIMITS = { sqlBytes: 100000, variables: 100, functionArgs: 32, columns: 100, compoundTerms: 5 };
// Words that can stand before '(' without calling a function, and words after which the
// next word names a table, an index or a CTE (whose column list follows).
const NOT_CALLS = new Set(['ALL', 'AND', 'AS', 'BETWEEN', 'BY', 'CASE', 'CHECK', 'CONFLICT', 'DISTINCT', 'DO', 'ELSE', 'END', 'EXCEPT',
  'EXISTS', 'FILTER', 'FROM', 'GLOB', 'HAVING', 'IN', 'INTERSECT', 'INTO', 'IS', 'JOIN', 'KEY', 'LIKE', 'LIMIT', 'MATERIALIZED', 'NOT',
  'OFFSET', 'ON', 'OR', 'OVER', 'RETURNING', 'SELECT', 'SET', 'THEN', 'UNION', 'UNIQUE', 'USING', 'VALUES', 'WHEN', 'WHERE', 'WINDOW', 'WITH']);
const NAMES_NEXT = new Set(['INTO', 'TABLE', 'EXISTS', 'ON', 'RECURSIVE', 'INDEX', 'VIEW', 'REFERENCES']);
const COMPOUND = new Set(['UNION', 'INTERSECT', 'EXCEPT']);
const EMPTY = /\s*\)/y, VARIABLE = /\?(\d*)/y, NAME = /[A-Za-z_][A-Za-z0-9_$]*/y;
// The first limit `sql` passes, as D1's message, or null. Strings, quoted names and
// comments are skipped; every pair of parentheses is a frame that counts its commas (the
// arguments, when the word before it calls a function) and its compound operators.
export function d1LimitError(sql) {
  if (Buffer.byteLength(sql) > D1_LIMITS.sqlBytes) return 'statement too long';
  const frames = [{ call: null, args: 1, compounds: 0 }], words = [];
  let variables = 0, i = 0;
  const close = frame => {
    if (frame.call && frame.args > D1_LIMITS.functionArgs) return `too many arguments on function ${frame.call}`;
    if (frame.compounds + 1 > D1_LIMITS.compoundTerms) return 'too many terms in compound SELECT';
    return null;
  };
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const end = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < sql.length && !(sql[j] === end && sql[j + 1] !== end)) j += sql[j] === end ? 2 : 1;
      if (ch !== "'") words.push('"');
      i = j + 1;
    } else if (ch === '-' && sql[i + 1] === '-') {
      i = sql.indexOf('\n', i) < 0 ? sql.length : sql.indexOf('\n', i);
    } else if (ch === '/' && sql[i + 1] === '*') {
      i = sql.indexOf('*/', i) < 0 ? sql.length : sql.indexOf('*/', i) + 2;
    } else if (ch === '(') {
      const [name, before] = [words.at(-1), words.at(-2)], upper = name && name.toUpperCase();
      const call = name && /^[A-Za-z_]/.test(name) && !NOT_CALLS.has(upper) && !NAMES_NEXT.has(before?.toUpperCase()) ? name : null;
      EMPTY.lastIndex = i + 1;
      frames.push({ call, args: EMPTY.test(sql) ? 0 : 1, compounds: 0 });
      words.push('(');
      i++;
    } else if (ch === ')') {
      const error = frames.length > 1 && close(frames.pop());
      if (error) return error;
      words.push(')');
      i++;
    } else if (ch === ',') {
      frames.at(-1).args++;
      words.push(',');
      i++;
    } else if (ch === '?') {
      VARIABLE.lastIndex = i;
      const m = VARIABLE.exec(sql);
      variables = m[1] ? Math.max(variables, Number(m[1])) : variables + 1;
      words.push('?');
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      NAME.lastIndex = i;
      const m = NAME.exec(sql);
      if (COMPOUND.has(m[0].toUpperCase())) frames.at(-1).compounds++;
      words.push(m[0]);
      i += m[0].length;
    } else {
      if (!/\s/.test(ch)) words.push(ch);
      i++;
    }
  }
  if (variables > D1_LIMITS.variables) return 'too many SQL variables';
  return close(frames[0]);
}

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
    this.size = sqlite.prepare('SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()');
    this.tableSql = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?");
    this.indexList = sqlite.prepare('SELECT origin FROM pragma_index_list(?)');
    this.indexes = new Map();
  }
  // 1 + the secondary indexes of a table: the entries one changed row writes. The primary
  // key of a WITHOUT ROWID table is the table itself; a UNIQUE constraint is an index.
  entries(table) {
    let n = this.indexes.get(table);
    if (n === undefined) {
      const sql = this.tableSql.get(table)?.sql || '';
      const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(sql);
      n = 1 + this.indexList.all(table).filter(index => !(withoutRowid && index.origin === 'pk')).length;
      this.indexes.set(table, n);
    }
    return n;
  }
  prepare(sql) {
    if (typeof sql !== 'string') throw new TypeError('D1_TYPE_ERROR: the query must be a string');
    return new Statement(this, sql);
  }
  compile(sql) {
    let entry = this.compiled.get(sql);
    if (!entry) {
      const limit = d1LimitError(sql);
      if (limit) throw new Error('D1_ERROR: ' + limit + ': SQLITE_ERROR');
      const statement = this.sqlite.prepare(sql);
      if (statement.columns().length > D1_LIMITS.columns) throw new Error('D1_ERROR: too many columns in result set: SQLITE_ERROR');
      // What follows the first statement, without comments, must be empty.
      if (/\S/.test(sql.slice(statement.sourceSQL.length).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ''))) {
        throw new Error('D1_ERROR: one statement per query (use batch() for several)');
      }
      const target = TARGET.exec(sql);
      entry = { statement, rows: statement.columns().length > 0, target: target ? target[1] : null, ddl: DDL.test(sql) };
      if (this.compiled.size >= CACHE) this.compiled.delete(this.compiled.keys().next().value);
      this.compiled.set(sql, entry);
    }
    return entry;
  }
  // Runs one statement synchronously and answers like D1: rows as plain objects, or as
  // arrays of values (with the column names) for raw().
  execute(statement, arrays = false) {
    const started = performance.now();
    let results = [], changes, lastRowId, columns = [], written = 0, size;
    try {
      const { statement: compiled, rows, target, ddl } = this.compile(statement.sql);
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
      if (ddl) this.indexes.clear();
      written = changes && target ? changes * this.entries(target) : changes;
      size = this.size.get().size;
    } catch (error) {
      throw d1Error(error);
    }
    return {
      success: true, results, columns,
      meta: {
        served_by: 'sqlite-d1', duration: performance.now() - started, changes, last_row_id: lastRowId,
        changed_db: changes > 0, size_after: size, rows_read: results.length, rows_written: written
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
    this.indexes.clear();
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
