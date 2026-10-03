import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { SHIM } from '../profile.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const NOT_BUILT = `The phone bundle is not built. Run \`${SHIM} mobile\` on the Mac.`;
// the page holds a socket that can run commands on the Mac, so it runs only its own code, and no other page may frame it
// and steer a tap into it. xterm and React set inline styles; an older WebKit does not count wss: as 'self'
const CSP = "default-src 'self'; script-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'";
const HEADERS = { 'content-security-policy': CSP, 'x-frame-options': 'DENY' };

/** The file `pathname` names, or index.html for a route the single page owns; never anything outside dir. */
export function resolveFile(dir: string, pathname: string): string | undefined {
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { return undefined; }
  const target = path.resolve(dir, `.${path.posix.normalize(rel)}`);
  if (target !== dir && !target.startsWith(dir + path.sep)) return undefined;
  const index = path.join(dir, 'index.html');
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  return fs.existsSync(index) ? index : undefined;
}

const BRANDED = new Set(['index.html', 'manifest.webmanifest']);

/** The page and its manifest name the fleet, so two fleets installed on one phone can be told apart. */
export function brand(file: string, text: string, fleet: string): string {
  if (path.basename(file) === 'index.html') return text.replace('<title>Svall</title>', `<title>Svall ${fleet}</title>`);
  const manifest = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify({ ...manifest, name: `Svall ${fleet}`, short_name: `svall ${fleet}` });
}

export function serveBundle(req: IncomingMessage, res: ServerResponse, dir: string, fleetName?: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  const file = resolveFile(dir, new URL(req.url ?? '/', 'http://svalld').pathname);
  if (!file) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(fs.existsSync(path.join(dir, 'index.html')) ? 'Not found' : NOT_BUILT); return; }
  // only Vite's assets/ carries a content hash, so only it can be pinned; everything else revalidates
  const hashed = path.relative(dir, file).startsWith(`assets${path.sep}`);
  const cache = hashed ? 'public, max-age=31536000, immutable' : 'no-cache';
  let branded: string | undefined;
  if (fleetName && BRANDED.has(path.basename(file))) {
    try { branded = brand(file, fs.readFileSync(file, 'utf8'), fleetName); } catch { /* served as built below */ }
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': cache, ...HEADERS });
  if (req.method === 'HEAD') { res.end(); return; }
  if (branded !== undefined) { res.end(branded); return; }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}
