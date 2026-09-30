import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentKind } from '@svall/protocol';
import { AGENTS, AGENT_KINDS, isExecutable, onPath } from './agents.js';
import { codexHookCommand, codexPaths, mergeCodexHooks, type CodexPaths } from './codex/install.js';
import { loadConfig } from './config.js';
import { CLAUDE_HOOKS, hooksFor } from './hooks/receiver.js';
import { writeAtomic } from './jsonfile.js';
import { BUNDLE_ID, LAUNCHD_LABEL, PRIVATE, SHIM, profileLabel, profileOf } from './profile.js';
import { HOOK_SCRIPT, claudePaths, expandHome, isOurs, resolvePaths, type Paths } from './paths.js';
import { assetDir, bundled, ownRuntime, variant, type Runtime } from './runtime.js';
import { shq } from './text.js';
import { tmuxConfText } from './tmux/conf.js';

const exec = promisify(execFile);

export const readOrUndefined = (file: string): string | undefined => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
};

export const HOOK_EVENTS = CLAUDE_HOOKS;
export { LAUNCHD_LABEL };

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const unxml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

const unshq = (s: string): string =>
  (s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/'\\''/g, "'") : s);

type HookEntry = { type: string; command?: string; timeout?: number; async?: boolean };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };
type StatusLine = { type?: string; command?: string };

// an event Claude Code need not wait on: it only says a subagent is gone. PermissionRequest waits, so a question
// is on record before the tool call its answer lets through
const ASYNC_HOOKS = new Set(['SubagentStop']);

// an entry from an earlier setup is rewritten whole, so a moved node, a changed command or a changed flag is repaired
export function mergeHooks(settings: Record<string, unknown>, command: string, events: readonly string[], script: string): Record<string, unknown> {
  const out = structuredClone(settings);
  const hooks = ((out.hooks ??= {}) as Record<string, HookGroup[]>);
  for (const ev of events) {
    const groups = (hooks[ev] ??= []);
    const ours = groups.flatMap((g) => g.hooks ?? []).filter((h) => isOurs(h.command, script));
    const entry = { type: 'command', command, timeout: 10, ...(ASYNC_HOOKS.has(ev) && { async: true }) };
    for (const h of ours) { delete h.async; Object.assign(h, entry); }
    if (!ours.length) groups.push({ matcher: '*', hooks: [entry] });
  }
  return out;
}

export function unmergeHooks(settings: Record<string, unknown>, script: string): Record<string, unknown> {
  const out = structuredClone(settings);
  const hooks = out.hooks as Record<string, HookGroup[]> | undefined;
  if (!hooks || typeof hooks !== 'object') return out;
  const ours = (h: HookEntry) => isOurs(h.command, script);
  let removed = false;
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || !groups.some((g) => (g.hooks ?? []).some(ours))) continue;
    removed = true;
    const kept = groups.flatMap((g) => {
      if (!(g.hooks ?? []).some(ours)) return [g];
      const rest = g.hooks!.filter((h) => !ours(h));
      return rest.length ? [{ ...g, hooks: rest }] : [];
    });
    if (kept.length) hooks[ev] = kept; else delete hooks[ev];
  }
  // a hooks object the user left empty is theirs to keep; only one this call emptied goes
  if (removed && !Object.keys(hooks).length) delete out.hooks;
  return out;
}

/** Whether the Claude settings run the statusline and the hook script of the fleet at `home`, for any of the events; an event added since is left to claudeHooksCurrent. */
export function hooksInstalled(settings: Record<string, unknown>, events: readonly string[], home: string): boolean {
  const paths = resolvePaths(home);
  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
  const status = (settings.statusLine as StatusLine | undefined)?.command ?? '';
  return ownHead(status, paths.statusScript) !== undefined && events.some((ev) =>
    (hooks[ev] ?? []).some((g) => (g.hooks ?? []).some((h) => isOurs(h.command, paths.hookScript))));
}

const WORD = String.raw`'(?:[^']|'\\'')*'`;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
type Wrapped = { head: string; inner?: string };

