import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MachineId, type SetupRow } from '@svall/protocol';
import { shq } from '@svall/svalld/text';
import { removeHost, rowCheck, rowStep } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { SshMaster } from '../src/controller/ssh.js';
import { waitFor } from '../../svalld/test/helpers.js';
import { BASE, DOCTOR, HOME, REMOTE, THERE, deps, fleet, okRow, ssh, ticked, unticked, useHostWorld, varRow, work } from './controller/host-world.js';

useHostWorld();

describe('a host command told to stop', () => {
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it.each(['SIGTERM', 'SIGQUIT'] as const)('ends the master it opened on %s rather than leaving it running', async (signal) => {
    const config = path.join(work, 'config');
    const registry = MachineRegistry.load(config);
    registry.add({
      name: 'trift', ssh: 'trift.test', platform: 'linux', arch: 'arm64',
      home: HOME, svallBase: BASE,
    }, REMOTE);
    registry.save();
    // the far doctor is still running when the app's Stop arrives
    ssh.reply(['doctor', '--json'], { stdout: DOCTOR, delayMs: 15_000 });
    // plain node, as the release shim runs it: the tsx CLI turns a signal into an exit, which runs exit hooks
    const root = path.resolve(import.meta.dirname, '../../..');
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'packages/cli/src/main.ts'), 'host', 'doctor', 'trift', '--json'], {
      cwd: root, env: { ...process.env, SVALL_CONFIG_DIR: config }, stdio: 'ignore',
    });
    const exited = new Promise((resolve) => { child.on('close', resolve); });
    await waitFor(() => ssh.remoteCalls().some((w) => w.includes('doctor')), 30_000);
    const state = path.join(ssh.dir, 'state');
    const [marker] = fs.readdirSync(state).filter((f) => f.endsWith('.master'));
    const master = Number(fs.readFileSync(path.join(state, marker), 'utf8'));
    expect(alive(master)).toBe(true);

    child.kill(signal);
    await exited;
    await waitFor(() => !alive(master), 5000);
  });
});

describe('the localhost sshd integration', () => {
  const live = process.env.SVALL_TEST_SSH;
  it.skipIf(!live)('runs a host probe over a real master (set SVALL_TEST_SSH=<destination> to run)', async () => {
    // the fake ssh is first on PATH for every other test in this file; a real master needs the real one
    const fake = process.env.PATH ?? '';
    process.env.PATH = fake.split(':').filter((p) => !p.startsWith(ssh.dir)).join(':');
    try {
      const master = await SshMaster.open({ destination: live as string });
      try {
        const script = 'printf "%s\\n" "$0" "$1" "$HOME" "$USER"';
        const r = await master.run(['sh', '-c', shq(script), shq('svall-home'), shq("a b'c")]);
        expect(r.code).toBe(0);
        // the far side's login shell split the line back into exactly the words the probe named
        const [marker, word, home, user] = r.stdout.split('\n');
        expect([marker, word]).toEqual(['svall-home', "a b'c"]);
        expect(home.startsWith('/')).toBe(true);
        expect(user).not.toBe('');
      } finally {
        await master.close();
      }
    } finally {
      process.env.PATH = fake;
    }
  });
});

