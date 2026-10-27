// The dashboard's static files for the Node host (on Cloudflare, Workers static assets
// serve them). Only regular files inside the folder are served: no dot segments or dot
// files, no _headers or _redirects, no symbolic link that leads outside; a directory
// path ending in / serves its index.html. Each answer carries the headers that the
// folder's _headers file gives that path, in Cloudflare's format, so both hosts send
// the same Content-Security-Policy. Anything else is the handler's JSON 404.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './handler.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json'
};
const HIDDEN = new Set(['_headers', '_redirects']);

// Cloudflare's _headers format: a path pattern on its own line (* matches any run of
// characters), then indented "Name: value" lines. When several rules give the same
// header, the values are joined with ", ".
export function parseHeaders(text) {
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pattern = new RegExp('^' + trimmed.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      rules.push({ pattern, headers: [] });
    } else if (rules.length && trimmed.indexOf(':') > 0) {
      const at = trimmed.indexOf(':');
      rules.at(-1).headers.push([trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim()]);
    }
  }
  return pathname => {
    const out = new Map();
    for (const rule of rules) {
      if (!rule.pattern.test(pathname)) continue;
      for (const [name, value] of rule.headers) {
        const key = name.toLowerCase(), previous = out.get(key);
        out.set(key, previous ? [previous[0], previous[1] + ', ' + value] : [name, value]);
      }
    }
    return [...out.values()];
  };
}

export function staticFiles(root) {
  const base = path.resolve(root);
  let rules = null;
  const headersFor = async pathname => {
    rules ||= fs.readFile(path.join(base, '_headers'), 'utf8').then(parseHeaders, () => () => []);
    return (await rules)(pathname);
  };
  return async request => {
    const { pathname } = new URL(request.url);
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(404, 'not found'); }
    const segments = decoded.split('/').slice(1);
    if (decoded.includes('\0') || decoded.includes('\\') || segments.slice(0, -1).some(s => !s) ||
      segments.some(s => s.startsWith('.') || HIDDEN.has(s))) throw new HttpError(404, 'not found');
    const relative = decoded.endsWith('/') ? decoded + 'index.html' : decoded;
    const file = path.resolve(base, '.' + relative);
    let real, realBase, stat;
    try {
      [real, realBase] = await Promise.all([fs.realpath(file), fs.realpath(base)]);
      stat = await fs.stat(real);
    } catch {
      throw new HttpError(404, 'not found');
    }
    if (!real.startsWith(realBase + path.sep) || !stat.isFile()) throw new HttpError(404, 'not found');
    const body = await fs.readFile(real);
    const headers = new Headers({ 'Content-Type': TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache' });
    // Matched on the decoded path, the one that names the file (/%69ndex.html is /index.html).
    for (const [name, value] of await headersFor(decoded)) headers.set(name, value);
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
  };
}
