import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { scan } from '../scripts/release-scan.mjs';

const SCRIPT = path.join(import.meta.dirname, '../scripts/release-scan.mjs');
const HOME = '/Users/builder';
const CHECKOUT = '/Users/builder/src/svall';
const TMP = '/private/var/folders/xy/abc123/T';
const where = { home: HOME, checkout: CHECKOUT, tmp: TMP };

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-release-scan-'));
  dirs.push(d);
  return d;
};

/** A release tree under releases/<version>/ holding `files`, as the build stages one. */
function release(files: Record<string, string> = {}): string {
  const root = tmp();
  const stage = path.join(root, 'releases', 'v1.0.0');
  const all: Record<string, string> = {
    'bin/svall': '#!/bin/sh\nexec "$SVALL_RELEASE_ROOT/node/bin/node" "$SVALL_RELEASE_ROOT/lib/svall.mjs" "$@"\n',
    'lib/svall.mjs': "import fs from 'node:fs';\nimport { createRequire as __cr } from 'node:module';\nconst u = __require(\"util\");\n",
    'hooks/agent-hook.mjs': "import net from 'node:net';\n",
    'node/bin/node': 'ELF built at /Users/admin/build/ws/out/../deps/cares/src/lib/',
    'web-mobile/index.html': '<script type="module" src="./assets/index.js"></script>',
    'release.json': '{"version":"v1.0.0"}\n',
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
    fs.writeFileSync(path.join(stage, rel), text);
  }
  return root;
}

const rules = (dir: string, o = {}): string[] => scan([dir], { ...where, ...o }).hits.map((h) => `${h.path} ${h.rule}`);

describe('a release with nothing in it that should not be there', () => {
  test('passes, with Node\'s own build paths in the pinned runtime', () => {
    expect(rules(release())).toEqual([]);
  });

  test('a module a dependency only tries for is one the release does not carry, as Node would look for it above the release', () => {
    expect(rules(release({ 'lib/svalld.mjs': 'try { __require("bufferutil"); } catch {}\ntry { require("supports-color"); } catch {}\n' })).sort()).toEqual([
      'releases/v1.0.0/lib/svalld.mjs module not in the release',
    ]);
  });
});

describe('secrets', () => {
  test('a private key, tokens and keys are hits, and the report never repeats the secret', () => {
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ'.repeat(3)}\n-----END OPENSSH PRIVATE KEY-----\n`;
    const token = `sk-ant-oat01-${'Q'.repeat(40)}`;
    const dir = release({
      'home/CLAUDE.md': pem,
      'lib/svalld.mjs': `const t = "${token}";\nconst g = "ghp_${'a1B2'.repeat(9)}";\n`,
      'web-mobile/assets/index.js': `k="AKIA${'Z'.repeat(16)}";s="tskey-auth-${'k'.repeat(20)}"`,
    });
    const { hits } = scan([dir], where);
    expect(hits.map((h) => `${h.path} ${h.rule}`).sort()).toEqual([
      'releases/v1.0.0/home/CLAUDE.md private key',
      'releases/v1.0.0/lib/svalld.mjs Anthropic key',
      'releases/v1.0.0/lib/svalld.mjs GitHub token',
      'releases/v1.0.0/web-mobile/assets/index.js AWS key',
      'releases/v1.0.0/web-mobile/assets/index.js Tailscale key',
    ]);
    const said = JSON.stringify(hits);
    expect(said).not.toContain(token);
    expect(said).not.toContain('Q'.repeat(20));
  });

  test('a private key a bundler inlined as a string, with its line breaks escaped, is a hit', () => {
    const body = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ'.repeat(3);
    expect(rules(release({
      'lib/svall.mjs': `import fs from 'node:fs';\nconst k = "-----BEGIN OPENSSH PRIVATE KEY-----\\n${body}\\n-----END OPENSSH PRIVATE KEY-----\\n";\n`,
      'lib/svalld.mjs': `const k = "-----BEGIN RSA PRIVATE KEY-----\\r\\nProc-Type: 4,ENCRYPTED\\r\\nDEK-Info: AES-128-CBC,00FF\\r\\n\\r\\n${body}";\n`,
    })).sort()).toEqual([
      'releases/v1.0.0/lib/svall.mjs private key',
      'releases/v1.0.0/lib/svalld.mjs private key',
    ]);
  });

  test('Codex\'s login is a hit by its file name and by the tokens in it', () => {
    const jwt = (claims: object): string => ['{"alg":"RS256","typ":"JWT"}', JSON.stringify(claims), 'signature-bytes-here']
      .map((p) => Buffer.from(p).toString('base64url')).join('.');
    const auth = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: jwt({ email: 'a@b.c' }), access_token: jwt({ scp: ['openid'] }), refresh_token: 'rt_opaque', account_id: 'x' },
      last_refresh: '2026-09-28T00:00:00Z',
    });
    expect(rules(release({ 'home/.codex/auth.json': auth, 'lib/svalld.mjs': `const t = "${jwt({ sub: 'x' })}";\n` })).sort()).toEqual([
      'releases/v1.0.0/home/.codex/auth.json JWT',
      'releases/v1.0.0/home/.codex/auth.json credential file',
      'releases/v1.0.0/lib/svalld.mjs JWT',
    ]);
  });

  test('a PEM header alone, as a TLS library carries one, is not a key', () => {
    expect(rules(release({ 'node/bin/node': 'fmt -----BEGIN %s----- and -----BEGIN PRIVATE KEY-----' }))).toEqual([]);
  });

  test('a credential file is a hit by its name', () => {
    expect(rules(release({ 'home/.credentials.json': '{}', 'agent-profiles/id_ed25519': 'x', 'release/signing.key': 'x' })).sort()).toEqual([
      'releases/v1.0.0/agent-profiles/id_ed25519 credential file',
      'releases/v1.0.0/home/.credentials.json credential file',
      'releases/v1.0.0/release/signing.key credential file',
    ]);
  });
});

