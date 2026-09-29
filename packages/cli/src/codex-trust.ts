import { spawn } from 'node:child_process';
import { isOurs } from '@svall/svalld/paths';

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
