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

// A robot is a general-purpose shell. Only agent credentials cross from the fleet's
// .env into it; other values in that file belong to headless daemon tasks.
export function robotKeyEnv(file: string): Record<string, string> {
  const values = readEnvFile(file);
  return Object.fromEntries(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']
    .filter((key) => values[key])
    .map((key) => [key, values[key]]));
}

// Claude Code's classic renderer erases its screen row by row, which tmux never keeps as history, so a resize loses what
// was on screen; the fullscreen one keeps its own. Set only without a `tui` setting, which the variable would override
export function rendererEnv(settingsFile: string): Record<string, string> {
  try {
    if ((JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { tui?: unknown } | null)?.tui !== undefined) return {};
  } catch { /* no settings file, or one Claude Code cannot read either */ }
  return { CLAUDE_CODE_NO_FLICKER: '1' };
}

// cwd is an empty folder so no project settings or CLAUDE.md load; without a robot id the
// Svall hook exits at once, so the pass is not mistaken for a robot. launchd gives the
// daemon no shell environment, so an API key reaches the child through envFile
export function spawnClaude(o: { args: string[]; cwd: string; envFile: string }): Piped {
  fs.mkdirSync(o.cwd, { recursive: true });
  const { SVALL_ROBOT_ID: _id, SVALL_CHAR_ID: _old, ...env } = { ...process.env, ...readEnvFile(o.envFile) };
  return spawn('claude', [...o.args, ...ISOLATION], { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
}
