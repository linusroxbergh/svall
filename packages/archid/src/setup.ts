import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentKind } from '@archipelago/protocol';
import { AGENTS, AGENT_KINDS, isExecutable, onPath } from './agents.js';
import { codexHookCommand, codexPaths, mergeCodexHooks, type CodexPaths } from './codex/install.js';
import { initConfig, loadConfig } from './config.js';
import { CLAUDE_HOOKS, hooksFor } from './hooks/receiver.js';
import { writeAtomic } from './jsonfile.js';
import { LAUNCHD_LABEL } from './profile.js';
import { HOOK_GUARD, HOOK_SCRIPT, claudePaths, expandHome, isOurs, resolvePaths, type Paths } from './paths.js';
import { hooksDir, homeTemplateDir } from './release.js';
import { shq } from './text.js';
import { tmuxConfText } from './tmux/conf.js';

const exec = promisify(execFile);

export const HOOK_EVENTS = CLAUDE_HOOKS;
export { LAUNCHD_LABEL };

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const unxml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

const unshq = (s: string): string =>
  (s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/'\\''/g, "'") : s);

type HookEntry = { type: string; command?: string; timeout?: number };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };
type StatusLine = { type?: string; command?: string };

// an entry from an earlier setup takes the current command, so a moved node or a changed command is repaired
export function mergeHooks(settings: Record<string, unknown>, command: string, events: readonly string[], script: string): Record<string, unknown> {
  const out = structuredClone(settings);
  const hooks = ((out.hooks ??= {}) as Record<string, HookGroup[]>);
  for (const ev of events) {
    const groups = (hooks[ev] ??= []);
    const ours = groups.flatMap((g) => g.hooks ?? []).filter((h) => isOurs(h.command, script));
    for (const h of ours) h.command = command;
    if (!ours.length) groups.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] });
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
  return status.includes(shq(paths.statusScript)) && events.some((ev) =>
    (hooks[ev] ?? []).some((g) => (g.hooks ?? []).some((h) => isOurs(h.command, paths.hookScript))));
}

// Claude Code's context reading reaches the daemon through its statusLine command, so the one
// the user already had becomes the wrapper's argument and still writes the line. A wrapper from an
// earlier setup keeps its inner command but is rebuilt, so a moved node is repaired.
export function mergeStatusLine(settings: Record<string, unknown>, wrapper: string, script: string): Record<string, unknown> {
  const out = structuredClone(settings);
  const current = out.statusLine as StatusLine | undefined;
  const command = current?.type === 'command' && current.command ? current.command : undefined;
  const inner = command && unwrapStatusLine(command, script);
  const next = inner ? `${wrapper} ${shq(inner)}` : wrapper;
  if (command === next) return out;
  out.statusLine = { ...current, type: 'command', command: next };
  return out;
}

// the command a wrapper of `script` wraps, or the command itself when it is not one
function unwrapStatusLine(command: string, script: string): string | undefined {
  const at = command.indexOf(shq(script));
  return at === -1 ? command : unshq(command.slice(at + shq(script).length).trim()) || undefined;
}

