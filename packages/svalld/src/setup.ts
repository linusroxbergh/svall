import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind } from '@svall/protocol';
import {
  claudeHooksCurrent, codexHooksCurrent, hookRemovals, installClaudeHooks, installCodexHooks, readCodexHooks, requireWritableHooks, type Removal,
} from './agent-hooks.js';
import { isExecutable } from './agents.js';
import type { CodexPaths } from './codex/install.js';
import { loadConfig } from './config.js';
import { writeAtomic } from './jsonfile.js';
import { bootstrapAgent, isLoaded, plistCurrent, takenOverBy, writePlist } from './launchd.js';
import { installOpencodePlugin, opencodePluginCurrent, removeOpencodePlugin, type OpencodePaths } from './opencode/install.js';
import { LAUNCHD_LABEL, PRIVATE, SHIM, profileLabel, profileOf } from './profile.js';
import { HOOK_SCRIPT, expandHome, realPath, resolvePaths, type Paths } from './paths.js';
import { assetDir, hookHelperSource, hookHelperSources, variant, type Runtime } from './runtime.js';
import { readJsonSettings, readOrUndefined, writeJsonSettings, type JsonSettings } from './settings-file.js';
import { shq } from './text.js';

// the scripts speak the daemon's socket protocol, so every daemon start refreshes them and the helper that stands in
// for them; without a built helper the scripts run
export function installHookScripts(paths: Paths, helper: string | undefined = hookHelperSource()): void {
  const hooksSrc = assetDir('hooks');
  // a hook may be reading a script as it is replaced, so an unchanged one stays and a changed one is renamed into place
  for (const [name, dest] of [[HOOK_SCRIPT, paths.hookScript], ['claude-status.mjs', paths.statusScript]]) {
    const text = fs.readFileSync(path.join(hooksSrc, name), 'utf8');
    if (readOrUndefined(dest) !== text) writeAtomic(dest, text, { perProcess: true });
  }
  const tmp = `${paths.hookHelper}.${process.pid}.tmp`;
  try {
    // a checkout's build older than its sources would run in place of newer scripts
    if (!helper || !isExecutable(helper) || hookHelperSources().some((s) => fs.statSync(s).mtimeMs > fs.statSync(helper).mtimeMs)) {
      fs.rmSync(paths.hookHelper, { force: true });
      return;
    }
    // a new file's first run waits ~90 ms on its signature check, so an unchanged one stays
    if (isExecutable(paths.hookHelper) && fs.readFileSync(helper).equals(fs.readFileSync(paths.hookHelper))) return;
    // renamed into place, as a hook may be running the old file and macOS kills a process whose binary changes under it
    fs.copyFileSync(helper, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, paths.hookHelper);
  } catch {
    // the helper only saves time, so one that cannot be put in place leaves the scripts to run
    fs.rmSync(tmp, { force: true });
    fs.rmSync(paths.hookHelper, { force: true });
  }
}

// every daemon start refreshes Svall's instructions and the skills the mission control buttons call in the crew's cwd;
// the CLAUDE.md and the settings are the user's, seeded once, and only `svall setup` replaces edited settings, keeping a copy
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
  if (fs.existsSync(agentsMd) && fs.existsSync(claudeMd) && realPath(agentsMd) === realPath(claudeMd)) {
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

  done.push(`launchd plist -> ${writePlist(o)}`);

  if (o.launchctl) done.push(await bootstrapAgent(o.launchAgentsDir, o.label));
  return done;
}

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
    done.push(...await setupHome({ home, label, runtime: o.runtime, launchAgentsDir: o.launchAgentsDir, launchctl: false }));
    // a fleet the user left stopped stays stopped
    if (o.launchctl && await isLoaded(label)) {
      done.push(await bootstrapAgent(o.launchAgentsDir, label));
      restarted.push(label);
    }
  }
  return { done, restarted };
}

// Svall Dev also answers to `svall`, the name the briefs use, while no release has installed its own
export const shimNames = (shimDir: string): string[] => {
  if (variant === 'release') return [SHIM];
  let text = '';
  try { text = fs.readFileSync(path.join(shimDir, 'svall'), 'utf8'); } catch { /* none yet */ }
  return text.includes('Contents/Resources/runtime/svall.mjs') ? [SHIM] : [SHIM, 'svall'];
};

