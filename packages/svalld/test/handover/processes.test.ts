import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookCommand, mergeStatusLine, statusWrapper } from '../../src/agent-hooks.js';
import { Config } from '../../src/config.js';
import { ProcessTable, killGroup, parsePs } from '../../src/handover/processes.js';
import { installedScripts } from '../../src/paths.js';
import { tmuxConfText } from '../../src/tmux/conf.js';
import { Tmux } from '../../src/tmux/tmux.js';
import { cleanHomes, hasTmux, makeHome, waitFor } from '../helpers.js';

const fixture = (name: string): string => fs.readFileSync(path.join(import.meta.dirname, '../fixtures/ps', name), 'utf8');
const args = (rows: { args: string }[] | undefined): string[] | undefined => rows?.map((r) => r.args);

// the same panes as each platform's ps prints them: a prompt, a pipeline, a background job, Claude with its MCP
// servers (`claude mcp serve` among them), tool commands (two naming scripts like Svall's) and Svall's own
// statusline and hook, each a shell running the app's helper on macOS and node on Linux,
// a Claude that node runs, a shell that exec'd into vim, a job that exited but is not reaped, a standalone
// Codex and one behind npm's node launcher. The macOS standalone Codex follows one measured on this Mac, the
// Linux one is an idle Codex 0.156.1 captured on Ubuntu; the npm layouts and Codex's tool commands are modelled.
const platforms = [
  {
    name: 'macOS', file: 'darwin.txt', rows: 45, shell: '-zsh', tool: /^\/bin\/zsh -c source/, home: '/Users/ada/.svall', node: '/Applications/Svall.app/Contents/Helpers/node',
    pane: { prompt: 88276, pipeline: 88278, pipelineGroup: 88486, background: 88283, agent: 41522, agentGroup: 41598, exec: 50001, reaping: 50100 },
    codex: { pane: 61000, pid: 61010, commands: ['/bin/zsh -lc npm test'] },
    npm: { pane: 62000, launcher: 62010, pid: 62011, commands: ['/bin/zsh -lc npm test'] },
    nodeClaude: { pane: 63000, pid: 63010 },
    trees: {
      codex: [
        'codex', '/Users/ada/.codex/packages/standalone/current/codex-path/node_repl', 'node /opt/homebrew/bin/adlc mcp-server',
        '/Users/ada/.codex/packages/standalone/current/bin/codex-code-mode-host', '/bin/zsh -lc npm test',
      ],
      npm: [
        'node /opt/homebrew/bin/codex', '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex',
        'node /opt/homebrew/bin/adlc mcp-server', '/bin/zsh -lc npm test',
      ],
      claudeGroups: [41598, 41640, 41641, 41650, 41651, 41700, 92650],
    },
  },
  {
    name: 'Linux procps', file: 'linux.txt', rows: 43, shell: '-bash', tool: /^\/bin\/bash -c source/, home: '/home/ada/.svall', node: '/home/ada/.local/share/svall/current/node/bin/node',
    pane: { prompt: 3526506, pipeline: 3526520, pipelineGroup: 3527276, background: 3526538, agent: 3530001, agentGroup: 3530010, exec: 3540001, reaping: 3550000 },
    codex: { pane: 1519551, pid: 1519855, commands: [] },
    npm: { pane: 3560001, launcher: 3560010, pid: 3560011, commands: ['/bin/bash -lc npm test'] },
    nodeClaude: { pane: 3580000, pid: 3580010 },
    trees: {
      codex: ['codex'],
      npm: [
        'node /home/ada/.local/bin/codex', '/home/ada/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex',
        'node /home/ada/mcp/server.js', '/bin/bash -lc npm test',
      ],
      claudeGroups: [3530010, 3530020, 3530030, 3530041, 3530042, 3530050, 3530051],
    },
  },
];

