// node scripts/robot-motion/preview.mjs [port] — serves the motion preview on localhost (robots stay on this machine)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = new URL('../../', import.meta.url).pathname;
const ROBOTS = path.join(ROOT, 'apps/desktop/web/public/robots');
const FILES = {
  '/': [path.join(HERE, 'preview.html'), 'text/html'],
  '/motion.js': [path.join(HERE, 'motion.js'), 'text/javascript'],
  '/card-grain.png': [path.join(ROOT, 'apps/desktop/web/src/assets/card-grain.png'), 'image/png'],
};
const port = Number(process.argv[2] ?? 5283);

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  const send = (body, type) => res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
  if (FILES[pathname]) return send(fs.readFileSync(FILES[pathname][0]), FILES[pathname][1]);
  // the robots that have motion, in file order
  if (pathname === '/robots.json') {
    const ids = fs.readdirSync(ROBOTS).filter((f) => /^robot-\d+\.svg$/.test(f) && fs.readFileSync(path.join(ROBOTS, f), 'utf8').includes('data-idle'));
    return send(JSON.stringify(ids.map((f) => f.slice(6, -4))), 'application/json');
  }
  const m = /^\/robots\/(robot-\d+\.svg)$/.exec(pathname);
  if (m && fs.existsSync(path.join(ROBOTS, m[1]))) return send(fs.readFileSync(path.join(ROBOTS, m[1])), 'image/svg+xml');
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