/** The command line that runs `r`'s CLI, which still works once uninstall has removed the shims. */
export const cliCommand = (r: Runtime): string => r.cli.map(shq).join(' ');

export const shimText = (r: Runtime): string => `#!/bin/sh\nexec ${cliCommand(r)} "$@"\n`;

/** Whether the shims hold what setup would write now to run `runtime`. */
export const shimsCurrent = (shimDir: string, runtime: Runtime): boolean =>
  shimNames(shimDir).every((name) => fs.existsSync(path.join(shimDir, name)) && fs.readFileSync(path.join(shimDir, name), 'utf8') === shimText(runtime));

function setupUser(o: { home: string; settings?: JsonSettings; codexHooks?: JsonSettings; shimDir: string; runtime: Runtime; replaceSettings: boolean }): string[] {
  const paths = resolvePaths(o.home);
  const done = installClaudeHooks(o.home, o.settings);
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

export type SetupOptions = {
  home: string; settingsPath: string; codex: CodexPaths; opencode: OpencodePaths; launchAgentsDir: string; shimDir: string; runtime: Runtime;
  // the agent CLIs on PATH; absent, Claude counts as installed
  agents?: AgentKind[]; integrations?: AgentKind[];
};

export type SetupState = { settings?: JsonSettings; codexHooks?: JsonSettings; opencodeWanted: boolean; removals: Removal[]; hooksStale: boolean; shimsStale: boolean; plistStale: boolean };

/** What setup finds for the private fleet at `o.home`: the agent files it would write, read and checked before anything
 *  is written, and which of the hooks, the shims and the plist it would change. Throws on a file it could not write back. */
export function setupState(o: SetupOptions): SetupState {
  const wants = (k: AgentKind, fallback: boolean) => fallback && (!o.integrations || o.integrations.includes(k));
  const claudeWanted = wants('claude', !o.agents || o.agents.includes('claude') || fs.existsSync(path.dirname(o.settingsPath)));
  const codexWanted = wants('codex', !!o.agents?.includes('codex') || fs.existsSync(o.codex.dir));
  const settings = claudeWanted ? readJsonSettings(o.settingsPath) : undefined;
  const codexHooks = readCodexHooks(o.codex, codexWanted);
  const opencodeWanted = wants('opencode', !!o.agents?.includes('opencode') || fs.existsSync(o.opencode.dir));
  const opencodeStale = opencodeWanted ? !opencodePluginCurrent(readOrUndefined(o.opencode.plugin)) : fs.existsSync(o.opencode.plugin);
  requireWritableHooks(o.home, settings, codexHooks);
  const removals = hookRemovals({ ...o, claudeWanted, codexWanted });
  return {
    settings, codexHooks, opencodeWanted, removals,
    hooksStale: !!settings && !claudeHooksCurrent(settings.settings, o.home)
      || !!codexHooks && !codexHooksCurrent(codexHooks.settings, resolvePaths(o.home).hookScript) || removals.length > 0 || opencodeStale,
    shimsStale: !shimsCurrent(o.shimDir, o.runtime),
    plistStale: !plistCurrent({ home: o.home, label: LAUNCHD_LABEL, launchAgentsDir: o.launchAgentsDir, runtime: o.runtime }),
  };
}

export async function runSetup(o: SetupOptions & { launchctl: boolean; replaceSettings?: boolean }): Promise<string[]> {
  // read again here, as a run decides what to do seconds before it writes, and an agent may have changed its file since
  const state = setupState(o);
  const home = await setupHome({ ...o, label: LAUNCHD_LABEL, launchctl: false });
  const user = setupUser({ ...o, settings: state.settings, codexHooks: state.codexHooks, replaceSettings: o.replaceSettings ?? true });
  for (const [current, next, what] of state.removals) user.push(...writeJsonSettings(current, next, what));
  user.push(...(state.opencodeWanted ? installOpencodePlugin(o.opencode) : removeOpencodePlugin(o.opencode)));
  if (!o.launchctl) return [...home, ...user];
  return [...home, ...user, await bootstrapAgent(o.launchAgentsDir, LAUNCHD_LABEL)];
}
