import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../src/config.js';
import { resolvePaths } from '../src/paths.js';
import { tmuxConfText } from '../src/tmux/conf.js';
import { Tmux } from '../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome } from './helpers.js';

const runIf = hasTmux() ? describe : describe.skip;

runIf('Tmux.listWindows', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const f of cleanup.splice(0)) await f(); cleanHomes(); });

  it('reads a pane whose path holds a tab, a newline, a separator or a whole row of its own', async () => {
    const home = makeHome();
    const paths = resolvePaths(home);
    fs.writeFileSync(paths.tmuxConf, tmuxConfText(Config.parse({ shell: '/bin/sh' })));
    const tmux = new Tmux(paths.tmuxSock, paths.tmuxConf);
    const ready = tmux.ensureServer();
    cleanup.push(async () => { await ready.catch(() => {}); await tmux.killServer(); });
    await ready;
    const dirs = ['tab\there', 'new\nline', 'unit\x1fsep', 'row\x1e\nend', 'forged\x1e\n@9\x1f%9\x1fc_0\x1fsh\x1f1\x1f0\x1fx', 'åäö'].map((n) => { const d = path.join(fs.realpathSync(home), n); fs.mkdirSync(d); return d; });
    for (const [i, cwd] of dirs.entries()) await tmux.newWindow(`c_${i}`, cwd, {});
    // tmux prints a tab or a letter outside ASCII as _ to a client outside a UTF-8 locale
    for (const k of ['LANG', 'LC_ALL', 'LC_CTYPE']) vi.stubEnv(k, '');
    const listed = (await tmux.listWindows()).sort((a, b) => a.name.localeCompare(b.name));
    vi.unstubAllEnvs();
    expect(listed.map((w) => [w.name, w.path, w.dead])).toEqual(dirs.map((d, i) => [`c_${i}`, d, false]));
    for (const w of listed) expect(w.activity).toBeGreaterThan(0);
  });

  it('gives an activity it cannot read as 0, never NaN', async () => {
    const tmux = new Tmux('/nowhere.sock', '/dev/null');
    const row = ['@1', '%1', '1', 'c_0', 'sh', 'soon', '0', '/tmp'];
    const listing = tmux as unknown as { call(args: string[]): Promise<string> };
    vi.spyOn(listing, 'call').mockImplementation(async (args) => `${args.at(-1)!.replace(/#\{[a-z_]+\}/g, () => row.shift()!)}\n`);
    expect((await tmux.listWindows())[0]).toMatchObject({ name: 'c_0', path: '/tmp', activity: 0 });
  });
});

// what tmux prints for the rows of a -F format: 3.5 and later print each byte as it is, while 3.4 prints a control
// character other than a tab or a newline as its octal escape, and a backslash as itself
const SHAPES: [string, (s: string) => string][] = [
  ['3.7c', (s) => s],
  ['3.4', (s) => s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)],
];

function printing(tmux: Tmux, shape: (s: string) => string, rows: string[][]): void {
  const listing = tmux as unknown as { call(args: string[]): Promise<string> };
  vi.spyOn(listing, 'call').mockImplementation(async (args) => {
    const format = args[args.indexOf('-F') + 1];
    return rows.map((row) => { let i = 0; return `${shape(format.replace(/#\{[a-z_]+\}/g, () => row[i++]))}\n`; }).join('');
  });
}

describe.each(SHAPES)('the listings as tmux %s prints them', (_, shape) => {
  it('reads every window, one whose name or path holds a tab or a newline too', async () => {
    const tmux = new Tmux('/nowhere.sock', '/dev/null');
    printing(tmux, shape, [
      ['@0', '%0', '10', '_keep', 'sleep', '1790433570', '0', '/'],
      ['@1', '%1', '11', 'c_1', 'zsh', '1790433575', '0', '/w/tab\there'],
      ['@2', '%2', '12', 'stray\tname', 'claude', '1790433576', '1', '/w/new\nline'],
    ]);
    expect(await tmux.listWindows()).toEqual([
      { windowId: '@1', paneId: '%1', panePid: 11, name: 'c_1', command: 'zsh', path: '/w/tab\there', activity: 1790433575000, dead: false },
      { windowId: '@2', paneId: '%2', panePid: 12, name: 'stray\tname', command: 'claude', path: '/w/new\nline', activity: 1790433576000, dead: true },
    ]);
  });

  it('reads every session', async () => {
    const tmux = new Tmux('/nowhere.sock', '/dev/null');
    printing(tmux, shape, [['fleet', '0', '1790433570'], ['v-c_1', '2', '1790433575']]);
    expect(await tmux.listSessions()).toEqual([
      { name: 'fleet', attached: 0, created: 1790433570000 },
      { name: 'v-c_1', attached: 2, created: 1790433575000 },
    ]);
  });
});
