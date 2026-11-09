import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_PROFILE_MAX, isStarterProfile, listAgentProfiles, readAgentProfile, seedAgentProfiles, STARTER_SHAS } from '../src/agent-profiles.js';
import { sha256Hex } from '../src/hash.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-profiles-')); dirs.push(d); return d; };
const write = (dir: string, name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);

describe('readAgentProfile', () => {
  it('reads the body without its frontmatter, and the description for the picker', () => {
    const dir = tmp();
    write(dir, 'reviewer.md', '---\ndescription: Reviews code\n---\n\nYou are a reviewer.\n');
    expect(readAgentProfile(dir, 'reviewer')).toEqual({ name: 'reviewer', description: 'Reviews code', body: 'You are a reviewer.' });
  });

  it('says why a profile cannot be used', () => {
    const dir = tmp(), outside = tmp();
    write(outside, 'secret.md', 'You are someone else.');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'linked.md'));
    fs.mkdirSync(path.join(dir, 'folder.md'));
    write(dir, 'empty.md', '---\ndescription: nothing yet\n---\n\n');
    write(dir, 'long.md', 'x'.repeat(AGENT_PROFILE_MAX + 1));
    write(dir, 'huge.md', `---\ndescription: ${'y'.repeat(20_000)}\n---\n\nshort`);
    write(dir, 'binary.md', 'a\u0000b');
    expect(readAgentProfile(dir, 'gone')).toEqual({ name: 'gone', error: 'is missing' });
    expect(readAgentProfile(dir, 'linked')).toEqual({ name: 'linked', error: 'is not a plain file' });
    expect(readAgentProfile(dir, 'folder')).toEqual({ name: 'folder', error: 'is not a plain file' });
    expect(readAgentProfile(dir, 'empty')).toEqual({ name: 'empty', error: 'has no text' });
    expect(readAgentProfile(dir, 'long')).toEqual({ name: 'long', error: `is over ${AGENT_PROFILE_MAX} characters` });
    expect(readAgentProfile(dir, 'huge')).toEqual({ name: 'huge', error: `is over ${AGENT_PROFILE_MAX} characters` });
    expect(readAgentProfile(dir, 'binary')).toEqual({ name: 'binary', error: 'is not text' });
  });

  it('takes only a file directly in the folder', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'sub'));
    write(path.join(dir, 'sub'), 'x.md', 'nested');
    write(dir, '.hidden.md', 'hidden');
    for (const name of ['sub/x', '../x', '.hidden', '', 'a\nb']) expect(readAgentProfile(dir, name)).toEqual({ name, error: 'is not a profile name' });
  });
});

describe('listAgentProfiles', () => {
  it('lists the .md files by name, leaving out links and anything else', () => {
    const dir = tmp();
    write(dir, 'b.md', 'B');
    write(dir, 'a.md', 'A');
    write(dir, 'notes.txt', 'no');
    fs.symlinkSync(path.join(dir, 'a.md'), path.join(dir, 'c.md'));
    expect(listAgentProfiles(dir)).toEqual([{ name: 'a', body: 'A' }, { name: 'b', body: 'B' }]);
    expect(listAgentProfiles(path.join(dir, 'none'))).toEqual([]);
  });
});

describe('seedAgentProfiles', () => {
  it('copies the bundled profiles into a fleet that has no folder yet, and leaves one it has alone', () => {
    const dir = path.join(tmp(), 'agent-profiles');
    expect(seedAgentProfiles(dir)).toBe(true);
    expect(listAgentProfiles(dir).map((p) => p.name)).toEqual(['architect', 'debugger', 'explorer', 'island-leader', 'planner', 'reviewer', 'verifier']);
    expect(listAgentProfiles(dir).filter((p) => 'error' in p)).toEqual([]);
    fs.rmSync(path.join(dir, 'reviewer.md'));
    expect(seedAgentProfiles(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'reviewer.md'))).toBe(false);
  });
});

describe('isStarterProfile', () => {
  it('knows every starter this release ships by its bytes', () => {
    const dir = path.join(tmp(), 'agent-profiles');
    seedAgentProfiles(dir);
    for (const name of fs.readdirSync(dir)) expect(isStarterProfile(name, path.join(dir, name))).toBe(true);
  });

  it('reads a profile as a starter by the bytes any release shipped, so one a later release edits reads so on a machine set up before', () => {
    const dir = tmp();
    write(dir, 'reviewer.md', 'You are a reviewer, as an earlier release had it.\n');
    const shipped = { 'reviewer.md': [sha256Hex('You are a reviewer, as an earlier release had it.\n'), ...STARTER_SHAS['reviewer.md']] };
    expect(isStarterProfile('reviewer.md', path.join(dir, 'reviewer.md'), shipped)).toBe(true);
    write(dir, 'reviewer.md', 'You are a reviewer, as a person edited it.\n');
    expect(isStarterProfile('reviewer.md', path.join(dir, 'reviewer.md'), shipped)).toBe(false);
    expect(isStarterProfile('constructor', path.join(dir, 'reviewer.md'), shipped)).toBe(false);
  });
});
