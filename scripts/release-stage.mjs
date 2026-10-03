// Everything the controller and the companion builds have in common: the pinned runtime, the
// bundled JavaScript, the assets a daemon reads at runtime and the licences of what travels with them.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PINS = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/release/pins.json'), 'utf8'));
export const VENDOR = path.join(REPO, 'vendor');
const DIRS = ['bin', 'lib', 'node', 'hooks', 'home', 'systemd', 'agent-profiles', 'web-mobile', 'licenses', 'release'];

const ENTRIES = [
  { name: 'svall', entry: 'packages/cli/src/main.ts' },
  { name: 'svalld', entry: 'packages/svalld/src/bin.ts' },
];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const run = (exe, argv, o = {}) => execFileSync(exe, argv, { stdio: ['ignore', 'pipe', 'inherit'], ...o });

const COMPANION_ARCHES = ['x64', 'arm64'];

/**
 * The Linux companions a desktop release publishes: where each archive will be served from, and the
 * digest an installer holds it to. The archives are built first; this only reads them.
 */
export function companionAssets(o) {
  const base = o.urlBase.replace(/\/$/, '');
  const companions = {};
  for (const arch of COMPANION_ARCHES) {
    const name = `svall-companion-${o.version}-linux-${arch}.tar.gz`;
    const file = path.join(o.dir, name);
    if (!fs.existsSync(file)) continue;
    companions[`linux-${arch}`] = { url: `${base}/${name}`, sha256: sha256(file) };
  }
  if (!Object.keys(companions).length) throw new Error(`no companion archive for ${o.version} under ${o.dir}: build them first`);
  return companions;
}

/** Copies each companion pinned by a URL relative to the release into the stage, where that URL finds it. */
export function carryCompanions(stage, companions, dir) {
  for (const { url } of Object.values(companions)) {
    if (URL.canParse(url)) continue;
    fs.mkdirSync(path.dirname(path.join(stage, url)), { recursive: true });
    fs.copyFileSync(path.join(dir, path.basename(url)), path.join(stage, url));
  }
}

/**
 * The release name, from the tree being built: its release tag, or its commit when none is there, as another tag such
 * as ghostty-kit names no release; never a path or anything a directory cannot be called.
 */
export function describeVersion(repo = REPO) {
  const version = run('git', ['describe', '--tags', '--match', 'v[0-9]*', '--always', '--dirty'], { cwd: repo, encoding: 'utf8' }).trim();
  if (!/^[A-Za-z0-9._+-]+$/.test(version)) throw new Error(`git describe gave an unusable release name: ${JSON.stringify(version)}`);
  return version;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${process.pid}`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
}

/**
 * The pinned Node tarball for one platform, cached under vendor/ and checked against the digest pins.json
 * holds for it, and the one nodejs.org publishes for that exact file, before any of it is staged.
 */
export async function nodeRuntime(platform, o = {}) {
  const { version } = PINS.node;
  if (!PINS.node.platforms.includes(platform)) throw new Error(`${platform} is not a pinned release platform`);
  const name = `node-${version}-${platform}.tar.xz`;
  const tarball = path.join(o.vendor ?? VENDOR, 'node', name);
  if (!fs.existsSync(tarball)) await download(`https://nodejs.org/dist/${version}/${name}`, tarball);

  // the published digests are cached beside the tarball, so a rebuild reaches for neither again.
  // the manifest names where they came from, not where this machine keeps them
  const publishedAt = `https://nodejs.org/dist/${version}/SHASUMS256.txt`;
  const cached = o.shasums ?? path.join(o.vendor ?? VENDOR, 'node', `SHASUMS256-${version}.txt`);
  if (!fs.existsSync(cached)) await download(publishedAt, cached);
  const sums = fs.readFileSync(cached, 'utf8');
  const published = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, f]) => f === name)?.[0];
  if (!published) throw new Error(`${cached} lists no digest for ${name}`);
  const actual = sha256(tarball);
  const pinned = PINS.node.sha256?.[platform];
  if (actual !== pinned) throw new Error(`${name} is not the pinned runtime: pins.json holds ${pinned ?? 'no digest'}, got ${actual}`);
  if (actual !== published) throw new Error(`${name} is not the published runtime: expected ${published}, got ${actual}`);
  return { version, platform, tarball, name, sha256: actual, verifiedAgainst: publishedAt };
}

