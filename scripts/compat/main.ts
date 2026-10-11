// `pnpm compat`: whether what Svall reads from Claude Code, Codex and OpenCode is still in each one's newest release,
// and whether the installed CLIs still take the flags Svall passes. Exits 1 when anything is gone or couldn't be checked.
// --update records the releases' event lists in snapshot.json; --json prints the findings and reports for a script to read
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import { AGENTS, versionOk } from '../../packages/svalld/src/agents.js';
import { helpHas } from './extract.js';
import { HARNESSES, HELP, type Harness } from './harnesses.js';

export type Snapshot = Partial<Record<AgentKind, { version: string; events: string[] }>>;
export type Report = { kind: AgentKind; version?: string; installed?: string; events: string[]; problems: string[]; added: string[]; notes: string[] };

const SNAPSHOT = path.join(import.meta.dirname, 'snapshot.json');

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

/** What needs a look, by CLI: each problem and each new event. Notes and the versions checked stay out, so a release
 * that changes nothing Svall reads isn't news. */
export const findings = (reports: Report[]): string[] =>
  reports.flatMap((r) => [...r.problems.map((p) => `${r.kind}: ${p}`), ...r.added.map((e) => `${r.kind}: new event ${e}`)]);

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const snap = (fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : {}) as Snapshot;
  const reports = await Promise.all((Object.keys(HARNESSES) as AgentKind[]).map((k) => checkRelease(k, snap)));
  for (const r of reports) checkInstalled(r);
  console.log(args.has('--json') ? JSON.stringify({ findings: findings(reports), reports }, null, 2) : format(reports));
  if (args.has('--update')) {
    const next: Snapshot = { ...snap };
    for (const r of reports) if (r.version && r.events.length) next[r.kind] = { version: r.version, events: r.events };
    fs.writeFileSync(SNAPSHOT, JSON.stringify(next, null, 2) + '\n');
  }
  process.exitCode = reports.some((r) => r.problems.length) ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
