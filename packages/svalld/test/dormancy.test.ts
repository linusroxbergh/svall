import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Agent, Robot, FleetState } from '@svall/protocol';
import { drowsy, freshCommand, markDormant, rememberFlags, resumeHere, resumeNote, reviveCommand, runsInBackground, sleepFlags, startFlags, unsaved, RESUME_NOTE } from '../src/dormancy.js';
import { snapshot, syncWindow } from '../src/reconcile.js';

const SID = '3f2b8c1e-6a4d-4e7b-9c21-5d8f0a1b2c3d';
const OSID = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
const HOUR = 3_600_000;
const agent = (over: Partial<Agent> = {}): Agent => ({ kind: 'claude', sessionId: SID, status: 'idle', lastActivityAt: 0, ...over });
const robot = (over: Partial<Robot> = {}): Robot => ({
  id: 'c_a', islandId: 'i_1', cell: { x: 0, y: 1 }, name: 'a', portrait: 'fox', note: '', instructions: '', cwd: '/repo', context: [],
  tmux: { windowId: '@1', paneId: '%1' }, shell: { lastOutputAt: 0 }, unread: false, agent: agent(), ...over,
});

describe('drowsy', () => {
  it('takes an idle or done agent once it has rested the whole limit', () => {
    expect(drowsy(robot(), 12 * HOUR, 12 * HOUR)).toBe(true);
    expect(drowsy(robot({ agent: agent({ status: 'done' }) }), 12 * HOUR, 12 * HOUR)).toBe(true);
    expect(drowsy(robot(), 12 * HOUR - 1, 12 * HOUR)).toBe(false);
  });

  it('counts the rest from the last look the user took, if later', () => {
    expect(drowsy(robot(), 12 * HOUR, 12 * HOUR, HOUR)).toBe(false);
    expect(drowsy(robot(), 13 * HOUR, 12 * HOUR, HOUR)).toBe(true);
  });

  it('leaves an agent at work, waiting on the user, with news the user has not seen, or on a failed turn', () => {
    const late = 100 * HOUR;
    expect(drowsy(robot({ agent: agent({ status: 'working' }) }), late, HOUR)).toBe(false);
    expect(drowsy(robot({ agent: agent({ status: 'blocked' }) }), late, HOUR)).toBe(false);
    expect(drowsy(robot({ agent: agent({ status: 'done', background: true }) }), late, HOUR)).toBe(false);
    expect(drowsy(robot({ agent: agent({ status: 'done', monitors: ['b1'] }) }), late, HOUR)).toBe(false);
    expect(drowsy(robot({ unread: true }), late, HOUR)).toBe(false);
    expect(drowsy(robot({ agent: agent({ status: 'idle', prompt: "You've hit your limit · resets 9pm" }) }), late, HOUR)).toBe(false);
  });

  it('leaves a plain shell, a dormant robot, and a session no resume could name', () => {
    const late = 100 * HOUR;
    expect(drowsy(robot({ agent: undefined }), late, HOUR)).toBe(false);
    expect(drowsy(robot({ tmux: undefined }), late, HOUR)).toBe(false);
    expect(drowsy(robot({ agent: agent({ sessionId: 'x; rm -rf ~' }) }), late, HOUR)).toBe(false);
  });

  it('leaves a robot with a second terminal open, which only a sleep closes', () => {
    expect(drowsy(robot({ second: { cwd: '/repo', tmux: { windowId: '@2', paneId: '%2' }, unread: false } }), 100 * HOUR, HOUR)).toBe(false);
  });

  it('takes a robot whose second terminal is dormant, with no window to close', () => {
    const second = { cwd: '/repo', unread: false, agent: agent(), revive: { command: `claude --resume ${SID}` } };
    expect(drowsy(robot({ second }), 100 * HOUR, HOUR)).toBe(true);
  });
});

