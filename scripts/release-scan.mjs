#!/usr/bin/env node
// Looks through release archives and trees for what must never ship, and exits 1 on the first sight of any of it:
//
//   node scripts/release-scan.mjs [--secrets-only] <archive.tar.gz or directory>...
//
// - secrets: private keys, API and access tokens, JWTs, and files that hold credentials by their name;
// - developer paths: any /Users/ path, and this builder's home, checkout and temp folder;
// - checkout dependencies: a module the release does not carry, a link out of it, a node_modules or .git folder.
//
// --secrets-only is for logs, which name the paths of the machine that wrote them by design.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// a line break, or the escaped one a bundler writes into a string literal
const NL = String.raw`(?:\r?\n|(?:\\r)?\\n)`;

const SECRETS = [
  ['private key', new RegExp(String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----${NL}(?:[A-Za-z-]+: [^\r\n\\]*${NL})*${NL}?[A-Za-z0-9+/=]{40,}`, 'g')],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ['AWS key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[abposr]-[0-9A-Za-z-]{10,}/g],
  ['Google key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['Tailscale key', /\btskey-[a-z]+-[A-Za-z0-9-]{10,}/g],
  ['JWT', /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g],
];

const CREDENTIAL_FILE = /^(?:\.credentials\.json|auth\.json|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|.+\.(?:pem|p12|pfx|key))$/;
const CHECKOUT_DIR = new Set(['node_modules', '.git']);
const BUILTIN = new Set(builtinModules);

const IMPORTS = [
  /^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\1/gm,
  /^\s*import\s*(['"])([^'"\n]+)\1/gm,
  /(?<![.\w$])import\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /(?<![.\w$])(?:__)?require\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The paths of the machine building the release; a folder of one component, such as /tmp or /root, names nobody. */
function builderPaths(o) {
  const out = new Set();
  for (const p of [o.home, o.checkout, o.tmp].filter(Boolean)) {
    for (const form of [p, p.replace(/^\/private(?=\/var\/)/, '')]) {
      const clean = form.replace(/\/+$/, '');
      if (clean.split('/').filter(Boolean).length > 1) out.add(clean);
    }
  }
  return [...out];
}

// the pinned Node runtime, whose digest the build checked against nodejs.org, carries its own build machine's paths
const UPSTREAM = /^(?:releases\/[^/]+\/)?node\//;

function moduleProblem(spec, file, root) {
  if (spec.startsWith('node:') || BUILTIN.has(spec)) return undefined;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const target = path.resolve(path.dirname(file), spec);
    return target.startsWith(root + path.sep) && fs.existsSync(target) ? undefined : spec;
  }
  return spec;
}

/** Every hit under one unpacked input, one per file and rule. */
function scanTree(root, input, o) {
  const hits = new Map();
  let files = 0;
  const hit = (rel, rule, excerpt) => {
    const key = `${rel}\0${rule}`;
    const held = hits.get(key);
    if (held) held.count += 1;
    else hits.set(key, { input, path: rel, rule, excerpt, count: 1 });
  };
  const developer = builderPaths(o).map((p) => [p, new RegExp(`${escape(p)}[^\\s"'\`\\0]{0,60}`, 'g')]);
  const anyUsers = /\/Users\/[^\s"'`\0]{1,60}/g;

  const visit = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        const to = fs.readlinkSync(full);
        const resolved = path.resolve(path.dirname(full), to);
        if (!o.secretsOnly && (path.isAbsolute(to) || !resolved.startsWith(root + path.sep))) hit(rel, 'link out of the release', to);
        continue;
      }
      if (st.isDirectory()) {
        if (!o.secretsOnly && CHECKOUT_DIR.has(name)) { hit(rel, 'checkout content', name); continue; }
        visit(full);
        continue;
      }
      if (!st.isFile()) continue;
      files += 1;
      if (CREDENTIAL_FILE.test(name)) hit(rel, 'credential file', name);
      const text = fs.readFileSync(full).toString('latin1');
      for (const [rule, re] of SECRETS) {
        for (const m of text.matchAll(re)) hit(rel, rule, `${m[0].slice(0, 6)}… (${m[0].length} characters)`);
      }
      if (o.secretsOnly) continue;
      for (const [, re] of developer) for (const m of text.matchAll(re)) hit(rel, 'developer path', m[0]);
      if (!UPSTREAM.test(rel)) for (const m of text.matchAll(anyUsers)) hit(rel, 'developer path', m[0]);
      if (/\.(?:mjs|cjs|js)$/.test(name) && !UPSTREAM.test(rel) && !/(?:^|\/)web-mobile\//.test(rel)) {
        for (const re of IMPORTS) {
          for (const m of text.matchAll(re)) {
            const missing = moduleProblem(m[2], full, root);
            if (missing) hit(rel, 'module not in the release', missing);
          }
        }
      }
    }
  };
  visit(root);
  return { hits: [...hits.values()], files };
}

const isArchive = (p) => /\.(?:tar\.gz|tgz)$/.test(p);

/**
 * Scans each archive or directory. `home`, `checkout` and `tmp` are the builder's own paths, from this process when
 * not given; `secretsOnly` skips every rule but the secrets.
 */
export function scan(inputs, o = {}) {
  const where = {
    home: o.home ?? os.homedir(),
    checkout: o.checkout ?? REPO,
    tmp: o.tmp ?? fs.realpathSync(os.tmpdir()),
    secretsOnly: Boolean(o.secretsOnly),
  };
  const hits = [];
  const scanned = [];
  for (const input of inputs) {
    let root = path.resolve(input);
    let work;
    if (isArchive(input)) {
      work = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-scan-'));
      execFileSync('tar', ['-xzf', input, '-C', work], { stdio: ['ignore', 'ignore', 'pipe'] });
      root = work;
    }
    try {
      const r = scanTree(fs.realpathSync(root), input, where);
      hits.push(...r.hits);
      scanned.push({ input, files: r.files });
    } finally {
      if (work) fs.rmSync(work, { recursive: true, force: true });
    }
  }
  return { hits, scanned };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const secretsOnly = args.includes('--secrets-only');
  const inputs = args.filter((a) => a !== '--secrets-only');
  if (!inputs.length || inputs.some((a) => a.startsWith('--') || !fs.existsSync(a))) {
    process.stderr.write('usage: release-scan.mjs [--secrets-only] <archive.tar.gz or directory>...\n');
    process.exit(2);
  }
  const { hits, scanned } = scan(inputs, { secretsOnly });
  for (const h of hits) {
    const where = isArchive(h.input) ? `${h.input}!${h.path}` : path.join(h.input, h.path);
    process.stdout.write(`${where}: ${h.rule} (${h.excerpt}${h.count > 1 ? `, and ${h.count - 1} more` : ''})\n`);
  }
  for (const s of scanned) process.stdout.write(`${hits.some((h) => h.input === s.input) ? 'FAIL' : 'ok'} ${s.input}: ${s.files} files\n`);
  process.exitCode = hits.length ? 1 : 0;
}