export const RSYNC_CONFIGURE = ['--disable-xxhash', '--disable-zstd', '--disable-lz4', '--disable-openssl', '--disable-md2man'];

/**
 * The pinned rsync, built once per version and architecture and kept under vendor/ after that, and the source it was
 * built from, which ships beside it under its GPL. A `fresh` one, for a signed release, is built again from that source
 * whatever vendor/ holds.
 */
export async function pinnedRsync(arch, o = {}) {
  const { version } = PINS.rsync;
  const vendor = o.vendor ?? VENDOR;
  const cache = path.join(vendor, 'rsync', `${version}-${arch}`);
  const binary = path.join(cache, 'rsync');
  const licence = path.join(cache, 'COPYING');
  const name = `rsync-${version}.tar.gz`;
  const tarball = path.join(vendor, 'rsync', name);
  if (!fs.existsSync(tarball)) await download(`https://download.samba.org/pub/rsync/src/${name}`, tarball);
  const digest = sha256(tarball);
  if (digest !== PINS.rsync.sha256) throw new Error(`${name} is not the pinned source: expected ${PINS.rsync.sha256}, got ${digest}`);
  if (!o.fresh && fs.existsSync(binary) && fs.existsSync(licence)) return { version, binary, licence, tarball, sha256: PINS.rsync.sha256 };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-rsync-'));
  try {
    run('tar', ['-xzf', tarball, '-C', work, '--strip-components', '1']);
    run('./configure', RSYNC_CONFIGURE, { cwd: work });
    run('make', ['-j', String(os.availableParallelism())], { cwd: work });
    fs.mkdirSync(cache, { recursive: true });
    fs.copyFileSync(path.join(work, 'rsync'), binary);
    fs.chmodSync(binary, 0o755);
    fs.copyFileSync(path.join(work, 'COPYING'), licence);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { version, binary, licence, tarball, sha256: PINS.rsync.sha256 };
}

/** Unpacks the runtime and drops what a companion never runs: the headers, npm and corepack. */
function stageNode(runtime, stage) {
  const dest = path.join(stage, 'node');
  run('tar', ['-xJf', runtime.tarball, '-C', dest, '--strip-components', '1']);
  fs.rmSync(path.join(dest, 'include'), { recursive: true, force: true });
  fs.rmSync(path.join(dest, 'lib', 'node_modules'), { recursive: true, force: true });
  // the launchers those modules held are links into what has just gone
  for (const bin of ['npm', 'npx', 'corepack']) fs.rmSync(path.join(dest, 'bin', bin), { force: true });
  fs.copyFileSync(path.join(dest, 'LICENSE'), path.join(stage, 'licenses', 'node-LICENSE'));
}

// modules the dependencies try for and run without: ws's native accelerators and debug's colour detection. Left
// unresolved, Node would look them up in every folder above the release, whoever put them there
const ABSENT = /^(?:bufferutil|utf-8-validate|supports-color)$/;
const absent = {
  name: 'absent',
  setup(b) {
    b.onResolve({ filter: ABSENT }, (a) => ({ path: a.path, namespace: 'absent' }));
    b.onLoad({ filter: /.*/, namespace: 'absent' }, (a) => ({ contents: `throw new Error(${JSON.stringify(`${a.path} is not bundled`)});`, loader: 'js' }));
  },
};

/** One ESM file per entry point, and the set of sources esbuild inlined into them. */
async function bundle(stage) {
  const bundles = {};
  const inputs = new Set();
  for (const { name, entry } of ENTRIES) {
    const outfile = path.join(stage, 'lib', `${name}.mjs`);
    const result = await build({
      absWorkingDir: REPO,
      entryPoints: [path.join(REPO, entry)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      sourcemap: false,
      metafile: true,
      logLevel: 'warning',
      plugins: [absent],
      // esbuild's ESM output has no require(); the CJS dependencies need one
      banner: { js: "import { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);" },
    });
    bundles[name] = result.metafile.outputs[path.relative(REPO, outfile)]?.bytes ?? fs.statSync(outfile).size;
    for (const input of Object.keys(result.metafile.inputs)) inputs.add(input);
  }
  return { bundles, inputs };
}

/** The versions every machine in a handover has to agree on, read from the protocol rather than retyped. */
export async function schemaVersions(work) {
  const outfile = path.join(work, 'schema-versions.mjs');
  await build({
    absWorkingDir: REPO,
    stdin: {
      contents: "export { AUTHORITY_SCHEMA_VERSION, PROTOCOL_VERSION, TRANSFER_SCHEMA_VERSION, emptyState } from '@svall/protocol';",
      resolveDir: path.join(REPO, 'packages/svalld'),
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'warning',
  });
  const v = await import(pathToFileURL(outfile).href);
  return {
    protocol: v.PROTOCOL_VERSION,
    stateSchema: v.emptyState().version,
    transferSchema: v.TRANSFER_SCHEMA_VERSION,
    authoritySchema: v.AUTHORITY_SCHEMA_VERSION,
  };
}

/**
 * A release is reached through symlinks — `~/.local/bin/svall` and `current` — so the shim follows
 * its own link chain and then resolves the directory physically. What it exports is
 * `releases/<version>`, never `current`, so a process keeps reading the release it started from
 * while an upgrade moves `current` underneath it.
 */
export const shimText = (name) => `#!/bin/sh
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname -- "$self")/$link ;;
  esac
done
SVALL_RELEASE_ROOT=$(CDPATH= cd -P -- "$(dirname -- "$self")" && cd -P -- .. && pwd -P)
export SVALL_RELEASE_ROOT
exec "$SVALL_RELEASE_ROOT/node/bin/node" "$SVALL_RELEASE_ROOT/lib/${name}.mjs" "$@"
`;

function stageShims(stage, platform) {
  for (const { name } of ENTRIES) {
    const file = path.join(stage, 'bin', name);
    fs.writeFileSync(file, shimText(name), { mode: 0o755 });
  }
  // the dialog the app's first ssh to a new machine asks through
  if (platform.startsWith('darwin')) {
    fs.copyFileSync(path.join(REPO, 'scripts/release/svall-askpass'), path.join(stage, 'bin', 'svall-askpass'));
    fs.chmodSync(path.join(stage, 'bin', 'svall-askpass'), 0o755);
  }
}

/** The assets the daemon reads at runtime, and the signers an upgrade is checked against. */
function stageAssets(stage) {
  fs.cpSync(path.join(REPO, 'packages/svalld/hooks'), path.join(stage, 'hooks'), { recursive: true });
  fs.cpSync(path.join(REPO, 'packages/svalld/home'), path.join(stage, 'home'), { recursive: true });
  fs.cpSync(path.join(REPO, 'packages/svalld/systemd'), path.join(stage, 'systemd'), { recursive: true });
  fs.cpSync(path.join(REPO, 'packages/svalld/agent-profiles'), path.join(stage, 'agent-profiles'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'scripts/release/allowed_signers'), path.join(stage, 'release', 'allowed_signers'));
  const mobile = path.join(REPO, 'apps/desktop/web/dist-mobile');
  if (!fs.existsSync(mobile)) throw new Error(`${mobile} is missing: run pnpm --filter @svall/desktop-web build:mobile`);
  fs.cpSync(mobile, path.join(stage, 'web-mobile'), { recursive: true });
}

const LICENCE_FILE = /^(?:licen[cs]e|copying)(?:\..*)?$/i;

/**
 * A bundled package's name, version, stated licence and the file holding its text: its own, else the upstream text kept
 * in scripts/release/licenses/. One with neither stops the build.
 */
export function packageLicence(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const own = fs.readdirSync(dir).find((f) => LICENCE_FILE.test(f));
  const kept = path.join(REPO, 'scripts/release/licenses', `${pkg.name.replace('/', '-')}-LICENSE`);
  const file = own ? path.join(dir, own) : fs.existsSync(kept) ? kept : undefined;
  if (!file) throw new Error(`${pkg.name}@${pkg.version} is bundled but ships no licence file in ${dir}; put its upstream licence text in ${kept}`);
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'see its licence file';
  return { name: pkg.name, version: pkg.version, license, file };
}

// the folder Node would find `name` in from `from`, walking up as require does
function resolvePackage(from, name) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const at = path.basename(dir) === 'node_modules' ? path.join(dir, name) : path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(at, 'package.json'))) return fs.realpathSync(at);
    if (dir === path.dirname(dir)) return undefined;
  }
}