describe('startFlags', () => {
  it("keeps what a claude resume does not restore, quoted, and leaves it the model and mode it had", () => {
    expect(startFlags('claude --model claude-opus-5-5[1m] --effort xhigh --dangerously-skip-permissions', 'claude'))
      .toEqual(['--effort', "'xhigh'", '--dangerously-skip-permissions']);
    expect(startFlags('claude --permission-mode=plan --agent reviewer', 'claude')).toEqual([]);
    expect(startFlags('claude --permission-mode bypassPermissions', 'claude')).toEqual(['--permission-mode', "'bypassPermissions'"]);
  });

  it('drops what described the start: a worktree to make, a session to resume, dirs and the prompt', () => {
    expect(startFlags('claude -w inbox --effort high --add-dir /x --resume 1234 -- look at --model haiku', 'claude'))
      .toEqual(['--effort', "'high'"]);
    expect(startFlags('claude -w --effort high', 'claude')).toEqual(['--effort', "'high'"]);
    expect(startFlags(`claude -r ${SID} --effort high`, 'claude')).toEqual(['--effort', "'high'"]);
    expect(startFlags('claude --continue --verbose', 'claude')).toEqual([]);
    expect(startFlags('claude', 'claude')).toEqual([]);
  });

  it('ends nothing whose launch the resume would change: a flag it does not know, or a value it cannot carry', () => {
    expect(startFlags('claude --dangerously-skip-permissions --disallowedTools Bash', 'claude')).toBeUndefined();
    expect(startFlags('claude --settings /x/deny.json', 'claude')).toBeUndefined();
    expect(startFlags("claude --effort a'b", 'claude')).toBeUndefined();
    expect(startFlags('claude --effort --dangerously-skip-permissions', 'claude')).toBeUndefined();
  });

  it('reads no flag out of a prompt, whose words ps prints unquoted', () => {
    expect(startFlags('claude fix it', 'claude')).toEqual([]);
    expect(startFlags('claude --dangerously-skip-permissions -- look at --model haiku', 'claude')).toEqual(['--dangerously-skip-permissions']);
    // past a bare word, a prompt and a value cut at its space look the same
    expect(startFlags('claude explain --dangerously-skip-permissions', 'claude')).toBeUndefined();
    expect(startFlags('claude --add-dir /My Docs --dangerously-skip-permissions', 'claude')).toBeUndefined();
    expect(startFlags('codex check git log -p output', 'codex')).toBeUndefined();
  });

  it("keeps a codex agent's model, profile, sandbox, approval, provider and hook-trust flags", () => {
    expect(startFlags('/opt/codex/codex -m gpt-5.5 -s workspace-write -a never --dangerously-bypass-approvals-and-sandbox -c x=y', 'codex'))
      .toEqual(['-m', "'gpt-5.5'", '-s', "'workspace-write'", '-a', "'never'", '--dangerously-bypass-approvals-and-sandbox']);
    expect(startFlags('codex --oss --local-provider ollama -m gpt-oss:20b --approve-for-me', 'codex'))
      .toEqual(['--oss', '--local-provider', "'ollama'", '-m', "'gpt-oss:20b'", '--approve-for-me']);
    expect(startFlags('codex -C /repo --add-dir /x --yolo --dangerously-bypass-hook-trust -m gpt-5.5', 'codex'))
      .toEqual(['--yolo', '--dangerously-bypass-hook-trust', '-m', "'gpt-5.5'"]);
  });

  it('keeps the flags of an agent already resumed, so they last through every sleep', () => {
    expect(startFlags(`codex resume -c tui.resume_cwd=session -m gpt-5.5 ${SID}`, 'codex')).toEqual(['-m', "'gpt-5.5'"]);
    expect(startFlags(`claude --effort high --resume ${SID} --add-dir /x`, 'claude')).toEqual(['--effort', "'high'"]);
    // woken with a prompt, or with the island's folders
    expect(startFlags(`codex resume -c tui.resume_cwd=session -m gpt-5.5 ${SID} -- look at --model haiku`, 'codex')).toEqual(['-m', "'gpt-5.5'"]);
    expect(startFlags(`codex resume -c tui.resume_cwd=session ${SID} --add-dir /x`, 'codex')).toEqual([]);
    expect(startFlags(`codex resume --no-daemon -c check_for_update_on_startup=false -c tui.resume_cwd=session -m gpt-5.5 ${SID}`, 'codex')).toEqual(['-m', "'gpt-5.5'"]);
    expect(startFlags('codex --no-daemon -m gpt-5.5 -- fix it', 'codex')).toEqual(['-m', "'gpt-5.5'"]);
  });

  it("reads a codex resume or fork typed into the robot's zsh, which puts --no-daemon before it", () => {
    expect(startFlags(`codex --no-daemon resume -m gpt-5.5 ${SID}`, 'codex')).toEqual(['-m', "'gpt-5.5'"]);
    expect(startFlags(`codex --no-daemon fork --yolo ${SID}`, 'codex')).toEqual(['--yolo']);
    expect(startFlags(`codex --no-daemon resume ${SID}`, 'codex')).toEqual([]);
    // a bare word after the subcommand is a prompt, and the session id is one only when resuming
    expect(startFlags(`codex --no-daemon resume ${SID} explain -m gpt-5.5`, 'codex')).toBeUndefined();
    expect(startFlags(`codex ${SID} -m gpt-5.5`, 'codex')).toBeUndefined();
  });

  it('reads an agent run by node, and nothing from a process that is not the agent', () => {
    expect(startFlags('node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --effort high', 'claude')).toEqual(['--effort', "'high'"]);
    expect(startFlags('node /Users/x/.nvm/versions/node/v24.18.0/bin/claude --effort high', 'claude')).toEqual(['--effort', "'high'"]);
    expect(startFlags('vim --model x', 'claude')).toBeUndefined();
    expect(startFlags('node /Users/x/.claude/plugins/helper/claude.js --model x', 'claude')).toBeUndefined();
    expect(startFlags('claude --model opus', 'codex')).toBeUndefined();
  });

  it("keeps an opencode agent's --auto, and drops its session, prompt and private server, which svalld adds back", () => {
    expect(startFlags('opencode --standalone --auto --prompt fix it', 'opencode')).toEqual(['--auto']);
    expect(startFlags('opencode --standalone --yolo', 'opencode')).toEqual(['--yolo']);
    expect(startFlags(`opencode.exe --standalone -s ${OSID}`, 'opencode')).toEqual([]);
    expect(startFlags('opencode --server http://localhost:4096', 'opencode')).toBeUndefined();
    // svalld puts the prompt last, where a bullet or a flag in its text is no option
    expect(startFlags('opencode --standalone --prompt fix these: - the --force flag', 'opencode')).toEqual([]);
    expect(startFlags('opencode --standalone --auto --prompt=- fix these: - the --force flag', 'opencode')).toEqual(['--auto']);
    expect(startFlags('opencode --standalone --prompt=a=b --force', 'opencode')).toEqual([]);
    expect(startFlags('opencode --standalone --promptx y', 'opencode')).toBeUndefined();
  });
});

