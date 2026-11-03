import { describe, expect, it } from 'vitest';
import { isRobotSaid, owedTo, reportBegan, robotMessage, robotNotice, robotSender, says, type Agent, type Robot } from '../src/index.js';

const from = { name: '#472 auth (review)]', id: 'c_abc123' };

describe('robotMessage', () => {
  it('puts a line naming the sender and how to answer it before the text', () => {
    expect(robotMessage(from, 'tests pass\nPR is up')).toBe('[from robot #472 auth (review)] (c_abc123); reply with svall robot send c_abc123]\ntests pass\nPR is up');
  });

  it("keeps the header one line a 2000-character clip still holds, whatever the name, and drops control bytes from the text", () => {
    expect(robotSender(robotMessage({ name: 'lead\nx\r\ty', id: 'c_abc123' }, 'hi'))).toBe('c_abc123');
    expect(robotMessage({ name: 'lead\u001b[201~', id: 'c_abc123' }, 'a\r\nb\rc\u001b[201~\r!echo\td\u009b')).toBe('[from robot lead[201~ (c_abc123); reply with svall robot send c_abc123]\na\nb\nc[201~\n!echo\td');
    expect(robotSender(robotMessage({ name: 'x'.repeat(5000), id: 'c_abc123' }, 'hi').slice(0, 2000))).toBe('c_abc123');
  });
});

describe('robotSender', () => {
  const sent = robotMessage(from, 'tests pass');

  it('reads the sender off a message as typed, and off one clipped to its head', () => {
    expect(robotSender(sent)).toBe('c_abc123');
    expect(robotSender(robotMessage(from, ''))).toBe('c_abc123');
    expect(robotSender(`${sent}${'x'.repeat(3000)}`.slice(0, 2000))).toBe('c_abc123');
  });

  it("reads it inside the wrapper Claude Code stores a collapsed paste in, trimmed or as its hook gets it", () => {
    const wrapped = `\n\n<pasted_content id="e0b1">\n${sent}\n</pasted_content id="e0b1">\n`;
    expect(robotSender(wrapped)).toBe('c_abc123');
    expect(robotSender(wrapped.trim())).toBe('c_abc123');
  });

  it("is undefined for the user's own prompt, a header past the first line, or one naming two robots", () => {
    expect(robotSender('fix the tests')).toBeUndefined();
    expect(robotSender(`look at this:\n${sent}`)).toBeUndefined();
    expect(robotSender('[from robot a (c_abc123); reply with svall robot send c_zzz999]\nhi')).toBeUndefined();
    expect(robotSender('[from robot a (c_abc123); reply with svall robot send c_abc123] and more')).toBeUndefined();
  });
});

describe('robotNotice', () => {
  it("is one line naming the robot, which counts as robot-said, plain or inside Claude Code's paste wrapper", () => {
    const n = robotNotice({ name: 'bob\nx', id: 'c_abc123' }, 'is blocked: Bash\n rm -rf build');
    expect(n).toBe('[svall] bob x (c_abc123) is blocked: Bash rm -rf build');
    expect(isRobotSaid(n)).toBe(true);
    expect(isRobotSaid(`<pasted_content id="e0b1">\n${n}\n</pasted_content id="e0b1">`)).toBe(true);
    expect(isRobotSaid(robotMessage(from, 'hi'))).toBe(true);
    expect(isRobotSaid('[svall] is great')).toBe(false);
    expect(isRobotSaid(`see:\n${n}`)).toBe(false);
  });
});

