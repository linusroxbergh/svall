import fs from 'node:fs';
import { z } from 'zod';
import { AgentKind, DEFAULT_CWD, Home, isProfileName } from '@svall/protocol';
import { writeAtomic } from './jsonfile.js';
import { resolvePaths } from './paths.js';
import { HOME_CWD, PRIVATE, profileHome, profileOf } from './profile.js';

export const Config = z.object({
  // what the app and `svall <name>` call the fleet; absent, its directory names it
  name: z.string().refine(isProfileName, 'use lowercase letters, digits and dashes, starting with a letter, and no svall command or dev name, which Svall Dev keeps').optional(),
  // absent, DEFAULT_PORT, or a free port while another program holds that
  port: z.number().int().optional(),
  host: z.string().default('127.0.0.1'),
  shell: z.string().optional(),
  linear: z.object({ workspace: z.string(), teamKeys: z.array(z.string()) }).optional(),
  // with no command, the crew starts the main agent's crewCommand
  home: Home.extend({ cwd: z.string().default(HOME_CWD), command: z.string().optional() }).prefault({}),
  defaultCwd: z.string().default(DEFAULT_CWD),
  // the agent the scribe, mission control's crew and `svall char new --run` use by default; absent, the private fleet's, else
  // claude, unless only other agents are installed
  mainAgent: AgentKind.optional(),
  // the agents setup turned off; any other agent found is on
  agentsOff: z.array(AgentKind).optional(),
  // the agents whose hooks setup installs; absent, every agent found. Read from agentsOff, else from an integrations list
  integrations: z.array(AgentKind).optional(),
  // which plan a scribe pass spends; absent, the main agent's. model names a model of scribe.agent's CLI, else of claude's
  scribe: z.object({ agent: AgentKind.optional(), model: z.string().optional() }).prefault({}),
  mobile: z.object({
    // the tailnet logins that may drive the fleet and get its pushes; empty lets in only the Mac's own login
    logins: z.array(z.string()).default([]),
    // page origins allowed to open a socket, beyond the one svalld itself served
    origins: z.array(z.string()).default([]),
    // who a push service may contact about this sender: Apple refuses a push without one; unset, the served page
    pushContact: z.string().regex(/^(https:\/\/|mailto:)./, 'an https: url or mailto: address').optional(),
    // the https port this fleet is reached on, which svalld saves once it serves there
    httpsPort: z.number().int().min(1).max(65535).optional(),
  }).prefault({}),
});
export type Config = z.infer<typeof Config>;

export const scribeModel = (s: Config['scribe'], agent: AgentKind): string | undefined =>
  ((s.agent ?? 'claude') === agent ? s.model : undefined);

export class InvalidConfig extends Error {}

// an integrations list in config.json leaves any agent but these on
const LISTED: AgentKind[] = ['claude', 'codex'];

/** The main agent of the fleet at `home`, whose own config names `own`: absent, the private fleet's, which setup switches
 *  when the user turns one off. */
export function fleetMainAgent(home: string, own: AgentKind | undefined): AgentKind | undefined {
  if (own || profileOf(home) === PRIVATE) return own;
  // a private config that does not parse is the private fleet's to report
  try { return loadConfig(resolvePaths(profileHome(PRIVATE)).config).mainAgent; } catch { return undefined; }
}

export function loadConfig(file: string): Config {
  if (!fs.existsSync(file)) return Config.parse({});
  return parseConfig(fs.readFileSync(file, 'utf8'), file);
}

/** The config `text` holds; throws an InvalidConfig that says, on one line, what in `file` is wrong. */
export function parseConfig(text: string, file: string): Config {
  try {
    const c = Config.parse(JSON.parse(text));
    const integrations = c.agentsOff ? AgentKind.options.filter((k) => !c.agentsOff!.includes(k))
      : c.integrations && AgentKind.options.filter((k) => c.integrations!.includes(k) || !LISTED.includes(k));
    return { ...c, integrations };
  } catch (err) {
    const why = err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join('.') || 'the whole file'}: ${i.message}`).join('; ')
      : (err as Error).message;
    throw new InvalidConfig(`invalid config ${file}: ${why}`);
  }
}

/** The phone ports the fleets at `homes` keep in their config.json. */
export const keptPorts = (homes: string[]): number[] => homes.flatMap((h) => {
  try { const p = loadConfig(resolvePaths(h).config).mobile.httpsPort; return p ? [p] : []; } catch { return []; }
});

/** Sets the keys of `patch` in `file` and keeps every other key; a file that does not parse is refused, not replaced.
 *  A linked file (stow, home-manager) is written where it points, with the mode it had. */
export function saveConfig(file: string, patch: Partial<Pick<Config, 'mainAgent' | 'name' | 'integrations' | 'defaultCwd'>> & { mobile?: Pick<Config['mobile'], 'httpsPort'> }): void {
  const there = fs.existsSync(file);
  const text = there ? fs.readFileSync(file, 'utf8') : '{}';
  parseConfig(text, file);
  const real = there ? fs.realpathSync(file) : file;
  const mode = there ? fs.statSync(real).mode & 0o777 : undefined;
  const { integrations, ...rest } = patch;
  const json = JSON.parse(text) as { mobile?: object; integrations?: unknown };
  // integrations are saved as agentsOff, which replaces an integrations list
  if (integrations) delete json.integrations;
  const off = integrations && { agentsOff: AgentKind.options.filter((k) => !integrations.includes(k)) };
  // mobile is merged a level down, so a saved port keeps the logins beside it
  const next = { ...json, ...rest, ...off, ...(patch.mobile && { mobile: { ...json.mobile, ...patch.mobile } }) };
  writeAtomic(real, JSON.stringify(next, null, 2) + '\n', { mode, perProcess: true });
  // the umask narrows the mode a file is created with
  if (mode !== undefined) fs.chmodSync(real, mode);
}
