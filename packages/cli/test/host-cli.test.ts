import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MachineId, type SetupRow } from '@svall/protocol';
import { shq } from '@svall/svalld/text';
import { flow, removeHost, rowCheck, rowStep, StepError, type StepEvent } from '../src/controller/host.js';
import { MachineRegistry } from '../src/controller/registry.js';
import { SshError, SshMaster } from '../src/controller/ssh.js';
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

describe('a relayed run', () => {
  it('logs in with no one to ask, as ssh in batch mode, and says this machine\'s key is what is missing', async () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    // stdin stays open, as the connection a relay keeps does
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'packages/cli/src/main.ts'), 'host', 'add', 'trift', '--ssh', 'denied.test', '--relayed', '--json'], {
      cwd: root, env: { ...process.env, SVALL_CONFIG_DIR: path.join(work, 'config'), SVALL_HOME: fleet }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    await new Promise((resolve) => { child.on('close', resolve); });
    child.stdin.destroy();
    expect(ssh.calls()[0].slice(0, 2)).toEqual(['-o', 'BatchMode=yes']);
    const master = out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as StepEvent).find((e) => e.step === 'ssh' && e.status === 'fail');
    expect(master).toMatchObject({ detail: expect.stringMatching(/cannot log in to denied\.test$/), raw: expect.stringContaining('linus@denied.test: Permission denied (publickey).') });
  });
});

describe('an ssh master that did not open', () => {
  it('reads by its kind and its sentence, ssh\'s own words behind it as raw', async () => {
    const { unreached } = await import('../src/controller/host.js');
    const { SshError } = await import('../src/controller/ssh.js');
    const said = (e: Error) => { const s = unreached(e, 'studio', 'ada@studio', 'this Mac'); return [s.detail, s.raw]; };
    expect(said(new SshError('auth', 'ssh could not reach ada@studio; run ssh ada@studio once in a terminal, then try again', 'Permission denied (publickey).')))
      .toEqual(['this Mac cannot log in to studio', 'Permission denied (publickey).']);
    expect(said(new SshError('unreachable', 'ssh did not open a control master to ada@studio within 20 s')))
      .toEqual(['studio did not answer in 20 s', 'ssh did not open a control master to ada@studio within 20 s']);
    expect(said(new SshError('unreachable', 'ssh could not reach ada@studio', 'ssh: connect to host studio port 22: Connection refused')))
      .toEqual(['studio is not reachable from this Mac', 'ssh: connect to host studio port 22: Connection refused']);
    const hostKey = unreached(new SshError('host_key', 'ssh could not reach ada@studio', 'Host key verification failed.'), 'studio', 'ada@studio', 'this Mac');
    expect([hostKey.detail, hostKey.action, hostKey.raw]).toEqual(['this Mac cannot log in to studio', 'run ssh ada@studio once in a terminal and answer what it asks', 'Host key verification failed.']);
    // ssh's own refusal, neither a login nor the network, is not sent to Tailscale
    const other = unreached(new SshError('other', 'ssh could not reach ada@studio', 'Bad owner or permissions on /Users/ada/.ssh/config'), 'studio', 'ada@studio', 'this Mac');
    expect([other.detail, other.action, other.raw]).toEqual(['ssh to studio did not open', 'run ssh ada@studio in a terminal to see why', 'Bad owner or permissions on /Users/ada/.ssh/config']);
  });
});

