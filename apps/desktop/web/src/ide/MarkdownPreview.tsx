import { useId, useRef } from 'react';
import { bodyOf } from '@svall/protocol';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import { app, deps } from '../boot.js';
import { openUrl } from '../bridge.js';
import { openFile } from './files.js';
import { markdownLink } from './markdown-links.js';

/** Render Markdown as React nodes. Raw HTML stays text, so a document cannot inject app markup. */
export function MarkdownPreview({ id, path, text }: { id: string; path: string; text: string }) {
  const host = useRef<HTMLDivElement>(null);
  // Prefix heading IDs so a document cannot collide with the app's own DOM IDs.
  const prefix = `svall-md-${useId().replace(/[^a-z0-9]/gi, '')}-`;
  return <div ref={host} className="markdown-preview" data-testid="markdown-preview">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSlug, { prefix }]]} components={{
      a: ({ href, children, title }) => <a href={href} title={title} onClick={(e) => {
        e.preventDefault();
        const link = markdownLink(path, href);
        if (link.kind === 'external') openUrl(app.bridge, link.href);
        else if (link.kind === 'file') void openFile(deps(), id, link.path);
        else if (link.kind === 'anchor') {
          if (!link.fragment) host.current?.scrollTo({ top: 0 });
          else [...(host.current?.querySelectorAll('[id]') ?? [])]
            .find((node) => node.id === `${prefix}${link.fragment}`)?.scrollIntoView({ block: 'start' });
        }
      }}>{children}</a>,
    }}>{bodyOf(text)}</ReactMarkdown>
  </div>;
}
