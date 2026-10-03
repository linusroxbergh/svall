import type { ContextKind, LinkKind } from './state.js';
import { trimEnd } from './text.js';

// first match wins, so the github PR and issue patterns come before the bare host
const PATTERNS: [RegExp, LinkKind][] = [
  [/^github\.com\/[^/]+\/[^/]+\/pull\/\d+/, 'pr'],
  [/^github\.com\/[^/]+\/[^/]+\/issues\/\d+/, 'issue'],
  [/^github\.com\//, 'github'],
  [/^gitlab\.com\//, 'gitlab'],
  [/^linear\.app\//, 'linear'],
  [/^[^/]*\.atlassian\.net\/wiki\//, 'confluence'],
  [/^[^/]*\.atlassian\.net\//, 'jira'],
  [/^notion\.(so|site)\//, 'notion'],
  [/^[^/]*\.slack\.com\//, 'slack'],
  [/^figma\.com\//, 'figma'],
  [/^([^/]*\.)?sentry\.io\//, 'sentry'],
  [/^([^/]*\.)?datadoghq\.(com|eu)\//, 'datadog'],
  [/^vercel\.com\//, 'vercel'],
  [/^(docs|sheets|slides)\.google\.com\//, 'gdocs'],
  [/^drive\.google\.com\//, 'gdrive'],
  [/^npmjs\.com\//, 'npm'],
  [/^loom\.com\//, 'loom'],
  [/^trello\.com\//, 'trello'],
  [/^(app\.)?asana\.com\//, 'asana'],
  [/^discord\.com\//, 'discord'],
  [/^(youtube\.com|youtu\.be)\//, 'youtube'],
  [/^stackoverflow\.com\//, 'stackoverflow'],
  [/^miro\.com\//, 'miro'],
  [/^dropbox\.com\//, 'dropbox'],
  [/^([^/]*\.)?(mentimeter\.(com|app)|menti\.com)\//, 'mentimeter'],
  [/^([^/]*\.)?(claude\.(ai|com)|anthropic\.com)\//, 'claude'],
];

const GLYPH: Record<ContextKind, string> = {
  pr: 'PR', issue: 'IS', github: 'GH', gitlab: 'GL', linear: 'LN', jira: 'JR',
  confluence: 'CF', notion: 'NO', slack: 'SL', figma: 'FG', sentry: 'SN', datadog: 'DD',
  vercel: 'VC', gdocs: 'GD', gdrive: 'DR', npm: 'NPM', loom: 'LM',
  trello: 'TR', asana: 'AS', discord: 'DC', youtube: 'YT', stackoverflow: 'SO',
  miro: 'MR', dropbox: 'DB', mentimeter: 'MT', claude: 'CL', other: 'LK',
  file: 'FILE', folder: 'DIR',
};

// the url without its protocol or leading www, lowercased, and always ending in the slash the
// patterns anchor on, so a bare host reads the same as one with a path
export const bareUrl = (url: string): string =>
  `${trimEnd(url.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, ''), '/')}/`;

export function linkKind(url: string): LinkKind {
  const bare = bareUrl(url);
  return PATTERNS.find(([re]) => re.test(bare))?.[1] ?? 'other';
}

// a path is a file until the daemon stats it; every other ref is a link
export const isPathRef = (ref: string): boolean => /^(\/|~(\/|$))/.test(ref.trim());
export function contextKind(ref: string): ContextKind {
  return isPathRef(ref) ? 'file' : linkKind(ref);
}
export const linkGlyph = (kind: ContextKind): string => GLYPH[kind] ?? GLYPH.other;

// a comment, commit, check run or file view inside a GitHub PR or issue names the PR or issue itself
export const itemUrl = (url: string): string =>
  url.replace(/^(https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+)[/?#].*$/i, '$1');
