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
    const dirs = ['tab\there', 'new\nline', 'unit\x1fsep', 'row\x1e\nend', 'forged\x1e\n@9\x1f%9\x1fc_0\x1fsh\x1f1\x1f0\x1fx'].map((n) => { const d = path.join(fs.realpathSync(home), n); fs.mkdirSync(d); return d; });
    for (const [i, cwd] of dirs.entries()) await tmux.newWindow(`c_${i}`, cwd, {});
    const listed = (await tmux.listWindows()).sort((a, b) => a.name.localeCompare(b.name));
    expect(listed.map((w) => [w.name, w.path, w.dead])).toEqual(dirs.map((d, i) => [`c_${i}`, d, false]));
    for (const w of listed) expect(w.activity).toBeGreaterThan(0);
  });

  it('gives an activity it cannot read as 0, never NaN', async () => {
    const tmux = new Tmux('/nowhere.sock', '/dev/null');
    const row = ['@1', '%1', 'c_0', 'sh', 'soon', '0', '/tmp'];
    vi.spyOn(tmux, 'run').mockImplementation(async (...args) => `${args.at(-1)!.replace(/#\{[a-z_]+\}/g, () => row.shift()!)}\n`);
    expect((await tmux.listWindows())[0]).toMatchObject({ name: 'c_0', path: '/tmp', activity: 0 });
  });
});
