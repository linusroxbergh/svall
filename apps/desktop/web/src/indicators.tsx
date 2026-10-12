import type { ContextItem } from '@svall/protocol';

export const reviewText = (pr: ContextItem): string => {
  const n = /\/pull\/(\d+)/.exec(pr.ref)?.[1];
  return n ? `PR #${n} in review` : 'PR in review';
};

export function PrGlyph() {
  return (
    <svg className="ind-glyph" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="3" cy="2.7" r="1.35" />
      <circle cx="3" cy="9.3" r="1.35" />
      <circle cx="9" cy="9.3" r="1.35" />
      <path d="M3 4.1v3.8" />
      <path d="M9 7.9V5.3c0-.9-.6-1.5-1.5-1.5H5.4" />
      <path d="M6.7 2.3 5.3 3.8l1.4 1.5" />
    </svg>
  );
}

export const subagentsText = (n: number): string => `${n} subagent${n === 1 ? '' : 's'} running`;

export function BotGlyph() {
  return (
    <svg className="ind-glyph" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M3.4 3.6h5.2a1.8 1.8 0 0 1 1.8 1.8v3.4a1.8 1.8 0 0 1-1.8 1.8H3.4a1.8 1.8 0 0 1-1.8-1.8V5.4a1.8 1.8 0 0 1 1.8-1.8zM3.7 7a1 1 0 1 0 2 0a1 1 0 1 0-2 0zM6.3 7a1 1 0 1 0 2 0a1 1 0 1 0-2 0zM5.45 3.6V2.3h1.1v1.3zM5 1.35a1 1 0 1 0 2 0a1 1 0 1 0-2 0zM.5 6h1.1v2.2H.5zM10.4 6h1.1v2.2h-1.1z" />
    </svg>
  );
}

export function EyeGlyph() {
  return (
    <svg className="ind-glyph" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M.9 6C2.2 3.7 3.9 2.6 6 2.6s3.8 1.1 5.1 3.4C9.8 8.3 8.1 9.4 6 9.4S2.2 8.3.9 6z" />
      <circle cx="6" cy="6" r="1.65" fill="currentColor" stroke="none" />
    </svg>
  );
}