describe('runsInBackground', () => {
  const proc = (pid: number, ppid: number, pgid: number, args = '') => ({ pid, ppid, pgid, args });

  it('is true while a descendant runs outside the agent\'s process group, as the Bash tool starts it', () => {
    const agentTree = [proc(10, 1, 10), proc(11, 10, 10), proc(12, 11, 10)];
    expect(runsInBackground(10, agentTree)).toBe(false);
    expect(runsInBackground(10, [...agentTree, proc(20, 10, 20), proc(21, 20, 20)])).toBe(true);
    expect(runsInBackground(10, [...agentTree, proc(30, 12, 30)])).toBe(true);
    expect(runsInBackground(10, [...agentTree, proc(40, 1, 40)])).toBe(false);
  });

  it("counts OpenCode's private server, in a group of its own, as the agent, and a shell or MCP server it runs as background", () => {
    const tree = [proc(10, 1, 10, 'opencode --standalone'), proc(11, 10, 11, '/u/.opencode/bin/opencode serve --stdio --port 0')];
    expect(runsInBackground(10, tree)).toBe(false);
    // the shell has exec'd its lone command
    expect(runsInBackground(10, [...tree, proc(13, 11, 13, 'npm run dev')])).toBe(true);
    expect(runsInBackground(10, [...tree, proc(12, 11, 12, 'npx -y mcp-server')])).toBe(true);
    expect(runsInBackground(10, [proc(10, 1, 10), proc(11, 10, 11, 'serve --stdio')])).toBe(true);
  });
});

describe('reviveCommand', () => {
  it('resumes with the flags the agent was started with', () => {
    expect(reviveCommand(robot(), ['--effort', "'high'"])).toBe(`claude --effort 'high' --resume ${SID}`);
    expect(reviveCommand(robot({ agent: agent({ kind: 'codex' }) }), ['-m', "'gpt-5.5'"]))
      .toBe(`codex resume -c tui.resume_cwd=session -m 'gpt-5.5' ${SID}`);
    expect(reviveCommand(robot())).toBe(`claude --resume ${SID}`);
  });

  it('resumes an opencode session with -s', () => {
    expect(reviveCommand(robot({ agent: agent({ kind: 'opencode', sessionId: OSID }) }), ['--auto'])).toBe(`opencode --auto -s ${OSID}`);
  });
});

