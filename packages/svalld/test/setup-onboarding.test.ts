import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { pathRecordFile, removeSetupPaths, setupPath, startupFile, writableStartupFile } from '../src/setup-path.js';
import { opencodeSvallRules, setSvallPermissions } from '../src/svall-permissions.js';
import { withAddDirs } from '../src/context/launch.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); cleanHomes(); });

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

it.each(['.bash_profile', '.bash_login', '.profile'])('keeps bash reading its existing %s before, during and after setup', (profile) => {
  const home = fs.realpathSync(makeHome());
  const file = path.join(home, profile);
  fs.writeFileSync(file, 'export SVALL_TEST_PROFILE=kept\n');
  const read = () => execFileSync('/bin/bash', ['-l', '-c', 'printf "%s" "$SVALL_TEST_PROFILE"'], {
    env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8',
  });
  expect(read()).toBe('kept');
  expect(startupFile(home, '/bin/bash')).toBe(file);
  const record = pathRecordFile(home);
  setupPath(file, '/svall/bin', false, false, record);
  expect(read()).toBe('kept');
  removeSetupPaths(home);
  expect(read()).toBe('kept');
  expect(fs.readFileSync(file, 'utf8')).toBe('export SVALL_TEST_PROFILE=kept\n');
});

it('removes a profile it created only while no user content remains', () => {
  const home = fs.realpathSync(makeHome());
  const file = startupFile(home, '/bin/bash')!;
  setupPath(file, '/svall/bin', false, false, pathRecordFile(home));
  removeSetupPaths(home);
  expect(fs.existsSync(file)).toBe(false);
  setupPath(file, '/svall/bin', false, false, pathRecordFile(home));
  fs.appendFileSync(file, 'export USER_SETTING=kept\n');
  removeSetupPaths(home);
  expect(fs.readFileSync(file, 'utf8').trim()).toBe('export USER_SETTING=kept');
});

it('leaves a read-only startup target untouched and offers manual PATH setup', () => {
  const home = fs.realpathSync(makeHome());
  const target = path.join(home, 'dotfile');
  fs.writeFileSync(target, '# managed elsewhere\n', { mode: 0o444 });
  fs.symlinkSync(target, path.join(home, '.zshrc'));
  expect(writableStartupFile(home, '/bin/zsh')).toBeUndefined();
  expect(() => setupPath(target, '/svall/bin')).toThrow('read-only');
  expect(fs.readFileSync(target, 'utf8')).toBe('# managed elsewhere\n');
  expect(fs.readdirSync(home)).toEqual(expect.not.arrayContaining([expect.stringContaining('.bak-')]));
});

it('backs up a changed startup file once and preserves its mode', () => {
  const home = fs.realpathSync(makeHome());
  const file = path.join(home, '.zshrc');
  fs.writeFileSync(file, 'export USER_SETTING=kept\n', { mode: 0o640 });
  setupPath(file, '/svall/bin');
  const backups = () => fs.readdirSync(home).filter((f) => f.startsWith('.zshrc.bak-'));
  expect(backups()).toHaveLength(1);
  expect(fs.readFileSync(path.join(home, backups()[0]), 'utf8')).toBe('export USER_SETTING=kept\n');
  expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  setupPath(file, '/svall/bin');
  expect(backups()).toHaveLength(1);
});

it('installs and removes PATH at the recorded fish XDG config home after the environment changes', () => {
  const home = fs.realpathSync(makeHome());
  const config = path.join(home, 'config-custom');
  const file = startupFile(home, '/bin/fish', undefined, config)!;
  expect(file).toBe(path.join(config, 'fish/conf.d/svall.fish'));
  setupPath(file, '/svall/bin', true, false, pathRecordFile(home));
  expect(fs.readFileSync(file, 'utf8')).toContain('fish_add_path');
  removeSetupPaths(home);
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.existsSync(pathRecordFile(home))).toBe(false);
});