describe('reports', () => {
  const agent = (lastPrompt?: string): Agent => ({ kind: 'claude', sessionId: 's', status: 'working', lastActivityAt: 0, ...(lastPrompt && { lastPrompt: { id: lastPrompt, text: lastPrompt === 'p2' ? robotMessage({ name: 'lead', id: 'c_lead00' }, 'go') : 'mine', at: 0 } }) });
  const robot = (extra: Partial<Robot>): Robot =>
    ({ id: 'c_kid000', islandId: 'i', cell: { x: 0, y: 0 }, name: 'kid', note: '', portrait: 'fox', instructions: '', context: [], cwd: '/tmp', shell: { lastOutputAt: 0 }, unread: false, ...extra });
  const lead = robot({ id: 'c_lead00', agent: agent() });

  it("begins with the first prompt after the one on record, the sender's own when the request was its message, and holds to it", () => {
    expect(reportBegan(robot({ agent: agent(), report: { to: 'c_lead00' } }))).toBe(false);
    expect(reportBegan(robot({ agent: agent('p1'), report: { to: 'c_lead00' } }))).toBe(true);
    expect(reportBegan(robot({ agent: agent('p1'), report: { to: 'c_lead00', after: 'p1' } }))).toBe(false);
    expect(reportBegan(robot({ agent: agent('p1'), report: { to: 'c_lead00', after: 'p0', tagged: true } }))).toBe(false);
    expect(reportBegan(robot({ agent: agent('p2'), report: { to: 'c_lead00', after: 'p0', tagged: true } }))).toBe(true);
    // once begun, only while that prompt is the newest: a later one is another request
    expect(reportBegan(robot({ agent: agent('p1'), report: { to: 'c_lead00', after: 'p0', prompt: 'p1' } }))).toBe(true);
    expect(reportBegan(robot({ agent: agent('p2'), report: { to: 'c_lead00', after: 'p0', prompt: 'p1' } }))).toBe(false);
  });

  it("begins a tagged report on the sender's message it was asked on, not an earlier one", () => {
    const sent = (text: string, id: string) => robot({ agent: { ...agent(), lastPrompt: { id, text: robotMessage({ name: 'lead', id: 'c_lead00' }, text), at: 0 } }, report: { to: 'c_lead00', after: 'p0', tagged: true, says: says('review\tPR 472\nthen merge') } });
    expect(reportBegan(sent('fix the docs', 'm1'))).toBe(false);
    expect(reportBegan(sent('review PR 472\nthen merge', 'm2'))).toBe(true);
    // as Claude Code keeps a long paste: inside its wrapper, tabs as spaces
    expect(reportBegan(robot({ ...sent('', 'm3'), agent: { ...agent(), lastPrompt: { id: 'm3', text: `<pasted_content id="e0b1">\n${robotMessage({ name: 'lead', id: 'c_lead00' }, 'review    PR 472\nthen merge')}`, at: 0 } } }))).toBe(true);
  });

  it("begins a started robot's report on its run, not on a first prompt of the user's, and holds while that prompt is the request", () => {
    const run = (text: string, id = 'p1') => robot({ agent: { ...agent(), lastPrompt: { id, text, at: 0 } }, report: { to: 'c_lead00', says: says('review PR 472') } });
    expect(reportBegan(run('review PR 472'))).toBe(true);
    expect(reportBegan(run('what is 2+2?'))).toBe(false);
    expect(reportBegan(robot({ ...run('what is 2+2?'), report: { to: 'c_lead00', says: says('review PR 472'), prompt: 'p1' } }))).toBe(false);
  });

  it("knows a request by its head as a hook hands it on, and holds through a robot's line taken into its turn", () => {
    expect(says(' go \u0001 now\t ')).toBe('go now');
    const turn = (text: string) => robot({ agent: { ...agent(), lastPrompt: { id: 'p1', text, at: 0 } }, report: { to: 'c_lead00', says: says('review PR 472'), prompt: 'p1' } });
    expect(reportBegan(turn('[svall] sub (c_sub000) is done; full answer: svall robot read c_sub000 --last'))).toBe(true);
    expect(reportBegan(turn('what is 2+2?'))).toBe(false);
  });

  it('is owed to a sender with an agent, live or dormant, once the request began', () => {
    const kid = robot({ agent: agent('p1'), report: { to: 'c_lead00' } });
    expect(owedTo({ robots: { c_lead00: lead } }, kid)?.id).toBe('c_lead00');
    expect(owedTo({ robots: {} }, kid)).toBeUndefined();
    expect(owedTo({ robots: { c_lead00: { ...lead, agent: undefined } } }, kid)).toBeUndefined();
    expect(owedTo({ robots: { c_lead00: { ...lead, tmux: undefined, revive: { command: 'claude --resume x' } } } }, kid)?.id).toBe('c_lead00');
    // a dormant shell keeps a revive too, and no agent to take the line
    expect(owedTo({ robots: { c_lead00: { ...lead, agent: undefined, revive: { command: 'zsh' } } } }, kid)).toBeUndefined();
    expect(owedTo({ robots: { c_lead00: lead } }, { ...kid, report: { to: 'c_lead00', after: 'p1' } })).toBeUndefined();
  });
});