describe('the last line a run prints', () => {
  it('names what each command did as the Machines panel does', async () => {
    const { doneLine } = await import('../src/commands/host.js');
    expect(doneLine('add', 'trift')).toBe('trift is added');
    expect(doneLine('upgrade', 'trift')).toBe('trift is upgraded');
    expect(doneLine('rollback', 'trift')).toBe('trift is rolled back');
    expect(doneLine('remove', 'trift')).toBe('trift is removed');
    expect(doneLine('remove', 'trift', { forget: true })).toBe('trift is forgotten');
  });

  it('the outcome line reads ready when nothing is left to do, counts the things to fix otherwise, then lists what of the agent setup will not work there yet', async () => {
    const { doctorVerdict, outcomeText } = await import('../src/commands/host.js');
    const ready = 'trift is ready. Robots you move there keep working while this Mac sleeps.';
    const linger = 'ssh trift, then loginctl enable-linger linus';
    const login = 'ssh trift, then claude auth login';
    const linear = { ...rowStep(unticked('claude:mcp:linear')) };
    const listed = '  linear  keys not copied (env.LINEAR_API_KEY)  → svall -p work host consent trift claude:mcp:linear on';
    const work = { there: { ssh: 'trift.test', svall: 'svall -p work' } };
    expect(outcomeText({ result: 'ready', actions: [] }, 'add', 'trift')).toBe(ready);
    expect(outcomeText({ result: 'ready', actions: [] }, 'upgrade', 'trift')).toBe(ready);
    expect(outcomeText({ result: 'ready', actions: [], setup: [linear] }, 'upgrade', 'trift', work))
      .toBe(`trift is ready. 1 part of your agent setup will not work there yet:\n${listed}`);
    expect(outcomeText({ result: 'actions', actions: [linger] }, 'add', 'trift')).toBe(`trift has 1 thing to fix:\n  ${linger}`);
    expect(outcomeText({ result: 'actions', actions: [linger, login] }, 'upgrade', 'trift')).toBe(`trift has 2 things to fix:\n  ${linger}\n  ${login}`);
    expect(outcomeText({ result: 'actions', actions: [linger], setup: [linear] }, 'add', 'trift', work))
      .toBe(`trift has 1 thing to fix:\n  ${linger}\n1 part of your agent setup will not work on trift yet:\n${listed}`);
    // a list with nothing to do about any of it will not work there, not yet
    const unread = rowStep({ key: 'unreadable:/Users/ada/x.json', status: 'warn', detail: 'd', gap: { name: 'x.json', what: 'not copied: this Mac cannot read it' } });
    expect(outcomeText({ result: 'ready', actions: [], setup: [unread] }, 'add', 'trift', work))
      .toBe('trift is ready. 1 part of your agent setup will not work there:\n  x.json  not copied: this Mac cannot read it');
    // a server that runs only on a Mac stands aside: one line of its own, after the list or alone
    const chrome = rowStep({ key: 'maconly:claude:chrome', status: 'skip', detail: 'd', gap: { name: 'chrome', what: 'runs only on a Mac' } });
    expect(outcomeText({ result: 'ready', actions: [], setup: [chrome] }, 'add', 'trift', work)).toBe('trift is ready. chrome runs only on a Mac.');
    expect(outcomeText({ result: 'actions', actions: [linger], setup: [chrome] }, 'add', 'trift', work))
      .toBe(`trift has 1 thing to fix:\n  ${linger}\nchrome runs only on a Mac.`);
    expect(outcomeText({ result: 'ready', actions: [], setup: [chrome, linear] }, 'add', 'trift', work).split('\n'))
      .toEqual(['trift is ready. 1 part of your agent setup will not work there yet:', ...listed.split('\n'), '  chrome runs only on a Mac']);
    expect(outcomeText({ result: 'actions', actions: [linger], stopped: 'install' }, 'add', 'trift'))
      .toBe(`stopped at install; trift has 1 thing to fix:\n  ${linger}`);
    expect(outcomeText({ result: 'actions', actions: [linger] }, 'rollback', 'trift')).toBe(`still to do:\n  ${linger}`);
    expect(outcomeText({ result: 'ready', actions: [] }, 'remove', 'trift', { forget: true })).toBe('trift is forgotten');

    const ok = { name: 'release', status: 'ok' as const, detail: '1.2.3' };
    const warn = { name: 'tmux', status: 'warn' as const, detail: '3.4' };
    const fail = (name: string) => ({ name, status: 'fail' as const, detail: 'inactive' });
    expect(doctorVerdict([ok, warn, warn], 'trift', THERE)).toBe(ready);
    expect(doctorVerdict([ok, rowCheck({ key: 'maconly:claude:chrome', status: 'skip', detail: 'd', gap: { name: 'chrome', what: 'runs only on a Mac' } })], 'trift', THERE))
      .toBe('trift is ready. chrome runs only on a Mac.');
    expect(doctorVerdict([ok, warn, fail('systemd')], 'trift', THERE)).toBe('trift has 1 thing to fix: systemd');
    expect(doctorVerdict([fail('systemd'), fail('release')], 'trift', THERE)).toBe('trift has 2 things to fix: systemd, release');
    // a mirror row by its own line, though two servers' rows read alike; rows that only ask to check again are not listed
    const again = (key: string) => rowCheck({ key, status: 'warn', action: 'check trift again', detail: 'not checked: trift is not reachable' });
    expect(doctorVerdict([rowCheck(unticked('claude:mcp:github')), rowCheck(unticked('codex:mcp:github')), again('var:X'), again('var:Y'), fail('systemd')], 'trift', THERE)).toBe([
      'trift has 1 thing to fix: systemd',
      '2 parts of your agent setup will not work on trift yet:',
      '  github  keys not copied (env.GITHUB_API_KEY)  → svall host consent trift claude:mcp:github on',
      '  github  keys not copied (env.GITHUB_API_KEY)  → svall host consent trift codex:mcp:github on',
    ].join('\n'));
  });

  it('lists each row of what will not work there by name, what it lacks and the one thing to do from this Mac\'s terminal', async () => {
    const { setupList } = await import('../src/commands/host.js');
    const row = (key: string, o: Partial<SetupRow> & Pick<SetupRow, 'gap'>): SetupRow => ({ key, status: 'warn', detail: 'd', ...o });
    expect(setupList([
      unticked('claude:mcp:linear'),
      row('oauth:claude:mcp:notion', { action: 'log in once on trift', run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118, gap: { name: 'notion', what: 'not logged in' } }),
      varRow('GAMMA_TOKEN'),
      row('runtime:/Users/ada/bin/db-mcp', { action: 'install db-mcp on trift', tick: { item: 'runtime:/Users/ada/bin/db-mcp', fields: ['skip'], on: false, preview: [] }, gap: { name: 'db-mcp', what: 'not installed; db needs it' } }),
      row('claude:mcp:odd', { action: 'check trift again', gap: { name: 'odd', what: 'ticked; not on trift yet' } }),
      row('claude:mcp:jira', { action: 'check trift again', tick: { item: 'claude:mcp:jira', fields: ['env.K'], on: false, preview: [] }, gap: { name: 'jira', what: 'unticked; still on trift' } }),
      row('maconly:claude:chrome', { status: 'skip', gap: { name: 'chrome', what: 'runs only on a Mac' } }),
      okRow('var:X'),
    ], 'trift', { ssh: 'ada@trift', svall: 'svall -p work' })).toEqual([
      '  linear       keys not copied (env.LINEAR_API_KEY)  → svall -p work host consent trift claude:mcp:linear on',
      '  notion       not logged in                         → ssh -L 3118:localhost:3118 ada@trift, then MCP_OAUTH_CALLBACK_PORT=3118 claude, /mcp',
      '  GAMMA_TOKEN  not set; gamma reads it               → ssh ada@trift, then svall worker env GAMMA_TOKEN',
      '  db-mcp       not installed; db needs it            → install db-mcp on trift',
      '  odd          ticked; not on trift yet              → svall -p work host doctor trift',
      '  jira         unticked; still on trift              → svall -p work host doctor trift',
      '  chrome       runs only on a Mac',
    ]);
  });

  it('cuts a what past 80 characters, so one long row does not pad every other', async () => {
    const { setupList } = await import('../src/commands/host.js');
    const what = `keys not copied (${Array.from({ length: 2000 }, (_, i) => `providers.p.body.k${i}`).join(', ')})`;
    const [long, short] = setupList([{ ...unticked('opencode:config'), gap: { name: 'opencode', what } }, varRow('GAMMA_TOKEN')], 'trift', THERE);
    expect(long).toBe(`  opencode     ${what.slice(0, 79)}…  → svall host consent trift opencode:config on`);
    expect(short).toBe(`  GAMMA_TOKEN  ${'not set; gamma reads it'.padEnd(80)}  → ssh trift.test, then svall worker env GAMMA_TOKEN`);
  });

  it('asks to set up what will not work there: yes asks for each key, copies the ones said yes to, and prints the commands to run there; no leaves it', async () => {
    const { setUpNow } = await import('../src/commands/host.js');
    const rows = [unticked('claude:mcp:linear'), unticked('codex:mcp:github'), varRow('GAMMA_TOKEN')].map(rowStep);
    const talk = (answers: string[]) => {
      const asked: string[] = [];
      const said: string[] = [];
      const consent: [MachineId, string, string[], boolean][] = [];
      return {
        asked, said, consent,
        io: {
          ask: (q: string) => { asked.push(q); return Promise.resolve(answers.shift() ?? ''); },
          write: (t: string) => { said.push(t); },
          consent: (m: MachineId, item: string, fields: string[], on: boolean) => { consent.push([m, item, fields, on]); return Promise.resolve([ticked(item)]); },
        },
      };
    };
    const yes = talk(['', 'y', '']);
    await setUpNow(rows, { name: 'trift', machine: REMOTE, there: THERE }, yes.io);
    expect(yes.asked).toEqual([
      'Set them up now? [Y/n] ',
      "Copy linear's keys to trift? env.LINEAR_API_KEY lin…90 [y/N] ",
      "Copy github's keys to trift? env.GITHUB_API_KEY git…90 [y/N] ",
    ]);
    expect(yes.consent).toEqual([[REMOTE, 'claude:mcp:linear', ['env.LINEAR_API_KEY'], true]]);
    expect(yes.said.join('')).toBe([
      '  ✓ linear: keys copied to trift',
      'Run these on trift:',
      '  ssh trift.test, then svall worker env GAMMA_TOKEN',
      'svall host doctor trift checks again once they are done.',
      '',
    ].join('\n'));

    const no = talk(['n']);
    await setUpNow(rows, { name: 'trift', machine: REMOTE, there: THERE }, no.io);
    expect(no.asked).toEqual(['Set them up now? [Y/n] ']);
    expect(no.consent).toEqual([]);
    expect(no.said).toEqual([]);
  });

  it('asks nothing when no row can be set up from here, never to tick a copy still there, and names each command to run there once', async () => {
    const { setUpNow } = await import('../src/commands/host.js');
    const asked: string[] = [];
    const said: string[] = [];
    const io = { ask: (q: string) => { asked.push(q); return Promise.resolve(''); }, write: (t: string) => { said.push(t); }, consent: () => Promise.resolve([]) };
    const macOnly: SetupRow = { key: 'maconly:claude:chrome', status: 'skip', detail: 'd', gap: { name: 'chrome', what: 'runs only on a Mac' } };
    const unchecked: SetupRow = { key: 'unchecked', status: 'warn', detail: 'd', action: 'svall host doctor trift once Svall is open', gap: { name: 'agent setup', what: 'not checked' } };
    const still: SetupRow = { ...unticked('claude:mcp:jira'), action: 'check trift again', gap: { name: 'jira', what: 'unticked; still on trift' } };
    // the phone link while it is off is nothing that will not work there
    const phone: SetupRow = { key: 'phone', status: 'skip', detail: 'off', tick: { item: 'phone', fields: ['on'], on: false, preview: [] } };
    await setUpNow([macOnly, unchecked, still, phone].map(rowStep), { name: 'trift', machine: REMOTE, there: THERE }, io);
    expect([asked, said]).toEqual([[], []]);

    const login = (name: string): SetupRow => ({
      key: `oauth:claude:mcp:${name}`, status: 'warn', action: 'log in once on trift', run: 'MCP_OAUTH_CALLBACK_PORT=3118 claude', forward: 3118, detail: 'd', gap: { name, what: 'not logged in' },
    });
    await setUpNow([login('notion'), login('linear'), still].map(rowStep), { name: 'trift', machine: REMOTE, there: THERE }, io);
    expect(asked).toEqual(['Set them up now? [Y/n] ']);
    expect(said.join('')).toBe('Run these on trift:\n  ssh -L 3118:localhost:3118 trift.test, then MCP_OAUTH_CALLBACK_PORT=3118 claude, /mcp\nsvall host doctor trift checks again once they are done.\n');

    // a program row's tick is not a key to copy, but its install command is still one to run there
    const npx: SetupRow = {
      key: 'runtime:npx', status: 'warn', action: 'install npx on trift', run: 'sudo apt install nodejs npm', detail: 'd',
      tick: { item: 'runtime:npx', fields: ['skip'], on: false, preview: [] }, gap: { name: 'npx', what: 'not installed; linear needs it' },
    };
    asked.length = 0;
    said.length = 0;
    await setUpNow([npx].map(rowStep), { name: 'trift', machine: REMOTE, there: THERE }, io);
    expect(asked).toEqual(['Set them up now? [Y/n] ']);
    expect(said.join('')).toBe('Run these on trift:\n  ssh trift.test, then sudo apt install nodejs npm\nsvall host doctor trift checks again once they are done.\n');
  });

  it('host doctor lists the phone link\'s row among the checks whatever it says, and leaves the other setup rows to the verdict', async () => {
    const { doctorText } = await import('../src/commands/host.js');
    const phone = (row: Partial<SetupRow>) => rowCheck({ key: 'phone', status: 'skip', detail: 'off', tick: { item: 'phone', fields: ['on'], on: false, preview: [] }, ...row });
    const release = { name: 'release', status: 'ok' as const, detail: '1.2.3' };
    expect(doctorText({ machine: 'trift', checks: [release, rowCheck(okRow('var:X')), phone({})] }, 'trift', THERE).split('\n').slice(0, 3))
      .toEqual(['machine trift', '✓ release  1.2.3', '– phone    [ ] off']);
    const refused = phone({
      status: 'warn', detail: 'trift does not serve the phone: Access denied', action: 'sudo tailscale set --operator=$USER', gap: { name: 'phone', what: 'not served' },
      tick: { item: 'phone', fields: ['on'], on: true, preview: [] },
    });
    expect(doctorText({ machine: 'trift', checks: [release, refused] }, 'trift', THERE).split('\n').slice(2)).toEqual([
      '! phone    [x] trift does not serve the phone: Access denied -> sudo tailscale set --operator=$USER',
      'trift is ready. 1 part of your agent setup will not work there yet:',
      '  phone  not served  → sudo tailscale set --operator=$USER',
    ]);
  });

  it('a run\'s lines leave the agent setup rows to the list at its end', async () => {
    const { reporter } = await import('../src/commands/host.js');
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    try {
      const r = reporter(false, () => 'last');
      r.emit({ step: 'registry', status: 'ok', detail: "trift is in this Mac's list of machines" });
      r.emit(rowStep(unticked('claude:mcp:linear')));
      r.finish({ result: 'ready', actions: [] });
    } finally { vi.restoreAllMocks(); }
    expect(out).toEqual(["✓ registry  trift is in this Mac's list of machines\n", 'last\n']);
  });

  it('lists a detail of several lines under its step', async () => {
    const { stepLine } = await import('../src/commands/host.js');
    expect(stepLine({ step: 'install', status: 'fail', detail: 'svall setup exited 1: one line\nanother line' }))
      .toBe('✗ install  svall setup exited 1: one line\n    another line');
  });

  it('stepLine prints [ ] before an unticked row and [x] before a ticked one', async () => {
    const { stepLine } = await import('../src/commands/host.js');
    const { checkLines } = await import('../src/commands/doctor.js');
    const row = unticked('claude:mcp:linear');
    expect(stepLine(rowStep(row))).toMatch(/^! mirror:claude:mcp:linear  \[ \] copied without its keys .* -> copy linear's keys to trift$/);
    expect(stepLine(rowStep({ ...row, status: 'ok', detail: 'keys copied to trift', action: undefined, tick: { ...row.tick!, on: true } })))
      .toBe('✓ mirror:claude:mcp:linear  [x] keys copied to trift');
    expect(stepLine(rowStep(varRow('X')))).toMatch(/^! mirror:var:X  gamma reads X/);
    expect(checkLines([rowCheck(row), { name: 'release', status: 'ok', detail: '1.2.3' }])).toEqual([
      `! mirror:claude:mcp:linear  [ ] ${row.detail} -> copy linear's keys to trift`, `✓ ${'release'.padEnd(row.key.length + 'mirror:'.length)}  1.2.3`,
    ]);
  });

  it('records the step a run stopped at', async () => {
    const out = await removeHost('trift', {}, deps());
    expect(out).toMatchObject({ result: 'actions', stopped: 'machine' });
  });
});

describe('the last check', () => {
  it('stays as it was after an add that never reached the machine', async () => {
    const config = path.join(work, 'config');
    const registry = MachineRegistry.load(config);
    registry.add({ name: 'trift', ssh: 'refused.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    registry.save();
    const before = { [REMOTE]: { at: 1, failed: 0, warned: 0, release: '1.2.3' } };
    fs.writeFileSync(path.join(config, 'checks.json'), JSON.stringify(before));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { hostCommands, lastChecks } = await import('../src/commands/host.js');
    try {
      await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => config).parseAsync(['add', 'trift', '--ssh', 'refused.test'], { from: 'user' });
    } finally { vi.restoreAllMocks(); process.exitCode = 0; }
    expect(lastChecks(config)).toEqual(before);
  });
});

describe('ndjson output', () => {
  it('writes one event per line and a final result', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const { hostCommands } = await import('../src/commands/host.js');
    try {
      await hostCommands(() => true, () => ({ name: 'private', home: fleet, managed: true }), () => path.join(work, 'config'))
        .parseAsync(['add', 'trift', '--ssh', 'refused.test'], { from: 'user' });
    } finally { vi.restoreAllMocks(); process.exitCode = 0; }
    const lines = out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toEqual({ step: 'name', status: 'start' });
    expect(lines.at(-1)).toMatchObject({ result: 'actions' });
    expect(Array.isArray((lines.at(-1) as { actions: unknown }).actions)).toBe(true);
  });
});
