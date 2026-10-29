import type { Issue } from './report.js';

export type GithubEnv = { GITHUB_APP_ID: string; GITHUB_INSTALLATION_ID: string; GITHUB_PRIVATE_KEY: string };

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'svall-feedback',
};

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const part = (o: object) => b64url(new TextEncoder().encode(JSON.stringify(o)));

export async function appJwt(appId: string, pem: string, nowSec: number): Promise<string> {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signing = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: nowSec - 60, exp: nowSec + 540, iss: appId })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signing));
  return `${signing}.${b64url(sig)}`;
}

export async function installationToken(env: GithubEnv, fetchFn: typeof fetch): Promise<string> {
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, Math.floor(Date.now() / 1000));
  const res = await fetchFn(`https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`installation token: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

export async function createIssue(token: string, repo: string, issue: Issue, fetchFn: typeof fetch): Promise<void> {
  const res = await fetchFn(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(issue),
  });
  if (!res.ok) throw new Error(`create issue: ${res.status}`);
}
