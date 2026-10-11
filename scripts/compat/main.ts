// `pnpm compat`: whether what Svall reads from Claude Code, Codex and OpenCode is still in each one's newest release,
// and whether the installed CLIs still take the flags Svall passes. Exits 1 when anything is gone or couldn't be checked.
// --update records the releases' event lists in snapshot.json; --notify posts a macOS notification when a run finds
// something the last run didn't
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { AGENTS, versionOk } from '../../packages/svalld/src/agents.js';
import { helpHas } from './extract.js';
import { HARNESSES, HELP, type Harness } from './harnesses.js';

export type Snapshot = Partial<Record<AgentKind, { version: string; events: string[] }>>;
export type Report = { kind: AgentKind; version?: string; installed?: string; events: string[]; problems: string[]; added: string[]; notes: string[] };

const SNAPSHOT = path.join(import.meta.dirname, 'snapshot.json');
const STATE = path.join(os.homedir(), 'Library/Caches/svall-compat');

/** The newest release checked against what Svall reads; a vendor that can't be checked is a problem, never a pass. */
export async function checkRelease(kind: AgentKind, snap: Snapshot, h: Harness = HARNESSES[kind]): Promise<Report> {
  const r: Report = { kind, events: [], problems: [], added: [], notes: [] };
  try {
    const { version, fresh, note } = await h.latest();
    r.version = version;
    if (note) r.notes.push(note);
    const a = AGENTS[kind];
    if (!versionOk(a, fresh)) r.problems.push(`a fresh install (${a.installCommand}) gets ${fresh}, below the ${a.minVersion?.join('.')} Svall needs`);
    const res = h.check(await h.files(version));
    r.events = res.events;
    r.problems.push(...res.missing.map((m) => `gone: ${m}`));
    const before = snap[kind]?.events;
    if (before) r.added = res.events.filter((e) => !before.includes(e));
  } catch (e) {
    // a vendor that is down or rate-limits, or answers with a cut-off body or a captive portal's page
    r.problems.push(`couldn't check: ${(e as Error).message}`);
  }
  return r;
}

const unreached = (r: Report) => r.problems.some((p) => p.startsWith("couldn't check"));

/** Every CLI's release check; one that couldn't be checked is tried again after `retryMs`, as a run on waking may
 * start before the network is up. */
export async function checkAll(snap: Snapshot, retryMs: number, harnesses: Record<AgentKind, Harness> = HARNESSES): Promise<Report[]> {
  const run = (k: AgentKind) => checkRelease(k, snap, harnesses[k]);
  const first = await Promise.all((Object.keys(harnesses) as AgentKind[]).map(run));
  if (!retryMs || !first.some(unreached)) return first;
  await new Promise((done) => setTimeout(done, retryMs));
  return Promise.all(first.map((r) => (unreached(r) ? run(r.kind) : r)));
}

function output(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
  } catch (e) {
    // a CLI may print its help to stderr, or exit non-zero after printing it
    const { stdout, stderr } = e as { stdout?: string; stderr?: string };
    return stdout || stderr || '';
  }
}

/** The installed CLI's help, checked for each flag and subcommand Svall passes it. */
export function checkInstalled(r: Report, bin: string = AGENTS[r.kind].bin): void {
  const name = path.basename(bin);
  r.installed = output(bin, ['--version']).trim().split('\n')[0] || undefined;
  if (!r.installed) { r.notes.push(`${name} isn't installed; its flags went unchecked`); return; }
  for (const [argv, words] of HELP[r.kind]) {
    const help = output(bin, argv);
    const cmd = `\`${name} ${argv.join(' ')}\``;
    if (!help.trim()) r.problems.push(`${cmd} printed nothing`);
    else r.problems.push(...words.filter((w) => !helpHas(help, w)).map((w) => `${cmd} no longer lists ${w}`));
  }
}

export function format(reports: Report[]): string {
  return reports.map((r) => {
    const head = `${r.kind} ${r.version ?? '?'} (installed: ${r.installed ?? 'none'}): ${r.problems.length ? 'NEEDS A LOOK' : 'ok'}`;
    const lines = [...r.problems, ...r.notes, ...(r.added.length ? [`new events: ${r.added.join(', ')}`] : [])];
    return [head, ...lines.map((l) => `  - ${l}`)].join('\n');
  }).join('\n');
}

const post = (title: string, subtitle: string): void => {
  execFileSync('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Svall compat" subtitle (item 2 of argv)', '-e', 'end run', title, subtitle]);
};

/** What needs a look, by CLI: each problem and each new event. Notes and the versions checked stay out, so a release
 * that changes nothing Svall reads isn't news. */
export const findings = (reports: Report[]): string[] =>
  reports.flatMap((r) => [...r.problems.map((p) => `${r.kind}: ${p}`), ...r.added.map((e) => `${r.kind}: new event ${e}`)]);

/** Saves the report and posts the first finding the last run didn't have. Findings are remembered once posted, so one
 * that goes away and comes back is posted again, and one whose post failed is tried on the next run. */
export function notify(text: string, found: string[], dir = STATE, send = post): boolean {
  fs.mkdirSync(dir, { recursive: true });
  const report = path.join(dir, 'report.txt');
  const last = path.join(dir, 'findings.json');
  fs.writeFileSync(report, `${new Date().toISOString()}\n${text}\n`);
  let before: string[] = [];
  try { before = JSON.parse(fs.readFileSync(last, 'utf8')) as string[]; } catch {}
  const fresh = found.filter((f) => !before.includes(f));
  if (fresh.length) send(fresh[0].slice(0, 200), `${fresh.length > 1 ? `and ${fresh.length - 1} more; ` : ''}report: ${report}`);
  fs.writeFileSync(last, JSON.stringify(found));
  return fresh.length > 0;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const snap = (fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : {}) as Snapshot;
  const reports = await checkAll(snap, args.has('--notify') ? 60_000 : 0);
  for (const r of reports) checkInstalled(r);
  const text = format(reports);
  console.log(text);
  if (args.has('--update')) {
    const next: Snapshot = { ...snap };
    for (const r of reports) if (r.version && r.events.length) next[r.kind] = { version: r.version, events: r.events };
    fs.writeFileSync(SNAPSHOT, JSON.stringify(next, null, 2) + '\n');
  }
  if (args.has('--notify')) notify(text, findings(reports));
  process.exitCode = reports.some((r) => r.problems.length) ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
