export const FEEDBACK_URL = 'https://svall.dev/api/feedback';
export const FEEDBACK_LOG_LINES = 200;
export const FEEDBACK_TEXT_MAX = 10_000;
export const FEEDBACK_DIAGNOSTICS_MAX = 50_000;

export type FeedbackKind = 'bug' | 'idea';

/** `text` with `home` written `~`, wherever it is not part of a longer path or name. */
export function maskHome(text: string, home: string): string {
  if (home === '' || home === '/') return text;
  return text.replace(new RegExp(`(?<![\\w.-])${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g'), '~');
}
