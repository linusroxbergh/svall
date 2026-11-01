import { createIssue, installationToken, type GithubEnv } from './github.js';
import { issueOf, parseReport } from './report.js';

type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> };
export type Env = GithubEnv & {
  FEEDBACK_REPO: string;
  FEEDBACK_ENABLED?: string;
  LIMITER: Limiter;
  SUBMISSION_LIMITER: Limiter;
  BUDGET: { getByName(name: string): { fetch(url: string, init: RequestInit): Promise<Response> } };
};

const MAX_BODY = 256 * 1024;
// Restricts other pages' browsers, not direct clients; rate limits and the durable budget bound public submissions.
const cors = { 'Access-Control-Allow-Origin': 'svall://app' };
const fail = (status: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers: { ...cors, 'Cache-Control': 'no-store', ...headers } });
const limited = (retryAfter = '60') => fail(429, 'too many reports, try again later', { 'Retry-After': retryAfter });
const cancel = (req: Request) => { void req.body?.cancel().catch(() => {}); };

async function readBody(req: Request): Promise<string | undefined> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  // A fixed buffer also bounds overhead when a sender supplies many tiny chunks.
  const buffer = new Uint8Array(MAX_BODY);
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return new TextDecoder().decode(buffer.subarray(0, bytes));
      if (value.byteLength > MAX_BODY - bytes) {
        // Do not wait for the sender to finish or for a cancellation acknowledgement before returning 413.
        void reader.cancel().catch(() => {});
        return undefined;
      }
      buffer.set(value, bytes);
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function handle(req: Request, env: Env, fetchFn: typeof fetch): Promise<Response> {
  try {
    return await route(req, env, fetchFn);
  } catch (e) {
    console.error('feedback: unhandled', e);
    return fail(500, 'internal error');
  }
}

async function route(req: Request, env: Env, fetchFn: typeof fetch): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' },
    });
  }
  if (req.method !== 'POST') return fail(405, 'method not allowed');
  if (env.FEEDBACK_ENABLED === 'false') {
    cancel(req);
    return fail(503, 'feedback is temporarily unavailable');
  }
  // Count malformed and oversized POSTs too, and refuse a limited sender before reading any body bytes.
  if (!(await env.LIMITER.limit({ key: req.headers.get('CF-Connecting-IP') ?? 'unknown' })).success) {
    cancel(req);
    return limited();
  }
  if (req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    cancel(req);
    return fail(415, 'body must be application/json');
  }
  if (Number(req.headers.get('content-length')) > MAX_BODY) {
    cancel(req);
    return fail(413, 'body too large');
  }
  const raw = await readBody(req);
  if (raw === undefined) return fail(413, 'body too large');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail(400, 'body is not JSON');
  }
  const report = parseReport(json);
  if ('error' in report) return fail(400, report.error);
  // The binding only sheds local load. The single durable object enforces strict worldwide rolling budgets.
  if (!(await env.SUBMISSION_LIMITER.limit({ key: 'all' })).success) return limited();
  try {
    const reservation = await env.BUDGET.getByName(env.FEEDBACK_REPO).fetch('https://budget/reserve', { method: 'POST' });
    if (reservation.status === 429) return limited(reservation.headers.get('Retry-After') ?? '60');
    if (reservation.status !== 204) throw new Error(`budget: ${reservation.status}`);
  } catch (e) {
    console.error('feedback: budget', e);
    return fail(503, 'feedback is temporarily unavailable');
  }
  try {
    await createIssue(await installationToken(env, fetchFn), env.FEEDBACK_REPO, issueOf(report), fetchFn);
  } catch (e) {
    console.error('feedback: github', e);
    return fail(502, 'could not file the report');
  }
  return Response.json({ ok: true }, { status: 201, headers: { ...cors, 'Cache-Control': 'no-store' } });
}

export default { fetch: (req: Request, env: Env) => handle(req, env, fetch) };
