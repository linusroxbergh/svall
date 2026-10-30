import { beforeAll, expect, test, vi } from 'vitest';
import { handle, type Env } from '../src/index.js';
import { appJwt } from '../src/github.js';

let pair: CryptoKeyPair;
let env: Env;
const limiter = (success: boolean) => ({ limit: vi.fn(async () => ({ success })) });

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

beforeAll(async () => {
  pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).replace(/.{64}/g, '$&\n')}\n-----END PRIVATE KEY-----`;
  env = { GITHUB_APP_ID: '42', GITHUB_INSTALLATION_ID: '7', GITHUB_PRIVATE_KEY: pem, FEEDBACK_REPO: 'linusroxbergh/svall-feedback', LIMITER: limiter(true), GLOBAL_LIMITER: limiter(true) };
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

test('the global limit refuses a report the IP limit lets through', async () => {
  const f = vi.fn();
  const res = await handle(post(JSON.stringify({ kind: 'bug', text: 'x' })), { ...env, GLOBAL_LIMITER: limiter(false) }, f);
  expect(res.status).toBe(429);
  expect(f).not.toHaveBeenCalled();
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