// our wrapper of `script` at the top of `command`: all up to the script, then the command it wraps as one quoted word.
// the script inside a nested wrapper's quoted argument is followed by an escaped quote, so it never matches here
function ownWrapper(command: string, script: string): Wrapped | undefined {
  const m = new RegExp(String.raw`^([\s\S]*?${escape(shq(script))})(?: (${WORD}))?$`).exec(command);
  return m ? { head: m[1], inner: m[2] === undefined ? undefined : unshq(m[2]) } : undefined;
}

// the other variant's wrapper, which statusWrapper wrote
const OTHER = new RegExp(String.raw`^(svall_status\(\) \{ [\s\S]*? \}; svall_status ${WORD})(?: (${WORD}))?$`);
function otherWrapper(command: string): Wrapped | undefined {
  const m = OTHER.exec(command);
  return m ? { head: m[1], inner: m[2] === undefined ? undefined : unshq(m[2]) } : undefined;
}

// the second variant to set up goes inside the first one's wrapper, which keeps its place
function withStatus(command: string | undefined, wrapper: string, script: string): string {
  if (!command) return wrapper;
  const own = ownWrapper(command, script);
  if (own) return own.inner ? `${wrapper} ${shq(own.inner)}` : wrapper;
  const other = otherWrapper(command);
  if (other) return `${other.head} ${shq(withStatus(other.inner, wrapper, script))}`;
  return `${wrapper} ${shq(command)}`;
}

function withoutStatus(command: string, script: string): string | undefined {
  const own = ownWrapper(command, script);
  if (own) return own.inner;
  const other = otherWrapper(command);
  if (!other) return command;
  const inner = other.inner && withoutStatus(other.inner, script);
  return inner ? `${other.head} ${shq(inner)}` : other.head;
}

/** The part of the statusline that runs `script`, up to it, wherever in a chain of wrappers it sits. */
function ownHead(command: string | undefined, script: string): string | undefined {
  for (let c = command; c; c = otherWrapper(c)?.inner) {
    const own = ownWrapper(c, script);
    if (own) return own.head;
  }
  return undefined;
}

// Claude Code's context reading reaches the daemon through its statusLine command, so the one
// the user already had becomes the wrapper's argument and still writes the line. A wrapper from an
// earlier setup keeps its inner command but is rebuilt, so a moved node is repaired; the other
// variant's wrapper stays outside it.
export function mergeStatusLine(settings: Record<string, unknown>, wrapper: string, script: string): Record<string, unknown> {
  const out = structuredClone(settings);
  const current = out.statusLine as StatusLine | undefined;
  const command = current?.type === 'command' && current.command ? current.command : undefined;
  const next = withStatus(command, wrapper, script);
  if (command === next) return out;
  out.statusLine = { ...current, type: 'command', command: next };
  return out;
}

export function unmergeStatusLine(settings: Record<string, unknown>, script: string): Record<string, unknown> {
  const out = structuredClone(settings);
  const current = out.statusLine as StatusLine | undefined;
  if (current?.type !== 'command' || ownHead(current.command, script) === undefined) return out;
  const inner = withoutStatus(current.command!, script);
  if (inner) out.statusLine = { ...current, command: inner };
  else delete out.statusLine;
  return out;
}

/** The plist entry that sets `key` for the daemon. */
export const plistEnv = (key: string, value: string): string => `<key>${xml(key)}</key><string>${xml(value)}</string>`;

/** Where this shell keeps Claude's and Codex's files, when it says; launchd gives the daemon no shell environment. */
export const launchdEnv = (): Record<string, string> => ({
  ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: claudePaths().dir } : {}),
  ...(process.env.CODEX_HOME ? { CODEX_HOME: codexPaths().dir } : {}),
});

export function launchdPlist(o: { label: string; program: string[]; home: string; log: string; pathEnv: string; bundleId?: string; env?: Record<string, string> }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(o.label)}</string>${o.bundleId ? `
  <key>AssociatedBundleIdentifiers</key><array><string>${xml(o.bundleId)}</string></array>` : ''}
  <key>ProgramArguments</key>
  <array>
