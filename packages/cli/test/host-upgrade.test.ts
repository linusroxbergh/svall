import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MachineId, OLDEST_STATE_SCHEMA_VERSION, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, emptyState } from '@svall/protocol';
import { resolvePaths } from '@svall/svalld/paths';
import { tokenFor } from '@svall/svalld/placement/workers';
import { shq } from '@svall/svalld/text';
import { addHost, doctorHost, rollbackHost, upgradeHost } from '../src/controller/host.js';
import { runProcess } from '../src/controller/process.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { SshMaster } from '../src/controller/ssh.js';
import { companionArchive, ephemeralSigner } from './controller/archive.js';
import {
  BASE, DF, DOCTOR, FLEET, HOME, MAC, OS_RELEASE, OTHER_FLEET, OTHER_MAC, OWN_TMUX, REMOTE, SERVES, TOKEN, archive, daemon, deps, doctorJson, events, fleet,
  refreshed, signer, smuggling, ssh, step, unticked, useHostWorld, work,
} from './controller/host-world.js';

useHostWorld();

describe('host upgrade', () => {
  const registered = (): MachineRegistry => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE,
    }, REMOTE);
    return registry;
  };

  /**
   * A companion on this machine whose far commands run here, each release given as [version, protocol, state schema or null].
   * Its setup keeps a new release only if its daemon comes up (no `down-<release>` file) and speaks this client's protocol,
   * else goes back to the release it replaced (after a reinstall, the newest other kept), as a real setup does.
   */
  async function farMachine(o: { releases: [string, number, (number | null)?][]; accepts?: (release: string) => boolean; pins?: string }) {
    const home = path.join(work, 'far');
    const base = `${home}/.local/share/svall`;
    const now = () => path.basename(fs.readlinkSync(`${base}/current`));
    const d = await daemon({ release: now, accepts: () => o.accepts?.(now()) ?? true });
    const svall = (version: string, protocol: number, schema: number | null = STATE_SCHEMA_VERSION) => `#!/bin/sh
base='${base}'
now() { basename "$(readlink "$base/current")"; }
fleet='${home}/.svall'
[ -n "$SVALL_HOME" ] && fleet=$SVALL_HOME
[ "$1" = -p ] && { fleet='${home}/.svall-'$2; shift 2; }
case "$1" in
  connection-info) [ -f '${home}/.svall/by-folder' ] && [ -z "$SVALL_HOME" ] && exit 1; printf '%s\\n' '${JSON.stringify({ fleetId: FLEET, machineId: REMOTE, release: version, protocol, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' })}' ;;
  version) x=; for k in worker role fleetId; do [ -f "$fleet/$k" ] && x="$x,\\"$k\\":$(cat "$fleet/$k")"; done
    printf '%s%s\\n}\\n' '${JSON.stringify({ release: version, machineId: REMOTE, protocol, ...(schema !== null && { stateSchema: schema }) }, null, 2).slice(0, -2)}' "$x" ;;
  doctor) [ -f '${home}/.svall/by-folder' ] && [ -z "$SVALL_HOME" ] && exit 1; printf '%s\\n' '${DOCTOR}' ;;
  worker) printf '%s\\n' "$@" > '${home}/.svall/worker-args' && cat > '${home}/.svall/worker-token' ;;
  setup)
    if [ "$2" = --rollback ]; then
      to=\${3:-$(ls -t "$base/releases" | grep -vx "$(now)" | head -1)}
      [ -n "$to" ] || { echo "no release under $base/releases to go back to" >&2; exit 1; }
      [ -d "$base/releases/$to" ] || { echo "no release at $base/releases/$to to go back to" >&2; exit 1; }
      ln -sfn "$base/releases/$to" "$base/current" && echo "current -> $base/releases/$to"
      exit
    fi
    was=$(now)
    new=$(tar -tzf "$3" | sed -n 's|^releases/\\([^/]*\\)/.*|\\1|p' | head -1)
    tar -xzf "$3" -C "$base" && ln -sfn "$base/releases/$new" "$base/current" && echo "release $new -> $base/releases/$new"
    if [ -e "$base/down-$new" ] || ! grep -q '"protocol": ${protocol},' "$base/releases/$new/release.json"; then
      back=$was; [ "$was" != "$new" ] || back=$(ls -t "$base/releases" | grep -vx "$new" | head -1)
      if [ -n "$back" ]; then ln -sfn "$base/releases/$back" "$base/current" && echo "the daemon did not answer: current -> $base/releases/$back"; fi
    fi ;;
esac
`;
    for (const [version, protocol, schema] of o.releases) {
      fs.mkdirSync(`${base}/releases/${version}/bin`, { recursive: true });
      fs.writeFileSync(`${base}/releases/${version}/bin/svall`, svall(version, protocol, schema), { mode: 0o755 });
      fs.mkdirSync(`${base}/releases/${version}/release`);
      fs.copyFileSync(o.pins ?? signer.signers, `${base}/releases/${version}/release/allowed_signers`);
    }
    fs.symlinkSync(`${base}/releases/${o.releases.at(-1)![0]}`, `${base}/current`);
    // the fleet's unit there, which runs it as this fleet's worker, as its worker.json says
    const units = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(units, { recursive: true });
    fs.writeFileSync(path.join(units, 'svall-svalld@private.service'), `ExecStart="${base}/current/bin/svalld" "--worker"\n`);
    serves(SERVES);
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64', home, svallBase: base }, REMOTE);
    ssh.reply(['uname', '-sm'], { stdout: 'Linux aarch64\n' });
    ssh.reply(['cat', '/etc/os-release'], { stdout: OS_RELEASE });
    ssh.execute({});
    return { base, now, registry, close: d.close, svall, archive: companionArchive(work, { signedBy: signer.key, svall: svall('1.2.3', PROTOCOL_VERSION) }) };
  }

  it('sweeps what runs that stopped short left over a day ago, and nothing fresher, of another name or deeper', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const cache = `${work}/far/.cache/svall`;
    const id = () => crypto.randomUUID();
    const gone = [`companion-1.2.2-${id()}.tar.gz`, `staging-1.2.2-${id()}`];
    const kept = [`companion-1.2.2-${id()}.tar.gz`, `staging-1.2.2-${id()}`, `companion-1.2.2-${id()}.tar.gz`, 'companion-1.2.2.tar.gz', 'staging-1.2.2', 'staging-1.2.2-not-a-run-id', 'notes.txt', 'nested'];
    const nested = path.join('nested', `companion-1.2.2-${id()}.tar.gz`);
    for (const d of [gone[1], kept[1], 'staging-1.2.2', 'staging-1.2.2-not-a-run-id', 'nested']) fs.mkdirSync(path.join(cache, d), { recursive: true });
    for (const f of [gone[0], kept[0], kept[2], 'companion-1.2.2.tar.gz', 'notes.txt', nested]) fs.writeFileSync(path.join(cache, f), 'x');
    const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);
    const age = (f: string, hours: number) => fs.utimesSync(path.join(cache, f), ago(hours), ago(hours));
    // a day is the line: 25 h goes, 23 h stays, as another home's run may be under way that long
    for (const f of gone) age(f, 25);
    for (const f of kept.slice(0, 2)) age(f, 23);
    for (const f of [...kept.slice(3), nested]) age(f, 48);
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(fs.readdirSync(cache).sort()).toEqual([...kept].sort());
    expect(fs.existsSync(path.join(cache, nested))).toBe(true);
  });

  it('installs a release that speaks a newer protocol with its own setup, and keeps it', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION - 1]] });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(far.now()).toBe('1.2.3');
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    const setup = ssh.remoteCalls().find((w) => w.includes('setup'))!;
    expect(setup[0]).toMatch(new RegExp(`^${work}/far/\\.cache/svall/staging-1\\.2\\.3-[0-9a-f-]{36}/releases/1\\.2\\.3/bin/svall$`));
    expect(ssh.remoteCalls().some((w) => w.includes('--rollback'))).toBe(false);
  });

  it('ends with the machine\'s agent setup rows, its link given 30 s, and is ready with them as what will not work there yet', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION - 1]] });
    const asked: [MachineId, number][] = [];
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry, setupRows: (m, wait) => { asked.push([m, wait]); return Promise.resolve([unticked('claude:mcp:linear')]); } }));
    await far.close();
    expect(asked).toEqual([[REMOTE, 30_000]]);
    expect(events.filter((e) => e.status !== 'start').at(-1)?.step).toBe('mirror:claude:mcp:linear');
    expect(out).toEqual({ result: 'ready', actions: [], setup: [step('mirror:claude:mcp:linear').at(-1)] });
  });

  it('checks the new release against the signers the installed release pins, with the far machine\'s own tools', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(step('install').at(-1)?.raw).toContain(`signed by a key ${far.base}/current/release/allowed_signers pins`);
    const verify = ssh.remoteCalls().findIndex((w) => w.includes('svall-unpack'));
    const setup = ssh.remoteCalls().findIndex((w) => w.includes('setup'));
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(setup);
  });

  it('refuses a release the installed release\'s signers do not vouch for, before anything it carries runs', async () => {
    // a controller that trusts another key, as one whose own signers were replaced would
    const intruder = ephemeralSigner(work);
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const ran = path.join(work, 'staged-svall-ran');
    const archive = companionArchive(work, { signedBy: intruder.key, signersInside: intruder.signers, svall: `#!/bin/sh\ntouch '${ran}'\n` });
    const out = await upgradeHost('trift', { release: archive }, deps({ registry: far.registry, verify: intruder.verify }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('install').at(-1)).toMatchObject({ status: 'fail', detail: `the uploaded release is not signed by a key ${far.base}/current/release/allowed_signers pins` });
    expect(fs.existsSync(ran)).toBe(false);
    expect(ssh.remoteCalls().some((w) => w.includes('setup'))).toBe(false);
    expect(far.now()).toBe('1.2.2');
  });

  it('checks with the system\'s own tools, whatever a relative entry in the far PATH finds in the upload first', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const ran = path.join(work, 'shim-ran');
    const shim = `#!/bin/sh\necho "$0" >> '${ran}'\nexit 0\n`;
    const archive = companionArchive(work, {
      signedBy: signer.key, svall: far.svall('1.2.3', PROTOCOL_VERSION),
      files: Object.fromEntries(['grep', 'ssh-keygen', 'sha256sum', 'tar'].map((t) => [`node_modules/.bin/${t}`, shim])),
    });
    ssh.execute({ path: `node_modules/.bin:${process.env.PATH}` });
    const out = await upgradeHost('trift', { release: archive }, deps({ registry: far.registry }));
    await far.close();
    expect(fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8') : '').toBe('');
    expect(out.result).toBe('ready');
    expect(step('install').at(-1)?.raw).toContain(`signed by a key ${far.base}/current/release/allowed_signers pins`);
  });

  it('refuses a release when the installed release has lost its signers file, rather than taking it for one that pins none', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    fs.rmSync(`${far.base}/releases/1.2.2/release/allowed_signers`);
    const intruder = ephemeralSigner(work);
    const ran = path.join(work, 'staged-svall-ran');
    const archive = companionArchive(work, { signedBy: intruder.key, signersInside: intruder.signers, svall: `#!/bin/sh\ntouch '${ran}'\n` });
    const out = await upgradeHost('trift', { release: archive }, deps({ registry: far.registry, verify: intruder.verify }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('install').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining(`${far.base}/current/release/allowed_signers is missing`) });
    expect(fs.existsSync(ran)).toBe(false);
    expect(far.now()).toBe('1.2.2');
  });

  it('holds a repeat host add over an installed release to the signers that release pins, as an upgrade is', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    // this Mac's home is the far one, so the paths host add builds from it land in the far machine's
    const config = path.join(work, 'config');
    const file = path.join(config, 'machines.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { machines: Record<string, { home: string }> };
    saved.machines[far.registry.localId].home = path.join(work, 'far');
    fs.writeFileSync(file, JSON.stringify(saved));
    for (const [match, stdout] of [
      [['uname', '-sm'], 'Linux aarch64\n'], [['cat', '/etc/os-release'], OS_RELEASE], [['svall-home'], `${work}/far\nlinus\n`],
      [['svall-tools'], ['tailscale', 'git', 'systemctl', 'loginctl'].map((t) => `${t} yes\n`).join('')],
      [['svall-tmux-version'], OWN_TMUX], [['svall-space'], DF], [['svall-linger'], 'Linger=yes\n'],
    ] as [string[], string][]) ssh.reply(match, { stdout });
    for (const bin of ['claude', 'codex', 'opencode']) ssh.reply([bin], { code: 127 });
    const intruder = ephemeralSigner(work);
    const ran = path.join(work, 'staged-svall-ran');
    const archive = companionArchive(work, { signedBy: intruder.key, signersInside: intruder.signers, svall: `#!/bin/sh\ntouch '${ran}'\n` });
    const out = await addHost({ name: 'trift', ssh: 'trift.test', release: archive }, deps({ registry: MachineRegistry.load(config), verify: intruder.verify }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('install').at(-1)).toMatchObject({ status: 'fail', detail: `the uploaded release is not signed by a key ${far.base}/current/release/allowed_signers pins` });
    expect(fs.existsSync(ran)).toBe(false);
    expect(far.now()).toBe('1.2.2');
  });

  it('says when a machine has no release installed to pin a signer, so only this controller\'s signers vouched for the new one', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const { bootstrapSetup } = await import('../src/controller/install.js');
    const master = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    const out = await bootstrapSetup(master, {
      staging: `${work}/fresh/.cache/svall/staging-1.2.3`, archive: far.archive, version: '1.2.3', allowUnsigned: false,
      installed: `${work}/fresh/.local/share/svall`,
    });
    await master.close();
    await far.close();
    expect(out).toContain('no release is installed there yet, so only this controller\'s signers vouched for it');
  });

  it('says when the installed release pins no signer, so only this controller\'s signers vouched for the new one', async () => {
    const unpinned = path.join(work, 'no-signers');
    fs.writeFileSync(unpinned, '# no release key is committed yet\n');
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: unpinned });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('ready');
    expect(step('install').at(-1)?.raw).toContain('the installed release pins no signer, so only this controller\'s signers vouched for it');
  });

  it('checks an unsigned release with --allow-unsigned by its digests alone, and refuses one whose files do not match them', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const archive = companionArchive(work, { svall: far.svall('1.2.3', PROTOCOL_VERSION) });
    const out = await upgradeHost('trift', { release: archive, allowUnsigned: true }, deps({ registry: far.registry }));
    expect(out.result).toBe('ready');
    expect(step('install').at(-1)?.raw).toContain('unsigned, checked by its digests alone');

    // the same archive with a file changed after its manifest was written
    const tree = fs.mkdtempSync(path.join(work, 'tampered-'));
    execFileSync('tar', ['-xzf', archive, '-C', tree]);
    fs.appendFileSync(path.join(tree, 'releases', '1.2.3', 'bin', 'svall'), '# changed\n');
    const tampered = path.join(work, 'tampered.tar.gz');
    execFileSync('tar', ['-czf', tampered, '-C', tree, 'releases']);
    const { bootstrapSetup } = await import('../src/controller/install.js');
    const master = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    await expect(bootstrapSetup(master, {
      staging: `${work}/far/.cache/svall/staging-x`, archive: tampered, version: '1.2.3', allowUnsigned: true, installed: far.base,
    })).rejects.toThrow(/SHA256SUMS/);
    await master.close();
    await far.close();
  });

  it('checks the signature over an upgrade\'s SHA256SUMS before it unpacks anything else the archive holds', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const archive = companionArchive(work, { signedBy: ephemeralSigner(work).key });
    const staging = `${work}/far/.cache/svall/staging-1.2.3`;
    const { bootstrapSetup } = await import('../src/controller/install.js');
    const master = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    // what the staging folder holds when the check has refused, read just before it is removed
    let unpacked: string[] = [];
    const watched = {
      run: (argv: string[], o?: Parameters<SshMaster['run']>[1]) => {
        if (argv[0] === 'rm') unpacked = fs.readdirSync(staging, { recursive: true }).map(String).sort();
        return master.run(argv, o);
      },
    } as SshMaster;
    await expect(bootstrapSetup(watched, { staging, archive, version: '1.2.3', allowUnsigned: false, installed: far.base })).rejects.toThrow(/not signed by a key/);
    await master.close();
    await far.close();
    expect(unpacked).toEqual(['releases', 'releases/1.2.3', 'releases/1.2.3/SHA256SUMS', 'releases/1.2.3/SHA256SUMS.sig']);
  });

  it('refuses a release the pinned key signed that arrives under another release\'s name, before anything it carries runs', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const ran = path.join(work, 'staged-svall-ran');
    const older = companionArchive(work, { version: '1.2.1', signedBy: signer.key, svall: `#!/bin/sh\ntouch '${ran}'\n` });
    const tree = fs.mkdtempSync(path.join(work, 'renamed-'));
    execFileSync('tar', ['-xzf', older, '-C', tree]);
    fs.renameSync(path.join(tree, 'releases', '1.2.1'), path.join(tree, 'releases', '1.2.3'));
    const renamed = path.join(work, 'renamed.tar.gz');
    execFileSync('tar', ['-czf', renamed, '-C', tree, 'releases']);
    const { bootstrapSetup } = await import('../src/controller/install.js');
    const master = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    await expect(bootstrapSetup(master, {
      staging: `${work}/far/.cache/svall/staging-1.2.3`, archive: renamed, version: '1.2.3', allowUnsigned: false, installed: far.base,
    })).rejects.toThrow(/release\.json does not name release 1\.2\.3/);
    await master.close();
    await far.close();
    expect(fs.existsSync(ran)).toBe(false);
  });

  it('refuses an archive that gives the far check one SHA256SUMS to verify and another to check the files by, before anything it carries runs', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const ran = (name: string): string => path.join(work, `ran-${name}`);
    const { bootstrapSetup } = await import('../src/controller/install.js');
    const master = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    for (const { name, archive } of smuggling(ran)) {
      const out = bootstrapSetup(master, {
        staging: `${work}/far/.cache/svall/staging-1.2.3`, archive, version: '1.2.3', allowUnsigned: false, installed: far.base,
      });
      // a link is the system tar's to refuse or to write through; the far check refuses what it wrote either way
      await expect(out, name).rejects.toThrow(name === 'link' ? /./ : /^the uploaded archive holds .*(is not a path in releases\/1\.2\.3|twice)$/);
      expect(fs.existsSync(ran(name)), name).toBe(false);
    }
    await master.close();
    await far.close();
    expect(far.now()).toBe('1.2.2');
  });

  it('refuses an archive holding a member whose name has a backslash, which tar lists escaped', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], pins: signer.signers });
    const tree = fs.mkdtempSync(path.join(work, 'backslash-'));
    fs.mkdirSync(path.join(tree, 'releases', '1.2.3'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'releases', '1.2.3', 'a\\b'), '');
    const archive = path.join(work, 'backslash.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', tree, 'releases']);
    const { bootstrapSetup } = await import('../src/controller/install.js');
    const master = await SshMaster.open({ destination: 'trift.test', socketDir: ssh.socketDir });
    await expect(bootstrapSetup(master, {
      staging: `${work}/far/.cache/svall/staging-1.2.3`, archive, version: '1.2.3', allowUnsigned: false, installed: far.base,
    })).rejects.toThrow(/^the uploaded archive holds "releases\/1\.2\.3\/a\\.*b", which is not a path in releases\/1\.2\.3$/);
    await master.close();
    await far.close();
  });

  it('tells the release the machine runs once it answers on it after an upgrade', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const runs = vi.fn();
    await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry, runs }));
    await far.close();
    expect(runs.mock.calls).toEqual([['1.2.3']]);
  });

  it('puts a new release that does not answer back on the release the machine ran before, and says which it runs', async () => {
    // an older release is the newest by mtime, which is where a rollback that names nothing would go
    const far = await farMachine({ releases: [['1.2.1', PROTOCOL_VERSION], ['1.2.2', PROTOCOL_VERSION]], accepts: (r) => r !== '1.2.3' });
    fs.utimesSync(`${far.base}/releases/1.2.1`, new Date(), new Date(Date.now() + 60_000));
    const runs = vi.fn();
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry, runs }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(far.now()).toBe('1.2.2');
    expect(runs.mock.calls).toEqual([['1.2.2']]);
    expect(ssh.remoteCalls()).toContainEqual([`${far.base}/releases/1.2.3/bin/svall`, 'setup', '--rollback', '1.2.2']);
    expect(step('rollback').at(-1)).toMatchObject({ status: 'warn', detail: 'back on 1.2.2', action: 'see why: svall host doctor trift', raw: expect.stringContaining("read the service's log") });
  });

  it('after a reinstall under the name it ran, goes back to the newest release kept there, and never calls the new tree the one it ran before', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]], accepts: (r) => r !== '1.2.3' });
    const runs = vi.fn();
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry, runs }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(far.now()).toBe('1.2.2');
    expect(runs.mock.calls).toEqual([['1.2.2']]);
    expect(ssh.remoteCalls()).toContainEqual([`${far.base}/releases/1.2.3/bin/svall`, 'setup', '--rollback']);
    expect(step('rollback').at(-1)).toMatchObject({ detail: 'on 1.2.2, the newest release kept there', action: 'see why: svall host doctor trift' });
  });

  it('after a reinstall under the name it ran that its own setup took back, stays on the release that setup went back to', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]], accepts: (r) => r !== '1.2.3' });
    fs.writeFileSync(`${far.base}/down-1.2.3`, '');
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(far.now()).toBe('1.2.2');
    expect(ssh.remoteCalls()).toContainEqual([`${far.base}/releases/1.2.3/bin/svall`, 'setup', '--rollback', '1.2.2']);
    expect(step('rollback').at(-1)).toMatchObject({ status: 'warn', detail: 'on 1.2.2, the newest release kept there' });
  });

  it('after a reinstall under the only name it had, says no other release is kept to go back to', async () => {
    const far = await farMachine({ releases: [['1.2.3', PROTOCOL_VERSION]], accepts: (r) => r !== '1.2.3' });
    await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(step('rollback').at(-1)).toMatchObject({
      status: 'fail', detail: 'did not finish; stays on 1.2.3: no earlier release is kept there', action: 'see why: svall host doctor trift',
      raw: expect.stringMatching(/svall host upgrade trift --rollback <release> puts back a release kept there$/),
    });
  });

  it('says a release before that could not be put back, and the one the machine stays on, with what its setup said behind', async () => {
    let base = '';
    // the release before goes once the new one is found not to answer, so going back to it fails
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]], accepts: (r) => { if (r === '1.2.3') fs.rmSync(`${base}/releases/1.2.2`, { recursive: true, force: true }); return r !== '1.2.3'; } });
    base = far.base;
    await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(step('rollback').at(-1)).toMatchObject({
      status: 'fail', detail: 'did not finish; on 1.2.3; 1.2.2 could not be put back', action: 'see why: svall host doctor trift',
      raw: expect.stringContaining(`svall setup --rollback 1.2.2 exited 1: no release at ${base}/releases/1.2.2 to go back to`),
    });
  });

  it('counts a new release whose own setup put the old one back as not answering, and says which the machine runs', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    fs.writeFileSync(`${far.base}/down-1.2.3`, '');
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('probe').at(-1)).toMatchObject({ status: 'warn', detail: 'does not answer', raw: expect.stringContaining('1.2.2') });
    expect(far.now()).toBe('1.2.2');
    expect(step('rollback').at(-1)).toMatchObject({ status: 'warn', detail: 'back on 1.2.2' });
  });

  it('keeps what the far machine said when its new release does not answer', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    ssh.reply(['connection-info'], { stderr: 'no port file at /home/linus/.svall/port', code: 1 });
    await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(step('probe').at(-1)).toMatchObject({ status: 'warn', detail: 'does not answer', raw: expect.stringContaining('no port file at /home/linus/.svall/port') });
  });

  const unitDown = JSON.stringify({ checks: JSON.parse(DOCTOR).checks.map((c: { name: string }) => (c.name === 'systemd'
    ? { name: 'systemd', status: 'fail', detail: 'svall-svalld@private.service: loaded, inactive (dead), disabled' } : c)) });

  it('puts a new release whose fleet unit is not running back on the release before, though its daemon answers', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    ssh.reply(['doctor', '--json'], { stdout: unitDown, code: 1 });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('probe').at(-1)).toMatchObject({ status: 'warn', detail: 'does not answer', raw: expect.stringContaining('svall-svalld@private.service') });
    expect(far.now()).toBe('1.2.2');
  });

  it('fails a rollback whose fleet unit is not running after it, and says which release the machine runs', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]] });
    ssh.reply(['doctor', '--json'], { stdout: unitDown, code: 1 });
    const runs = vi.fn();
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry, runs }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(runs.mock.calls).toEqual([['1.2.2']]);
    expect(step('probe').at(-1)).toMatchObject({ status: 'fail', detail: 'does not answer', action: 'see why: svall host doctor trift', raw: expect.stringContaining('svall-svalld@private.service') });
    expect(step('probe').at(-1)?.raw).toContain('trift runs release 1.2.2');
  });

  /** The far machine's systemctl, which writes each call it is given to `log`, first on the far PATH; it fails while `broken` is there. */
  const farSystemctl = (broken = path.join(work, 'systemctl-broken')): string => {
    const bin = path.join(work, 'far-bin');
    const log = path.join(work, 'systemctl.log');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\n[ -e '${broken}' ] && { echo 'Failed to connect to bus' >&2; exit 1; }\necho "$*" >> '${log}'\n`, { mode: 0o755 });
    ssh.execute({ path: `${bin}:${process.env.PATH}` });
    return log;
  };

  it('upgrade stops and removes a gateway unit it finds there and makes the provisioned unit the worker, with no other step', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const systemctl = farSystemctl();
    const home = path.join(work, 'far');
    const units = path.join(home, '.config', 'systemd', 'user');
    fs.writeFileSync(path.join(units, 'svall-gateway.service'), '[Service]\n');
    fs.writeFileSync(path.join(units, 'svall-svalld@private.service'), `ExecStart="${far.base}/current/bin/svalld"\n`);
    fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: REMOTE }));

    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();

    expect(out).toEqual({ result: 'ready', actions: [] });
    const mac = far.registry.localMachine().name;
    expect(fs.readFileSync(path.join(home, '.svall', 'worker-args'), 'utf8').split('\n')).toEqual(['worker', 'enroll', '--home-machine', MAC, '--home-name', mac, '--fleet-id', FLEET, '--home-platform', far.registry.localMachine().platform, '']);
    expect(fs.readFileSync(path.join(home, '.svall', 'worker-token'), 'utf8')).toBe(tokenFor(resolvePaths(fleet), REMOTE));
    expect(fs.readFileSync(systemctl, 'utf8')).toBe('--user disable --now svall-gateway.service\n--user daemon-reload\n');
    expect(fs.existsSync(path.join(units, 'svall-gateway.service'))).toBe(false);
    expect(step('enrol').at(-1)).toMatchObject({ status: 'ok', detail: 'joined this fleet', raw: expect.stringContaining('; svall-gateway.service is stopped and removed') });
    expect(events.filter((e) => e.status !== 'start').map((e) => e.step)).toEqual(['machine', 'master', 'os', 'release', 'upload', 'install', 'probe', 'enrol']);
    expect(refreshed).toBe(1);
  });

  /** What the far fleet home serves, as its `svall version --json` names it: the home it is a worker of, or none. */
  const serves = (worker?: object): void => {
    fs.mkdirSync(path.join(work, 'far', '.svall'), { recursive: true });
    const at = path.join(work, 'far', '.svall', 'worker');
    if (worker) fs.writeFileSync(at, JSON.stringify(worker));
    else fs.rmSync(at, { force: true });
  };

  /** The machine as an earlier release left it: its gateway unit, a fleet unit without --worker, fleet.json naming it, and no worker.json there. */
  const oldGateway = (): { units: string } => {
    serves();
    const units = path.join(work, 'far', '.config', 'systemd', 'user');
    fs.writeFileSync(path.join(units, 'svall-gateway.service'), '[Service]\n');
    fs.writeFileSync(path.join(units, 'svall-svalld@private.service'), `ExecStart="${work}/far/.local/share/svall/current/bin/svalld"\n`);
    fs.mkdirSync(path.join(work, 'far', '.svall'), { recursive: true });
    fs.writeFileSync(path.join(fleet, 'fleet.json'), JSON.stringify({ id: FLEET, gatewayMachineId: REMOTE }));
    return { units };
  };

  /** The signers the release an upgrade installed pins, as a real release carries them, for the upgrade after it. */
  const pinSigners = (base: string): void => {
    fs.mkdirSync(`${base}/current/release`, { recursive: true });
    fs.copyFileSync(signer.signers, `${base}/current/release/allowed_signers`);
  };

  it('enrols nothing while the gateway unit there will not stop, and a run again makes the machine the worker', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const broken = path.join(work, 'systemctl-broken');
    fs.writeFileSync(broken, '');
    farSystemctl(broken);
    const { units } = oldGateway();

    const first = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    expect(first).toMatchObject({ result: 'actions', stopped: 'enrol' });
    expect(step('enrol').at(-1)).toMatchObject({ status: 'fail', detail: 'the old gateway service there did not stop', raw: 'systemctl --user disable --now svall-gateway.service exited 1: Failed to connect to bus' });
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    expect(fs.existsSync(path.join(units, 'svall-gateway.service'))).toBe(true);

    fs.rmSync(broken);
    events.length = 0;
    pinSigners(far.base);
    const again = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(again).toEqual({ result: 'ready', actions: [] });
    expect(fs.existsSync(path.join(units, 'svall-gateway.service'))).toBe(false);
    expect(ssh.remoteCalls().filter((w) => w.includes('enroll'))).toHaveLength(1);
  });

  it('upgrade of a machine already the worker stops and removes a gateway unit it finds there, enrolling nothing', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const systemctl = farSystemctl();
    const { units } = oldGateway();
    serves(SERVES);
    fs.writeFileSync(path.join(units, 'svall-svalld@private.service'), `ExecStart="${far.base}/current/bin/svalld" "--worker"\n`);
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(ssh.remoteCalls()).toContainEqual(expect.arrayContaining(['systemctl --user disable --now "$(basename "$1")" && rm -f "$1" && systemctl --user daemon-reload']));
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    expect(fs.readFileSync(systemctl, 'utf8')).toBe('--user disable --now svall-gateway.service\n--user daemon-reload\n');
    expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'ok', detail: 'trift serves this fleet as a worker; svall-gateway.service is stopped and removed' });
    expect(events.map((e) => e.step)).not.toContain('fleet');
  });

  it('leaves a machine that serves this fleet as a worker as it is, past the release it installs', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const systemctl = farSystemctl();
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'skip', detail: 'trift serves this fleet as a worker' });
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    expect(fs.existsSync(systemctl)).toBe(false);
  });

  it("upgrades the fleet's home, which this machine serves as a worker, and leaves it the home: no enrol and no agent setup there", async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    serves();
    fs.writeFileSync(path.join(work, 'far', '.svall', 'role'), '"home"');
    fs.writeFileSync(path.join(work, 'far', '.svall', 'fleetId'), JSON.stringify(FLEET));
    fs.writeFileSync(resolvePaths(fleet).workerFile, JSON.stringify({ homeMachineId: REMOTE, fleetId: FLEET, token: 't'.repeat(48), homeName: 'trift' }));
    const setupRows = vi.fn(() => Promise.resolve([unticked('claude:mcp:linear')]));
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry, setupRows }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(far.now()).toBe('1.2.3');
    expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'skip', detail: "trift is this fleet's home, and its daemon runs the new release as the home" });
    expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    expect(fs.existsSync(path.join(work, 'far', '.svall', 'worker-args'))).toBe(false);
    expect(setupRows).not.toHaveBeenCalled();
    expect(events.filter((e) => e.status !== 'start').map((e) => e.step)).toEqual(['machine', 'master', 'os', 'release', 'upload', 'install', 'probe', 'enrol']);
  });

  describe('from a named fleet here, whose profile the home there does not have', () => {
    const named = () => ({ home: fleet, profile: 'fartest' });
    const dialing = (o: object = {}) => ({ homeMachineId: REMOTE, fleetId: FLEET, token: 't'.repeat(48), homeName: 'trift', homeSsh: 'trift', homeSocket: `${work}/far/.svall/w/0123456789ab.sock`, homeSvallBase: BASE, ...o });
    const asHome = () => {
      fs.writeFileSync(path.join(work, 'far', '.svall', 'role'), '"home"');
      fs.writeFileSync(path.join(work, 'far', '.svall', 'fleetId'), JSON.stringify(FLEET));
      fs.writeFileSync(resolvePaths(fleet).workerFile, JSON.stringify(dialing()));
      fs.writeFileSync(path.join(work, 'far', '.svall', 'by-folder'), '');
    };

    it('upgrades the home by the folder worker.json names, and leaves it the home with no fleet enrolled', async () => {
      const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
      asHome();
      const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry, fleet: named() }));
      await far.close();
      expect(out).toEqual({ result: 'ready', actions: [] });
      expect(far.now()).toBe('1.2.3');
      expect(step('enrol').at(-1)).toEqual({ step: 'enrol', status: 'skip', detail: "trift is this fleet's home, and its daemon runs the new release as the home" });
      expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
      expect(ssh.remoteCalls().some((w) => w.includes('fartest'))).toBe(false);
      expect(ssh.remoteCalls().some((w) => w.some((a) => a.includes(`SVALL_HOME=${work}/far/.svall`)))).toBe(true);
      expect(fs.existsSync(path.join(work, 'far', '.svall', 'worker-args'))).toBe(false);
    });

    it('enrols nothing and says why when worker.json cannot be read', async () => {
      const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
      fs.writeFileSync(resolvePaths(fleet).workerFile, '{ broken');
      const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry, fleet: named() }));
      await far.close();
      expect(out.result).not.toBe('ready');
      expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    });

    it('rolls a far home back and probes it by its folder', async () => {
      const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]] });
      asHome();
      await rollbackHost('trift', {}, deps({ registry: far.registry, fleet: named() }));
      await far.close();
      expect(step('probe').at(-1)).toMatchObject({ status: 'ok' });
      expect(ssh.remoteCalls().filter((w) => w.includes('connection-info')).every((w) => w.some((a) => a.includes('SVALL_HOME=')))).toBe(true);
    });

    it('finds the machine by the id worker.json holds, whichever name the registry gives it', async () => {
      const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
      asHome();
      const out = await upgradeHost(REMOTE, { release: far.archive }, deps({ registry: far.registry, fleet: named() }));
      await far.close();
      expect(out).toEqual({ result: 'ready', actions: [] });
      expect(step('machine').at(-1)).toMatchObject({ status: 'ok', detail: expect.stringContaining('trift at') });
    });

    it('enrols nothing on the machine worker.json names as home, though the fleet there answers as another', async () => {
      const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
      asHome();
      fs.writeFileSync(path.join(work, 'far', '.svall', 'fleetId'), JSON.stringify(OTHER_FLEET));
      const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry, fleet: named() }));
      await far.close();
      expect(out.result).not.toBe('ready');
      expect(step('enrol').at(-1)).toMatchObject({ status: 'fail', detail: expect.stringContaining('not enrolled') });
      expect(ssh.remoteCalls().some((w) => w.includes('enroll'))).toBe(false);
    });

    it('host doctor reads the same fleet, and says it is the home', async () => {
      const far = await farMachine({ releases: [['1.2.3', PROTOCOL_VERSION]] });
      asHome();
      const report = await doctorHost('trift', deps({ registry: far.registry, fleet: named() }));
      await far.close();
      expect(report.checks.find((c) => c.name === 'worker')).toEqual({ name: 'worker', status: 'ok', detail: 'home of this fleet' });
      expect(ssh.remoteCalls().some((w) => w.includes('fartest'))).toBe(false);
    });
  });

  it('uploads, installs and enrols nothing over a fleet home there that serves another Mac as a worker, and changes nothing there', async () => {
    const action = 'on bea-mbp, run svall host remove trift';
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const systemctl = farSystemctl();
    const { units } = oldGateway();
    serves({ homeMachineId: OTHER_MAC, homeName: 'bea-mbp', fleetId: OTHER_FLEET });
    events.length = 0;
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'actions', stopped: 'release', actions: [action] });
    expect(step('release').at(-1)).toEqual({ step: 'release', status: 'fail', detail: 'trift already serves bea-mbp as a worker; remove it from bea-mbp first', action });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup') || w.includes('enroll'))).toBe(false);
    expect(far.now()).toBe('1.2.2');
    expect(JSON.parse(fs.readFileSync(path.join(fleet, 'fleet.json'), 'utf8'))).toEqual({ id: FLEET, gatewayMachineId: REMOTE });
    expect(fs.existsSync(path.join(units, 'svall-gateway.service'))).toBe(true);
    expect(fs.existsSync(systemctl)).toBe(false);
  });

  it('uploads and installs nothing on a machine that runs a newer release than this Mac, which installing would take back', async () => {
    const far = await farMachine({ releases: [['1.10.0', PROTOCOL_VERSION]] });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'actions', stopped: 'release', actions: ['update svall on this Mac'] });
    expect(step('release').at(-1)).toMatchObject({ status: 'fail', detail: 'trift runs release 1.10.0, newer than 1.2.3, the one this Mac would install' });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup'))).toBe(false);
    expect(far.now()).toBe('1.10.0');
  });

  it('enrols a worker unit there whose worker.json names another fleet of this Mac', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    serves({ ...SERVES, fleetId: OTHER_FLEET });
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(ssh.remoteCalls().filter((w) => w.includes('enroll'))).toHaveLength(1);
  });

  it('enrols a fleet of this Mac that runs no unit there yet', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    serves();
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry, fleet: { home: fleet, profile: 'work' } }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(ssh.remoteCalls().filter((w) => w.includes('enroll'))).toEqual([expect.arrayContaining(['-p', 'work', 'worker', 'enroll'])]);
  });

  it('upgrade runs where owner.json and route.json name another machine', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
    const owner = (home: string, fleetId: string) => {
      fs.writeFileSync(path.join(home, 'owner.json'), JSON.stringify({ fleetId, generation: 2, ownerMachineId: REMOTE }));
      fs.mkdirSync(path.join(home, 'controller'), { recursive: true });
      fs.writeFileSync(path.join(home, 'controller', 'route.json'), JSON.stringify({ ownerMachineId: REMOTE, generation: 2, at: '2026-10-01T00:00:00.000Z' }));
    };
    owner(fleet, FLEET);
    const lab = path.join(work, '.svall-lab');
    fs.mkdirSync(lab);
    fs.writeFileSync(path.join(lab, 'fleet.json'), JSON.stringify({ id: OTHER_FLEET }));
    owner(lab, OTHER_FLEET);
    const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry }));
    await far.close();
    expect(step('machine').at(-1)?.status).toBe('ok');
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(far.now()).toBe('1.2.3');
  });

  it('puts the machine back on the release before when asked, with its own svall, and probes it as an upgrade does', async () => {
    const far = await farMachine({ releases: [['1.2.1', PROTOCOL_VERSION], ['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]] });
    fs.utimesSync(`${far.base}/releases/1.2.1`, new Date(0), new Date(0));
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    const named = await rollbackHost('trift', { to: '1.2.1' }, deps({ registry: far.registry }));
    await far.close();
    expect([out, named]).toEqual([{ result: 'ready', actions: [] }, { result: 'ready', actions: [] }]);
    expect(ssh.remoteCalls().filter((w) => w.includes('--rollback'))).toEqual([
      [`${far.base}/releases/1.2.3/bin/svall`, 'setup', '--rollback'],
      [`${far.base}/releases/1.2.2/bin/svall`, 'setup', '--rollback', '1.2.1'],
    ]);
    expect(far.now()).toBe('1.2.1');
    expect(step('probe').map((e) => e.detail)).toEqual(['answers', 'answers']);
    expect(step('rollback').map((e) => e.detail)).toEqual(['back on 1.2.2', 'back on 1.2.1']);
  });

  it('probes a rollback onto a release that speaks the protocol before this controller\'s', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION - 1], ['1.2.3', PROTOCOL_VERSION]] });
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(far.now()).toBe('1.2.2');
    expect(step('probe').at(-1)).toMatchObject({ status: 'ok', detail: 'answers' });
  });

  /** A fleet on the far machine, kept in `dir` under its home, whose state.json is at `version`. */
  const fleetState = (dir: string, version: number): string => {
    const file = path.join(work, 'far', dir, 'state.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...emptyState(), version }, null, 2)}\n`);
    return file;
  };

  it('refuses a rollback onto a release that reads an older state schema than a fleet there keeps, before anything changes', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION, STATE_SCHEMA_VERSION - 1], ['1.2.3', PROTOCOL_VERSION]] });
    fleetState('.svall', STATE_SCHEMA_VERSION - 1);
    const newer = fleetState('.svall-work', STATE_SCHEMA_VERSION);
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    const named = await rollbackHost('trift', { to: '1.2.2' }, deps({ registry: far.registry }));
    await far.close();
    expect([out.result, named.result]).toEqual(['actions', 'actions']);
    expect(step('rollback')).toEqual([1, 2].map(() => ({
      step: 'rollback', status: 'fail', detail: "cannot go back to 1.2.2: the fleet's state is newer than that release reads; stays on 1.2.3",
      raw: `${newer} is at state schema ${STATE_SCHEMA_VERSION}, and release 1.2.2 reads ${STATE_SCHEMA_VERSION - 1}: its svalld would refuse to start after going back`,
    })));
    expect(ssh.remoteCalls().some((w) => w.includes('--rollback'))).toBe(false);
    expect(far.now()).toBe('1.2.3');
  });

  it('refuses a rollback onto a release carrying no tmux while a fleet\'s server runs a tmux the machine\'s own cannot reach', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]] });
    const served = path.join(work, 'served');
    fs.writeFileSync(`${far.base}/releases/1.2.3/bin/tmux`, `#!/bin/sh\ncat '${served}'\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(work, 'far', '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(work, 'far', '.local', 'bin', 'tmux'), '#!/bin/sh\necho "tmux 3.4"\n', { mode: 0o755 });
    fs.mkdirSync(path.join(work, 'far', '.svall'), { recursive: true });
    const sock = path.join(work, 'far', '.svall', 'tmux.sock');
    const server = net.createServer().listen(sock);
    await once(server, 'listening');
    fs.writeFileSync(served, 'tmux 3.7c\n');
    const refused = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    fs.writeFileSync(served, 'tmux 3.4\n');
    const back = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    server.close();
    await far.close();
    expect(refused.result).toBe('actions');
    expect(step('rollback')[0]).toEqual({
      step: 'rollback', status: 'fail', detail: "cannot go back to 1.2.2: its robots' terminals run on a tmux that release lacks; stays on 1.2.3",
      raw: `${sock} is served by tmux 3.7c, and release 1.2.2 carries no tmux and would run the machine's (tmux 3.4), which cannot reach it`,
    });
    expect(back.result).toBe('ready');
    expect(far.now()).toBe('1.2.2');
  });

  it('refuses a rollback onto a release that reads an older state schema than a fleet in a home named for a command svall keeps', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION, STATE_SCHEMA_VERSION - 1], ['1.2.3', PROTOCOL_VERSION]] });
    fleetState('.svall', STATE_SCHEMA_VERSION - 1);
    const newer = fleetState('.svall-host', STATE_SCHEMA_VERSION);
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    await far.close();
    expect(out.result).toBe('actions');
    expect(step('rollback').at(-1)).toMatchObject({ status: 'fail', raw: expect.stringContaining(`${newer} is at state schema ${STATE_SCHEMA_VERSION}`) });
    expect(far.now()).toBe('1.2.3');
  });

  it('goes back onto a release that reads every fleet\'s state there, whatever a folder no profile names holds', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION, STATE_SCHEMA_VERSION - 1], ['1.2.3', PROTOCOL_VERSION]] });
    fleetState('.svall', STATE_SCHEMA_VERSION - 1);
    fleetState('.svall-work.old', STATE_SCHEMA_VERSION);
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(far.now()).toBe('1.2.2');
  });

  it('refuses a rollback onto a release that does not say which state schema it reads only while a fleet there is newer than any release read', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION, null], ['1.2.3', PROTOCOL_VERSION]] });
    const state = fleetState('.svall', OLDEST_STATE_SCHEMA_VERSION + 1);
    const refused = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    expect(refused.result).toBe('actions');
    expect(step('rollback').at(-1)).toMatchObject({
      status: 'fail', detail: "cannot go back to 1.2.2: the fleet's state is newer than that release reads; stays on 1.2.3",
      raw: `release 1.2.2 does not say which state schema it reads, and ${state} is at state schema ${OLDEST_STATE_SCHEMA_VERSION + 1}, newer than the oldest a release has read (${OLDEST_STATE_SCHEMA_VERSION}): its svalld could refuse to start after going back`,
    });
    expect(far.now()).toBe('1.2.3');
    fleetState('.svall', OLDEST_STATE_SCHEMA_VERSION);
    const out = await rollbackHost('trift', {}, deps({ registry: far.registry }));
    await far.close();
    expect(out).toEqual({ result: 'ready', actions: [] });
    expect(far.now()).toBe('1.2.2');
  });

  it('rolls back from the command line, keeping what it found as the machine\'s last check, and refuses a rollback asked with a release to install', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]] });
    far.registry.save();
    // a doctor's check from before, which host list would go on showing
    fs.writeFileSync(path.join(work, 'config', 'checks.json'), JSON.stringify({ [REMOTE]: { at: 1, failed: 2, warned: 0, release: '1.2.3' } }));
    const { hostCommands, lastChecks } = await import('../src/commands/host.js');
    const cli = () => hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => path.join(work, 'config'));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await cli().parseAsync(['upgrade', 'trift', '--rollback'], { from: 'user' });
      await expect(cli().parseAsync(['upgrade', 'trift', '--rollback', '--release', far.archive], { from: 'user' })).rejects.toThrow(/--rollback/);
    } finally {
      out.mockRestore();
      await far.close();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(far.now()).toBe('1.2.2');
    expect(lastChecks(path.join(work, 'config'))).toEqual({ [REMOTE]: { at: expect.any(Number), failed: 0, warned: 0, release: '1.2.2' } });
  });

  it('says which release the machine runs when a rollback fails or its daemon does not answer after it', async () => {
    const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION], ['1.2.3', PROTOCOL_VERSION]], accepts: (r) => r !== '1.2.2' });
    const runs = vi.fn();
    const silent = await rollbackHost('trift', {}, deps({ registry: far.registry, runs }));
    const none = await rollbackHost('trift', { to: '1.0.0' }, deps({ registry: far.registry, runs }));
    await far.close();
    // the far rollback to a release not kept there fails, and the machine stays on 1.2.2
    expect(runs.mock.calls).toEqual([['1.2.2'], ['1.2.2']]);
    expect(silent.result).toBe('actions');
    expect(step('probe')[0]).toMatchObject({ status: 'fail', action: 'see why: svall host doctor trift', raw: expect.stringContaining('trift runs release 1.2.2') });
    expect(none.result).toBe('actions');
    expect(step('rollback').at(-1)).toMatchObject({ status: 'fail', detail: 'did not finish; on 1.2.2', action: 'see why: svall host doctor trift', raw: expect.stringContaining('trift runs release 1.2.2') });
    expect(step('rollback').at(-1)?.raw).toContain('svall host upgrade trift --rollback <release>');
  });

  it('says the machine is not reachable when an upgrade or a rollback cannot connect, and what to check', async () => {
    const registry = MachineRegistry.load(path.join(work, 'config'));
    registry.add({ name: 'trift', ssh: 'refused.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    for (const run of [() => upgradeHost('trift', {}, deps({ registry })), () => rollbackHost('trift', {}, deps({ registry }))]) {
      events.length = 0;
      ssh.clearReplies();
      expect((await run()).result).toBe('actions');
      expect(step('master').at(-1)).toMatchObject({ status: 'fail', detail: 'trift is not reachable from this Mac', action: 'check that it is on and on Tailscale', raw: expect.stringContaining('refused.test') });
    }
  });

  it('keeps a new release whose companion doctor exits 1 over a check unrelated to the daemon', async () => {
    ssh.reply(['uname', '-sm'], { stdout: 'Linux aarch64\n' });
    ssh.reply(['cat', '/etc/os-release'], { stdout: OS_RELEASE });
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mkdir'], {});
    ssh.reply(['rm'], {});
    ssh.reply(['readlink'], { stdout: `${BASE}/releases/1.2.2\n` });
    ssh.reply(['svall-unpack'], { stdout: 'pinned\n' });
    ssh.reply(['setup', '--release'], { stdout: 'release 1.2.3 installed\n' });
    ssh.reply(['doctor', '--json'], { stdout: doctorJson({ status: 'warn', detail: 'off' }).replace('"tmux 3.4"}', '"tmux 3.4"},{"name":"hooks","status":"fail","detail":"not installed"}'), code: 1 });
    ssh.reply(['svall-units'], { stdout: 'worker\n' });
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.3', protocol: PROTOCOL_VERSION, machineId: REMOTE, worker: SERVES }, null, 2) });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const out = await upgradeHost('trift', { release: archive() }, deps({ registry: registered() }));
    await d.close();
    expect(ssh.remoteCalls().some((w) => w.includes('--rollback'))).toBe(false);
    expect(step('probe').at(-1)).toMatchObject({ status: 'ok' });
    expect(out.result).toBe('ready');
  });

  it('uploads and installs nothing on a machine that answers as another than the registry names', async () => {
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.2', protocol: PROTOCOL_VERSION, machineId: OTHER_MAC }, null, 2) });
    const out = await upgradeHost('trift', { release: archive() }, deps({ registry: registered() }));
    expect(out.result).toBe('actions');
    expect(step('master').at(-1)).toMatchObject({ status: 'fail', detail: 'trift.test now reaches another machine than trift', raw: expect.stringContaining(`now reaches machine ${OTHER_MAC}`) });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup'))).toBe(false);
  });

  it('uploads and installs nothing on an Ubuntu older than the release runs on', async () => {
    ssh.reply(['version', '--json'], { stdout: JSON.stringify({ release: '1.2.2', protocol: PROTOCOL_VERSION, machineId: REMOTE }, null, 2) });
    ssh.reply(['uname', '-sm'], { stdout: 'Linux aarch64\n' });
    ssh.reply(['cat', '/etc/os-release'], { stdout: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="20.04"\n' });
    const out = await upgradeHost('trift', { release: archive() }, deps({ registry: registered() }));
    expect(out).toMatchObject({ result: 'actions', stopped: 'os' });
    expect(step('os').at(-1)).toMatchObject({ status: 'fail', detail: 'Ubuntu 20.04 is older than 22.04, the oldest release the companion runs on' });
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"') || w.includes('setup'))).toBe(false);
  });

  it('uploads all the same when the sweep cannot run', async () => {
    ssh.reply(['uname', '-sm'], { stdout: 'Linux aarch64\n' });
    ssh.reply(['cat', '/etc/os-release'], { stdout: OS_RELEASE });
    for (const m of ['cat > "$1"', 'mkdir', 'rm']) ssh.reply([m], {});
    ssh.reply(['readlink'], { stdout: `${BASE}/releases/1.2.2\n` });
    ssh.reply(['svall-unpack'], { stdout: 'pinned\n' });
    ssh.reply(['setup', '--release'], { stdout: 'release 1.2.3 installed\n' });
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const openMaster = async (destination: string) => {
      const m = await SshMaster.open({ destination, socketDir: ssh.socketDir });
      const run = m.run.bind(m);
      m.run = (argv, o) => (argv.some((w) => w.includes('svall-sweep')) ? Promise.reject(new Error('the sweep timed out')) : run(argv, o));
      return m;
    };
    await upgradeHost('trift', { release: archive() }, deps({ registry: registered(), openMaster }));
    await d.close();
    expect(step('upload').at(-1)?.status).toBe('ok');
    expect(ssh.remoteCalls().some((w) => w.includes('cat > "$1"'))).toBe(true);
  });

  it('deletes the archive it uploaded and the release it unpacked once the release is installed, each run only its own', async () => {
    ssh.reply(['uname', '-sm'], { stdout: 'Linux aarch64\n' });
    ssh.reply(['cat', '/etc/os-release'], { stdout: OS_RELEASE });
    ssh.reply(['cat > "$1"'], {});
    ssh.reply(['mkdir'], {});
    ssh.reply(['rm'], {});
    ssh.reply(['readlink'], { stdout: `${BASE}/releases/1.2.2\n` });
    ssh.reply(['svall-unpack'], { stdout: 'pinned\n' });
    ssh.reply(['setup', '--release'], { stdout: 'release 1.2.3 installed\n' });
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR });
    const d = await daemon();
    ssh.answer({ fleetId: FLEET, machineId: REMOTE, release: '1.2.3', protocol: PROTOCOL_VERSION, host: '127.0.0.1', port: d.port, token: TOKEN, fleetHome: '/home/linus/.svall' });
    const registry = registered();
    await upgradeHost('trift', { release: archive() }, deps({ registry }));
    await upgradeHost('trift', { release: archive() }, deps({ registry }));
    await d.close();
    // each run uploads to a path of its own and removes only that, so one run's cleanup never takes another's archive
    const uploads = ssh.remoteCalls().filter((w) => w.includes('cat > "$1"')).map((w) => w.at(-1)!);
    const removed = ssh.remoteCalls().filter((w) => w[0] === 'rm');
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).not.toBe(uploads[1]);
    for (const [i, upload] of uploads.entries()) {
      expect(upload).toMatch(new RegExp(`^${HOME}/\\.cache/svall/companion-1\\.2\\.3-[0-9a-f-]{36}\\.tar\\.gz$`));
      expect(removed[i]).toEqual(['rm', '-rf', upload.replace('/companion-', '/staging-').replace(/\.tar\.gz$/, ''), upload]);
    }
  });

  describe('a fleet named apart on its two machines, the server its worker under the private profile there', () => {
    const T = 'a'.repeat(48);
    const cameBack = () => {
      serves(SERVES);
      fs.writeFileSync(resolvePaths(fleet).workersFile, JSON.stringify({ [REMOTE]: { token: T, addedAt: 1, profile: 'private' } }));
    };
    const named = (w: string[]) => w.includes('mac2') || w.includes("'mac2'");

    it('upgrade asks that fleet, finds it serving this one, and enrols nothing', async () => {
      const far = await farMachine({ releases: [['1.2.2', PROTOCOL_VERSION]] });
      cameBack();
      const out = await upgradeHost('trift', { release: far.archive }, deps({ registry: far.registry, fleet: { home: fleet, profile: 'mac2' } }));
      await far.close();
      expect(out.result).toBe('ready');
      expect(step('enrol').at(-1)).toMatchObject({ status: 'skip' });
      expect(ssh.remoteCalls().filter(named)).toEqual([]);
      expect(tokenFor(resolvePaths(fleet), REMOTE)).toBe(T);
    });

    it('doctor reads that fleet as this one\'s worker', async () => {
      const far = await farMachine({ releases: [['1.2.3', PROTOCOL_VERSION]] });
      cameBack();
      const report = await doctorHost('trift', deps({ registry: far.registry, fleet: { home: fleet, profile: 'mac2' } }));
      await far.close();
      expect(report.checks.find((c) => c.name === 'worker')).toMatchObject({ status: 'ok' });
      expect(ssh.remoteCalls().filter(named)).toEqual([]);
    });
  });
});