describe('a command that fails', () => {
  it('says why in a sentence, with what ssh said on a line of its own under it', async () => {
    const config = path.join(work, 'config');
    const registry = MachineRegistry.load(config);
    registry.add({ name: 'trift', ssh: 'denied.test', platform: 'linux', arch: 'arm64', home: HOME, svallBase: BASE }, REMOTE);
    registry.save();
    const root = path.resolve(import.meta.dirname, '../../..');
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'packages/cli/src/main.ts'), '--host', 'trift', 'robot', 'list'], {
      cwd: root, env: { ...process.env, SVALL_CONFIG_DIR: config, SVALL_HOME: fleet }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    expect(await new Promise((resolve) => { child.on('close', resolve); })).toBe(1);
    expect(err).toBe('svall: ssh could not reach denied.test; run ssh denied.test once in a terminal, then try again\n  linus@denied.test: Permission denied (publickey).\n');
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

  it('a run ends on the rows that need a person in full, the notes and the fine rows a line each, then its verdict and the setup still to come', async () => {
    const { outcomeText } = await import('../src/commands/host.js');
    const work = { there: { ssh: 'trift.test', svall: 'svall -p work' } };
    const linger: StepEvent = { step: 'linger', status: 'warn', detail: 'off: the fleet stops when you log out', action: 'ssh trift, then sudo loginctl enable-linger linus' };
    const tmux: StepEvent = { step: 'tmux', status: 'warn', detail: '3.4: Shift+Enter needs 3.5', raw: 'tmux 3.4, from /usr/bin/tmux' };
    const steps: StepEvent[] = [{ step: 'ssh', status: 'start' }, { step: 'ssh', status: 'ok', detail: 'logs in' }, { step: 'os', status: 'ok', detail: 'Ubuntu 24.04 LTS, x86-64' }, linger, tmux];
    const linear = { ...rowStep(unticked('claude:mcp:linear')) };
    const chrome = rowStep({ key: 'maconly:claude:chrome', status: 'skip', detail: 'd', gap: { name: 'chrome', what: 'runs only on a Mac' } });
    expect(outcomeText({ result: 'actions', actions: [linger.action!], setup: [linear, chrome] }, 'add', 'trift', { ...work, steps }).split('\n')).toEqual([
      '! linger  off: the fleet stops when you log out -> ssh trift, then sudo loginctl enable-linger linus',
      '! 1 note',
      '✓ 2 checks fine',
      'trift has 1 thing to fix',
      '1 part of your agent setup is not on trift yet: svall -p work host doctor trift --all lists them',
    ]);
    // a setup that only stands aside counts nothing
    expect(outcomeText({ result: 'ready', actions: [], setup: [chrome] }, 'add', 'trift', { ...work, steps: steps.slice(0, 3) })).toBe('✓ 2 checks fine\ntrift is ready');
    // an agent the fleet does not run is a note in an add, and every warning is to do in an upgrade
    const codex: StepEvent = { step: 'codex', status: 'warn', detail: '0.156.1, not logged in', action: 'ssh trift, then codex login' };
    const fleetRuns = { mainAgent: 'claude', robots: {} } as never;
    expect(outcomeText({ result: 'actions', actions: [] }, 'add', 'trift', { ...work, steps: [codex], fleet: fleetRuns })).toBe('! 1 note\ntrift is ready');
    expect(outcomeText({ result: 'actions', actions: [] }, 'upgrade', 'trift', { ...work, steps: [tmux], fleet: fleetRuns }).split('\n')).toEqual([
      '! tmux  3.4: Shift+Enter needs 3.5', '  tmux 3.4, from /usr/bin/tmux', 'trift has 1 thing to fix',
    ]);
    const failed: StepEvent = { step: 'install', status: 'fail', detail: 'did not finish', raw: 'svall setup exited 1: no space' };
    expect(outcomeText({ result: 'actions', actions: ['did not finish'], stopped: 'install' }, 'add', 'trift', { ...work, steps: [failed] }).split('\n'))
      .toEqual(['✗ install  did not finish', '  svall setup exited 1: no space', 'Add machine did not finish']);
    // a run that stopped ends as the window's verdict on it: a machine still listed has things to fix, else the run did not finish
    expect(outcomeText({ result: 'actions', actions: [], stopped: 'install' }, 'upgrade', 'trift', { ...work, steps: [failed] }).split('\n').at(-1)).toBe('trift has 1 thing to fix');
    // an upgrade of a name the list does not hold left no machine with anything to fix
    const unknown: StepEvent = { step: 'machine', status: 'fail', detail: 'no machine trift in the registry' };
    expect(outcomeText({ result: 'actions', actions: [unknown.detail!], stopped: 'machine' }, 'upgrade', 'trift', { ...work, steps: [unknown] }).split('\n').at(-1)).toBe('Upgrade did not finish');
    const listed: StepEvent = { step: 'registry', status: 'ok', detail: 'listed' };
    expect(outcomeText({ result: 'actions', actions: [], stopped: 'install' }, 'add', 'trift', { ...work, steps: [listed, failed] }).split('\n').at(-1)).toBe('trift has 1 thing to fix');
    expect(outcomeText({ result: 'actions', actions: [], stopped: 'install' }, 'rollback', 'trift', { steps: [failed] }).split('\n').at(-1)).toBe('Roll back did not finish');
    expect(outcomeText({ result: 'ready', actions: [] }, 'remove', 'trift', { forget: true })).toBe('trift is forgotten');
    const keys: StepEvent = { step: 'keys', status: 'warn', detail: 'copied keys left in 1 file', action: 'ssh trift, then remove them by hand' };
    expect(outcomeText({ result: 'actions', actions: [keys.action!] }, 'remove', 'trift', { steps: [keys] }).split('\n'))
      .toEqual(['! keys  copied keys left in 1 file -> ssh trift, then remove them by hand', 'trift is removed']);
  });

  it('a run ends 1 while it stopped or a row needs a person, and 0 on notes alone', async () => {
    const { leftToDo } = await import('../src/commands/host.js');
    const note: StepEvent = { step: 'gh', status: 'warn', detail: 'not logged in: pull request links stay unresolved', action: 'gh auth login' };
    const todo: StepEvent = { step: 'linger', status: 'warn', detail: 'off: the fleet stops when you log out', action: 'x' };
    expect(leftToDo({ result: 'actions', actions: [note.action!] }, 'add', [note], undefined)).toBe(false);
    expect(leftToDo({ result: 'actions', actions: ['x'] }, 'add', [note, todo], undefined)).toBe(true);
    expect(leftToDo({ result: 'actions', actions: [], stopped: 'ssh' }, 'add', [], undefined)).toBe(true);
    expect(leftToDo({ result: 'actions', actions: [] }, 'upgrade', [note], undefined)).toBe(true);
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
      "Copy linear's LINEAR_API_KEY to trift? lin…90 [y/N] ",
      "Copy github's GITHUB_API_KEY to trift? git…90 [y/N] ",
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

  it('host doctor tiers its checks, the phone link\'s row among them, counts the setup still to come, and lists every row with --all', async () => {
    const { doctorText } = await import('../src/commands/host.js');
    const phone = (row: Partial<SetupRow>) => rowCheck({ key: 'phone', status: 'skip', detail: 'off', tick: { item: 'phone', fields: ['on'], on: false, preview: [] }, ...row });
    const release = { name: 'release', status: 'ok' as const, detail: '1.2.3' };
    const systemd = { name: 'systemd', status: 'fail' as const, detail: 'not running', raw: 'svall-svalld@private.service: loaded, inactive (dead), enabled' };
    const tmux = { name: 'tmux', status: 'warn' as const, detail: '3.4: Shift+Enter needs 3.5' };
    expect(doctorText({ machine: 'trift', checks: [release, rowCheck(okRow('var:X')), phone({})] }, 'trift', THERE)).toBe('machine trift\n✓ 2 checks fine\ntrift is ready');
    const refused = phone({
      status: 'warn', detail: 'on, not serving', action: 'sudo tailscale set --operator=$USER', gap: { name: 'phone', what: 'not served' },
      tick: { item: 'phone', fields: ['on'], on: true, preview: [] },
    });
    const linear = rowCheck(unticked('claude:mcp:linear'));
    const checks = [release, systemd, tmux, refused, linear];
    expect(doctorText({ machine: 'trift', checks }, 'trift', THERE).split('\n')).toEqual([
      'machine trift',
      '✗ systemd  not running',
      '  svall-svalld@private.service: loaded, inactive (dead), enabled',
      '! 2 notes',
      '✓ 1 check fine',
      'trift has 1 thing to fix',
      '2 parts of your agent setup are not on trift yet: svall host doctor trift --all lists them',
    ]);
    expect(doctorText({ machine: 'trift', checks }, 'trift', THERE, { all: true }).split('\n').filter((l) => !l.startsWith(' '))).toEqual([
      'machine trift',
      '✓ release  1.2.3',
      '✗ systemd  not running',
      '! tmux     3.4: Shift+Enter needs 3.5',
      '! phone    [x] on, not serving -> sudo tailscale set --operator=$USER',
      'trift has 1 thing to fix',
      '2 parts of your agent setup are not on trift yet:',
    ]);
    expect(doctorText({ machine: 'trift', checks }, 'trift', THERE, { all: true })).toContain('  linear  keys not copied (env.LINEAR_API_KEY)  → svall host consent trift claude:mcp:linear on');
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

  it('prints what a tool said of a step that failed or warned dim under it, two spaces in, and of one that went well nothing', async () => {
    const { stepLine } = await import('../src/commands/host.js');
    expect(stepLine({ step: 'tailscale', status: 'fail', detail: 'Tailscale is not running on studio', raw: 'Command failed: tailscale status --json\ntailscale is stopped' }))
      .toBe('✗ tailscale  Tailscale is not running on studio\n  Command failed: tailscale status --json\n  tailscale is stopped');
    expect(stepLine({ step: 'tmux', status: 'warn', detail: '3.4', raw: 'tmux 3.4' })).toBe('! tmux  3.4\n  tmux 3.4');
    expect(stepLine({ step: 'ssh', status: 'ok', detail: 'logs in', raw: 'OpenSSH_9.6' })).toBe('✓ ssh  logs in');
  });

  it('a step carries what a tool said, from what it found and from what stopped it', async () => {
    const events: StepEvent[] = [];
    await flow((e) => events.push(e), async (run) => {
      await run.step('space', async () => ({ value: undefined, status: 'warn' as const, detail: '2 GB free: low', raw: 'df: 2097152' }));
      await run.step('install', () => Promise.reject(new StepError('did not finish', undefined, undefined, undefined, 'svall setup exited 1: no space')));
    });
    expect(events.filter((e) => e.status !== 'start').map((e) => [e.step, e.raw])).toEqual([['space', 'df: 2097152'], ['install', 'svall setup exited 1: no space']]);
  });

  it('a step that a command there stopped says so in words of its own, with what was said behind them', async () => {
    const events: StepEvent[] = [];
    await flow((e) => events.push(e), (run) => run.step('install', () => Promise.reject(new SshError('other', 'svall setup exited 1', 'no space'))));
    expect(events.at(-1)).toEqual({ step: 'install', status: 'fail', detail: 'did not finish', raw: 'svall setup exited 1: no space' });
  });

  it('a step that ssh stopped in Svall\'s own words keeps them, with what the tool said behind them', async () => {
    const events: StepEvent[] = [];
    const out = await flow((e) => events.push(e), (run) => run.step('probe', () => Promise.reject(new SshError('version', 'vault answered with protocol 45, not 46', 'svall connection-info said 45'))));
    expect(events.at(-1)).toEqual({ step: 'probe', status: 'fail', detail: 'vault answered with protocol 45, not 46', raw: 'svall connection-info said 45' });
    expect(out.actions).toEqual(['vault answered with protocol 45, not 46']);
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
