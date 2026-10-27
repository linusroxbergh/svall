import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { parse as parseToml } from 'smol-toml';
import { writeDurable } from '../durable.js';
import { lockAgentFiles } from '../kernel-lock.js';
import { realPath } from '../path-tools.js';
import { configOf } from '../sessions/claude.js';
import type { SessionAdapter } from '../sessions/types.js';
import type { Tmux } from '../tmux/tmux.js';

const POLL_MS = 500;
const [UP, DOWN, ENTER] = ['\x1b[A', '\x1b[B', '\r'];

const modeOf = (file: string): number => (fs.statSync(file, { throwIfNoEntry: false })?.mode ?? 0o600) & 0o777;

// a file's text, or undefined for no file
function textOf(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

// Claude keys a project by its real path composed to NFC; a file missing or one it cannot parse is left as it is
function seedClaude(agentHome: string, key: string): 'seeded' | 'skipped' {
  const file = configOf(agentHome);
  let config: unknown;
  try { config = JSON.parse(textOf(file) ?? ''); } catch { return 'skipped'; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'skipped';
  const projects = ((config as { projects?: unknown }).projects ?? {}) as Record<string, Record<string, unknown> | undefined>;
  if (projects[key]?.hasTrustDialogAccepted === true) return 'seeded';
  writeDurable(file, { ...config, projects: { ...projects, [key]: { ...projects[key], hasTrustDialogAccepted: true } } }, { mode: modeOf(file) });
  return 'seeded';
}

// Codex keys a project by its real path; an entry the user wrote, trusted or not, is theirs
function seedCodex(agentHome: string, key: string): 'seeded' | 'skipped' {
  const file = path.join(agentHome, 'config.toml');
  const text = textOf(file) ?? '';
  let entry: { trust_level?: unknown } | undefined;
  try { entry = (parseToml(text) as { projects?: Record<string, { trust_level?: unknown }> }).projects?.[key]; } catch { return 'skipped'; }
  if (entry) return entry.trust_level === 'trusted' ? 'seeded' : 'skipped';
  const gap = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  writeDurable(file, Buffer.from(`${text}${gap}[projects.${JSON.stringify(key)}]\ntrust_level = "trusted"\n`), { mode: modeOf(file) });
  return 'seeded';
}

// `ms`, or less when `signal` aborts first
const nap = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done);
});

/**
 * Trusts the clone's main checkout, and so every worktree in it, in the agent's own file: written read-modify-write while
 * holding the agent files of the user at `homedir`, as a mirror's apply does, and only while no agent of that kind runs,
 * which would write the file over again. OpenCode never asks.
 */
export async function seedTrust(kind: AgentKind, clone: string, o: { agentHome: string; homedir: string; agentRunning: () => Promise<boolean> }): Promise<'seeded' | 'skipped'> {
  if (kind === 'opencode') return 'seeded';
  const unlock = await lockAgentFiles(o.homedir);
  try {
    if (await o.agentRunning()) return 'skipped';
    const key = realPath(clone);
    return kind === 'claude' ? seedClaude(o.agentHome, key.normalize('NFC')) : seedCodex(o.agentHome, key);
  } finally {
    unlock();
  }
}

// a dialog's choice row: the pointer if it marks it, the choice's number, its text
const CHOICE = /^\s*(?:[❯›>]\s*)?(?:(\d+)\.\s+)?(.*?)\s*$/;

/**
 * Watches a pane for `forMs` for the agent's trust question and, once the question and its answer as a choice below it
 * show, picks the answer and confirms, once. A CLI whose adapter gives no question and answer is never answered.
 */
export async function answerTrustPrompt(
  tmux: Pick<Tmux, 'screen' | 'sendBytes'>, paneId: string, adapter: Pick<SessionAdapter, 'trustQuestion' | 'trustAnswer'>, o: { forMs: number; signal?: AbortSignal },
): Promise<'answered' | 'none'> {
  const { trustQuestion: question, trustAnswer: answer } = adapter;
  if (!question || !answer) return 'none';
  for (const end = Date.now() + o.forMs; !o.signal?.aborted;) {
    const { rows } = await tmux.screen(paneId);
    const asked = rows.findIndex((r) => r.includes(question));
    const at = asked < 0 ? -1 : rows.findIndex((r, i) => i > asked && CHOICE.exec(r)?.[2] === answer);
    if (at >= 0) {
      // the answer's own number picks it; a dialog that numbers none is walked from the choice the pointer marks
      const number = CHOICE.exec(rows[at])?.[1];
      const pointer = rows.findIndex((r, i) => i > asked && /^\s*[❯›>]\s/.test(r));
      const keys = number ? [number] : pointer >= 0 ? Array<string>(Math.abs(at - pointer)).fill(at > pointer ? DOWN : UP) : [];
      for (const k of [...keys, ENTER]) await tmux.sendBytes(paneId, Buffer.from(k));
      return 'answered';
    }
    if (Date.now() + POLL_MS > end) return 'none';
    await nap(POLL_MS, o.signal);
  }
  return 'none';
}
