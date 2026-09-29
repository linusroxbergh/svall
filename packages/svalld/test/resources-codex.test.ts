import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState } from '@svall/protocol';
import { codexPaths } from '../src/codex/install.js';
import { codexSource, resourceRoot, scanResources } from '../src/resources/scan.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

const claude = { dir: '/h/.claude', json: '/h/.claude.json' };

function codexHome() {
  const dir = makeHome();
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  return { dir, write, paths: codexPaths({ CODEX_HOME: dir }) };
}

describe('codexSource', () => {
  it('is nothing when there is no codex on the machine', () => {
    expect(codexSource(codexPaths({ CODEX_HOME: '/nope' }))).toBeUndefined();
  });

  it('lists the instructions, a skill, a prompt, an mcp server, a hook and the settings', () => {
    const { write, paths } = codexHome();
    write('AGENTS.md', '# me');
    write('skills/find-skills/SKILL.md', '---\nname: find-skills\ndescription: finds them\n---\n');
    write('prompts/review.md', 'review this');
    write('config.toml', 'model = "gpt-5.1-codex-max"\n\n[mcp_servers.node_repl]\ncommand = "node_repl"\n');
    write('hooks.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }));
    write('auth.json', '{"tokens":"top-secret"}');
    const s = codexSource(paths)!;
    expect(s).toMatchObject({ name: 'Codex', tier: 'global', root: paths.dir });
    const names = Object.fromEntries(s.groups.map((g) => [g.kind, g.items.map((i) => i.name)]));
    expect(names).toEqual({
      instructions: ['AGENTS.md'], skills: ['find-skills'], commands: ['review'], mcp: ['node_repl'],
      hooks: [expect.stringContaining('Stop')], settings: ['config.toml', 'hooks.json'],
    });
    expect(s.groups.find((g) => g.kind === 'skills')!.items[0].detail).toBe('finds them');
    // the row opens config.toml on the server's own table
    expect(s.groups.find((g) => g.kind === 'mcp')!.items[0].open).toMatchObject({ path: 'config.toml', find: '[mcp_servers.node_repl' });
    expect(JSON.stringify(s)).not.toMatch(/top-secret|auth\.json/);
  });

  it('shows a config.toml that will not parse rather than dropping it', () => {
    const { write, paths } = codexHome();
    write('config.toml', '[[[broken');
    const settings = codexSource(paths)!.groups.find((g) => g.kind === 'settings')!.items;
    expect(settings).toEqual([expect.objectContaining({ name: 'config.toml', error: 'cannot be read as TOML' })]);
  });

  it('follows the claude source in the scan, and its root opens while no other folder of the machine does', () => {
    const { write, paths } = codexHome();
    write('AGENTS.md', '# me');
    const state = emptyState();
    expect(scanResources(state, claude, paths).map((s) => s.name)).toEqual(['Claude', 'Codex']);
    expect(scanResources(state, claude).map((s) => s.name)).toEqual(['Claude']);
    expect(resourceRoot(`r:${paths.dir}`, state, claude, paths)).toBe(paths.dir);
    expect(resourceRoot(`r:${paths.dir}`, state, claude)).toBeUndefined();
    expect(resourceRoot(`r:${path.dirname(paths.dir)}`, state, claude, paths)).toBeUndefined();
  });
});
