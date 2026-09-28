// Everything the controller and the companion builds have in common: the pinned runtime, the
// bundled JavaScript, the assets a daemon reads at runtime and the licences of what travels with them.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PINS = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/release/pins.json'), 'utf8'));
export const VENDOR = path.join(REPO, 'vendor');
const DIRS = ['bin', 'lib', 'node', 'hooks', 'home', 'systemd', 'agent-profiles', 'web-mobile', 'licenses', 'release'];

const ENTRIES = [
  { name: 'archi', entry: 'packages/cli/src/main.ts' },
  { name: 'archid', entry: 'packages/archid/src/bin.ts' },
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
    const name = `archipelago-companion-${o.version}-linux-${arch}.tar.gz`;
    const file = path.join(o.dir, name);
    if (!fs.existsSync(file)) continue;
    companions[`linux-${arch}`] = { url: `${base}/${name}`, sha256: sha256(file) };
  }
  if (!Object.keys(companions).length) throw new Error(`no companion archive for ${o.version} under ${o.dir}: build them first`);
  return companions;
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
 * The pinned Node tarball for one platform, cached under vendor/ and checked against the digest
 * nodejs.org publishes for that exact file before any of it is staged.
 */
async function nodeRuntime(platform, o = {}) {
  const { version } = PINS.node;
  if (!PINS.node.platforms.includes(platform)) throw new Error(`${platform} is not a pinned release platform`);
  const name = `node-${version}-${platform}.tar.xz`;
  const tarball = path.join(VENDOR, 'node', name);
  if (!fs.existsSync(tarball)) await download(`https://nodejs.org/dist/${version}/${name}`, tarball);

  // the published digests are cached beside the tarball, so a rebuild reaches for neither again.
  // the manifest names where they came from, not where this machine keeps them
  const publishedAt = `https://nodejs.org/dist/${version}/SHASUMS256.txt`;
  const cached = o.shasums ?? path.join(VENDOR, 'node', `SHASUMS256-${version}.txt`);
  if (!fs.existsSync(cached)) await download(publishedAt, cached);
  const sums = fs.readFileSync(cached, 'utf8');
  const published = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, f]) => f === name)?.[0];
  if (!published) throw new Error(`${cached} lists no digest for ${name}`);
  const actual = sha256(tarball);
  if (actual !== published) throw new Error(`${name} is not the published runtime: expected ${published}, got ${actual}`);
  return { version, platform, tarball, name, sha256: actual, verifiedAgainst: publishedAt };
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
async function schemaVersions(work) {
  const outfile = path.join(work, 'schema-versions.mjs');
  await build({
    absWorkingDir: REPO,
    stdin: {
      contents: "export { AUTHORITY_SCHEMA_VERSION, PROTOCOL_VERSION, TRANSFER_SCHEMA_VERSION, emptyState } from '@archipelago/protocol';",
      resolveDir: path.join(REPO, 'packages/archid'),
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
    agentAdapters: [],
  };
}

/**
 * A release is reached through symlinks — `~/.local/bin/archi` and `current` — so the shim follows
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
ARCHI_RELEASE_ROOT=$(CDPATH= cd -P -- "$(dirname -- "$self")" && cd -P -- .. && pwd -P)
export ARCHI_RELEASE_ROOT
exec "$ARCHI_RELEASE_ROOT/node/bin/node" "$ARCHI_RELEASE_ROOT/lib/${name}.mjs" "$@"
`;

function stageShims(stage, platform) {
  for (const { name } of ENTRIES) {
    const file = path.join(stage, 'bin', name);
    fs.writeFileSync(file, shimText(name), { mode: 0o755 });
  }
  // the dialog the app's first ssh to a new machine asks through
  if (platform.startsWith('darwin')) {
    fs.copyFileSync(path.join(REPO, 'scripts/release/archi-askpass'), path.join(stage, 'bin', 'archi-askpass'));
    fs.chmodSync(path.join(stage, 'bin', 'archi-askpass'), 0o755);
  }
}

/** The assets the daemon reads at runtime, and the signers an upgrade is checked against. */
function stageAssets(stage) {
  fs.cpSync(path.join(REPO, 'packages/archid/hooks'), path.join(stage, 'hooks'), { recursive: true });
  fs.cpSync(path.join(REPO, 'packages/archid/home'), path.join(stage, 'home'), { recursive: true });
  fs.cpSync(path.join(REPO, 'packages/archid/systemd'), path.join(stage, 'systemd'), { recursive: true });
  fs.cpSync(path.join(REPO, 'packages/archid/agent-profiles'), path.join(stage, 'agent-profiles'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'scripts/release/allowed_signers'), path.join(stage, 'release', 'allowed_signers'));
  const mobile = path.join(REPO, 'apps/desktop/web/dist-mobile');
  if (!fs.existsSync(mobile)) throw new Error(`${mobile} is missing: run pnpm --filter @archipelago/desktop-web build:mobile`);
  fs.cpSync(mobile, path.join(stage, 'web-mobile'), { recursive: true });
}

/**
 * The licence of everything the release redistributes. A bundle inlines its dependencies' code, so
 * the list comes from what esbuild actually read rather than from a manifest that could fall behind.
 */
function stageLicenses(stage, inputs) {
  fs.copyFileSync(path.join(REPO, 'LICENSE'), path.join(stage, 'licenses', 'archipelago-LICENSE'));
  const found = new Map();
  for (const input of inputs) {
    const cut = input.lastIndexOf('node_modules/');
    if (cut === -1) continue;
    const rest = input.slice(cut + 'node_modules/'.length).split('/');
    const pkg = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    if (found.has(pkg)) continue;
    const dir = path.join(REPO, input.slice(0, cut), 'node_modules', pkg);
    if (!fs.existsSync(dir)) continue;
    const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\..*)?$/i.test(f));
    if (file) found.set(pkg, path.join(dir, file));
  }
  for (const [pkg, file] of found) fs.copyFileSync(file, path.join(stage, 'licenses', `${pkg.replace('/', '-')}-LICENSE`));
  return [...found.keys()].sort();
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
  return {
    stage,
    meta: {
      version: o.version,
      platform: o.platform,
      ...schemas,
      ...(o.companionUrlBase ? { companions: companionAssets({ dir: o.companionDir ?? o.out, version: o.version, urlBase: o.companionUrlBase }) } : {}),
      node: { version: runtime.version, tarball: runtime.name, sha256: runtime.sha256, verifiedAgainst: runtime.verifiedAgainst },
      bundles,
      bundledLicenses,
    },
  };
}

export const releaseKey = () => process.env.ARCHI_RELEASE_KEY || undefined;