${o.program.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SVALL_HOME</key><string>${xml(o.home)}</string>
    <key>PATH</key><string>${xml(o.pathEnv)}</string>
    <key>HOME</key><string>${xml(os.homedir())}</string>
    <key>LANG</key><string>en_US.UTF-8</string>${Object.entries(o.env ?? {}).map(([k, v]) => `
    ${plistEnv(k, v)}`).join('')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(o.log)}</string>
  <key>StandardErrorPath</key><string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

// the scripts speak the daemon's socket protocol, so every daemon start refreshes them
export function installHookScripts(paths: Paths): void {
  fs.mkdirSync(path.dirname(paths.hookScript), { recursive: true });
  const hooksSrc = assetDir('hooks');
  fs.copyFileSync(path.join(hooksSrc, HOOK_SCRIPT), paths.hookScript);
  fs.copyFileSync(path.join(hooksSrc, 'claude-status.mjs'), paths.statusScript);
}

// Svall's instructions and the skills the mission control buttons call live in the crew's cwd,
// so every daemon start refreshes them there. the CLAUDE.md and the settings are the user's to edit,
// and are seeded once; `svall setup` is the explicit ask that replaces edited settings, keeping a copy
export function installHomeTemplate(cwd: string, o: { replaceSettings: boolean }): string[] {
  const done: string[] = [];
  const template = assetDir('home');
  const dir = expandHome(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const claudeMd = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.copyFileSync(path.join(template, 'CLAUDE.md'), claudeMd);
    done.push(`home CLAUDE.md -> ${claudeMd}`);
  }
  const dotClaude = path.join(dir, '.claude');
  fs.mkdirSync(dotClaude, { recursive: true });
  fs.cpSync(path.join(template, '.claude/rules'), path.join(dotClaude, 'rules'), { recursive: true, force: true });
  done.push(`home rules -> ${dotClaude}/rules`);
  fs.cpSync(path.join(template, '.claude/skills'), path.join(dotClaude, 'skills'), { recursive: true, force: true });
  done.push(`home skills -> ${dotClaude}/skills`);
  // codex reads AGENTS.md, .agents/skills and .codex/rules instead; each start writes them from the same template
  const agentsMd = path.join(dir, 'AGENTS.md');
  const agentsHeader = '<!-- svalld rewrites this file on every start from .claude/rules/svall.md and CLAUDE.md; add your own rules to CLAUDE.md -->';
  // CLAUDE.md -> AGENTS.md (a common convention) would otherwise make AGENTS.md read, then append, itself
  if (fs.existsSync(agentsMd) && fs.existsSync(claudeMd) && realDir(agentsMd) === realDir(claudeMd)) {
    done.push(`home AGENTS.md left alone, as it is CLAUDE.md, so a Codex crew misses Svall's rules -> ${agentsMd}`);
  } else {
    if (fs.existsSync(agentsMd) && !fs.readFileSync(agentsMd, 'utf8').startsWith(agentsHeader)) {
      const backup = `${agentsMd}.bak-${Date.now()}`;
      fs.copyFileSync(agentsMd, backup);
      done.push(`backup -> ${backup}`);
    }
    const rules = fs.readFileSync(path.join(template, '.claude/rules/svall.md'), 'utf8');
    writeAtomic(agentsMd, `${agentsHeader}\n\n${rules}\n${fs.readFileSync(claudeMd, 'utf8')}`, { perProcess: true });
    done.push(`home AGENTS.md -> ${agentsMd}`);
  }
  fs.cpSync(path.join(template, '.claude/skills'), path.join(dir, '.agents/skills'), { recursive: true, force: true });
  done.push(`home codex skills -> ${dir}/.agents/skills`);
  fs.cpSync(path.join(template, '.codex/rules'), path.join(dir, '.codex/rules'), { recursive: true, force: true });
  done.push(`home codex rules -> ${dir}/.codex/rules`);
  const settings = path.join(dotClaude, 'settings.json');
  const shipped = fs.readFileSync(path.join(template, '.claude/settings.json'), 'utf8');
  const current = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : undefined;
  if (current === shipped) return done;
  if (current !== undefined) {
    if (!o.replaceSettings) return done;
    const backup = `${settings}.bak-${Date.now()}`;
    fs.copyFileSync(settings, backup);
    done.push(`backup -> ${backup}`);
  }
  writeAtomic(settings, shipped, { perProcess: true });
  done.push(`home settings -> ${settings}`);
  return done;
}

export type HomeSetup = {
  home: string; label: string; runtime: Runtime; launchAgentsDir: string; launchctl: boolean; port?: number;
};

// a Homebrew keg's versioned folder goes with the next upgrade, while its opt link stays
const nodeDirOf = (execPath: string): string => path.dirname(execPath).replace(/\/Cellar\/([^/]+)\/[^/]+\/bin$/, '/opt/$1/bin');

const realDir = (dir: string): string => {
  try { return fs.realpathSync(dir); } catch { return dir; }
};

// launchd gives the daemon no shell PATH, so the folder this shell finds claude or codex in is added after the usual
// ones when it is none of them, as for a pnpm, bun or volta global. Its real path, as a node manager's can be per shell
function daemonPath(nodeDir?: string): string {
  const usual = [...nodeDir ? [nodeDir] : [], path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const found = AGENT_KINDS.map((k) => onPath(AGENTS[k].bin, process.env.PATH ?? ''))
    .filter((dir) => dir !== undefined).map(realDir);
  const known = new Set(usual.map(realDir));
  return [...new Set([...usual, ...found.filter((dir) => !known.has(dir))])].join(':');
}

const plistFile = (o: Pick<HomeSetup, 'label' | 'launchAgentsDir'>): string => path.join(o.launchAgentsDir, `${o.label}.plist`);

// tsx needs node on PATH; the bundle's node is named outright
const plistText = (o: Pick<HomeSetup, 'home' | 'label' | 'runtime'>, nodeDir: string | undefined): string => launchdPlist({
  label: o.label, program: o.runtime.daemon, bundleId: o.runtime.bundle ? BUNDLE_ID : undefined,
  home: o.home, log: resolvePaths(o.home).log, pathEnv: daemonPath(o.runtime.bundle ? undefined : nodeDir), env: launchdEnv(),
});

/** The program and the PATH folders that a plist setup wrote starts svalld with. */
export function plistRun(text: string): { program: string[]; path: string[] } {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '';
  const program = [...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]));
  const pathEnv = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(text)?.[1];
  return { program, path: pathEnv ? unxml(pathEnv).split(':') : [] };
}

