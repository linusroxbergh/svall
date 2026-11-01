import fs from 'node:fs';
import path from 'node:path';
import { formatJsonSettings, readJsonSettings } from './settings-file.js';
import { editUserFiles, readUserFile, requireWritableUserFile, type UserFileEdit } from './user-file.js';

// Exact command prefixes, shared by the user rules and OpenCode's robot environment.
const SVALL_COMMANDS = [
  'status', ...['robot', 'char'].flatMap((noun) => ['new', 'list', 'read', 'show', 'wait', 'move', 'update', 'send'].map((verb) => `${noun} ${verb}`)),
  ...['list', 'show', 'create', 'update', 'arrange'].map((verb) => `island ${verb}`), 'scribe sweep',
  ...['plan', 'run', 'wait', 'status', 'findings', 'show', 'mark'].map((verb) => `retro ${verb}`),
];
export const opencodeSvallRules = () => SVALL_COMMANDS.flatMap((c) => [`svall ${c}`, `svall ${c} *`].map((resource) => ({ action: 'shell', resource, effect: 'allow' })));
const RULE_MARK = '# Managed by Svall: robot command permissions';
const OWNED = 'svall-permissions.json';

function permissionEdits(settingsPath: string, codexHome: string, enabled: boolean, agents: string[]): UserFileEdit[] {
  const edits: UserFileEdit[] = [];
  const ownership = path.join(path.dirname(settingsPath), OWNED);
  const owned = readUserFile(ownership);
  const added: string[] = owned.text ? JSON.parse(owned.text) : [];
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
      edits.push({ current: readUserFile(settingsPath, 0o644), next: formatJsonSettings(current.text, settings), what: 'Claude Code svall permissions' });
    }
    const ownershipEdit = { current: owned, next: ours.length ? `${JSON.stringify(ours, null, 2)}\n` : undefined, what: 'Claude Code permission ownership', backup: false };
    // Record additions before granting them; remove their record only after revoking them. Both orders survive a crash.
    if (ours.length) edits.unshift(ownershipEdit); else edits.push(ownershipEdit);
  }
  const rules = path.join(codexHome, 'rules/svall.rules');
  const current = readUserFile(rules);
  if (enabled && agents.includes('codex')) {
    const text = `${RULE_MARK}\n${SVALL_COMMANDS.map((c) => `prefix_rule(pattern = ${JSON.stringify(['svall', ...c.split(' ')])}, decision = "allow")`).join('\n')}\n`;
    if (current.text?.trim() && !current.text.startsWith(RULE_MARK)) throw new Error(`${rules} already exists and is not managed by Svall`);
    edits.push({ current, next: text, what: 'Codex svall permissions' });
  } else if (current.text?.startsWith(RULE_MARK)) {
    // Keep a user's dotfile link usable after disabling the rules, as Claude's linked settings stay usable too.
    edits.push({ current, next: fs.lstatSync(rules).isSymbolicLink() ? '' : undefined, what: 'Codex svall permissions' });
  }
  return edits;
}

export function requireSvallPermissions(settingsPath: string, codexHome: string, enabled: boolean, agents: string[]): void {
  for (const { current, next } of permissionEdits(settingsPath, codexHome, enabled, agents)) {
    if (current.text !== next) requireWritableUserFile(current);
  }
}

/** Only rules added by Svall are removed; pre-existing user allows remain theirs. */
export function setSvallPermissions(settingsPath: string, codexHome: string, enabled: boolean, agents: string[]): string[] {
  return editUserFiles(permissionEdits(settingsPath, codexHome, enabled, agents));
}