export function unmergeStatusLine(settings: Record<string, unknown>, script: string): Record<string, unknown> {
  const out = structuredClone(settings);
  const current = out.statusLine as StatusLine | undefined;
  if (current?.type !== 'command' || !current.command?.includes(shq(script))) return out;
  const inner = unwrapStatusLine(current.command, script);
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

export function launchdPlist(o: { label: string; program: string[]; home: string; log: string; pathEnv: string; env?: Record<string, string> }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${o.program.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ARCHI_HOME</key><string>${xml(o.home)}</string>
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
  const hooksSrc = hooksDir();
  fs.copyFileSync(path.join(hooksSrc, HOOK_SCRIPT), paths.hookScript);
  fs.copyFileSync(path.join(hooksSrc, 'claude-status.mjs'), paths.statusScript);
}

// the start of the SHA-256 of each CLAUDE.md that earlier versions seeded with the instructions
// .claude/rules/archipelago.md now holds; a copy nobody edited gives way to the current one
const SEEDED_CLAUDE_MD = new Set([
  '77e9f0ad748940d2', 'fd5b0fdf4bb053ff', 'ff25eb15d2396c4c', '548d402f8b0374dd', 'e47044e2c8110026',
  'f52495fcfd575fce', 'ed85a096e0d5d77b', '54112402beb19563', 'b110071fb3f4a834', '7b879ad49d407495',
]);
const seeded = (text: string): boolean => SEEDED_CLAUDE_MD.has(crypto.createHash('sha256').update(text).digest('hex').slice(0, 16));

// Archipelago's instructions and the skills the mission control buttons call live in the crew's cwd,
// so every daemon start refreshes them there. the CLAUDE.md and the settings are the user's to edit,
// and are seeded once; only `archi setup --replace-settings` replaces edited settings, keeping a copy
export function installHomeTemplate(cwd: string, o: { replaceSettings: boolean }): string[] {
  const done: string[] = [];
  const template = homeTemplateDir();
  const dir = expandHome(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const claudeMd = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd) || seeded(fs.readFileSync(claudeMd, 'utf8'))) {
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
  const agentsHeader = '<!-- archid rewrites this file on every start from .claude/rules/archipelago.md and CLAUDE.md; add your own rules to CLAUDE.md -->';
  // CLAUDE.md -> AGENTS.md (a common convention) would otherwise make AGENTS.md read, then append, itself
  if (fs.existsSync(agentsMd) && fs.existsSync(claudeMd) && realDir(agentsMd) === realDir(claudeMd)) {
    done.push(`home AGENTS.md left alone, as it is CLAUDE.md, so a Codex crew misses Archipelago's rules -> ${agentsMd}`);
  } else {
    if (fs.existsSync(agentsMd) && !fs.readFileSync(agentsMd, 'utf8').startsWith(agentsHeader)) {
      const backup = `${agentsMd}.bak-${Date.now()}`;
      fs.copyFileSync(agentsMd, backup);
      done.push(`backup -> ${backup}`);
    }
    const rules = fs.readFileSync(path.join(template, '.claude/rules/archipelago.md'), 'utf8');
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

/** An installed release root, or the checkout a development install runs the daemon out of. */
export type RunFrom = { release: string } | { repoRoot: string };

/** What launchd starts: the release's own daemon, or the checkout's entry point through tsx. */
export function daemonProgram(o: RunFrom): string[] {
  return 'release' in o
    ? [path.join(o.release, 'bin', 'archid')]
    : [path.join(o.repoRoot, 'node_modules/.bin/tsx'), path.join(o.repoRoot, 'packages/archid/src/bin.ts')];
}

export type FleetHome = RunFrom & { home: string; port?: number; tmuxVersion?: string };

/** What a fleet home needs before its daemon starts: the hook scripts, the config and tmux.conf. */
export function setupFleetHome(o: FleetHome): string[] {
  const done: string[] = [];
  const paths = resolvePaths(o.home);
  installHookScripts(paths);
  done.push(`hook script -> ${paths.hookScript}`);
  done.push(`statusline script -> ${paths.statusScript}`);

  for (const file of initConfig(paths, { port: o.port })) done.push(`config -> ${file}`);
  if (!fs.existsSync(paths.tmuxConf)) { fs.writeFileSync(paths.tmuxConf, tmuxConfText(loadConfig(paths), { tmuxVersion: o.tmuxVersion })); done.push(`tmux.conf -> ${paths.tmuxConf}`); }
  return done;
}

export type HomeSetup = FleetHome & { label: string; launchAgentsDir: string; launchctl: boolean };

// a Homebrew keg's versioned folder goes with the next upgrade, while its opt link stays
const nodeDirOf = (execPath: string): string => path.dirname(execPath).replace(/\/Cellar\/([^/]+)\/[^/]+\/bin$/, '/opt/$1/bin');

const realDir = (dir: string): string => {
  try { return fs.realpathSync(dir); } catch { return dir; }
};

// launchd gives the daemon no shell PATH, so the folder this shell finds claude or codex in is added after the usual
// ones when it is none of them, as for a pnpm, bun or volta global. Its real path, as a node manager's can be per shell
function daemonPath(nodeDir: string): string {
  const usual = [nodeDir, path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const found = AGENT_KINDS.map((k) => onPath(AGENTS[k].bin, process.env.PATH ?? ''))
    .filter((dir) => dir !== undefined).map(realDir);
  const known = new Set(usual.map(realDir));
  return [...new Set([...usual, ...found.filter((dir) => !known.has(dir))])].join(':');
}

const plistFile = (o: Pick<HomeSetup, 'label' | 'launchAgentsDir'>): string => path.join(o.launchAgentsDir, `${o.label}.plist`);

const plistText = (o: Pick<HomeSetup, 'home' | 'label'> & RunFrom, nodeDir: string): string => launchdPlist({
  label: o.label, program: daemonProgram(o), home: o.home, log: resolvePaths(o.home).log, pathEnv: daemonPath(nodeDir), env: launchdEnv(),
});

/** The program, a checkout's tsx or a release's archid, and the PATH folders that a plist setup wrote starts archid with. */
export function plistRun(text: string): { program?: string; path: string[] } {
  const program = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
  const pathEnv = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(text)?.[1];
  return { program: program && unxml(program), path: pathEnv ? unxml(pathEnv).split(':') : [] };
}

/** Whether a fleet's plist holds what setup would write now to run the checkout or release `o` names; the node it names stands while it is there. */
export function plistCurrent(o: Pick<HomeSetup, 'home' | 'label' | 'launchAgentsDir'> & RunFrom): boolean {
  let text: string;
  try { text = fs.readFileSync(plistFile(o), 'utf8'); } catch { return false; }
  const named = plistRun(text).path[0];
  return text === plistText(o, named && isExecutable(path.join(named, 'node')) ? named : nodeDirOf(process.execPath));
}

export async function setupHome(o: HomeSetup): Promise<string[]> {
  const done = setupFleetHome(o);

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
  `archi_status() { if [ -n "$ARCHI_CHAR_ID" ] && [ -f "$1" ]; then n=${shq(node)}; [ -x "$n" ] || n=node; "$n" "$@"; elif [ -n "$2" ]; then c=$2; shift 2; eval "$c"; fi; }; archi_status ${shq(script)}`;

// outside a character the shell exits before node starts, as every session on the machine runs this hook;
// $PPID is the agent, which tells it apart from a `claude -p` or `codex exec` run inside it
export const hookCommand = (node: string, script: string, backend: AgentKind): string =>
  `${HOOK_GUARD} { ${nodeRun(node, script)} ${backend} "$PPID"; }`;

/** Codex's hooks file when Codex is wanted here (on PATH, or its home exists); throws on one that is not JSON. */
export const readCodexHooks = (codex: CodexPaths, wanted = fs.existsSync(codex.dir)): JsonSettings | undefined =>
  (wanted ? readJsonSettings(codex.hooks) : undefined);

/** Writes the hooks into Codex's own file, when Codex is wanted here. */
export function installCodexHooks(codex: CodexPaths, script: string, before: JsonSettings | undefined = readCodexHooks(codex)): string[] {
  if (!before) return [];
  const wrote = writeJsonSettings(before, withCodexHooks(before.settings, script), 'codex hooks');
  return wrote.length ? [...wrote, 'Codex asks once to trust these hooks: start codex and choose "Trust all and continue", or trust them in /hooks'] : [];
}

// the node the installed statusline names, while it is there: the commands fall back to the node on PATH,
// so archi running under another node is no reason to rewrite them
function installedNode(settings: Record<string, unknown>): string | undefined {
  const quoted = /\bn=('(?:[^']|'\\'')*'); \[ -x "\$n" \]/.exec((settings.statusLine as StatusLine | undefined)?.command ?? '')?.[1];
  if (!quoted) return undefined;
  try {
    fs.accessSync(unshq(quoted), fs.constants.X_OK);
    return unshq(quoted);
  } catch {
    return undefined;
  }
}

// the hooks and statusline setup writes into the Claude settings for the fleet at `home`, run by `node`
// unless the installed ones name one that is still there
function withClaudeHooks(settings: Record<string, unknown>, home: string, node: string = process.execPath): Record<string, unknown> {
  const paths = resolvePaths(home);
  const run = installedNode(settings) ?? node;
  return mergeStatusLine(
    mergeHooks(settings, hookCommand(run, paths.hookScript, 'claude'), hooksFor('claude'), paths.hookScript),
    statusWrapper(run, paths.statusScript),
    paths.statusScript,
  );
}

const withCodexHooks = (current: Record<string, unknown>, script: string): Record<string, unknown> =>
  mergeCodexHooks(current, codexHookCommand(script), script);

/** Whether the Claude settings already hold what setup would write for the fleet at `home`. */
export const claudeHooksCurrent = (settings: Record<string, unknown>, home: string): boolean => same(withClaudeHooks(settings, home), settings);

/** Whether Codex's hooks file already holds what setup would write for `script`. */
export const codexHooksCurrent = (current: Record<string, unknown>, script: string): boolean => same(withCodexHooks(current, script), current);

const SHIMS = ['archi', 'archipelago'];

// tsx otherwise reads the tsconfig of the caller's cwd, whose paths can point @archipelago/* at another checkout
const shimText = (root: string): string => `#!/bin/sh\nexec ${shq(path.join(root, 'node_modules/.bin/tsx'))} --tsconfig ${shq(path.join(root, 'tsconfig.json'))} ${shq(path.join(root, 'packages/cli/src/main.ts'))} "$@"\n`;

// an installed release's shim is a relative link to its archi through `current`, which setup writes the same way every time
const releaseLink = (shimDir: string, release: string): string => path.relative(shimDir, path.join(release, 'bin', 'archi'));

/** Whether both shims hold what setup would write now to run the checkout or release `from` names. */
export const shimsCurrent = (shimDir: string, from: RunFrom): boolean => SHIMS.every((name) => {
  const file = path.join(shimDir, name);
  if ('release' in from) return fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true && fs.readlinkSync(file) === releaseLink(shimDir, from.release);
  return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === shimText(from.repoRoot);
});

/** Throws, before anything is written, when the Claude settings or Codex's hooks need a change setup cannot write. */
export function requireWritableHooks(home: string, settings: JsonSettings | undefined, codexHooks: JsonSettings | undefined): void {
  if (settings) requireWritable(settings, withClaudeHooks(settings.settings, home));
  if (codexHooks) requireWritable(codexHooks, withCodexHooks(codexHooks.settings, resolvePaths(home).hookScript));
}

// an installed release is reached through a relative link, so an upgrade that moves `current` needs no new shim
function writeShims(shimDir: string, o: RunFrom): string[] {
  fs.mkdirSync(shimDir, { recursive: true });
  return SHIMS.map((name) => {
    const shim = path.join(shimDir, name);
    fs.rmSync(shim, { force: true });
    if ('release' in o) fs.symlinkSync(releaseLink(shimDir, o.release), shim);
    else fs.writeFileSync(shim, shimText(o.repoRoot), { mode: 0o755 });
    return `shim -> ${shim}`;
  });
}

export function setupUser(o: RunFrom & { home: string; settings?: JsonSettings; codex: CodexPaths; codexHooks?: JsonSettings; shimDir: string; replaceSettings?: boolean }): string[] {
  const paths = resolvePaths(o.home);
  // a first install runs from a staging copy that is deleted after it, so the hooks name the installed node
  const node = 'release' in o ? path.join(o.release, 'node', 'bin', 'node') : process.execPath;
  const done = o.settings ? writeJsonSettings(o.settings, withClaudeHooks(o.settings.settings, o.home, node), 'claude hooks and statusline') : [];
  done.push(...installCodexHooks(o.codex, paths.hookScript, o.codexHooks));

  done.push(...writeShims(o.shimDir, o));

  // the home folder comes last and never fails the run: an unreadable config or an unwritable cwd
  // must not cost the user the hooks, the plist and the shim
  try {
    done.push(...installHomeTemplate(loadConfig(paths).home.cwd, { replaceSettings: o.replaceSettings === true }));
  } catch (e) {
    done.push(`home folder skipped: ${(e as Error).message}`);
  }
  return done;
}

/**
 * Rewrites every named profile's agent to run the installed release through current, since whatever
 * opened the profile first wrote it; returns the labels it rewrote.
 */
function moveProfileAgents(o: RunFrom & { launchAgentsDir: string }): string[] {
  if (!('release' in o) || !fs.existsSync(o.launchAgentsDir)) return [];
  const moved: string[] = [];
  for (const name of fs.readdirSync(o.launchAgentsDir).sort()) {
    if (!name.startsWith(`${LAUNCHD_LABEL}.`) || !name.endsWith('.plist')) continue;
    const file = path.join(o.launchAgentsDir, name);
    const text = fs.readFileSync(file, 'utf8');
    const home = /<key>ARCHI_HOME<\/key><string>([^<]*)<\/string>/.exec(text)?.[1];
    if (!home) continue;
    const label = name.slice(0, -'.plist'.length);
    const next = plistText({ ...o, label, home: unxml(home) }, nodeDirOf(process.execPath));
    if (next === text) continue;
    writeAtomic(file, next, { perProcess: true });
    moved.push(label);
  }
  return moved;
}

export async function runSetup(o: RunFrom & {
  home: string; settingsPath: string; codex: CodexPaths; launchAgentsDir: string; shimDir: string; launchctl: boolean; replaceSettings?: boolean; agents?: AgentKind[];
}): Promise<string[]> {
  const claudeWanted = !o.agents || o.agents.includes('claude') || fs.existsSync(path.dirname(o.settingsPath));
  const codexWanted = !!o.agents?.includes('codex') || fs.existsSync(o.codex.dir);
  // both files are read and checked before anything is written, so one that is not JSON, or cannot take
  // the change, stops a setup that has changed nothing
  const settings = claudeWanted ? readJsonSettings(o.settingsPath) : undefined;
  const codexHooks = readCodexHooks(o.codex, codexWanted);
  requireWritableHooks(o.home, settings, codexHooks);
  const home = await setupHome({ ...o, label: LAUNCHD_LABEL, launchctl: false });
  const moved = moveProfileAgents(o);
  home.push(...moved.map((label) => `launchd plist -> ${path.join(o.launchAgentsDir, `${label}.plist`)}`));
  const user = setupUser({ ...o, settings, codexHooks });
  if (!o.launchctl) return [...home, ...user];
  const loaded: string[] = [];
  for (const label of [LAUNCHD_LABEL, ...moved]) loaded.push(await bootstrapAgent(o.launchAgentsDir, label));
  return [...home, ...user, ...loaded];
}

