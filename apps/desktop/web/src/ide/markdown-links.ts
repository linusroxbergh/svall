export type MarkdownLink =
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; fragment: string }
  | { kind: 'file'; path: string }
  | { kind: 'unsupported' };

/** A Markdown link is relative to its file and may never climb above that file's root. */
export function markdownLink(path: string, href: string | undefined): MarkdownLink {
  if (!href) return { kind: 'unsupported' };
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return { kind: 'external', href };
  if (href.startsWith('//')) return { kind: 'external', href: `https:${href}` };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.includes('\\')) return { kind: 'unsupported' };

  const hash = href.indexOf('#');
  const rawPath = hash < 0 ? href : href.slice(0, hash);
  let fragment: string | undefined;
  let relative: string;
  try {
    fragment = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
    relative = decodeURIComponent(rawPath);
  } catch { return { kind: 'unsupported' }; }

  if (!relative) return fragment === undefined ? { kind: 'unsupported' } : { kind: 'anchor', fragment };
  const parts = relative.startsWith('/') ? [] : path.split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return { kind: 'unsupported' };
      parts.pop();
    } else parts.push(part);
  }
  const target = parts.join('/');
  if (!target) return { kind: 'unsupported' };
  if (target === path && fragment !== undefined) return { kind: 'anchor', fragment };
  return { kind: 'file', path: target };
}
