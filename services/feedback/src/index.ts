import { createIssue, installationToken, type GithubEnv } from './github.js';
import { issueOf, parseReport } from './report.js';

type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> };
export type Env = GithubEnv & { FEEDBACK_REPO: string; LIMITER: Limiter; GLOBAL_LIMITER: Limiter };

const MAX_BODY = 256 * 1024;
// only the app's web view may post: a JSON body makes any other page's browser ask first, and this refuses it
const cors = { 'Access-Control-Allow-Origin': 'svall://app' };
const reply = (status: number, body?: object) =>
  body ? Response.json(body, { status, headers: cors }) : new Response(null, { status, headers: cors });
const fail = (status: number, error: string) => reply(status, { error });

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
  if (!req.headers.get('content-type')?.startsWith('application/json')) return fail(415, 'body must be application/json');
  if (Number(req.headers.get('content-length')) > MAX_BODY) return fail(413, 'body too large');
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY) return fail(413, 'body too large');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return fail(400, 'body is not JSON');
  }
  const report = parseReport(json);
  if ('error' in report) return fail(400, report.error);
  const { success } = await env.LIMITER.limit({ key: req.headers.get('CF-Connecting-IP') ?? 'unknown' });
  if (!success || !(await env.GLOBAL_LIMITER.limit({ key: 'all' })).success) return fail(429, 'too many reports, try again shortly');
  try {
    await createIssue(await installationToken(env, fetchFn), env.FEEDBACK_REPO, issueOf(report), fetchFn);
  } catch (e) {
    console.error('feedback: github', e);
    return fail(502, 'could not file the report');
  }
  return reply(201, { ok: true });
}

export default { fetch: (req: Request, env: Env) => handle(req, env, fetch) };
