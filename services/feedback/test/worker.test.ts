import { beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { handle, type Env } from '../src/index.js';
import { appJwt } from '../src/github.js';

let pair: CryptoKeyPair;
let env: Env;
let pem: string;
const limiter = (success: boolean) => ({ limit: vi.fn(async () => ({ success })) });
const budget = (status = 204, retryAfter = '60') => ({
  getByName: vi.fn(() => ({ fetch: vi.fn(async () => new Response(null, { status, headers: { 'Retry-After': retryAfter } })) })),
});

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

beforeAll(async () => {
  pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  pem = `-----BEGIN PRIVATE KEY-----\n${b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).replace(/.{64}/g, '$&\n')}\n-----END PRIVATE KEY-----`;
});

beforeEach(() => {
  env = { GITHUB_APP_ID: '42', GITHUB_INSTALLATION_ID: '7', GITHUB_PRIVATE_KEY: pem, FEEDBACK_REPO: 'linusroxbergh/svall-feedback', LIMITER: limiter(true), SUBMISSION_LIMITER: limiter(true), BUDGET: budget() };
});

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request('https://svall.dev/api/feedback', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
const ok = () => vi.fn(async (url: string | URL | Request) =>
  String(url).includes('access_tokens') ? Response.json({ token: 'ghs_secret' }, { status: 201 }) : Response.json({}, { status: 201 }));

test('a report files one issue as the app installation', async () => {
  const fetchFn = ok();
  const res = await handle(post(JSON.stringify({ kind: 'bug', text: 'Map froze' })), env, fetchFn as unknown as typeof fetch);
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ ok: true });
  expect(res.headers.get('access-control-allow-origin')).toBe('svall://app');
  expect(fetchFn).toHaveBeenCalledTimes(2);
  const [tokenUrl, tokenInit] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
  expect(tokenUrl).toBe('https://api.github.com/app/installations/7/access_tokens');
  expect(tokenInit.method).toBe('POST');
  expect((tokenInit.headers as Record<string, string>).Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const [url, init] = fetchFn.mock.calls[1] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.github.com/repos/linusroxbergh/svall-feedback/issues');
  expect(init.method).toBe('POST');
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghs_secret');
  expect(JSON.parse(init.body as string)).toEqual({ title: 'Map froze', body: 'Map froze', labels: ['bug'] });
});

test('appJwt signs RS256 with iss = app id and iat 60 s in the past', async () => {
  const jwt = await appJwt('42', env.GITHUB_PRIVATE_KEY, 1_000_000);
  const [h, c, s] = jwt.split('.') as [string, string, string];
  expect(JSON.parse(new TextDecoder().decode(dec(h)))).toEqual({ alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(new TextDecoder().decode(dec(c)));
  expect(claims).toEqual({ iat: 999_940, exp: 1_000_540, iss: '42' });
  expect(claims.exp - claims.iat).toBe(600);
  expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, dec(s), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
});

test('OPTIONS answers the CORS preflight', async () => {
  const res = await handle(new Request('https://svall.dev/api/feedback', { method: 'OPTIONS' }), env, vi.fn());
  expect(res.status).toBe(204);
  expect(res.headers.get('access-control-allow-origin')).toBe('svall://app');
  expect(res.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
  expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
});

test('a GET is 405, a 300 KiB body 413, bad JSON 400', async () => {
  const f = vi.fn();
  const get = await handle(new Request('https://svall.dev/api/feedback'), env, f);
  expect(get.status).toBe(405);
  expect(get.headers.get('access-control-allow-origin')).toBe('svall://app');
  expect((await handle(post('x'.repeat(300 * 1024)), env, f)).status).toBe(413);
  expect((await handle(post('{}', { 'content-length': String(100 * 1024 * 1024) }), env, f)).status).toBe(413);
  const bad = await handle(post('{nope'), env, f);
  expect(bad.status).toBe(400);
  expect(await bad.json()).toHaveProperty('error');
  expect((await handle(post(JSON.stringify({ kind: 'rant', text: 'x' })), env, f)).status).toBe(400);
  expect(f).not.toHaveBeenCalled();
});

test('a body that is not JSON-typed is 415, so no other page can post without the preflight it is refused', async () => {
  const f = vi.fn();
  expect((await handle(post(JSON.stringify({ kind: 'bug', text: 'x' }), { 'content-type': 'text/plain' }), env, f)).status).toBe(415);
  expect((await handle(new Request('https://svall.dev/api/feedback', { method: 'POST', body: '{}' }), env, f)).status).toBe(415);
  expect(f).not.toHaveBeenCalled();
});

test('simple cross-origin POSTs cannot consume the visitor IP allowance', async () => {
  let used = 0;
  const limit = vi.fn(async () => ({ success: ++used <= 5 }));
  const visitor = { ...env, LIMITER: { limit } };
  const f = ok();
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    for (let i = 0; i < 5; i++) {
      const res = await handle(post('x', {
        Origin: 'https://attacker.invalid', 'content-type': type, 'CF-Connecting-IP': '192.0.2.1',
      }), visitor, f as unknown as typeof fetch);
      expect(res.status).toBe(415);
    }
  }
  expect(limit).not.toHaveBeenCalled();
  const valid = await handle(post(JSON.stringify({ kind: 'idea', text: 'A real report' }), {
    Origin: 'svall://app', 'CF-Connecting-IP': '192.0.2.1',
  }), visitor, f as unknown as typeof fetch);
  expect(valid.status).toBe(201);
  expect(limit).toHaveBeenCalledOnce();
  expect(limit).toHaveBeenCalledWith({ key: '192.0.2.1' });
});

test('the local submission limit refuses a report before reserving worldwide budget', async () => {
  const f = vi.fn();
  const res = await handle(post(JSON.stringify({ kind: 'bug', text: 'x' })), { ...env, SUBMISSION_LIMITER: limiter(false) }, f);
  expect(res.status).toBe(429);
  expect(env.BUDGET.getByName).not.toHaveBeenCalled();
  expect(f).not.toHaveBeenCalled();
});

test('the worldwide budget refuses a locally allowed report without contacting GitHub', async () => {
  const f = vi.fn();
  const b = budget(429, '7200');
  const res = await handle(post(JSON.stringify({ kind: 'bug', text: 'x' })), { ...env, BUDGET: b }, f);
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('7200');
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(b.getByName).toHaveBeenCalledWith('linusroxbergh/svall-feedback');
  expect(f).not.toHaveBeenCalled();
});

test.each(['throw', 'bad response'])('a budget failure (%s) fails closed before contacting GitHub', async (failure) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const f = vi.fn();
    const b = { getByName: () => ({ fetch: async () => {
      if (failure === 'throw') throw new Error('budget unavailable');
      return new Response(null, { status: 500 });
    } }) };
    const res = await handle(post(JSON.stringify({ kind: 'bug', text: 'x' })), { ...env, BUDGET: b }, f);
    expect(res.status).toBe(503);
    expect(res.headers.get('access-control-allow-origin')).toBe('svall://app');
    expect(f).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let reads = 0;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads < chunks.length) controller.enqueue(chunks[reads++]!);
      else controller.close();
    },
    cancel: cancelled,
  }, { highWaterMark: 0 });
  const req = new Request('https://svall.dev/api/feedback', Object.assign({
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  }, { duplex: 'half' }));
  return { req, cancelled, reads: () => reads };
}