describe.each(platforms)('ps as $name prints it', ({ file, rows, shell, tool, home, node, pane, codex, npm, nodeClaude, trees }) => {
  const table = new ProcessTable(parsePs(fixture(file)), installedScripts(home));

  it('reads every row, with the command line whole and the ids as numbers', () => {
    const parsed = parsePs(fixture(file));
    expect(parsed).toHaveLength(rows);
    expect(parsed.find((r) => r.pid === pane.prompt)).toMatchObject({ pgid: pane.prompt, tpgid: pane.prompt, args: shell });
    expect(parsed.find((r) => r.args.startsWith('npm exec'))?.args).toBe('npm exec @playwright/mcp@latest');
    expect(parsed.some((r) => r.tpgid < 1)).toBe(true);
  });

  it('holds the statusline and the hook as setup writes them, each in the shell Claude runs it in', () => {
    const [script, status] = installedScripts(home);
    const settings = mergeStatusLine({ statusLine: { type: 'command', command: 'ccstatusline' } }, statusWrapper(node, status), status) as { statusLine: { command: string } };
    const argv = parsePs(fixture(file)).map((r) => r.args);
    expect(argv).toContain(`/bin/sh -c ${settings.statusLine.command}`);
    expect(argv).toContain(`/bin/sh -c ${hookCommand(node, script, 'claude')}`);
  });

  it('finds nothing holding a shell at its prompt, and leaves its background jobs out', () => {
    expect(table.pane(pane.prompt)).toEqual({ group: pane.prompt, foreground: [] });
    expect(table.pane(pane.background)).toEqual({ group: pane.background, foreground: [] });
  });

  it('reads a pipeline in the foreground as the job holding the terminal', () => {
    const p = table.pane(pane.pipeline);
    expect(p?.group).toBe(pane.pipelineGroup);
    expect(args(p?.foreground)).toEqual(['sleep 300', 'cat']);
    expect(p?.agent).toBeUndefined();
  });

  it('holds Claude with its MCP servers in the foreground, and counts only its own work off the terminal as a command', () => {
    const p = table.pane(pane.agent);
    expect(p?.group).toBe(pane.agentGroup);
    expect(p?.foreground.map((r) => r.args.split(' ')[0])).toEqual([
      'claude', expect.stringMatching(/python$/), 'npm', 'claude', 'node',
    ]);
    // `claude mcp serve` is one of its MCP servers, not the agent behind a launcher
    expect(p?.agent).toMatchObject({ kind: 'claude', pid: pane.agentGroup });
    // neither the browser an MCP server launched nor Svall's statusline and hook are the agent's work,
    // while commands that only name scripts like them are
    const commands = args(p?.agent?.commands) ?? [];
    expect(commands).toHaveLength(3);
    expect(commands[0]).toMatch(tool);
    expect(commands[1]).toContain("eval 'node --watch packages/svalld/hooks/agent-hook.mjs --port 0'");
    expect(commands[2]).toContain("eval 'node ~/tools/claude-status.mjs --serve'");
  });

  it('takes a Claude that node runs as the agent, not the `claude mcp serve` it runs the same way', () => {
    const p = table.pane(nodeClaude.pane);
    expect(p?.agent?.kind).toBe('claude');
    expect(p?.agent?.pid).toBe(nodeClaude.pid);
    expect(args(p?.agent?.commands)).toEqual([expect.stringContaining("eval 'cargo build'")]);
  });

  it("leaves Svall's helper and scripts out only where setup installed them", () => {
    // a shell that runs its last command in its own place, as dash does, leaves the helper or node straight under the agent
    const ran = [`${home}/hooks/svall-hook claude ${pane.agentGroup}`, `${node} ${home}/hooks/agent-hook.mjs claude ${pane.agentGroup}`]
      .map((args, i) => ({ pid: 4_100_000 + i, ppid: pane.agentGroup, pgid: 4_100_000 + i, tpgid: 0, stat: 'Ss', args }));
    const ps = [...parsePs(fixture(file)), ...ran];
    expect(new ProcessTable(ps, installedScripts(home)).pane(pane.agent)?.agent?.commands).toHaveLength(3);
    // the guarded hook command and the statusline wrapper are setup's wherever they live; the helper and scripts of another home are not
    expect(args(new ProcessTable(ps, installedScripts('/opt/other')).pane(pane.agent)?.agent?.commands)?.slice(3)).toEqual(ran.map((r) => r.args));
  });

  it("finds a standalone Codex, leaving out the MCP servers it keeps on the terminal in groups of their own", () => {
    const p = table.pane(codex.pane);
    expect(args(p?.foreground)).toEqual(['codex']);
    expect(p?.agent?.kind).toBe('codex');
    expect(p?.agent?.pid).toBe(codex.pid);
    expect(args(p?.agent?.commands)).toEqual(codex.commands);
  });

  it("sees through npm's node launcher to the Codex it starts, and reads that process's commands", () => {
    const p = table.pane(npm.pane);
    expect(p?.group).toBe(npm.launcher);
    expect(p?.agent?.kind).toBe('codex');
    expect(p?.agent?.pid).toBe(npm.pid);
    expect(args(p?.agent?.commands)).toEqual(npm.commands);
  });

  it('reaches everything a job holding the terminal started, its helpers on the terminal and its work off it alike', () => {
    const tree = (panePid: number) => table.tree(table.pane(panePid)?.foreground ?? []);
    expect(args(tree(codex.pane))).toEqual(trees.codex);
    expect(args(tree(npm.pane))).toEqual(trees.npm);
    // Claude's MCP servers, the browser one of them launched, its tool commands, statusline and hook
    expect([...new Set(tree(pane.agent).map((p) => p.pgid))].sort((a, b) => a - b)).toEqual(trees.claudeGroups);
    expect(tree(pane.prompt)).toEqual([]);
    expect(tree(pane.reaping)).toEqual([]);
  });

  it('counts a pane whose shell was replaced as holding its terminal, with no agent in it', () => {
    const p = table.pane(pane.exec);
    expect(args(p?.foreground)).toEqual(['vim notes.md']);
    expect(p?.agent).toBeUndefined();
  });

  it('does not count a job that has exited and waits to be reaped', () => {
    expect(table.pane(pane.reaping)?.foreground).toEqual([]);
  });

  it('knows nothing of a pane whose process is gone', () => {
    expect(table.pane(4_000_000)).toBeUndefined();
  });
});