// GNU tar writes a member spelled another way, or one under a link, over a file it extracted by name, where the Mac's
// bsdtar matches every spelling and refuses the link, so these run on a Linux image such as svall-it:machine
const gnuTar = process.env.SVALL_TEST_GNU_TAR;

describe.skipIf(!gnuTar)('the far check under GNU tar (set SVALL_TEST_GNU_TAR=<docker image> to run)', () => {
  const box = `svall-far-check-${crypto.randomBytes(3).toString('hex')}`;
  const base = '/root/.local/share/svall';
  const docker = (argv: string[], input?: string | Uint8Array) => runProcess('docker', argv, { timeoutMs: 60_000, input });
  // each far command runs in the container as its login shell would split the line ssh hands it
  const far = { run: (argv: string[], o: { input?: string | Uint8Array } = {}) => docker(['exec', '-i', box, 'sh', '-c', argv.join(' ')], o.input) } as SshMaster;

  beforeAll(async () => {
    const r = await docker(['run', '-d', '--rm', '--name', box, gnuTar!, 'sleep', '900']);
    expect(r.stderr).toBe('');
  });
  afterAll(async () => { await docker(['rm', '-f', box]); });

  it('checks the files against the SHA256SUMS the pinned key signed, whatever the archive writes over it', async () => {
    const pinned = `mkdir -p ${base}/releases/1.2.2/release && cat > ${base}/releases/1.2.2/release/allowed_signers && ln -sfn ${base}/releases/1.2.2 ${base}/current`;
    expect((await far.run(['sh', '-c', shq(pinned)], { input: fs.readFileSync(signer.signers) })).code).toBe(0);
    const { bootstrapSetup, uploadArchive } = await import('../src/controller/install.js');
    const install = async (archive: string): Promise<string> => {
      const remote = `/root/uploads/${path.basename(archive)}`;
      await uploadArchive(far, { archive, remote });
      return bootstrapSetup(far, { staging: '/root/staging-1.2.3', archive: remote, version: '1.2.3', allowUnsigned: false, installed: base });
    };
    const good = companionArchive(work, { signedBy: signer.key, svall: '#!/bin/sh\necho release 1.2.3 installed\n' });
    expect(await install(good)).toContain(`signed by a key ${base}/current/release/allowed_signers pins`);
    for (const { name, archive } of smuggling((n) => `/tmp/ran-${n}`)) {
      await expect(install(archive), name).rejects.toThrow(name === 'link' ? /not signed by a key/ : /^the uploaded archive holds .*(is not a path in releases\/1\.2\.3|twice)$/);
      expect((await far.run(['test', '-e', `/tmp/ran-${name}`])).code, name).toBe(1);
    }
  });
});
