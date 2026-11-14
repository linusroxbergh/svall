import fs from 'node:fs';

const readJson = (file: string): unknown => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The email of the Codex ChatGPT login, carried in auth.json's id token; an API-key login has none. */
export function codexAccount(file: string): string | undefined {
  const json = readJson(file) as { tokens?: { id_token?: unknown } } | undefined;
  const token = str(json?.tokens?.id_token);
  const payload = token?.split('.')[1];
  if (!payload) return undefined;
  try { return str((JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }).email); } catch { return undefined; }
}
