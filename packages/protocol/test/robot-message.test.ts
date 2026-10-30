import { describe, expect, it } from 'vitest';
import { robotMessage, robotSender } from '../src/index.js';

const from = { name: '#472 auth (review)]', id: 'c_abc123' };

describe('robotMessage', () => {
  it('puts a line naming the sender and how to answer it before the text', () => {
    expect(robotMessage(from, 'tests pass\nPR is up')).toBe('[from robot #472 auth (review)] (c_abc123); reply with svall robot send c_abc123]\ntests pass\nPR is up');
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