// an OpenCode TUI as measured on this Mac with 2.0.22: its private server in a session of its own, which runs a shell
// command and an MCP or language server each in one more, and Svall's plugin reading the TUI's command line in its own
// off a terminal, macOS prints a tpgid of 0 and procps one of -1
describe.each([
  { name: 'macOS', none: 0, OC: '/Users/ada/.opencode/bin/opencode', shell: '-zsh' },
  { name: 'Linux procps', none: -1, OC: '/home/ada/.opencode/bin/opencode', shell: '-bash' },
])('an OpenCode pane as $name prints it', ({ none, OC, shell }) => {
  const row = (pid: number, ppid: number, pgid: number, tpgid: number, args: string) => ({ pid, ppid, pgid, tpgid, stat: 'S', args });
  const pane = parsePs([
    `65132     1 65132 66006 Ss   ${shell}`,
    `66006 65132 66006 66006 S+   ${OC} --standalone -s ses_eeda388f0ffeOB6E6MBZswShKL`,
    `66078 66006 66078 ${none} Ss   ${OC} serve --stdio --port 0`,
    `66080 66078 66078 ${none} S    ps -o args= -p 66006`,
    `76905 66078 76905 ${none} Ss   sleep 300`,
    `76910 66078 76910 ${none} Ss   node /Users/ada/.cache/opencode/node_modules/typescript-language-server/lib/cli.mjs --stdio`,
    `31187     1 31187 ${none} Ss   ${OC} serve --service`,
  ].join('\n'));

  it('reads every row', () => {
    expect(pane).toHaveLength(7);
    expect(pane.filter((r) => r.tpgid === none)).toHaveLength(5);
  });

  it('counts a command of another group named like the server, but not serving over stdio, as a command', () => {
    const run = [...pane.filter((r) => r.ppid !== 66078 && r.pid !== 66078), row(66090, 66006, 66090, none, `${OC} run --format json hello`)];
    const p = new ProcessTable(run).pane(65132);
    expect(p?.agent?.server).toBeUndefined();
    expect(args(p?.agent?.commands)).toEqual([`${OC} run --format json hello`]);
  });

  it('takes the TUI as the agent and its private server, the plugin and what the server runs directly as its own', () => {
    const p = new ProcessTable(pane, installedScripts('/Users/ada/.svall')).pane(65132);
    expect(args(p?.foreground)).toEqual([`${OC} --standalone -s ses_eeda388f0ffeOB6E6MBZswShKL`]);
    expect(p?.agent).toMatchObject({ kind: 'opencode', pid: 66006, server: { pid: 66078, pgid: 66078 }, commands: [] });
  });

  it("counts a job left outside the server's tree in one of the agent's live groups as a command, and cannot see one whose group leader has exited", () => {
    const left = [
      ...pane,
      // a background job of the shell command still running, reparented once the shell between them exited
      row(76920, 1, 76905, none, 'sleep 501'),
      row(76921, 1, 66078, none, 'node /tmp/watch.js'),
      row(76922, 1, 66006, none, 'tail -f log'),
      // its group's leader exited too, so nothing ties it to the agent
      row(76930, 1, 76929, none, 'sleep 502'),
    ];
    expect(args(new ProcessTable(left).pane(65132)?.agent?.commands)).toEqual(['sleep 501', 'node /tmp/watch.js', 'tail -f log']);
  });

  it("finds the agent in npm's opencode.exe", () => {
    const npm = pane.map((r) => (r.pid === 66006 ? { ...r, args: '/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe --standalone' } : r));
    expect(new ProcessTable(npm).pane(65132)?.agent).toMatchObject({ kind: 'opencode', pid: 66006, server: { pid: 66078 } });
  });

  it("neither waits on nor reaches the user's shared service, even one the TUI started", () => {
    const started = [...pane, row(31200, 66006, 31200, none, `${OC} serve --service`)];
    const table = new ProcessTable(started);
    const p = table.pane(65132);
    expect(p?.agent?.commands).toEqual([]);
    expect(table.tree(p?.foreground ?? []).map((r) => r.pid).sort()).toEqual([66006, 66078, 66080, 76905, 76910]);
  });

  it('has no server for a TUI that talks to the shared service', () => {
    const shared = pane.filter((r) => r.ppid !== 66078 && r.pid !== 66078).map((r) => (r.pid === 66006 ? { ...r, args: OC } : r));
    expect(new ProcessTable(shared).pane(65132)?.agent).toEqual({ kind: 'opencode', pid: 66006, commands: [] });
  });
});

