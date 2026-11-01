import fs from 'node:fs';
import path from 'node:path';
import { writeDurable } from './durable.js';
import { readJsonSettings, writeJsonSettings } from './settings-file.js';

// Exact command prefixes, shared by the user rules and OpenCode's robot environment.
export const SVALL_COMMANDS = [
  'status', ...['robot', 'char'].flatMap((noun) => ['new', 'list', 'read', 'show', 'wait', 'move', 'update', 'send'].map((verb) => `${noun} ${verb}`)),
  ...['list', 'show', 'create', 'update', 'arrange'].map((verb) => `island ${verb}`), 'scribe sweep',
  ...['plan', 'run', 'wait', 'status', 'findings', 'show', 'mark'].map((verb) => `retro ${verb}`),
];
export const opencodeSvallRules = () => SVALL_COMMANDS.flatMap((c) => [`svall ${c}`, `svall ${c} *`].map((resource) => ({ action: 'bash', resource, effect: 'allow' })));
const RULE_MARK = '# Managed by Svall: robot command permissions';
const OWNED = 'svall-permissions.json';

/** Only rules added by Svall are removed; pre-existing user allows remain theirs. */
export function setSvallPermissions(settingsPath: string, codexHome: string, enabled: boolean, agents: string[]): string[] {
  const done: string[] = [];
  const ownership = path.join(path.dirname(settingsPath), OWNED);
  let added: string[] = [];
  if (fs.existsSync(ownership)) added = JSON.parse(fs.readFileSync(ownership, 'utf8')) as string[];
  if (agents.includes('claude') || added.length) {
    const current = readJsonSettings(settingsPath);
    const permissions = (current.settings.permissions ?? {}) as Record<string, unknown>;
    const allow = (permissions.allow ?? []) as string[];
    const wanted = enabled && agents.includes('claude') ? SVALL_COMMANDS.map((c) => `Bash(svall ${c}:*)`) : [];
    const next = [...allow.filter((r) => !added.includes(r)), ...wanted.filter((r) => !allow.includes(r) || added.includes(r))];
    const ours = wanted.filter((r) => !allow.includes(r) || added.includes(r));
    if (JSON.stringify(allow) !== JSON.stringify(next)) {
      const p = { ...permissions, ...(next.length ? { allow: next } : {}) };
      if (!next.length) delete p.allow;
      const settings = { ...current.settings, ...(Object.keys(p).length ? { permissions: p } : {}) };
      if (!Object.keys(p).length) delete settings.permissions;
      done.push(...writeJsonSettings(current, settings, 'Claude Code svall permissions'));
    }
    if (ours.length) writeDurable(ownership, ours); else fs.rmSync(ownership, { force: true });
  }
  const rules = path.join(codexHome, 'rules/svall.rules');
  if (enabled && agents.includes('codex')) {
    const text = `${RULE_MARK}\n${SVALL_COMMANDS.map((c) => `prefix_rule(pattern = ${JSON.stringify(['svall', ...c.split(' ')])}, decision = "allow")`).join('\n')}\n`;
    if (fs.existsSync(rules) && !fs.readFileSync(rules, 'utf8').startsWith(RULE_MARK)) throw new Error(`${rules} already exists and is not managed by Svall`);
    fs.mkdirSync(path.dirname(rules), { recursive: true });
    writeDurable(rules, Buffer.from(text), { mode: 0o600 });
    done.push(`Codex svall permissions -> ${rules}`);
  } else if (fs.existsSync(rules) && fs.readFileSync(rules, 'utf8').startsWith(RULE_MARK)) {
    fs.rmSync(rules); done.push(`removed ${rules}`);
  }
  return done;
}
