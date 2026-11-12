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
const ENTER = '\r';
// how long a confirmed answer has to take the dialog off the screen
const LEAVE_MS = 5_000;

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
    edits.unshift({ current: ownership, next: `${JSON.stringify(records, null, 2)}\n`, what: 'Mission control trust ownership', backup: false });
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
    throw signal.aborted ? new Error(`a copy of the agent setup held the agent files in ${o.homedir} for ${o.waitMs / 1000}s`) : e;
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
// a pane's rows as they read, without the colours a capture keeps
const plain = (rows: string[]): string[] => rows.map((r) => r.replace(/\x1b\[[0-9;:]*m/g, ''));

/** Resolves once the pane shows a numbered choice under any question but the trust one, which no one here answers; or once `signal` aborts. */
export async function asksOwnQuestion(tmux: Pick<Tmux, 'screen'>, paneId: string, adapter: Pick<SessionAdapter, 'trustQuestion'>, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const rows = await tmux.screen(paneId).then((s) => plain(s.rows), () => [] as string[]);
    const trust = adapter.trustQuestion !== undefined && rows.some((r) => r.includes(adapter.trustQuestion!));
    // the selection pointer alone, as a past prompt shows after `> `
    if (!trust && rows.some((r) => /^\s*[❯›]\s*\d+\.\s+\S/.test(r))) return;
    await nap(POLL_MS, signal);
  }
}

// the trust question as a dialog on screen, a choice under it marked by the selection pointer: the answer's row, -1 where none
// reads so, and the pointer's
function trustDialog(rows: string[], question: string, answer: string): { at: number; pointer: number; number?: string } | undefined {
  const asked = rows.findIndex((r) => r.includes(question));
  const pointer = asked < 0 ? -1 : rows.findIndex((r, i) => i > asked && /^\s*[❯›>]\s+\S/.test(r));
  if (pointer < 0) return undefined;
  const at = rows.findIndex((r, i) => i > asked && CHOICE.exec(r)?.[2] === answer);
  return { at, pointer, ...(at >= 0 && { number: CHOICE.exec(rows[at])?.[1] }) };
}

/**
 * Watches a pane for `forMs` for the agent's trust question and picks its answer: by the answer's own number where its row has
 * one, else by stepping the pointer onto it, read after each key. Enter goes only while the pointer is read on the answer, so
 * nothing confirms another choice; `answered` once the dialog has left the screen. `unread`: the question showed, and was not
 * answered so, which is the person's to answer. A CLI whose adapter gives no question and answer is never answered.
 */
export async function answerTrustPrompt(
  tmux: Pick<Tmux, 'screen' | 'sendBytes' | 'sendKey'>, paneId: string, adapter: Pick<SessionAdapter, 'trustQuestion' | 'trustAnswer'>, o: { forMs: number; signal?: AbortSignal },
): Promise<'answered' | 'unread' | 'none'> {
  const { trustQuestion: question, trustAnswer: answer } = adapter;
  if (!question || !answer) return 'none';
  let [seen, numbered, steps] = [false, false, 0];
  let confirmed: number | undefined;
  for (const end = Date.now() + o.forMs; !o.signal?.aborted;) {
    const d = trustDialog(plain((await tmux.screen(paneId)).rows), question, answer);
    if (!d) {
      if (seen) return confirmed !== undefined || numbered ? 'answered' : 'none';
    } else {
      seen = true;
      if (confirmed !== undefined) {
        if (Date.now() - confirmed > LEAVE_MS) return 'unread';
      } else if (d.at >= 0 && d.pointer === d.at) {
        await tmux.sendBytes(paneId, Buffer.from(ENTER));
        confirmed = Date.now();
      } else if (d.number && !numbered) {
        await tmux.sendBytes(paneId, Buffer.from(d.number));
        numbered = true;
      } else if (d.at >= 0 && steps < Math.abs(d.at - d.pointer) + 2) {
        await tmux.sendKey(paneId, d.at > d.pointer ? 'Down' : 'Up');
        steps++;
      }
    }
    if (Date.now() + POLL_MS > end) return seen ? 'unread' : 'none';
    await nap(POLL_MS, o.signal);
  }
  return 'none';
}
