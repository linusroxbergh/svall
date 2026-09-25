import { describe, expect, it } from 'vitest';
import { hooks, mcpServers, plugins } from '../src/resources/parse.js';

describe('mcpServers', () => {
  const servers = {
    pal: { command: '/Users/me/.claude/pal-launcher.sh', env: { OPENAI_API_KEY: 'sk-secret' } },
    npx: { type: 'stdio', command: 'npx -y agentation --token tok-secret', args: ['--key', 'arg-secret'] },
    linear: { type: 'http', url: 'https://mcp.linear.app/mcp?api_key=url-secret', headers: { Authorization: 'Bearer hdr-secret' } },
    odd: { url: 'not a url' },
  };
  it('names the transport and where it runs', () => {
    expect(mcpServers(servers)).toEqual([
      { name: 'pal', detail: 'stdio · pal-launcher.sh', find: '"pal"' },
      { name: 'npx', detail: 'stdio · npx', find: '"npx"' },
      { name: 'linear', detail: 'http · mcp.linear.app', find: '"linear"' },
      { name: 'odd', detail: 'http', find: '"odd"' },
    ]);
  });
  it('lets no secret through', () => {
    expect(JSON.stringify(mcpServers(servers))).not.toMatch(/secret/);
  });
  it('answers nothing for what is not an object', () => {
    expect(mcpServers(undefined)).toEqual([]);
    expect(mcpServers('x')).toEqual([]);
  });
});

describe('hooks', () => {
  it('counts the commands of each event', () => {
    const h = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }, { hooks: [{ type: 'command', command: 'c' }] }], Stop: [{ hooks: [{ type: 'command', command: 'd' }] }], Empty: [] };
    expect(hooks(h)).toEqual([
      { name: 'PreToolUse', detail: '3 commands', find: '"PreToolUse"' },
      { name: 'Stop', detail: '1 command', find: '"Stop"' },
    ]);
  });
  it('answers nothing for what is not an object', () => { expect(hooks(null)).toEqual([]); });
});

describe('plugins', () => {
  it('lists what is installed, off unless enabled', () => {
    const installed = { 'slack@claude-plugins-official': [{ installPath: '/p/slack' }], 'mine@local': [{ installPath: '/p/mine' }], 'bare@x': [] };
    expect(plugins(installed, { 'slack@claude-plugins-official': true, 'mine@local': false })).toEqual([
      { name: 'slack', detail: 'claude-plugins-official', find: '"slack@claude-plugins-official"', path: '/p/slack' },
      { name: 'mine', detail: 'local', off: true, find: '"mine@local"', path: '/p/mine' },
      { name: 'bare', detail: 'x', off: true, find: '"bare@x"' },
    ]);
  });
});
