import { spawn, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import type { Readable, Writable } from 'node:stream';

type Piped = ChildProcessByStdio<Writable, Readable, Readable>;

// the flags that keep a headless pass off the user's machine: no tools, no session left behind,
// and none of their hooks, plugins or MCP servers
const ISOLATION = ['--tools', '', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence'];

// KEY=value lines, optionally quoted or after `export`; anything else is skipped
export function readEnvFile(file: string): Record<string, string> {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const v = m[2];
    env[m[1]] = /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
  }
  return env;
}

// A character is a general-purpose shell. Only agent credentials cross from the fleet's
// .env into it; other values in that file belong to headless daemon tasks.
export function characterKeyEnv(file: string): Record<string, string> {
  const values = readEnvFile(file);
  return Object.fromEntries(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']
    .filter((key) => values[key])
    .map((key) => [key, values[key]]));
}

// cwd is an empty folder so no project settings or CLAUDE.md load; without a character id the
// Svall hook exits at once, so the pass is not mistaken for a character. launchd gives the
// daemon no shell environment, so an API key reaches the child through envFile
export function spawnClaude(o: { args: string[]; cwd: string; envFile: string }): Piped {
  fs.mkdirSync(o.cwd, { recursive: true });
  const { SVALL_CHAR_ID: _id, ...env } = { ...process.env, ...readEnvFile(o.envFile) };
  return spawn('claude', [...o.args, ...ISOLATION], { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
}
