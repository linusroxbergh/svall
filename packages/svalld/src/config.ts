import fs from 'node:fs';
import { z } from 'zod';
import { AgentKind, DEFAULT_CWD, Home, isProfileName } from '@svall/protocol';
import { writeAtomic } from './jsonfile.js';

export const Config = z.object({
  // what the app and `svall <name>` call the fleet; absent, its directory names it
  name: z.string().refine(isProfileName, 'use lowercase letters, digits and dashes, starting with a letter, and no svall command').optional(),
  port: z.number().int().default(47800),
  host: z.string().default('127.0.0.1'),
  shell: z.string().optional(),
  linear: z.object({ workspace: z.string(), teamKeys: z.array(z.string()) }).optional(),
  // with no command, the crew starts the main agent's crewCommand
  home: Home.extend({ command: z.string().optional() }).prefault({}),
  defaultCwd: z.string().default(DEFAULT_CWD),
  // the agent the scribe, mission control's crew and `svall char new --run` use by default; absent, the only one installed, else claude
  mainAgent: AgentKind.optional(),
  // which plan a scribe pass spends; absent, the main agent's. model names a model of scribe.agent's CLI, else of claude's
  scribe: z.object({ agent: AgentKind.optional(), model: z.string().optional() }).prefault({}),
  // phone clients: which tailnet logins may drive the fleet and get its pushes (empty lets in only the Mac's own login),
  // extra page origins allowed to open a socket beyond the one svalld itself served, who a push
  // service may contact about this sender (Apple refuses a push without one; unset, it is the served page), and
  // which of the three https ports tailscale serve offers this fleet is reached on
  mobile: z.object({
    logins: z.array(z.string()).default([]),
    origins: z.array(z.string()).default([]),
    pushContact: z.string().regex(/^(https:\/\/|mailto:)./, 'an https: url or mailto: address').optional(),
    httpsPort: z.union([z.literal(443), z.literal(8443), z.literal(10000)]).optional(),
  }).prefault({}),
});
export type Config = z.infer<typeof Config>;

export const scribeModel = (s: Config['scribe'], agent: AgentKind): string | undefined =>
  ((s.agent ?? 'claude') === agent ? s.model : undefined);

export class InvalidConfig extends Error {}

export function loadConfig(file: string): Config {
  if (!fs.existsSync(file)) return Config.parse({});
  return parseConfig(fs.readFileSync(file, 'utf8'), file);
}

/** The config `text` holds; throws an InvalidConfig that says, on one line, what in `file` is wrong. */
export function parseConfig(text: string, file: string): Config {
  try {
    return Config.parse(JSON.parse(text));
  } catch (err) {
    const why = err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join('.') || 'the whole file'}: ${i.message}`).join('; ')
      : (err as Error).message;
    throw new InvalidConfig(`invalid config ${file}: ${why}`);
  }
}

/** Sets the keys of `patch` in `file` and keeps every other key; a file that does not parse is refused, not replaced.
 *  A linked file (stow, home-manager) is written where it points, with the mode it had. */
export function saveConfig(file: string, patch: Partial<Pick<Config, 'mainAgent' | 'name'>>): void {
  const there = fs.existsSync(file);
  const text = there ? fs.readFileSync(file, 'utf8') : '{}';
  parseConfig(text, file);
  const real = there ? fs.realpathSync(file) : file;
  const mode = there ? fs.statSync(real).mode & 0o777 : undefined;
  writeAtomic(real, JSON.stringify({ ...(JSON.parse(text) as object), ...patch }, null, 2) + '\n', { mode, perProcess: true });
  // the umask narrows the mode a file is created with
  if (mode !== undefined) fs.chmodSync(real, mode);
}