/** Whether a fleet's plist holds what setup would write now to run `o.runtime`; the node it names stands while it is there. */
export function plistCurrent(o: Pick<HomeSetup, 'home' | 'label' | 'launchAgentsDir' | 'runtime'>): boolean {
  let text: string;
  try { text = fs.readFileSync(plistFile(o), 'utf8'); } catch { return false; }
  if (o.runtime.bundle) return text === plistText(o, undefined);
  const named = plistRun(text).path[0];
  return text === plistText(o, named && isExecutable(path.join(named, 'node')) ? named : nodeDirOf(process.execPath));
}

export async function setupHome(o: HomeSetup): Promise<string[]> {
  const done: string[] = [];
  const paths = resolvePaths(o.home);
  installHookScripts(paths);
  done.push(`hook script -> ${paths.hookScript}`);
  done.push(`statusline script -> ${paths.statusScript}`);

  if (!fs.existsSync(paths.config)) {
    fs.writeFileSync(paths.config, JSON.stringify(o.port === undefined ? {} : { port: o.port }) + '\n');
    done.push(`config -> ${paths.config}`);
  }
  if (!fs.existsSync(paths.tmuxConf)) { fs.writeFileSync(paths.tmuxConf, tmuxConfText(loadConfig(paths.config))); done.push(`tmux.conf -> ${paths.tmuxConf}`); }

  fs.mkdirSync(o.launchAgentsDir, { recursive: true });
  const plist = plistFile(o);
  fs.writeFileSync(plist, plistText(o, nodeDirOf(process.execPath)));
  done.push(`launchd plist -> ${plist}`);

  if (o.launchctl) done.push(await bootstrapAgent(o.launchAgentsDir, o.label));
  return done;
}

async function bootstrapAgent(launchAgentsDir: string, label: string): Promise<string> {
  const domain = `gui/${os.userInfo().uid}`;
  const plist = path.join(launchAgentsDir, `${label}.plist`);
  await exec('launchctl', ['bootout', domain, plist]).catch(() => {});
  await exec('launchctl', ['bootstrap', domain, plist]);
  return `launchctl bootstrap ${domain} ${plist}`;
}

