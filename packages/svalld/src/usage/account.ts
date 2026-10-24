import fs from 'node:fs';

const readJson = (file: string): unknown => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The email of the Claude login in .claude.json, when it has one. */
export function claudeAccount(file: string): string | undefined {
  const json = readJson(file) as { oauthAccount?: { emailAddress?: unknown } } | undefined;
  return str(json?.oauthAccount?.emailAddress);
}

/** The email of the Codex ChatGPT login, carried in auth.json's id token; an API-key login has none. */
export function codexAccount(file: string): string | undefined {
  const json = readJson(file) as { tokens?: { id_token?: unknown } } | undefined;
  const token = str(json?.tokens?.id_token);
  const payload = token?.split('.')[1];
  if (!payload) return undefined;
  try { return str((JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }).email); } catch { return undefined; }
}

export type Account = { agent: string; email?: string };

/** One login reads as its email; two different ones name their agent, since the windows above them do too. */
export function accountLine(accounts: Account[]): string | undefined {
  const named = accounts.filter((a): a is Required<Account> => !!a.email);
  const emails = new Set(named.map((a) => a.email));
  if (emails.size === 0) return undefined;
  if (emails.size === 1) return named[0].email;
  return named.map((a) => `${a.agent} ${a.email}`).join(' · ');
}
