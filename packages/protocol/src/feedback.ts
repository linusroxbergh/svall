export const FEEDBACK_URL = 'https://svall.dev/api/feedback';
export const FEEDBACK_LOG_LINES = 200;
export const FEEDBACK_TEXT_MAX = 10_000;
export const FEEDBACK_DIAGNOSTICS_MAX = 50_000;

export type FeedbackKind = 'bug' | 'idea';

/** `text` with `home` written `~`, wherever it ends a path segment, a quote or the text. */
export function maskHome(text: string, home: string): string {
  if (home === '' || home === '/') return text;
  return text.replace(new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/"'\\s]|$)`, 'g'), '~');
}
