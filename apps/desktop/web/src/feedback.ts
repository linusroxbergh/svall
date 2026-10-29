import { FEEDBACK_DIAGNOSTICS_MAX, FEEDBACK_LOG_LINES, FEEDBACK_URL, maskHome, type FeedbackKind } from '@svall/protocol';
import type { ShellInfo } from './bridge.js';

/** Posts a report to the feedback Worker; rejects with the Worker's reason, or "Couldn't send: …". */
export async function sendFeedback(r: { kind: FeedbackKind; text: string; diagnostics?: string }, fetchFn: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn((import.meta.env.VITE_FEEDBACK_URL as string | undefined) ?? FEEDBACK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) });
  } catch (e) {
    throw new Error(`Couldn't send: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.ok) return;
  const body = await res.json().catch(() => undefined) as { error?: unknown } | undefined;
  throw new Error(typeof body?.error === 'string' ? body.error : `Couldn't send: ${res.status}`);
}

/** What a report carries while svalld is down: the shell's log tail, the home masked and the oldest lines dropped to fit. */
export function connectDiagnostics(shell: ShellInfo): string {
  const home = /^\/Users\/[^/]+/.exec(shell.home)?.[0] ?? '';
  const lines = shell.log.filter(Boolean).slice(-FEEDBACK_LOG_LINES);
  const build = (from: number) => maskHome(['svall (svalld not running)', '', 'svalld.log, last lines', ...lines.slice(from)].join('\n'), home);
  let from = 0;
  while (from < lines.length - 1 && build(from).length > FEEDBACK_DIAGNOSTICS_MAX) from++;
  const text = build(from);
  const cut = text.length - FEEDBACK_DIAGNOSTICS_MAX;
  if (cut <= 0) return text;
  const start = text.lastIndexOf('\n') + 1;
  return text.slice(0, start) + text.slice(start + cut);
}