export async function kickstart(labels: string[]): Promise<string[]> {
  const done: string[] = [];
  for (const label of labels) {
    await exec('launchctl', ['kickstart', '-k', `gui/${os.userInfo().uid}/${label}`]);
    done.push(`restarted ${label}`);
  }
  return done;
}

/** Whether launchd has `label` loaded in this user's session. */
export const isLoaded = (label: string): Promise<boolean> =>
  exec('launchctl', ['print', `gui/${os.userInfo().uid}/${label}`]).then(() => true, () => false);

/** The program of another copy of Svall, still on disk, whose fleets these are: only an explicit setup takes them from it. */
export const takenOverBy = (plist: string | undefined, runtime: Runtime, exists: (p: string) => boolean = fs.existsSync): string | undefined => {
  const program = plist ? plistRun(plist).program[0] : undefined;
  return program && program !== runtime.daemon[0] && exists(program) ? program : undefined;
};

/** Points every fleet but the private one at `runtime`, as moving or updating the app leaves their plists behind. */
export async function refreshFleetPlists(o: { homes: string[]; runtime: Runtime; launchAgentsDir: string; launchctl: boolean; takeOver: boolean }): Promise<{ done: string[]; restarted: string[] }> {
  const done: string[] = [];
  const restarted: string[] = [];
  for (const home of o.homes) {
    const name = profileOf(home);
    const label = profileLabel(name);
    if (name === PRIVATE || plistCurrent({ home, label, launchAgentsDir: o.launchAgentsDir, runtime: o.runtime })) continue;
    const owner = o.takeOver ? undefined : takenOverBy(readOrUndefined(path.join(o.launchAgentsDir, `${label}.plist`)), o.runtime);
    if (owner) { done.push(`left ${home}, which ${owner} runs`); continue; }
    done.push(...await setupHome({ home, label, runtime: o.runtime, launchAgentsDir: o.launchAgentsDir, launchctl: false, port: 0 }));
    // a fleet the user left stopped stays stopped
    if (o.launchctl && await isLoaded(label)) {
      done.push(await bootstrapAgent(o.launchAgentsDir, label));
      restarted.push(label);
    }
  }
  return { done, restarted };
}