function heldUpload() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let reading!: () => void;
  const started = new Promise<void>((resolve) => { reading = resolve; });
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    pull() { reading(); },
    cancel: cancelled,
  }, { highWaterMark: 0 });
  const req = new Request('https://svall.dev/api/feedback', Object.assign({
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }, { duplex: 'half' }));
  return { req, started, controller, cancelled };
}

test('an idle upload allocates no maximum-sized body buffer before receiving data', async () => {
  const upload = heldUpload();
  const allocations: number[] = [];
  const observed = new Proxy(Uint8Array, {
    construct(target, args, newTarget) {
      if (typeof args[0] === 'number') allocations.push(args[0]);
      return Reflect.construct(target, args, newTarget);
    },
  });
  vi.stubGlobal('Uint8Array', observed);
  const pending = handle(upload.req, env, vi.fn());
  try {
    await upload.started;
    expect(Math.max(0, ...allocations)).toBeLessThanOrEqual(1024);
  } finally {
    upload.controller.close();
    await pending;
    vi.unstubAllGlobals();
  }
});

test.each(['idle', 'trickle', 'unacknowledged cancellation'])('the total upload deadline cancels %s bodies', async (mode) => {
  vi.useFakeTimers();
  const upload = heldUpload();
  if (mode === 'unacknowledged cancellation') upload.cancelled.mockImplementation(() => new Promise(() => {}));
  const f = vi.fn();
  let settled = false;
  const pending = handle(upload.req, env, f).then((res) => { settled = true; return res; });
  try {
    await upload.started;
    await vi.advanceTimersByTimeAsync(4000);
    if (mode === 'trickle') upload.controller.enqueue(new TextEncoder().encode(' '));
    await vi.advanceTimersByTimeAsync(4000);
    if (mode === 'trickle') upload.controller.enqueue(new TextEncoder().encode(' '));
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(408);
    expect(res.headers.get('access-control-allow-origin')).toBe('svall://app');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(upload.cancelled).toHaveBeenCalledOnce();
    expect(env.SUBMISSION_LIMITER.limit).not.toHaveBeenCalled();
    expect(env.BUDGET.getByName).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    try { upload.controller.close(); } catch { /* the deadline already closed it */ }
    await pending;
    vi.useRealTimers();
  }
});

