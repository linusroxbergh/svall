import fs from 'node:fs';
import path from 'node:path';
import { configOf } from '../../src/sessions/claude.js';
import { filesIn } from '../../src/placement/docs-sync.js';
import type { MirrorHomes } from '../../src/placement/mirror-state.js';
import { SHIM } from '../../src/profile.js';
import { makeHome } from '../helpers.js';

export const put = (file: string, data: string | Buffer): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

export const read = (file: string): string => fs.readFileSync(file, 'utf8');
export const json = (file: string): any => JSON.parse(read(file));

export function editJson(file: string, edit: (j: any) => void): void {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(j);
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
}

/** Every file the mirror may write in `home`: those under its Claude, Codex and OpenCode folders, and its .claude.json. */
export const mirroredFiles = (home: MirrorHomes): string[] =>
  [...new Set([...[home.claudeDir, home.codexDir, home.opencodeDir].flatMap((d) => filesIn(d).map((f) => path.join(d, f))), home.claudeJson])]
    .filter((f) => fs.existsSync(f)).sort();

export const statsOf = (files: string[]) => files.map((file) => {
  const st = fs.statSync(file);
  return { file, ino: st.ino, mtimeMs: st.mtimeMs };
});

const MAC_HOOKS = { Stop: [{ hooks: [{ type: 'command', command: '/Applications/Svall.app/hook' }] }] };
const MAC_STATUS = { type: 'command', command: '/Applications/Svall.app/status' };

/** A Mac home whose Claude configuration holds what must not travel beside what does. */
export function macHome() {
  const homedir = makeHome();
  const claudeDir = path.join(homedir, '.claude');
  const codexDir = path.join(homedir, '.codex');
  const opencodeDir = path.join(homedir, '.config/opencode');
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
  const acme = path.join(claudeDir, 'plugins/cache/mp/acme/1.0.0');
  const pdf = { mcpServers: { pdf: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/pdf.js'], env: { PDF_KEY: 'pdf_key_1234567890' } } } };
  put(path.join(claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { acme: [{ scope: 'user', installPath: acme, version: '1.0.0' }] } }));
  put(path.join(acme, 'skills/pdf/SKILL.md'), 'pdf\n');
  put(path.join(acme, '.mcp.json'), JSON.stringify(pdf));
  put(path.join(claudeDir, 'plugins/known_marketplaces.json'), JSON.stringify({
    mp: { source: { source: 'git', url: 'https://u:p@git.test/mp.git' }, installLocation: path.join(claudeDir, 'plugins/marketplaces/mp'), lastUpdated: '2026-10-01T00:00:00.000Z' },
  }));
  put(path.join(claudeDir, 'plugins/marketplaces/mp/.claude-plugin/marketplace.json'), JSON.stringify({ name: 'mp', plugins: [{ name: 'acme', source: './acme' }] }));
  put(path.join(claudeDir, 'plugins/marketplaces/mp/acme/.mcp.json'), JSON.stringify(pdf));
  put(path.join(claudeDir, '.credentials.json'), '{"token":"x"}');
  put(path.join(claudeDir, 'projects/-Users-ada-code/s.jsonl'), '{}\n');
  put(path.join(homedir, '.claude.json'), JSON.stringify({
    mcpServers: {
      linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: 'lin_api_1234567890' } },
      remote: { type: 'http', url: 'https://remote.test/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' } },
      chrome: { command: 'npx', args: ['claude-in-chrome-mcp'] },
      empty: { command: 'npx', args: ['-y', 'empty-mcp'], env: { E: '' } },
    },
    projects: {
      [path.join(homedir, 'code/app')]: { mcpServers: { db: { command: path.join(homedir, '.local/bin/db-mcp'), args: ['--db', path.join(homedir, 'code/app/db.sqlite')] } } },
    },
  }));
  put(path.join(codexDir, 'AGENTS.md'), '# codex\n');
  put(path.join(codexDir, 'auth.json'), '{}');
  put(path.join(codexDir, 'config.toml'), [
    'model = "gpt-5"', 'notify = ["/Applications/Svall.app/notify"]', '',
    `[projects.${JSON.stringify(path.join(homedir, 'code/app'))}]`, 'trust_level = "trusted"', '',
    '[hooks.state]', 'command = "/Applications/Svall.app/hook"', '',
    '[desktop]', 'theme = "dark"', '',
    '[marketplaces.mp]', 'url = "https://git.test/mp.git"', '',
    '[plugins.acme]', 'enabled = true', '',
    '[mcp_servers.github]', 'command = "npx"', 'args = ["-y", "github-mcp"]', `cwd = ${JSON.stringify(path.join(homedir, 'code'))}`,
    'env = { GITHUB_TOKEN = "ghp_1234567890abcdef" }', '',
    '[model_providers.acme]', 'name = "Acme"', 'base_url = "https://acme.test/v1"', 'http_headers = { "X-Key" = "acme_key_1234567890" }', '',
  ].join('\n'));
  put(path.join(opencodeDir, 'opencode.jsonc'), [
    '{', '  // the Mac\'s OpenCode', '  "plugin": ["oc-plugin"],', '  "provider": { "openai": { "options": { "apiKey": "sk-oc-1234567890" } } },',
    '  "mcp": { "ctx": { "type": "local", "command": ["bunx", "ctx-mcp"] } }', '}', '',
  ].join('\n'));
  put(path.join(opencodeDir, `plugins/${SHIM}.js`), '// svall here\n');
  put(path.join(opencodeDir, 'plugins/mine.js'), 'export default {}\n');
  put(path.join(homedir, '.agents/skills/lint/SKILL.md'), 'lint\n');
  put(path.join(agentProfiles, 'reviewer.md'), 'a reviewer\n');
  return { homedir, claudeDir, codexDir, agentProfiles, claudeJson: path.join(homedir, '.claude.json'), opencodeDir };
}

export const ACME = 'claude/plugins/cache/mp/acme/1.0.0';
export const marketKey = (mac: ReturnType<typeof macHome>) => `${path.join(mac.claudeDir, 'plugins/marketplaces/mp/acme/.mcp.json')} holds a key`;

export const FAR_HOOKS = { Stop: [{ hooks: [{ type: 'command', command: '/home/ada/.svall/hooks/hook' }] }] };
export const FAR_STATUS = { type: 'command', command: '/home/ada/.svall/hooks/status' };

// a worker's homes: its own settings and Svall's OpenCode plugin, and overrides for the model and CLAUDE.md
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
  put(path.join(far.opencodeDir, `plugins/${SHIM}.js`), '// svall there\n');
  put(path.join(far.overrides, 'claude/settings.json'), JSON.stringify({ model: 'sonnet' }));
  put(path.join(far.overrides, 'claude/CLAUDE.md'), '# this worker\n');
  return far;
}