export type JsonSettings = { file: string; text?: string; settings: Record<string, unknown> };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function readJsonSettings(file: string): JsonSettings {
  if (!fs.existsSync(file)) return { file, settings: {} };
  const text = fs.readFileSync(file, 'utf8');
  try {
    return { file, text, settings: JSON.parse(text) };
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}), so nothing was changed; fix it and run again`);
  }
}

/** Throws when `next` changes a file that links into a folder that cannot be written, such as home-manager's store. */
export function requireWritable(current: JsonSettings, next: Record<string, unknown>): void {
  if (current.text === undefined || same(current.settings, next)) return;
  const real = fs.realpathSync(current.file);
  try {
    fs.accessSync(path.dirname(real), fs.constants.W_OK);
  } catch {
    throw new Error(`${current.file} links to ${real}, whose folder is not writable; make the change in ${real} or replace the link with a regular file, then run again`);
  }
}

// an unchanged file is left as it is, so repeated runs leave no pile of backups
export function writeJsonSettings(current: JsonSettings, next: Record<string, unknown>, what: string): string[] {
  if (same(current.settings, next)) return [];
  requireWritable(current, next);
  const done: string[] = [];
  // a linked file (stow, home-manager) is written where it points, with the mode it had
  let file = current.file;
  let mode: number | undefined;
  if (current.text !== undefined) {
    file = fs.realpathSync(current.file);
    mode = fs.statSync(file).mode & 0o777;
    const backup = `${current.file}.bak-${Date.now()}`;
    fs.writeFileSync(backup, current.text, { mode });
    fs.chmodSync(backup, mode);
    done.push(`backup -> ${backup}`);
  }
  fs.mkdirSync(path.dirname(current.file), { recursive: true });
  writeAtomic(file, JSON.stringify(next, null, 2) + '\n', { mode, perProcess: true });
  // the umask narrows the mode a file is created with, so the one it had is set again
  if (mode !== undefined) fs.chmodSync(file, mode);
  done.push(`${what} -> ${current.file}`);
  return done;
}

// the node setup ran with, or the one on PATH once a version manager has removed it
export const nodeRun = (node: string, script: string): string => `n=${shq(node)}; [ -x "$n" ] || n=node; "$n" ${shq(script)}`;

// every Claude session on the machine runs the statusline, so outside a character, or once the script
// is gone, the one the user had runs on its own and node never starts
export const statusWrapper = (node: string, script: string): string =>
  `svall_status() { if [ -n "$SVALL_CHAR_ID" ] && [ -f "$1" ]; then n=${shq(node)}; [ -x "$n" ] || n=node; "$n" "$@"; elif [ -n "$2" ]; then c=$2; shift 2; eval "$c"; fi; }; svall_status ${shq(script)}`;

// outside a character the shell exits before node starts, as every session on the machine runs this hook;
// $PPID is the agent, which tells it apart from a `claude -p` or `codex exec` run inside it
export const hookCommand = (node: string, script: string, backend: AgentKind): string =>
  `[ -z "$SVALL_CHAR_ID" ] || { ${nodeRun(node, script)} ${backend} "$PPID"; }`;

/** Codex's hooks file when Codex is wanted here (on PATH, or its home exists); throws on one that is not JSON. */
export const readCodexHooks = (codex: CodexPaths, wanted = fs.existsSync(codex.dir)): JsonSettings | undefined =>
  (wanted ? readJsonSettings(codex.hooks) : undefined);

/** Writes the hooks into Codex's own file, when Codex is wanted here. */
export function installCodexHooks(script: string, before: JsonSettings | undefined): string[] {
  if (!before) return [];
  const wrote = writeJsonSettings(before, withCodexHooks(before.settings, script), 'codex hooks');
  return wrote.length ? [...wrote, 'Codex asks once to trust these hooks: start codex and choose "Trust all and continue", or trust them in /hooks'] : [];
}

// the node the installed statusline names, while it is there: the commands fall back to the node on PATH,
// so svall running under another node is no reason to rewrite them
function installedNode(settings: Record<string, unknown>, script: string): string | undefined {
  const quoted = /\bn=('(?:[^']|'\\'')*'); \[ -x "\$n" \]/.exec(ownHead((settings.statusLine as StatusLine | undefined)?.command, script) ?? '')?.[1];
  if (!quoted) return undefined;
  try {
    fs.accessSync(unshq(quoted), fs.constants.X_OK);
    return unshq(quoted);
  } catch {
    return undefined;
  }
}

// the hooks and statusline setup writes into the Claude settings for the fleet at `home`
function withClaudeHooks(settings: Record<string, unknown>, home: string): Record<string, unknown> {
  const paths = resolvePaths(home);
  const node = ownRuntime().bundle ? process.execPath : installedNode(settings, paths.statusScript) ?? process.execPath;
  return mergeStatusLine(
    mergeHooks(settings, hookCommand(node, paths.hookScript, 'claude'), hooksFor('claude'), paths.hookScript),
    statusWrapper(node, paths.statusScript),
    paths.statusScript,
  );
}

const withCodexHooks = (current: Record<string, unknown>, script: string): Record<string, unknown> =>
  mergeCodexHooks(current, codexHookCommand(script, bundled ? process.execPath : undefined), script);

/** Whether the Claude settings already hold what setup would write for the fleet at `home`. */
export const claudeHooksCurrent = (settings: Record<string, unknown>, home: string): boolean => same(withClaudeHooks(settings, home), settings);

/** Whether Codex's hooks file already holds what setup would write for `script`. */
export const codexHooksCurrent = (current: Record<string, unknown>, script: string): boolean => same(withCodexHooks(current, script), current);

// Svall Dev also answers to `svall`, the name the briefs use, while no release has installed its own
export const shimNames = (shimDir: string): string[] => {
  if (variant === 'release') return [SHIM];
  let text = '';
  try { text = fs.readFileSync(path.join(shimDir, 'svall'), 'utf8'); } catch { /* none yet */ }
  return text.includes('Contents/Resources/runtime/svall.mjs') ? [SHIM] : [SHIM, 'svall'];
};

export const shimText = (r: Runtime): string => `#!/bin/sh\nexec ${r.cli.map(shq).join(' ')} "$@"\n`;