test.each(['complete', 'oversized'])('a %s body clears its upload deadline', async (mode) => {
  vi.useFakeTimers();
  try {
    const upload = streamed([new Uint8Array(mode === 'complete' ? 0 : 256 * 1024 + 1)]);
    expect((await handle(upload.req, env, vi.fn())).status).toBe(mode === 'complete' ? 400 : 413);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(upload.cancelled).toHaveBeenCalledTimes(mode === 'complete' ? 0 : 1);
  } finally { vi.useRealTimers(); }
});

test.each<Record<string, string>>([{}, { 'content-length': '1' }])('a streamed upload stops at the byte limit with length header %j', async (headers) => {
  const upload = streamed(Array.from({ length: 32 }, () => new Uint8Array(64 * 1024)), headers);
  const f = vi.fn();
  const res = await handle(upload.req, env, f);
  expect(res.status).toBe(413);
  expect(upload.reads()).toBe(5);
  expect(upload.cancelled).toHaveBeenCalledOnce();
  expect(env.LIMITER.limit).toHaveBeenCalledOnce();
  expect(env.SUBMISSION_LIMITER.limit).not.toHaveBeenCalled();
  expect(env.BUDGET.getByName).not.toHaveBeenCalled();
  expect(f).not.toHaveBeenCalled();
});

test('a single oversized chunk is cancelled without trying to read the next chunk', async () => {
  const upload = streamed([new Uint8Array(256 * 1024 + 1), new Uint8Array(10)]);
  expect((await handle(upload.req, env, vi.fn())).status).toBe(413);
  expect(upload.reads()).toBe(1);
  expect(upload.cancelled).toHaveBeenCalledOnce();
});

test('rejecting an upload does not wait for the sender to acknowledge cancellation', async () => {
  const upload = streamed([new Uint8Array(256 * 1024 + 1)]);
  upload.cancelled.mockImplementation(() => new Promise(() => {}));
  expect((await handle(upload.req, env, vi.fn())).status).toBe(413);
});

