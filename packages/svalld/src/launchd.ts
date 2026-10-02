import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AGENTS, AGENT_KINDS, isExecutable, onPath } from './agents.js';
import { codexPaths } from './codex/install.js';
import { usualDirs } from './login-env.js';
import { claudePaths, realPath, resolvePaths } from './paths.js';
import { BUNDLE_ID } from './profile.js';
import type { Runtime } from './runtime.js';

const exec = promisify(execFile);

/** The launchd job that runs the daemon of the fleet at `home`. */
type Plist = { home: string; label: string; launchAgentsDir: string; runtime: Runtime };

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const unxml = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

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
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${xml(o.log)}</string>
  <key>StandardErrorPath</key><string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

// a Homebrew keg's versioned folder goes with the next upgrade, while its opt link stays
const nodeDirOf = (execPath: string): string => path.dirname(execPath).replace(/\/Cellar\/([^/]+)\/[^/]+\/bin$/, '/opt/$1/bin');

// launchd gives the daemon no shell PATH, so the folder this shell finds claude or codex in is added after the usual
// ones when it is none of them, as for a pnpm, bun or volta global. Its real path, as a node manager's can be per shell
function daemonPath(nodeDir?: string): string {
  const usual = [...nodeDir ? [nodeDir] : [], ...usualDirs()];
  const found = AGENT_KINDS.map((k) => onPath(AGENTS[k].bin, process.env.PATH ?? ''))
    .filter((dir) => dir !== undefined).map(realPath);
  const known = new Set(usual.map(realPath));
  return [...new Set([...usual, ...found.filter((dir) => !known.has(dir))])].join(':');
}

const plistFile = (o: Pick<Plist, 'label' | 'launchAgentsDir'>): string => path.join(o.launchAgentsDir, `${o.label}.plist`);

// tsx needs node on PATH; the bundle's node is named outright
const plistText = (o: Pick<Plist, 'home' | 'label' | 'runtime'>, nodeDir: string | undefined): string => launchdPlist({
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
export function plistCurrent(o: Plist): boolean {
  let text: string;
  try { text = fs.readFileSync(plistFile(o), 'utf8'); } catch { return false; }
  if (o.runtime.bundle) return text === plistText(o, undefined);
  const named = plistRun(text).path[0];
  return text === plistText(o, named && isExecutable(path.join(named, 'node')) ? named : nodeDirOf(process.execPath));
}

/** Writes the plist that runs `o.runtime`, on the node this process runs on unless the runtime names its own; its path. */
export function writePlist(o: Plist): string {
  fs.mkdirSync(o.launchAgentsDir, { recursive: true });
  const plist = plistFile(o);
  fs.writeFileSync(plist, plistText(o, nodeDirOf(process.execPath)));
  return plist;
}

export async function bootstrapAgent(launchAgentsDir: string, label: string): Promise<string> {
  const domain = `gui/${os.userInfo().uid}`;
  const plist = path.join(launchAgentsDir, `${label}.plist`);
  // launchd starts the daemon only when the app asks, so one that ran before the reload is started again on the new plist
  const running = await isRunning(label);
  await exec('launchctl', ['bootout', domain, plist]).catch(() => {});
  const bootstrap = () => exec('launchctl', ['bootstrap', domain, plist]);
  // launchd refuses a bootstrap while the job it booted out is still going away, so a refusal is tried once more
  await bootstrap().catch(() => new Promise((r) => setTimeout(r, 500)).then(bootstrap)).catch((e: Error & { stderr?: string }) => {
    throw new Error(`launchd did not load ${label} (${(e.stderr || e.message).trim().split('\n')[0]}); run setup again`);
  });
  if (running) await exec('launchctl', ['kickstart', `${domain}/${label}`]);
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

/** Whether `label`'s daemon runs: a loaded job runs only while its fleet's window is open. */
export const isRunning = (label: string): Promise<boolean> =>
  exec('launchctl', ['print', `gui/${os.userInfo().uid}/${label}`]).then(({ stdout }) => /\bstate = running\b/.test(stdout), () => false);

/** The program of another copy of Svall, still on disk, whose fleets these are: only an explicit setup takes them from it. */
export const takenOverBy = (plist: string | undefined, runtime: Runtime, exists: (p: string) => boolean = fs.existsSync): string | undefined => {
  const program = plist ? plistRun(plist).program[0] : undefined;
  return program && program !== runtime.daemon[0] && exists(program) ? program : undefined;
};
