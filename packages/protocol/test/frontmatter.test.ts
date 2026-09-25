import { describe, expect, it } from 'vitest';
import { bodyOf, frontmatter, frontmatterEnd, withDescription } from '../src/frontmatter.js';

const SKELETON = '---\ndescription: \n---\n\n';

describe('frontmatter', () => {
  it('reads name and description', () => {
    expect(frontmatter('---\nname: ship-it\ndescription: "Commit, PR and merge"\n---\n# x')).toEqual({ name: 'ship-it', description: 'Commit, PR and merge' });
  });
  it('reads a value over several lines, block and folded ones too, as one line', () => {
    expect(frontmatter('---\nname: a\ndescription: |\n  First line.\n  Second.\n---')).toEqual({ name: 'a', description: 'First line. Second.' });
    expect(frontmatter('---\ndescription: >-\n  Folded one\n---').description).toBe('Folded one');
    expect(frontmatter('---\ndescription: Read before\n  the billing code\nname: n\n---').description).toBe('Read before the billing code');
  });
  it('answers nothing for a file without frontmatter or with an empty value', () => {
    expect(frontmatter('# just markdown')).toEqual({});
    expect(frontmatter('---\nname:\ndescription: d\n---')).toEqual({ description: 'd' });
    expect(frontmatter(SKELETON)).toEqual({});
  });
  it('unescapes a double-quoted value', () => {
    expect(frontmatter('---\ndescription: "say \\"hi\\" \\\\ ok"\n---\n').description).toBe('say "hi" \\ ok');
  });
  it('reads the first description line when there are two', () => {
    expect(frontmatter('---\ndescription: one\ndescription: two\n---\n').description).toBe('one');
  });
});

describe('frontmatterEnd and bodyOf', () => {
  it('ends just past the closing line', () => {
    expect(frontmatterEnd(SKELETON)).toBe(21);
    expect(bodyOf('---\ndescription: d\n---\n# Title\n')).toBe('# Title\n');
  });
  it('finds no block where the text does not open with one, or the closing line is not ---', () => {
    expect(frontmatterEnd('# Title\n')).toBe(0);
    expect(frontmatterEnd('---\ndescription: d\n----\n')).toBe(0);
    expect(bodyOf('# Title\n')).toBe('# Title\n');
  });
  it('closes an empty block at the second ---, leaving a later rule in the body', () => {
    expect(frontmatterEnd('---\n---\n# Plan\n\n---\nMore\n')).toBe(7);
    expect(bodyOf('---\n---\n# Plan\n\n---\nMore\n')).toBe('# Plan\n\n---\nMore\n');
    expect(frontmatter('---\n---\ndescription: d\n---\n')).toEqual({});
  });
  it('reads CRLF line ends', () => {
    expect(bodyOf('---\r\ndescription: d\r\n---\r\nbody')).toBe('body');
  });
  it('takes --- lines with trailing spaces or tabs, and a leading byte order mark', () => {
    expect(frontmatter('---\ndescription: d\n--- \t\n# x').description).toBe('d');
    expect(frontmatterEnd('--- \ndescription: d\n--- \n# x')).toBe(24);
    expect(bodyOf('---\t\ndescription: d\n---  \n# x')).toBe('# x');
    expect(frontmatter('﻿---\ndescription: d\n---\n').description).toBe('d');
    expect(frontmatterEnd('﻿---\ndescription: d\n---\n# x')).toBe(23);
    expect(bodyOf('﻿---\ndescription: d\n---\n# x')).toBe('# x');
  });
});

describe('withDescription', () => {
  it('sets the value in place and keeps every other line', () => {
    expect(withDescription('---\nname: n\ndescription: old\ntags: x\n---\nbody', 'new')).toBe('---\nname: n\ndescription: new\ntags: x\n---\nbody');
  });
  it('adds the line first when the block has none', () => {
    expect(withDescription('---\nname: n\n---\nbody', 'd')).toBe('---\ndescription: d\nname: n\n---\nbody');
  });
  it('makes the block when there is none', () => {
    expect(withDescription('# Title\n', 'd')).toBe('---\ndescription: d\n---\n\n# Title\n');
  });
  it('replaces a block scalar and its indented lines', () => {
    expect(withDescription('---\ndescription: >\n  folded\n  more\nname: n\n---\n', 'd')).toBe('---\ndescription: d\nname: n\n---\n');
  });
  it('writes the whole of a value over several lines, so an edit to what the field shows loses none of it', () => {
    const doc = '---\ndescription: >\n  Read before touching billing,\n  and before any refund work.\nname: n\n---\n# Body\n';
    const shown = frontmatter(doc).description!;
    expect(withDescription(doc, `${shown}!`)).toBe('---\ndescription: Read before touching billing, and before any refund work.!\nname: n\n---\n# Body\n');
  });
  it('fills an empty block', () => {
    expect(withDescription('---\n---\nbody', 'd')).toBe('---\ndescription: d\n---\nbody');
  });
  it('keeps a byte order mark and the --- lines as they are written', () => {
    expect(withDescription('﻿--- \ndescription: a\nname: n \n---\t\nbody', 'b')).toBe('﻿--- \ndescription: b\nname: n \n---\t\nbody');
  });
  it('writes the first description line when there are two, and reads that one back', () => {
    const two = withDescription('---\ndescription: one\ndescription: two\n---\n', 'new');
    expect(two).toBe('---\ndescription: new\ndescription: two\n---\n');
    expect(frontmatter(two).description).toBe('new');
  });
  it('keeps CRLF line ends', () => {
    expect(withDescription('---\r\ndescription: a\r\n---\r\nbody', 'b')).toBe('---\r\ndescription: b\r\n---\r\nbody');
  });
  it('writes a typed newline as a space', () => {
    expect(withDescription(SKELETON, 'a\nb')).toBe('---\ndescription: a b\n---\n\n');
  });
  it('leaves the skeleton as it is for an empty value', () => {
    expect(withDescription(SKELETON, '')).toBe(SKELETON);
  });
  it('reads back exactly what a person typed', () => {
    for (const v of ['plain words', 'a: b', 'x #y', '#tag', '"quoted"', "'single'", "it's", ' lead', 'trail ', 'ends:', '|', '>', 'back\\slash', '- dash', 'semi; colon']) {
      expect(frontmatter(withDescription(SKELETON, v)).description).toBe(v);
    }
  });
});
