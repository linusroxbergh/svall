import fs from 'node:fs';
import { z } from 'zod';
import { AgentKind, DEFAULT_CWD, Home } from '@archipelago/protocol';

export const Config = z.object({
  port: z.number().int().default(47800),
  host: z.string().default('127.0.0.1'),
  shell: z.string().optional(),
  linear: z.object({ workspace: z.string(), teamKeys: z.array(z.string()) }).optional(),
  home: Home.prefault({}),
  defaultCwd: z.string().default(DEFAULT_CWD),
  // which plan a scribe pass spends, whatever agent the character it describes runs. Without a model,
  // claude runs sonnet and codex its own default
  scribe: z.object({ agent: AgentKind.default('claude'), model: z.string().optional() }).prefault({}),
  // phone clients: which tailnet logins may drive the fleet and get its pushes (empty lets in only the Mac's own login),
  // extra page origins allowed to open a socket beyond the one archid itself served, who a push
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

export function loadConfig(file: string): Config {
  if (!fs.existsSync(file)) return Config.parse({});
  try {
    return Config.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`invalid config ${file}: ${String(err)}`);
  }
}