/** Whether the shims hold what setup would write now to run `runtime`. */
export const shimsCurrent = (shimDir: string, runtime: Runtime): boolean =>
  shimNames(shimDir).every((name) => fs.existsSync(path.join(shimDir, name)) && fs.readFileSync(path.join(shimDir, name), 'utf8') === shimText(runtime));

/** Throws, before anything is written, when the Claude settings or Codex's hooks need a change setup cannot write. */
export function requireWritableHooks(home: string, settings: JsonSettings | undefined, codexHooks: JsonSettings | undefined): void {
  if (settings) requireWritable(settings, withClaudeHooks(settings.settings, home));
  if (codexHooks) requireWritable(codexHooks, withCodexHooks(codexHooks.settings, resolvePaths(home).hookScript));
}

export function setupUser(o: { home: string; settings?: JsonSettings; codex: CodexPaths; codexHooks?: JsonSettings; shimDir: string; runtime: Runtime; replaceSettings: boolean }): string[] {
  const paths = resolvePaths(o.home);
  const done = o.settings ? writeJsonSettings(o.settings, withClaudeHooks(o.settings.settings, o.home), 'claude hooks and statusline') : [];
  done.push(...installCodexHooks(paths.hookScript, o.codexHooks));

  fs.mkdirSync(o.shimDir, { recursive: true });
  for (const name of shimNames(o.shimDir)) {
    const shim = path.join(o.shimDir, name);
    fs.writeFileSync(shim, shimText(o.runtime), { mode: 0o755 });
    done.push(`shim -> ${shim}`);
  }

  // the home folder comes last and never fails the run: an unreadable config or an unwritable cwd
  // must not cost the user the hooks, the plist and the shim
  try {
    done.push(...installHomeTemplate(loadConfig(paths.config).home.cwd, { replaceSettings: o.replaceSettings }));
  } catch (e) {
    done.push(`home folder skipped: ${(e as Error).message}`);
  }
  return done;
}

export async function runSetup(o: {
  home: string; settingsPath: string; codex: CodexPaths; launchAgentsDir: string; shimDir: string; runtime: Runtime; launchctl: boolean; agents?: AgentKind[];
  integrations?: AgentKind[]; replaceSettings?: boolean;
}): Promise<string[]> {
  const wants = (k: AgentKind, fallback: boolean) => fallback && (!o.integrations || o.integrations.includes(k));
  const claudeWanted = wants('claude', !o.agents || o.agents.includes('claude') || fs.existsSync(path.dirname(o.settingsPath)));
  const codexWanted = wants('codex', !!o.agents?.includes('codex') || fs.existsSync(o.codex.dir));
  // both files are read and checked before anything is written, so one that is not JSON, or cannot take
  // the change, stops a setup that has changed nothing
  const settings = claudeWanted ? readJsonSettings(o.settingsPath) : undefined;
  const codexHooks = readCodexHooks(o.codex, codexWanted);
  requireWritableHooks(o.home, settings, codexHooks);
  const paths = resolvePaths(o.home);
  const holdsOurs = (file: string): boolean => {
    const text = readOrUndefined(file) ?? '';
    return text.includes(paths.hookScript) || text.includes(paths.statusScript);
  };
  const removals: [JsonSettings, Record<string, unknown>, string][] = [];
  if (!claudeWanted && holdsOurs(o.settingsPath)) {
    const s = readJsonSettings(o.settingsPath);
    removals.push([s, unmergeStatusLine(unmergeHooks(s.settings, paths.hookScript), paths.statusScript), 'claude hooks removed']);
  }
  if (!codexWanted && holdsOurs(o.codex.hooks)) {
    const s = readJsonSettings(o.codex.hooks);
    removals.push([s, unmergeHooks(s.settings, paths.hookScript), 'codex hooks removed']);
  }
  for (const [current, next] of removals) requireWritable(current, next);
  const home = await setupHome({ ...o, label: LAUNCHD_LABEL, launchctl: false });
  const user = setupUser({ ...o, settings, codexHooks, replaceSettings: o.replaceSettings ?? true });
  for (const [current, next, what] of removals) user.push(...writeJsonSettings(current, next, what));
  if (!o.launchctl) return [...home, ...user];
  return [...home, ...user, await bootstrapAgent(o.launchAgentsDir, LAUNCHD_LABEL)];
}

