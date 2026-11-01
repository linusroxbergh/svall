import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { setupPath, startupFile } from '../src/setup-path.js';
import { setSvallPermissions } from '../src/svall-permissions.js';
import { withAddDirs } from '../src/context/launch.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

it('writes PATH through a symlink once and removes only its block', () => {
  const home = makeHome();
  const real = path.join(home, 'dotfiles');
  const rc = path.join(home, '.zshrc');
  fs.writeFileSync(real, 'export OTHER=kept\n', { mode: 0o640 });
  fs.symlinkSync(real, rc);
  expect(startupFile(home, '/bin/zsh')).toBe(fs.realpathSync(real));
  setupPath(rc, path.join(home, '.local/bin'));
  expect(setupPath(rc, path.join(home, '.local/bin'))).toEqual([]);
  expect(fs.lstatSync(rc).isSymbolicLink()).toBe(true);
  expect(fs.statSync(real).mode & 0o777).toBe(0o640);
  setupPath(rc, '', false, true);
  expect(fs.readFileSync(real, 'utf8')).toBe('export OTHER=kept\n');
});

it('chooses bash, fish and custom zsh startup paths, leaving other shells manual', () => {
  expect(startupFile('/u', '/bin/bash')).toBe('/u/.bash_profile');
  expect(startupFile('/u', '/bin/fish')).toBe('/u/.config/fish/conf.d/svall.fish');
  expect(startupFile('/u', '/bin/zsh', '/dot')).toBe('/dot/.zshrc');
  expect(startupFile('/u', '/bin/sh')).toBeUndefined();
  const home = makeHome();
  const file = path.join(home, 'svall.fish');
  setupPath(file, '/u/bin', true);
  expect(fs.readFileSync(file, 'utf8')).toContain("fish_add_path --path '/u/bin'");
});

it('adds only selected-agent rules, and removing them preserves pre-existing rules', () => {
  const home = makeHome();
  const claude = path.join(home, 'claude/settings.json');
  const codex = path.join(home, 'codex');
  fs.mkdirSync(path.dirname(claude));
  const original = { permissions: { allow: ['Bash(svall status:*)', 'Read(*)'], deny: ['Write(*)'] }, theme: 'dark' };
  fs.writeFileSync(claude, JSON.stringify(original));
  setSvallPermissions(claude, codex, true, ['claude']);
  expect(fs.existsSync(codex)).toBe(false);
  setSvallPermissions(claude, codex, true, ['claude', 'codex']);
  const rules = path.join(codex, 'rules/svall.rules');
  expect(fs.readFileSync(rules, 'utf8')).toContain('["svall","robot","new"]');
  setSvallPermissions(claude, codex, false, []);
  expect(JSON.parse(fs.readFileSync(claude, 'utf8'))).toEqual(original);
  expect(fs.existsSync(rules)).toBe(false);
});

it('refuses to replace a Codex rules file the user owns', () => {
  const home = makeHome();
  fs.mkdirSync(path.join(home, 'rules'));
  fs.writeFileSync(path.join(home, 'rules/svall.rules'), '# mine\n');
  expect(() => setSvallPermissions(path.join(home, 'settings.json'), home, true, ['codex'])).toThrow('not managed by Svall');
  expect(fs.readFileSync(path.join(home, 'rules/svall.rules'), 'utf8')).toBe('# mine\n');
});

it('keeps svall command permissions alongside OpenCode context folder access', () => {
  const command = withAddDirs('opencode', [{ kind: 'folder', ref: '/project', label: '', source: 'manual' }], true);
  expect(command).toContain('external_directory');
  expect(command).toContain('svall robot new *');
  expect(withAddDirs('opencode', [{ kind: 'folder', ref: '/project', label: '', source: 'manual' }])).not.toContain('svall robot');
});

it('writes a dangling startup-file symlink at its intended target', () => {
  const home = makeHome();
  const rc = path.join(home, '.zshrc');
  const target = path.join(home, 'dotfiles/zshrc');
  fs.symlinkSync('dotfiles/zshrc', rc);
  setupPath(rc, '/u/bin');
  expect(fs.lstatSync(rc).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toContain('Svall PATH');
});
