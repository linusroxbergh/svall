import { describe, expect, it } from 'vitest';
import { contextKind, linkGlyph, linkKind } from '../src/links.js';
import { LinkKind } from '../src/state.js';

describe('linkKind', () => {
  it('tells a github pull request from an issue and from the rest of the host', () => {
    expect(linkKind('https://github.com/a/b/pull/12')).toBe('pr');
    expect(linkKind('https://github.com/a/b/issues/12')).toBe('issue');
    expect(linkKind('https://github.com/a/b/blob/main/x.ts')).toBe('github');
  });

  it('reads the common tools off the host', () => {
    expect(linkKind('linear.app/acme/issue/ENG-1')).toBe('linear');
    expect(linkKind('https://acme.atlassian.net/browse/AB-1')).toBe('jira');
    expect(linkKind('https://www.notion.so/page')).toBe('notion');
    expect(linkKind('https://acme.slack.com/archives/C1')).toBe('slack');
    expect(linkKind('https://www.figma.com/file/x')).toBe('figma');
    expect(linkKind('https://acme.sentry.io/issues/1')).toBe('sentry');
    expect(linkKind('https://app.datadoghq.eu/dashboard/x')).toBe('datadog');
    expect(linkKind('https://docs.google.com/document/d/x')).toBe('gdocs');
  });

  it('tells confluence from jira, and drive from docs', () => {
    expect(linkKind('https://acme.atlassian.net/wiki/spaces/X')).toBe('confluence');
    expect(linkKind('https://drive.google.com/file/d/x')).toBe('gdrive');
  });

  it('reads the rest of the everyday hosts', () => {
    expect(linkKind('https://trello.com/b/x')).toBe('trello');
    expect(linkKind('https://app.asana.com/0/1/2')).toBe('asana');
    expect(linkKind('https://asana.com/pricing')).toBe('asana');
    expect(linkKind('https://discord.com/channels/1/2')).toBe('discord');
    expect(linkKind('https://www.youtube.com/watch?v=x')).toBe('youtube');
    expect(linkKind('https://youtu.be/x')).toBe('youtube');
    expect(linkKind('https://stackoverflow.com/questions/1')).toBe('stackoverflow');
    expect(linkKind('https://miro.com/app/board/x')).toBe('miro');
    expect(linkKind('https://www.dropbox.com/s/x')).toBe('dropbox');
  });

  it('reads mentimeter off every host it ships on, and claude off its own', () => {
    expect(linkKind('https://www.mentimeter.com/app/presentation/x')).toBe('mentimeter');
    expect(linkKind('https://voting-preview.mentimeter.app/?code=12345678')).toBe('mentimeter');
    expect(linkKind('https://www.menti.com/alxyz')).toBe('mentimeter');
    expect(linkKind('https://claude.ai/public/artifacts/x')).toBe('claude');
    expect(linkKind('https://code.claude.com/docs')).toBe('claude');
    expect(linkKind('https://docs.anthropic.com/x')).toBe('claude');
    expect(linkKind('https://notmentimeter.com/x')).toBe('other');
  });

  it('ignores a www prefix and the case of the host', () => {
    expect(linkKind('https://www.github.com/a/b/pull/7')).toBe('pr');
    expect(linkKind('https://www.linear.app/acme/issue/ENG-1')).toBe('linear');
    expect(linkKind('HTTPS://GitHub.com/a/b/issues/3')).toBe('issue');
  });

  it('reads a bare host with or without its trailing slash', () => {
    expect(linkKind('https://github.com/')).toBe('github');
    expect(linkKind('https://github.com')).toBe('github');
  });

  it('anchors on the host, so a path or query cannot claim a kind', () => {
    expect(linkKind('https://evil.com/x/.atlassian.net/y')).toBe('other');
    expect(linkKind('https://evil.com/?u=a.slack.com/x')).toBe('other');
    expect(linkKind('https://notsentry.io/a')).toBe('other');
  });

  it('falls back to other', () => {
    expect(linkKind('https://example.com/x')).toBe('other');
    expect(linkKind('nonsense')).toBe('other');
  });
});

describe('linkGlyph', () => {
  it('has a glyph for every kind', () => {
    for (const kind of LinkKind.options) expect(linkGlyph(kind)).toMatch(/^[A-Z]{2,3}$/);
    expect(linkGlyph('pr')).toBe('PR');
  });
});

it('reads a path as a file until the daemon settles it, and has glyphs for both', () => {
  expect(contextKind('/Users/x/notes/spec.md')).toBe('file');
  expect(contextKind('~/notes')).toBe('file');
  expect(contextKind('https://github.com/a/b/pull/7')).toBe('pr');
  expect(linkGlyph('file')).toBe('FILE');
  expect(linkGlyph('folder')).toBe('DIR');
});