describe('ProcessTable.read', () => {
  it('ends the ps it started when the signal it was given aborts', async () => {
    await expect(ProcessTable.read({ signal: AbortSignal.abort() })).rejects.toThrow(/abort/i);
  });
});

describe('parsePs', () => {
  it('skips a header, a blank line and anything else that is not a row', () => {
    const rows = parsePs('  PID  PPID  PGID TPGID STAT ARGS\n\n   12     1    12   12 Ss+  -zsh\nnot a row\n   13    12    13   12 S\n');
    expect(rows).toEqual([
      { pid: 12, ppid: 1, pgid: 12, tpgid: 12, stat: 'Ss+', args: '-zsh' },
      { pid: 13, ppid: 12, pgid: 13, tpgid: 12, stat: 'S', args: '' },
    ]);
  });
});

describe('killGroup', () => {
  it('refuses a group that would reach every process, or its own', () => {
    for (const g of [-1, 0, 1]) expect(() => killGroup(g, 'SIGTERM')).toThrow(/process group/);
  });

  it('leaves a job that is gone, or that this user may not signal, for resting to report', async () => {
    const child = spawn('sleep', ['0'], { detached: true });
    await new Promise((r) => child.on('exit', r));
    expect(() => killGroup(child.pid!, 'SIGTERM')).not.toThrow();
    // SIGCONT harms nothing it reaches; it reaches nothing here unless this runs as root
    const rootGroup = execFileSync('ps', ['-A', '-o', 'pgid=,uid='], { encoding: 'utf8' }).split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number)).find(([pgid, uid]) => pgid > 1 && uid === 0)?.[0];
    if (process.getuid?.() !== 0 && rootGroup) expect(() => killGroup(rootGroup, 'SIGCONT')).not.toThrow();
  });
});

const runIf = hasTmux() ? describe : describe.skip;

runIf(`ProcessTable on this machine${hasTmux() ? '' : ' (skipped: tmux is not on PATH)'}`, () => {
  const started: Tmux[] = [];
  afterEach(async () => { for (const t of started.splice(0)) await t.killServer(); cleanHomes(); });

  it("reads what holds a real tmux pane from this machine's ps", async () => {
    const home = makeHome();
    fs.writeFileSync(`${home}/tmux.conf`, tmuxConfText(Config.parse({ shell: '/bin/sh' })));
    const tmux = new Tmux(`${home}/tmux.sock`, `${home}/tmux.conf`);
    await tmux.ensureServer();
    started.push(tmux);
    const w = await tmux.newWindow('c_ps', '/tmp', {});
    const [listed] = await tmux.listWindows();
    expect(listed.panePid).toBeGreaterThan(1);
    await waitFor(async () => (await ProcessTable.read()).pane(listed.panePid)?.foreground.length === 0);
    await tmux.sendLine(w.paneId, 'sleep 30 | cat', true);
    await waitFor(async () => args((await ProcessTable.read()).pane(listed.panePid)?.foreground)?.join(',') === 'sleep 30,cat');
    // a call that resting gives up on takes its tmux client with it
    await expect(tmux.listWindows(AbortSignal.abort())).rejects.toThrow(/abort/i);
    await expect(tmux.capture(w.paneId, 10, false, AbortSignal.abort())).rejects.toThrow(/abort/i);
  });
});