describe('markDormant', () => {
  it('marks an agent ended mid-turn or on a question interrupted, and one at rest not', () => {
    for (const status of ['working', 'blocked'] as const) {
      const c = robot({ agent: agent({ status }) });
      markDormant(c);
      expect(c.revive).toEqual({ command: `claude --resume ${SID}`, interrupted: true });
      expect(c.agent?.status).toBe('idle');
    }
    for (const status of ['idle', 'done'] as const) {
      const c = robot({ agent: agent({ status }) });
      markDormant(c);
      expect(c.revive).toEqual({ command: `claude --resume ${SID}` });
    }
  });
  it('marks an agent whose monitors were still watching or subagents still running interrupted, and forgets them', () => {
    for (const running of [{ monitors: ['b1'] }, { subagents: ['a1'] }]) {
      const c = robot({ agent: agent({ status: 'done', ...running }) });
      markDormant(c);
      expect(c.revive).toEqual({ command: `claude --resume ${SID}`, interrupted: true });
      expect(c.agent).toMatchObject({ status: 'done' });
      expect(c.agent?.monitors).toBeUndefined();
      expect(c.agent?.subagents).toBeUndefined();
    }
  });
  it('resumes with the flags remembered at the start when none are read off the process', () => {
    const c = robot({ agent: agent({ pid: 7 }) });
    rememberFlags(c, [{ pid: 7, ppid: 1, pgid: 7, args: 'claude --effort high' }]);
    expect(c.agent?.flags).toEqual(['--effort', "'high'"]);
    markDormant(c);
    expect(c.revive).toEqual({ command: `claude --effort 'high' --resume ${SID}` });
    // read off the process, the flags ps shows win
    const again = robot({ agent: agent({ pid: 7, flags: ['--effort', "'high'"] }) });
    markDormant(again, []);
    expect(again.revive).toEqual({ command: `claude --resume ${SID}` });
    // a launch without flags, or one no resume repeats, remembers none
    for (const args of ['claude', 'claude --settings /x/deny.json']) {
      rememberFlags(c, [{ pid: 7, ppid: 1, pgid: 7, args }]);
      expect(c.agent).not.toHaveProperty('flags');
    }
  });
  it('forgets the brief the session was told, going dormant or already dormant at a listing', () => {
    const c = robot({ agent: agent({ brief: '# Svall context' }) });
    markDormant(c);
    expect(c.agent).not.toHaveProperty('brief');
    const asleep = robot({ tmux: undefined, revive: { command: 'claude --resume x', interrupted: true }, agent: agent({ brief: '# Svall context' }) });
    syncWindow(asleep, new Map(), snapshot({ islands: {}, robots: { [asleep.id]: asleep } } as unknown as FleetState));
    expect(asleep.agent).not.toHaveProperty('brief');
    expect(asleep.revive).toEqual({ command: 'claude --resume x', interrupted: true });
  });
});

describe('sleepFlags', () => {
  const transcript = path.join(os.tmpdir(), `sleepflags-${process.pid}.jsonl`);
  const withAgent = (over: Partial<Agent> = {}) => robot({ agent: agent({ pid: 7, transcriptPath: transcript, ...over }) });
  beforeAll(() => fs.writeFileSync(transcript, ''));
  afterAll(() => fs.rmSync(transcript, { force: true }));

  it('gives the launch flags of an agent that can be resumed', () => {
    expect(sleepFlags(withAgent(), [{ pid: 7, args: 'claude' }])).toEqual([]);
  });

  it('gives none when the transcript is missing, the pid is gone, or the launch cannot be repeated', () => {
    expect(sleepFlags(withAgent({ transcriptPath: '/nope/x.jsonl' }), [{ pid: 7, args: 'claude' }])).toBeUndefined();
    expect(sleepFlags(withAgent(), [{ pid: 8, args: 'claude' }])).toBeUndefined();
    expect(sleepFlags(withAgent(), [{ pid: 7, args: 'claude --bogus' }])).toBeUndefined();
  });

  it('gives none for a session it could not resume', () => {
    expect(sleepFlags(withAgent({ sessionId: 'not a session' }), [{ pid: 7, args: 'claude' }])).toBeUndefined();
  });
});

