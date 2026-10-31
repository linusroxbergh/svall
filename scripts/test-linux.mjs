#!/usr/bin/env node
// Runs the tmux-driven unit tests in a Linux container, as on a Mac they can hang the tty layer until a reboot:
//
//   pnpm test:linux [<vitest args>]     the svalld-tmux and cli-tmux projects, or what the args name
//
// It tests the checkout it is run from, read-only, with node_modules installed in docker volumes of that checkout's own.
// The Linux tmux 3.7c comes from vendor/tmux, this checkout's or the main checkout's. Output and exit code are vitest's.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeRuntime } from './release-stage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const checkout = git('rev-parse', '--show-toplevel');
const common = path.resolve(checkout, git('rev-parse', '--git-common-dir'));
const main = path.dirname(common);
const fail = (why) => { console.error(`test:linux: ${why}`); process.exit(1); };

const platform = execFileSync('docker', ['info', '--format', '{{.Architecture}}'], { encoding: 'utf8' }).trim();
const arch = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', amd64: 'x64' }[platform] ?? fail(`no tmux build for ${platform}`);
// the folder scripts/tmux-build.sh names for the versions it pins
const v = Object.fromEntries([...fs.readFileSync(path.join(HERE, 'tmux-build.sh'), 'utf8').matchAll(/^(TMUX|LIBEVENT|UTF8PROC|NCURSES)=(\S+)$/gm)].map((m) => [m[1], m[2]]));
const build = `${v.TMUX}-libevent-${v.LIBEVENT}-utf8proc-${v.UTF8PROC}-ncurses-${v.NCURSES}-linux-${arch}`;
const vendor = [checkout, main].map((c) => path.join(c, 'vendor')).find((d) => fs.existsSync(path.join(d, 'tmux', build, 'tmux')))
  ?? fail(`no vendor/tmux/${build} here or in ${main}; build it with scripts/tmux-build.sh --linux ${arch} in ${main}`);
const node = await nodeRuntime(`linux-${arch}`, { vendor });
const pnpm = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')).packageManager.replace(/^pnpm@/, '');

const bits = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-test-linux-'));
fs.copyFileSync(node.tarball, path.join(bits, node.name));
fs.copyFileSync(path.join(vendor, 'tmux', build, 'tmux'), path.join(bits, 'tmux'));
const built = spawnSync('docker', ['build', '-q', '--target', 'tests', '-t', 'svall-tests', '--build-context', `bits=${bits}`,
  '--build-arg', `NODE=${node.name}`, '--build-arg', `PNPM=${pnpm}`, path.join(HERE, 'integration')], { stdio: ['ignore', 'ignore', 'inherit'] });
fs.rmSync(bits, { recursive: true, force: true });
if (built.status !== 0) fail('docker build failed');

// the root's and each workspace package's node_modules, as Linux builds of their packages in volumes of this checkout's
const id = crypto.createHash('sha256').update(checkout).digest('hex').slice(0, 8);
const globs = [...fs.readFileSync(path.join(checkout, 'pnpm-workspace.yaml'), 'utf8').matchAll(/^\s+- (\S+)$/gm)].map((m) => `${m[1]}/package.json`);
const dirs = ['.', ...fs.globSync(globs, { cwd: checkout }).map(path.dirname)];
const mounts = dirs.map((d) => {
  // a mount point inside the read-only checkout has to be there already
  fs.mkdirSync(path.join(checkout, d, 'node_modules'), { recursive: true });
  return { volume: `svall-test-linux-${id}-${d === '.' ? 'root' : path.basename(d)}`, at: path.posix.join('/w', d, 'node_modules') };
});
console.error(`test:linux: ${checkout} in docker, its node_modules in volumes ${mounts.map((m) => m.volume).join(' ')}`);

const args = process.argv.length > 2 ? process.argv.slice(2) : ['--project', 'svalld-tmux', '--project', 'cli-tmux'];
const owned = [...mounts.map((m) => m.at), '/store'].join(' ');
// a worktree's .git names the main checkout's by its path on the Mac
const gitDir = common.startsWith(`${checkout}/`) ? [] : ['-v', `${common}:${common}:ro`];
const run = spawnSync('docker', ['run', '--rm', '--init', '-v', `${checkout}:/w:ro`, ...gitDir, ...mounts.flatMap((m) => ['-v', `${m.volume}:${m.at}`]),
  '-v', 'svall-test-linux-store:/store', '-w', '/w', 'svall-tests', 'sh', '-c',
  `chown 1000:1000 ${owned} && exec setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/home/tester sh -c `
  + `'pnpm install --frozen-lockfile --store-dir /store && exec node_modules/.bin/vitest run "$@"' sh "$@"`, 'sh', ...args], { stdio: 'inherit' });
process.exit(run.status ?? 1);