test('an exact-limit body and UTF-8 split across chunks are decoded correctly', async () => {
  const text = 'A snowman ☃ and an island 🏝';
  const json = new TextEncoder().encode(JSON.stringify({ kind: 'idea', text }));
  // Split every multi-byte code point, then pad with legal JSON whitespace to the exact byte limit.
  const upload = streamed([...Array.from(json, (b) => Uint8Array.of(b)), new Uint8Array(256 * 1024 - json.length).fill(32)]);
  const f = ok();
  expect((await handle(upload.req, env, f as unknown as typeof fetch)).status).toBe(201);
  const issue = f.mock.calls[1] as unknown as [string, RequestInit];
  expect(JSON.parse(issue[1].body as string).body).toBe(text);
  expect(upload.cancelled).not.toHaveBeenCalled();
});

test('the limit counts UTF-8 bytes rather than characters', async () => {
  const upload = streamed([new TextEncoder().encode('☃'.repeat(90_000))]);
  expect((await handle(upload.req, env, vi.fn())).status).toBe(413);
});

test.each(['limited', 'wrong type', 'declared too large', 'disabled'])('%s requests are cancelled without reading the body', async (reason) => {
  const headers: Record<string, string> = reason === 'wrong type' ? { 'content-type': 'text/plain' }
    : reason === 'declared too large' ? { 'content-length': String(256 * 1024 + 1) } : {};
  const upload = streamed([new Uint8Array(10)], headers);
  const f = vi.fn();
  const res = await handle(upload.req, {
    ...env, LIMITER: limiter(reason !== 'limited'), FEEDBACK_ENABLED: reason === 'disabled' ? 'false' : 'true',
  }, f);
  expect(res.status).toBe({ limited: 429, 'wrong type': 415, 'declared too large': 413, disabled: 503 }[reason]);
  expect(upload.reads()).toBe(0);
  expect(upload.cancelled).toHaveBeenCalledOnce();
  expect(env.BUDGET.getByName).not.toHaveBeenCalled();
  expect(f).not.toHaveBeenCalled();
});

test.each(['{broken', '{}'])('malformed or invalid JSON consumes only the IP allowance: %s', async (body) => {
  expect((await handle(post(body), env, vi.fn())).status).toBe(400);
  expect(env.LIMITER.limit).toHaveBeenCalledOnce();
  expect(env.SUBMISSION_LIMITER.limit).not.toHaveBeenCalled();
  expect(env.BUDGET.getByName).not.toHaveBeenCalled();
});

test('a limited IP gets 429 and GitHub is never called', async () => {
  const lim = limiter(false);
  const f = vi.fn();
  const res = await handle(post(JSON.stringify({ kind: 'bug', text: 'x' }), { 'CF-Connecting-IP': '1.2.3.4' }), { ...env, LIMITER: lim }, f);
  expect(res.status).toBe(429);
  expect(lim.limit).toHaveBeenCalledWith({ key: '1.2.3.4' });
  expect(f).not.toHaveBeenCalled();
});

test('GitHub refusing the issue is 502 with no token or GitHub body in the reply', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetchFn = vi.fn(async (url: string | URL | Request) =>
    String(url).includes('access_tokens') ? Response.json({ token: 'ghs_secret' }, { status: 201 }) : new Response('internal repo details', { status: 403 }));
  const res = await handle(post(JSON.stringify({ kind: 'bug', text: 'x' })), env, fetchFn as unknown as typeof fetch);
  expect(res.status).toBe(502);
  const text = await res.text();
  expect(text).not.toContain('ghs_secret');
  expect(text).not.toContain('internal repo details');
  expect(JSON.parse(text)).toHaveProperty('error');
  expect(log).toHaveBeenCalledWith('feedback: github', expect.objectContaining({ message: 'create issue: 403' }));
  log.mockRestore();
});

test('a throw inside the handler still answers 500 with CORS', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const lim = { limit: vi.fn(async () => { throw new Error('limiter down'); }) };
  const res = await handle(post(JSON.stringify({ kind: 'bug', text: 'x' })), { ...env, LIMITER: lim }, vi.fn());
  expect(res.status).toBe(500);
  expect(res.headers.get('access-control-allow-origin')).toBe('svall://app');
  expect(await res.json()).toHaveProperty('error');
  expect(log).toHaveBeenCalled();
  log.mockRestore();
});