describe('freshCommand', () => {
  const SID = '1fb0d1a7-29a9-4159-a932-5ffd2da8faba';
  const OSID = 'ses_0f3a5b7c9d1eAbCdEfGhIjKlMn';
  it('starts a new session with the launch flags the resume carries', () => {
    expect(freshCommand(`claude --dangerously-skip-permissions --effort 'high' --resume ${SID}`, 'claude', SID)).toBe("claude --dangerously-skip-permissions --effort 'high'");
    expect(freshCommand(`codex resume -c tui.resume_cwd=session --yolo -m 'gpt-6' ${SID}`, 'codex', SID)).toBe("codex --yolo -m 'gpt-6'");
    expect(freshCommand(`opencode --auto -s ${OSID}`, 'opencode', OSID)).toBe('opencode --auto');
    expect(freshCommand(`claude --resume ${SID}`, 'claude', SID)).toBe('claude');
  });

  it('starts the bare agent from a resume of another session, or of none', () => {
    expect(freshCommand(`claude --effort 'high' --resume ${SID}`, 'claude', 'another')).toBe('claude');
    expect(freshCommand('', 'codex', SID)).toBe('codex');
  });
});

describe('unsaved', () => {
  let projects: string;
  beforeAll(() => { projects = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'svall-unsaved-')), 'projects'); fs.mkdirSync(path.join(projects, '-a'), { recursive: true }); fs.mkdirSync(path.join(projects, '-b')); });
  afterAll(() => fs.rmSync(path.dirname(projects), { recursive: true, force: true }));
  const slot = (over: Partial<Agent> = {}, command = `claude --effort 'high' --resume ${SID}`) =>
    robot({ tmux: undefined, revive: { command }, agent: agent({ transcriptPath: path.join(projects, '-a', `${SID}.jsonl`), ...over }) });

  it('starts claude afresh with its flags when the session it resumes saved no transcript, as one never prompted', () => {
    expect(unsaved(slot())).toBe("claude --effort 'high'");
  });

  it('resumes a session whose transcript is on disk, in its own project or another one a resume elsewhere left it in', () => {
    fs.writeFileSync(path.join(projects, '-b', `${SID}.jsonl`), '');
    expect(unsaved(slot())).toBeUndefined();
    fs.writeFileSync(path.join(projects, '-a', `${SID}.jsonl`), '');
    expect(unsaved(slot())).toBeUndefined();
  });

  it("leaves a session with no transcript on record, a revive that resumes no session of it, and any other agent's", () => {
    const missing = path.join(projects, '-a', 'f0f0f0f0-0000-4000-8000-000000000000.jsonl');
    expect(unsaved(slot({ transcriptPath: undefined }))).toBeUndefined();
    expect(unsaved(slot({ transcriptPath: missing }, 'claude --resume f0f0f0f0-1111-4000-8000-000000000000'))).toBeUndefined();
    expect(unsaved(slot({ transcriptPath: missing }, `: --resume ${SID}`))).toBeUndefined();
    expect(unsaved(slot({ kind: 'codex', transcriptPath: missing }, `codex resume -c tui.resume_cwd=session ${SID}`))).toBeUndefined();
    expect(unsaved(robot({ revive: undefined }))).toBeUndefined();
  });
});

describe('resumeHere', () => {
  const plain = `codex resume -c tui.resume_cwd=session -m 'gpt-6' ${SID}`;

  it('resumes Codex in the folder the window opens in while the one its rollout last recorded is not on this machine', () => {
    expect(resumeHere(plain, true)).toBe(`codex resume -c tui.resume_cwd=current -m 'gpt-6' ${SID}`);
  });

  it('leaves a resume whose recorded folder is here, and any other agent\'s, as it is', () => {
    expect(resumeHere(plain, false)).toBe(plain);
    expect(resumeHere(`claude --resume ${SID}`, true)).toBe(`claude --resume ${SID}`);
  });
});

describe('resumeNote', () => {
  it('tells a session whose folder is not on this machine where it works now', () => {
    expect(resumeNote()).toBe(RESUME_NOTE);
    expect(resumeNote({ from: '/Users/ada/app', to: '/home/ada/app' })).toBe(`${RESUME_NOTE} The folder this session last worked in, /Users/ada/app, is not on this machine; it works in /home/ada/app now, so check a path from earlier in this conversation before using it.`);
  });
});
