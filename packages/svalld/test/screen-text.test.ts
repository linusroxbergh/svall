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

  it('ends a link an OSC ends with BEL as well, and passes other OSCs over', () => {
    expect(screenText('\x1b]8;;https://x.test/b\x07B\x1b]8;;\x07 \x1b]0;title\x07end')).toBe('B (https://x.test/b) end');
  });
});