it('validates Codex ownership before adding any Claude permission', () => {
  const home = fs.realpathSync(makeHome());
  const settings = path.join(home, '.claude/settings.json');
  const codex = path.join(home, '.codex');
  fs.mkdirSync(path.dirname(settings));
  fs.mkdirSync(path.join(codex, 'rules'), { recursive: true });
  fs.writeFileSync(settings, '{"theme":"dark"}\n');
  fs.writeFileSync(path.join(codex, 'rules/svall.rules'), '# mine\n');
  expect(() => setSvallPermissions(settings, codex, true, ['claude', 'codex'])).toThrow('not managed by Svall');
  expect(fs.readFileSync(settings, 'utf8')).toBe('{"theme":"dark"}\n');
  expect(fs.existsSync(path.join(home, '.claude/svall-permissions.json'))).toBe(false);
});

it('rolls back Claude permissions and ownership if a later Codex write fails', () => {
  const home = fs.realpathSync(makeHome());
  const settings = path.join(home, '.claude/settings.json');
  const codex = path.join(home, '.codex');
  fs.mkdirSync(path.dirname(settings));
  const original = '{"permissions":{"allow":["Read(*)"]}}\n';
  fs.writeFileSync(settings, original);
  const rename = fs.renameSync;
  let failed = false;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (!failed && to === path.join(codex, 'rules/svall.rules')) { failed = true; throw new Error('disk write failed'); }
    return rename(from, to);
  });
  expect(() => setSvallPermissions(settings, codex, true, ['claude', 'codex'])).toThrow('disk write failed');
  expect(fs.readFileSync(settings, 'utf8')).toBe(original);
  expect(fs.existsSync(path.join(home, '.claude/svall-permissions.json'))).toBe(false);
  expect(fs.existsSync(path.join(codex, 'rules/svall.rules'))).toBe(false);
});

it('persists Claude ownership before granting permissions and retains it until revocation is written', () => {
  const home = fs.realpathSync(makeHome());
  const settings = path.join(home, '.claude/settings.json');
  const ownership = path.join(home, '.claude/svall-permissions.json');
  const rename = fs.renameSync;
  let observed = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === settings) {
      expect(JSON.parse(fs.readFileSync(ownership, 'utf8'))).toContain('Bash(svall robot new:*)');
      observed++;
    }
    return rename(from, to);
  });
  setSvallPermissions(settings, path.join(home, '.codex'), true, ['claude']);
  setSvallPermissions(settings, path.join(home, '.codex'), false, []);
  expect(observed).toBe(2);
  expect(fs.existsSync(ownership)).toBe(false);
});

it('persists a created startup file’s ownership before installing its PATH block', () => {
  const home = fs.realpathSync(makeHome());
  const file = path.join(home, '.bash_profile');
  const record = pathRecordFile(home);
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === file) expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual([{ file, created: true }]);
    return rename(from, to);
  });
  setupPath(file, '/svall/bin', false, false, record);
  removeSetupPaths(home);
  expect(fs.existsSync(file)).toBe(false);
});

it('updates Codex permission rules through a link without breaking it', () => {
  const home = fs.realpathSync(makeHome());
  const settings = path.join(home, 'settings.json');
  setSvallPermissions(settings, home, true, ['codex']);
  const rules = path.join(home, 'rules/svall.rules');
  const target = path.join(home, 'dotfile.rules');
  fs.renameSync(rules, target);
  fs.symlinkSync(target, rules);
  fs.appendFileSync(target, '# outdated managed content\n');
  fs.chmodSync(target, 0o640);
  setSvallPermissions(settings, home, true, ['codex']);
  expect(fs.lstatSync(rules).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).not.toContain('outdated');
  expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  setSvallPermissions(settings, home, false, []);
  expect(fs.lstatSync(rules).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toBe('');
  setSvallPermissions(settings, home, true, ['codex']);
  expect(fs.lstatSync(rules).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toContain('prefix_rule');
});

it('uses OpenCode V2 shell rules to override an ask policy for only the selected commands', () => {
  const rules = [{ action: 'shell', resource: '*', effect: 'ask' }, ...opencodeSvallRules()];
  const decision = (command: string) => rules.filter((r) => r.action === 'shell' && (r.resource === command || (r.resource.endsWith('*') && command.startsWith(r.resource.slice(0, -1)))))
    .at(-1)?.effect;
  expect(decision('svall robot new --name test')).toBe('allow');
  expect(decision('svall robot send c_123 hello')).toBe('allow');
  expect(decision('svall robot wait c_123')).toBe('allow');
  expect(decision('git push')).toBe('ask');
});
