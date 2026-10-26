import fs from 'node:fs';
import path from 'node:path';
import { configOf } from '../../src/handover/sessions/claude.js';
import { makeHome } from '../helpers.js';

export const put = (file: string, data: string | Buffer): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

const MAC_HOOKS = { Stop: [{ hooks: [{ type: 'command', command: '/Applications/Svall.app/hook' }] }] };
const MAC_STATUS = { type: 'command', command: '/Applications/Svall.app/status' };

// a Mac home: Claude's configuration with what must not travel beside it, Codex's, the shared skills and a profile
export function macHome() {
  const homedir = makeHome();
  const claudeDir = path.join(homedir, '.claude');
  const codexDir = path.join(homedir, '.codex');
  const agentProfiles = path.join(homedir, '.svall/agent-profiles');
  put(path.join(claudeDir, 'CLAUDE.md'), '# how I work\n');
  put(path.join(claudeDir, 'skills/review/SKILL.md'), 'review it\n');
  put(path.join(claudeDir, 'skills/review/.env'), 'TOKEN=secret\n');
  put(path.join(claudeDir, 'rules/style.md'), 'terse\n');
  put(path.join(claudeDir, 'agents/planner.md'), 'plan\n');
  put(path.join(claudeDir, 'commands/ship.md'), 'ship\n');
  put(path.join(claudeDir, 'keybindings.json'), '[]\n');
  put(path.join(claudeDir, 'settings.json'), JSON.stringify({
    model: 'opus', theme: 'dark', hooks: MAC_HOOKS, statusLine: MAC_STATUS,
    scratchDir: path.join(homedir, 'scratch'), sandbox: { workPath: [path.join(homedir, 'code')], cwd: '/opt/shared' },
    env: { ANTHROPIC_API_KEY: 'sk-mac' }, apiKeyHelper: '/Users/ada/bin/key', awsCredentialExport: '/Users/ada/bin/aws', awsAuthRefresh: 'aws sso login', otelHeadersHelper: '/Users/ada/bin/otel',
  }));
  put(path.join(claudeDir, 'plugins/installed_plugins.json'), '{}');
  put(path.join(claudeDir, '.credentials.json'), '{"token":"x"}');
  put(path.join(claudeDir, 'projects/-Users-ada-code/s.jsonl'), '{}\n');
  put(path.join(homedir, '.claude.json'), '{"mcpServers":{}}');
  put(path.join(codexDir, 'AGENTS.md'), '# codex\n');
  put(path.join(codexDir, 'auth.json'), '{}');
  put(path.join(homedir, '.agents/skills/lint/SKILL.md'), 'lint\n');
  put(path.join(agentProfiles, 'reviewer.md'), 'a reviewer\n');
  return { homedir, claudeDir, codexDir, agentProfiles, claudeJson: path.join(homedir, '.claude.json'), opencodeDir: path.join(homedir, '.config/opencode') };
}

export const FAR_HOOKS = { Stop: [{ hooks: [{ type: 'command', command: '/home/ada/.svall/hooks/hook' }] }] };
export const FAR_STATUS = { type: 'command', command: '/home/ada/.svall/hooks/status' };

// a worker's homes: its own settings, and overrides for the model and CLAUDE.md
export function farHome() {
  const homedir = makeHome();
  const claudeDir = path.join(homedir, '.claude');
  const far = {
    homedir, claudeDir, codexDir: path.join(homedir, '.codex'), claudeJson: configOf(claudeDir), opencodeDir: path.join(homedir, '.config/opencode'),
    agentProfiles: path.join(homedir, '.svall/agent-profiles'), overrides: path.join(homedir, '.svall/mirror-overrides'),
  };
  put(path.join(far.claudeDir, 'settings.json'), JSON.stringify({
    model: 'haiku', cleanupPeriodDays: 7, hooks: FAR_HOOKS, statusLine: FAR_STATUS, env: { HTTPS_PROXY: 'http://proxy:3128' }, apiKeyHelper: '/home/ada/bin/key',
  }));
  put(path.join(far.overrides, 'claude/settings.json'), JSON.stringify({ model: 'sonnet' }));
  put(path.join(far.overrides, 'claude/CLAUDE.md'), '# this worker\n');
  return far;
}
