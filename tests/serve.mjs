/**
 * Static server that honours Netlify's `_headers` file.
 *
 * WHY NOT `python3 -m http.server`
 * Because it ignores `_headers` entirely. Running the tests against it would mean
 * the Content-Security-Policy — the directive most likely to break the iframe —
 * was silently absent, and a "passing" browser test would prove nothing about the
 * policy that will actually be served in production.
 *
 * This implements the subset of Netlify's header rules these sites use:
 *   /path        exact match
 *   /path/*      prefix match
 *   /*           catch-all
 * Rules are merged; later matching blocks add to earlier ones, which is what
 * Netlify does and what the `_headers` comments rely on.
 *
 * It also mimics the SPA/rewrite behaviour the sites need:
 *   /            → index.html
 *   /embed       → embed/index.html
 *
 * Usage: node tests/serve.mjs <dir> <port>
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Parse `_headers` into [{ pattern, headers }]. */
async function loadHeaderRules() {
  let raw;
  try {
    raw = await readFile(join(root, '_headers'), 'utf8');
  } catch {
    return [];
  }

  const rules = [];
  let current = null;

  for (const line of raw.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line) && line.trim().startsWith('/')) {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    const m = line.match(/^\s+([\w-]+):\s*(.+)$/);
    if (m && current) current.headers[m[1]] = m[2].trim();
  }
  return rules;
}

const rules = await loadHeaderRules();

function matches(pattern, pathname) {
  if (pattern === '/*') return true;
  if (pattern.endsWith('/*')) return pathname.startsWith(pattern.slice(0, -1));
  return pathname === pattern;
}

function headersFor(pathname) {
  const out = {};
  for (const rule of rules) {
    if (matches(rule.pattern, pathname)) Object.assign(out, rule.headers);
  }
  return out;
}

/** Map a URL path to a file, applying the rewrites these sites declare. */
async function resolveFile(pathname) {
  const clean = normalize(decodeURIComponent(pathname.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const candidates = [];

  if (clean === '/') candidates.push('index.html');
  else {
    candidates.push(clean.replace(/^\//, ''));
    candidates.push(clean.replace(/^\//, '') + '/index.html');
    candidates.push(clean.replace(/^\//, '') + '.html');
  }

  for (const rel of candidates) {
    const abs = join(root, rel);
    if (!abs.startsWith(root)) continue;
    try {
      const s = await stat(abs);
      if (s.isFile()) return abs;
    } catch {
      /* try next */
    }
  }
  return null;
}

createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  const file = await resolveFile(pathname);
  const headers = headersFor(pathname);

  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...headers });
    res.end('Not found');
    return;
  }

  const body = await readFile(file);
  const type = TYPES[extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': headers['Content-Type'] || type, ...headers });
  res.end(body);
}).listen(port, '0.0.0.0', () => {
  console.log(`[serve] ${root} on http://0.0.0.0:${port} (${rules.length} header rule(s))`);
});
