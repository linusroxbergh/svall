import { describe, expect, it } from 'vitest';
import { parseLine, unescapeOutput } from '../src/tmux/parse.js';

describe('unescapeOutput', () => {
  it('decodes octal escapes and passes high bytes through', () => {
    const s = 'a\\015\\012' + String.fromCharCode(0xc3) + String.fromCharCode(0xa5) + '\\134';
    expect([...unescapeOutput(s)]).toEqual([0x61, 0x0d, 0x0a, 0xc3, 0xa5, 0x5c]);
  });
  it('leaves a lone backslash that is not an escape', () => {
    expect(unescapeOutput('x\\y').toString('latin1')).toBe('x\\y');
  });
});

describe('parseLine', () => {
  it('parses %output', () => {
    expect(parseLine('%output %1 hi\\015\\012')).toEqual({ type: 'output', paneId: '%1', data: Buffer.from('hi\r\n') });
  });
  it('parses %extended-output', () => {
    expect(parseLine('%extended-output %1 0 : a : b')).toEqual({ type: 'output', paneId: '%1', data: Buffer.from('a : b') });
  });
  it('parses empty output', () => {
    expect(parseLine('%output %3 ')).toEqual({ type: 'output', paneId: '%3', data: Buffer.alloc(0) });
  });
  it('parses window events, both linked and unlinked forms', () => {
    expect(parseLine('%window-close @2')).toEqual({ type: 'window-close', windowId: '@2' });
    expect(parseLine('%unlinked-window-close @2')).toEqual({ type: 'window-close', windowId: '@2' });
  });
  it('parses pause, continue, exit, begin/end and unknowns', () => {
    expect(parseLine('%pause %1')).toEqual({ type: 'pause', paneId: '%1' });
    expect(parseLine('%continue %1')).toEqual({ type: 'continue', paneId: '%1' });
    expect(parseLine('%exit server exited')).toEqual({ type: 'exit', reason: 'server exited' });
    expect(parseLine('%begin 1 2 0')).toEqual({ type: 'begin' });
    expect(parseLine('%end 1 2 0')).toEqual({ type: 'end' });
    expect(parseLine('%error 1 2 0')).toEqual({ type: 'error' });
    expect(parseLine('%session-changed $0 fleet')).toEqual({ type: 'other', raw: '%session-changed $0 fleet' });
    expect(parseLine('plain text')).toEqual({ type: 'other', raw: 'plain text' });
  });
});