/**
 * Every package the phone page can hold: the web app's production dependencies and theirs, as Node resolves them.
 * Vite bundled it before this build, so the whole reach stands in for what it inlined.
 */
export function phonePackages(repo = REPO) {
  const found = new Set();
  const visit = (dir) => {
    const deps = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies ?? {};
    for (const name of Object.keys(deps)) {
      const at = resolvePackage(dir, name);
      if (!at) throw new Error(`${name}, a dependency of ${dir}, is not installed`);
      if (found.has(at)) continue;
      found.add(at);
      visit(at);
    }
  };
  visit(path.join(repo, 'apps/desktop/web'));
  // a workspace package is Svall's own, under its LICENSE
  return [...found].filter((dir) => dir.split(path.sep).includes('node_modules'));
}

const noticeLine = (what, license, file) => `${what}  ${license}  ${file}\n`;

/**
 * The licence of everything the release redistributes, and a NOTICE naming each with the file that holds its text. A
 * bundle inlines its dependencies' code, so its list comes from what esbuild read rather than from a manifest that
 * could fall behind.
 */
function stageLicenses(stage, inputs) {
  const licenses = path.join(stage, 'licenses');
  fs.copyFileSync(path.join(REPO, 'LICENSE'), path.join(licenses, 'svall-LICENSE'));
  const bundled = new Set();
  for (const input of inputs) {
    const cut = input.lastIndexOf('node_modules/');
    if (cut === -1) continue;
    const rest = input.slice(cut + 'node_modules/'.length).split('/');
    const pkg = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    bundled.add(fs.realpathSync(path.join(REPO, input.slice(0, cut), 'node_modules', pkg)));
  }
  const phone = new Set(phonePackages());
  const lines = [];
  const names = [];
  for (const dir of [...new Set([...bundled, ...phone])]) {
    const l = packageLicence(dir);
    const file = `${l.name.replace('/', '-')}-${l.version}-LICENSE`;
    fs.copyFileSync(l.file, path.join(licenses, file));
    const where = [bundled.has(dir) && 'lib/', phone.has(dir) && 'the phone page, web-mobile/'].filter(Boolean).join(' and ');
    lines.push(noticeLine(`${l.name} ${l.version} (in ${where})`, l.license, `licenses/${file}`));
    if (bundled.has(dir)) names.push(l.name);
  }
  for (const f of fs.readdirSync(path.join(stage, 'web-mobile'), { recursive: true }).map(String).filter((f) => LICENCE_FILE.test(path.basename(f)) || /^OFL\./.test(path.basename(f))).sort()) {
    lines.push(noticeLine(`the files in web-mobile/${path.dirname(f)}/`, 'as its file says', `web-mobile/${f}`));
  }
  const own = [noticeLine('Svall', 'MIT', 'licenses/svall-LICENSE'), noticeLine('Node.js runtime (node/), with the libraries it bundles', 'MIT and others', 'licenses/node-LICENSE')];
  fs.writeFileSync(path.join(licenses, 'NOTICE'), `This release carries the software below, each under its own licence, in the file named beside it.\n\n${[...own, ...lines.sort()].join('')}`);
  return [...new Set(names)].sort();
}

