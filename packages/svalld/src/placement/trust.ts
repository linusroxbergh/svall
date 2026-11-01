import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { parse as parseToml } from 'smol-toml';
import { lockAgentFiles } from '../kernel-lock.js';
import { realPath } from '../path-tools.js';
import { formatJsonSettings } from '../settings-file.js';
import { configOf } from '../sessions/claude.js';
import type { SessionAdapter } from '../sessions/types.js';
import type { Tmux } from '../tmux/tmux.js';
import { editUserFiles, readUserFile, type UserFile, type UserFileEdit } from '../user-file.js';

const POLL_MS = 500;
const [UP, DOWN, ENTER] = ['\x1b[A', '\x1b[B', '\r'];

type TrustRecord = { file: string; target: string; key: string } & (
  { kind: 'claude'; projectExisted: boolean; projectsExisted: boolean; before?: unknown }
  | { kind: 'codex'; block: string; created: boolean }
);
export const trustRecordFile = (home: string): string => path.join(home, 'setup-trust.json');

function writeTrust(current: UserFile, next: string, record?: TrustRecord, recordFile?: string): void {
  const edits: UserFileEdit[] = [{ current, next, what: 'Folder trust' }];
  if (record && recordFile) {
    const ownership = readUserFile(recordFile);
    const records: TrustRecord[] = ownership.text ? JSON.parse(ownership.text) : [];
    records.push(record);
    edits.push({ current: ownership, next: `${JSON.stringify(records, null, 2)}\n`, what: 'Mission control trust ownership', backup: false });
  }
  editUserFiles(edits);
}

// Claude keys a project by its real path composed to NFC; onboarding may create a missing config.
function seedClaude(agentHome: string, key: string, create = false, recordFile?: string): 'seeded' | 'skipped' {
  const file = configOf(agentHome);
  const current = readUserFile(file);
  let config: unknown;
  try { config = JSON.parse(current.text ?? (create ? '{}' : '')); } catch { return 'skipped'; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'skipped';
  const rawProjects = (config as { projects?: unknown }).projects;
  if (rawProjects !== undefined && (!rawProjects || typeof rawProjects !== 'object' || Array.isArray(rawProjects))) return 'skipped';
  const projects = (rawProjects ?? {}) as Record<string, Record<string, unknown> | undefined>;
  if (projects[key] !== undefined && (!projects[key] || typeof projects[key] !== 'object' || Array.isArray(projects[key]))) return 'skipped';
  if (projects[key]?.hasTrustDialogAccepted === true) return 'seeded';
  const next = { ...config, projects: { ...projects, [key]: { ...projects[key], hasTrustDialogAccepted: true } } };
  writeTrust(current, formatJsonSettings(current.text, next), {
    kind: 'claude', file, target: current.target, key, projectExisted: Object.hasOwn(projects, key),
    projectsExisted: rawProjects !== undefined, before: projects[key]?.hasTrustDialogAccepted,
  }, recordFile);
  return 'seeded';
}

// Codex keys a project by its real path; an entry the user wrote, trusted or not, is theirs
function seedCodex(agentHome: string, key: string, recordFile?: string): 'seeded' | 'skipped' {
  const file = path.join(agentHome, 'config.toml');
  const current = readUserFile(file);
  const text = current.text ?? '';
  let entry: { trust_level?: unknown } | undefined;
  try { entry = (parseToml(text) as { projects?: Record<string, { trust_level?: unknown }> }).projects?.[key]; } catch { return 'skipped'; }
  if (entry) return entry.trust_level === 'trusted' ? 'seeded' : 'skipped';
  const gap = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  const block = `[projects.${JSON.stringify(key)}]\ntrust_level = "trusted"\n`;
  writeTrust(current, `${text}${gap}${block}`, { kind: 'codex', file, target: current.target, key, block, created: current.text === undefined }, recordFile);
  return 'seeded';
}

// `ms`, or less when `signal` aborts first
export const nap = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done);
});

/**
 * Trusts the clone's main checkout, and so its worktrees, in the agent's own file, holding the user's agent files as a mirror's
 * apply does, and only while no agent of that kind runs to write over it. Rejects once a mirror held them `waitMs`; OpenCode never asks.
 */
export async function seedTrust(
  kind: AgentKind, clone: string, o: { agentHome: string; homedir: string; agentRunning: () => Promise<boolean>; waitMs: number; create?: boolean; recordFile?: string },
): Promise<'seeded' | 'skipped'> {
  if (kind === 'opencode') return 'seeded';
  const signal = AbortSignal.timeout(o.waitMs);
  const unlock = await lockAgentFiles(o.homedir, signal).catch((e: unknown) => {
    throw signal.aborted ? new Error(`a mirror held the agent files in ${o.homedir} for ${o.waitMs / 1000}s`) : e;
  });
  try {
    if (await o.agentRunning()) return 'skipped';
    const key = realPath(clone);
    return kind === 'claude' ? seedClaude(o.agentHome, key.normalize('NFC'), o.create, o.recordFile) : seedCodex(o.agentHome, key, o.recordFile);
  } finally {
    unlock();
  }
}

/** Only mission control is recorded: a project the user chose stays trusted after Svall is uninstalled. */
export async function removeOwnedTrust(recordFile: string, homedir: string): Promise<string[]> {
  if (!readUserFile(recordFile).text) return [];
  const unlock = await lockAgentFiles(homedir, AbortSignal.timeout(5000));
  try {
    const ownership = readUserFile(recordFile);
    if (!ownership.text) return [];
    const records: TrustRecord[] = JSON.parse(ownership.text);
    const edits = new Map<string, UserFileEdit>();
    for (const r of records) {
      const current = readUserFile(r.file);
      if (current.target !== r.target || current.text === undefined) continue;
      const text = edits.get(current.target)?.next ?? current.text;
      let next: string | undefined = text;
      if (r.kind === 'claude') {
        const config = JSON.parse(text);
        const project = config.projects?.[r.key];
        if (project?.hasTrustDialogAccepted !== true) continue;
        if (r.before === undefined) delete project.hasTrustDialogAccepted;
        else project.hasTrustDialogAccepted = r.before;
        if (!r.projectExisted && !Object.keys(project).length) delete config.projects[r.key];
        if (!r.projectsExisted && !Object.keys(config.projects).length) delete config.projects;
        next = formatJsonSettings(current.text, config);
      } else {
        const entry = (parseToml(text) as { projects?: Record<string, Record<string, unknown>> }).projects?.[r.key];
        // A changed entry belongs to the user. Never remove a header while leaving their extra keys behind.
        if (entry?.trust_level !== 'trusted' || Object.keys(entry).length !== 1 || !text.includes(r.block)) continue;
        next = text.replace(r.block, '');
        if (r.created && !next.trim()) next = undefined;
      }
      edits.set(current.target, { current, next, what: 'Mission control folder trust removed' });
    }
    return editUserFiles([...edits.values(), { current: ownership, next: undefined, what: 'Mission control trust ownership', backup: false }]);
  } finally { unlock(); }
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
