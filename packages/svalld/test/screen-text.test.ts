import { describe, expect, it } from 'vitest';
import { screenText } from '../src/tmux/tmux.js';

const link = (url: string, text: string, params = '') => `\x1b]8;${params};${url}\x1b\\${text}\x1b]8;;\x1b\\`;

describe('screenText', () => {
  it('reads capture-pane -e rows as -p prints them, without escapes or the spaces a colour kept', () => {
    expect(screenText('\x1b[1m\x1b[38;2;1;2;3mbold\x1b[0m text\n\x1b[44mbg   \x1b[49m\nå')).toBe('bold text\nbg\nå');
  });

  it('follows a link drawn as a label with its url, which -p would lose', () => {
    expect(screenText(`see ${link('https://github.com/o/r/pull/12', 'PR #12', 'id=7')} done`)).toBe('see PR #12 (https://github.com/o/r/pull/12) done');
    expect(screenText(`a ${link('https://x.test/docs', 'docs')}`)).toBe('a docs (https://x.test/docs)');
  });

  it('leaves a link drawn as its own url as it is', () => {
    expect(screenText(`bare ${link('https://x.test/a', 'https://x.test/a')}`)).toBe('bare https://x.test/a');
  });

  it('names a url once, at the first row a link wrapped over shows', () => {
    const url = 'https://github.com/o/r/pull/12/files#diff-0123456789abcdef';
    expect(screenText(`long ${link(url, 'https://github.com/o/r/pull/12/files#diff-')}\n${link(url, '0123456789abcdef')}`))
      .toBe(`long https://github.com/o/r/pull/12/files#diff- (${url})\n0123456789abcdef`);
  });

  it('leaves out the placeholder or suggestion an agent draws faint on its prompt line, and keeps its past prompts', () => {
    expect(screenText('\x1b[39m❯ \x1b[2mmerge it\x1b[0m')).toBe('❯ ');
    expect(screenText('\x1b[38;5;246m❯ \x1b[7m\x1b[39mP\x1b[0;2mress up to edit queued messages\x1b[0m')).toBe('❯ ');
    expect(screenText('\x1b[39m❯ half typed draft\x1b[7m \x1b[0m')).toBe('❯ half typed draft');
    expect(screenText('\x1b[38;5;246m\x1b[48;5;237m❯ \x1b[38;5;231mmerge it\x1b[39m')).toBe('❯ merge it');
    expect(screenText('\x1b[1m›\x1b[0m\x1b[48;2;30;30;30m \x1b[2mAsk Codex to do anything\x1b[0m\x1b[48;2;30;30;30m   ')).toBe('›');
    expect(screenText('\x1b[1;2m› \x1b[0m\x1b[48;2;40;40;40mmerge it')).toBe('› merge it');
  });

  it('ends a link an OSC ends with BEL as well, and passes other OSCs over', () => {
    expect(screenText('\x1b]8;;https://x.test/b\x07B\x1b]8;;\x07 \x1b]0;title\x07end')).toBe('B (https://x.test/b) end');
  });
});