function emptyStage(out, version) {
  const stage = path.join(out, 'releases', version);
  fs.rmSync(stage, { recursive: true, force: true });
  for (const d of DIRS) fs.mkdirSync(path.join(stage, d), { recursive: true });
  return stage;
}

/** Stages everything both platforms share and reports what the manifest has to record. */
export async function stageRelease(o) {
  const stage = emptyStage(o.out, o.version);
  const work = path.join(o.out, '.build');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const runtime = await nodeRuntime(o.platform, { shasums: o.shasums });
  stageNode(runtime, stage);
  const { bundles, inputs } = await bundle(stage);
  stageShims(stage, o.platform);
  stageAssets(stage);
  const bundledLicenses = stageLicenses(stage, inputs);
  const schemas = await schemaVersions(work);
  fs.rmSync(work, { recursive: true, force: true });
  const companionDir = o.companionDir ?? o.out;
  const companions = o.companionUrlBase && companionAssets({ dir: companionDir, version: o.version, urlBase: o.companionUrlBase });
  if (companions) carryCompanions(stage, companions, companionDir);
  return {
    stage,
    meta: {
      version: o.version,
      platform: o.platform,
      ...schemas,
      ...(companions ? { companions } : {}),
      node: { version: runtime.version, tarball: runtime.name, sha256: runtime.sha256, verifiedAgainst: runtime.verifiedAgainst },
      bundles,
      bundledLicenses,
    },
  };
}

export const releaseKey = () => process.env.SVALL_RELEASE_KEY || undefined;
