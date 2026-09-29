import { describe, expect, it } from 'vitest';
import { markdownLink } from '../src/ide/markdown-links.js';

describe('Markdown links', () => {
  it('resolves local files from the open file without leaving its root', () => {
    expect(markdownLink('docs/README.md', './setup.md')).toEqual({ kind: 'file', path: 'docs/setup.md' });
    expect(markdownLink('docs/README.md', '../guide.md')).toEqual({ kind: 'file', path: 'guide.md' });
    expect(markdownLink('docs/README.md', '../../outside.md')).toEqual({ kind: 'unsupported' });
  });

  it('keeps section links in the preview and web links external', () => {
    expect(markdownLink('README.md', '#prerequisites')).toEqual({ kind: 'anchor', fragment: 'prerequisites' });
    expect(markdownLink('README.md', './README.md#prerequisites')).toEqual({ kind: 'anchor', fragment: 'prerequisites' });
    expect(markdownLink('README.md', 'https://example.com')).toEqual({ kind: 'external', href: 'https://example.com' });
  });
});
