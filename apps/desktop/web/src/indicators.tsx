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

export function EyeGlyph() {
  return (
    <svg className="ind-glyph" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path d="M.9 6C2.2 3.7 3.9 2.6 6 2.6s3.8 1.1 5.1 3.4C9.8 8.3 8.1 9.4 6 9.4S2.2 8.3.9 6z" />
      <circle cx="6" cy="6" r="1.65" fill="currentColor" stroke="none" />
    </svg>
  );
}
