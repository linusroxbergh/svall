import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { realPath } from '../path-tools.js';
import { isOurs } from '../paths.js';

export type HookTrust = { trusted: number; untrusted: number };

type Hook = { command?: unknown; trustStatus?: string } | null;
type Listed = { data?: ({ hooks?: Hook[] } | null)[] };

export function ourTrust(result: unknown, script: string): HookTrust | undefined {
  const data = (result as Listed | undefined)?.data;
  if (!Array.isArray(data)) return undefined;
  const hooks = data.flatMap((d) => d?.hooks ?? []).filter((h) => isOurs(h?.command, script));
  if (!hooks.length) return undefined;
  const trusted = hooks.filter((h) => h?.trustStatus === 'trusted').length;
  return { trusted, untrusted: hooks.length - trusted };
}

/**
 * Svall's hooks in `codexHome`'s hooks.json that Codex has a trust record for in config.toml, keyed
 * `<hooks file>:<event>:<group>:<handler>`, read without starting Codex; one changed since it was trusted counts as trusted.
 */
export function recordedTrust(codexHome: string, script: string): HookTrust | undefined {
  const file = path.join(codexHome, 'hooks.json');
  const config = path.join(codexHome, 'config.toml');
  const trust = { trusted: 0, untrusted: 0 };
  try {
    const events: Record<string, { hooks?: { command?: unknown }[] }[]> = JSON.parse(fs.readFileSync(file, 'utf8')).hooks ?? {};
    const state: Record<string, { trusted_hash?: unknown } | undefined> = fs.existsSync(config)
      ? (parseToml(fs.readFileSync(config, 'utf8')) as { hooks?: { state?: Record<string, { trusted_hash?: unknown }> } }).hooks?.state ?? {} : {};
    const files = [file, realPath(file)];
    for (const [event, groups] of Object.entries(events)) {
      const label = event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
      groups.forEach((g, i) => (g.hooks ?? []).forEach((h, j) => {
        if (!isOurs(h?.command, script)) return;
        const held = files.some((f) => typeof state[`${f}:${label}:${i}:${j}`]?.trusted_hash === 'string');
        trust[held ? 'trusted' : 'untrusted'] += 1;
      }));
    }
  } catch {
    return undefined;
  }
  return trust.trusted + trust.untrusted ? trust : undefined;
}

// codex app-server is experimental: any failure or unknown answer is "couldn't tell", within timeoutMs
export function askCodexTrust(o: { codexHome: string; script: string; bin?: string; timeoutMs?: number }): Promise<HookTrust | undefined> {
  return new Promise((resolve) => {
    const child = spawn(o.bin ?? 'codex', ['app-server'], { cwd: o.codexHome, env: { ...process.env, CODEX_HOME: o.codexHome }, stdio: ['pipe', 'pipe', 'ignore'] });
    const done = (v: HookTrust | undefined) => { clearTimeout(timer); child.kill(); resolve(v); };
    const timer = setTimeout(() => done(undefined), o.timeoutMs ?? 5000);
    let buf = '';
    child.on('error', () => done(undefined));
    child.stdin.on('error', () => done(undefined));
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: { id?: number; result?: unknown } | null;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.id === 1) {
          child.stdin.write('{"method":"initialized"}\n');
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [o.codexHome] } })}\n`);
        }
        if (msg?.id === 2) done(ourTrust(msg.result, o.script));
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'svall', version: '0' } } })}\n`);
  });
}