describe('developer paths', () => {
  test('any /Users/ path, and this builder\'s home, checkout and temp folder, are hits', () => {
    expect(rules(release({
      'lib/svall.mjs': "import fs from 'node:fs';\nconst a = '/Users/someone/x';\n",
      'systemd/svalld.service.in': `ExecStart=${CHECKOUT}/node_modules/.bin/tsx\n`,
      'bin/rsync': `debug map ${TMP}/svall-rsync-1/flist.o`,
    })).sort()).toEqual([
      'releases/v1.0.0/bin/rsync developer path',
      'releases/v1.0.0/lib/svall.mjs developer path',
      'releases/v1.0.0/systemd/svalld.service.in developer path',
    ]);
  });

  test('the pinned runtime is held only to this builder\'s paths, not to Node\'s', () => {
    expect(rules(release({ 'node/bin/node': `/Users/admin/build/ws/out and ${HOME}/.nvm` }))).toEqual(['releases/v1.0.0/node/bin/node developer path']);
  });

  test('a home or temp folder too short to mean anything is not looked for', () => {
    expect(rules(release({ 'lib/svalld.mjs': "const t = '/tmp/x'; const r = '/root';\n" }), { home: '/root', tmp: '/tmp' })).toEqual([]);
  });
});

describe('checkout dependencies', () => {
  test('a module the release does not carry, a link out of it and a checkout folder are hits', () => {
    const dir = release({
      'lib/svall.mjs': "import fs from 'node:fs';\nimport { z } from 'zod';\nconst p = require(\"@svall/protocol\");\n",
      'hooks/claude-status.mjs': "import x from '../lib/missing.mjs';\n",
      'lib/node_modules/zod/index.js': '',
    });
    fs.symlinkSync(CHECKOUT, path.join(dir, 'releases/v1.0.0/lib/checkout'));
    fs.symlinkSync('../../../../elsewhere', path.join(dir, 'releases/v1.0.0/lib/up'));
    fs.symlinkSync('svall.mjs', path.join(dir, 'releases/v1.0.0/lib/same'));
    expect(rules(dir).sort()).toEqual([
      'releases/v1.0.0/hooks/claude-status.mjs module not in the release',
      'releases/v1.0.0/lib/checkout link out of the release',
      'releases/v1.0.0/lib/node_modules checkout content',
      'releases/v1.0.0/lib/svall.mjs module not in the release',
      'releases/v1.0.0/lib/up link out of the release',
    ]);
  });

  test('ObjC.import in a script string is not a module', () => {
    expect(rules(release({ 'lib/svall.mjs': "import fs from 'node:fs';\nconst s = `ObjC.import('AppKit'); x`;\n" }))).toEqual([]);
  });
});

describe('what it reads', () => {
  test('an archive is unpacked and its members named after it', () => {
    const dir = release({ 'lib/svalld.mjs': "const a = '/Users/someone';\n" });
    const archive = path.join(tmp(), 'svall-companion-v1.0.0-linux-x64.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', dir, 'releases']);
    const { hits, scanned } = scan([archive], where);
    expect(hits.map((h) => `${h.input} ${h.path} ${h.rule}`)).toEqual([`${archive} releases/v1.0.0/lib/svalld.mjs developer path`]);
    expect(scanned[0].files).toBeGreaterThan(5);
  });

  test('--secrets-only looks at logs for secrets and nothing else', () => {
    const logs = tmp();
    fs.writeFileSync(path.join(logs, 'run.log'), `$ docker exec … ${CHECKOUT} /Users/runner/work\n`);
    expect(scan([logs], { ...where, secretsOnly: true }).hits).toEqual([]);
    fs.writeFileSync(path.join(logs, 'daemon.log'), `token ghs_${'x'.repeat(36)}\n`);
    expect(scan([logs], { ...where, secretsOnly: true }).hits.map((h) => h.rule)).toEqual(['GitHub token']);
  });

  test('--secrets-only still names a file that holds credentials by its name', () => {
    const logs = tmp();
    for (const f of ['run.log', '.credentials.json', 'id_ed25519', 'auth.json']) fs.writeFileSync(path.join(logs, f), 'nothing a content rule knows\n');
    expect(scan([logs], { ...where, secretsOnly: true }).hits.map((h) => `${h.path} ${h.rule}`).sort()).toEqual([
      '.credentials.json credential file',
      'auth.json credential file',
      'id_ed25519 credential file',
    ]);
  });

  test('the command exits 1 on a hit and names it, and 0 on a clean release', () => {
    const run = (dir: string) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env: { ...process.env, HOME } });
    const clean = run(release());
    expect(clean.status).toBe(0);
    const dirty = run(release({ 'lib/svalld.mjs': "const a = '/Users/someone';\n" }));
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toMatch(/releases\/v1\.0\.0\/lib\/svalld\.mjs: developer path/);
  });

  test('the command scans when it is run through a link to the checkout', () => {
    const real = tmp();
    fs.mkdirSync(path.join(real, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(real, 'scripts', 'release-scan.mjs'));
    const link = path.join(tmp(), 'checkout');
    fs.symlinkSync(real, link);
    const dirty = spawnSync(process.execPath, [path.join(link, 'scripts', 'release-scan.mjs'), release({ 'lib/svalld.mjs': "const a = '/Users/someone';\n" })],
      { encoding: 'utf8', env: { ...process.env, HOME } });
    expect(dirty.stdout).toMatch(/releases\/v1\.0\.0\/lib\/svalld\.mjs: developer path/);
    expect(dirty.status).toBe(1);
  });
});
