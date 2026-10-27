import { describe, expect, it } from 'vitest';
import { applyUnified } from '../src/retro/apply.js';

const skill = ['# Review', '', '1. Read the diff.', '2. Check the tests.', '3. Write the findings.', ''].join('\n');
const diff = [
  '--- a/SKILL.md', '+++ b/SKILL.md', '@@ -3,3 +3,4 @@', ' 1. Read the diff.', ' 2. Check the tests.',
  '+   Would each test still pass with the change reverted?', ' 3. Write the findings.',
].join('\n');

describe('applyUnified', () => {
  it('applies a hunk where its header puts it', () => {
    expect(applyUnified(skill, diff, 'SKILL.md')).toBe(skill.replace('2. Check the tests.\n', '2. Check the tests.\n   Would each test still pass with the change reverted?\n'));
  });

  it('fits a hunk moved by a few lines', () => {
    const moved = `intro\nmore\n${skill}`;
    expect(applyUnified(moved, diff, 'SKILL.md')).toContain('Check the tests.\n   Would each test');
  });

  it('refuses a diff whose context changed, and one that is not a diff', () => {
    expect(() => applyUnified(skill.replace('Check the tests', 'Run the tests'), diff, 'SKILL.md')).toThrow('the diff no longer fits SKILL.md');
    expect(() => applyUnified(skill, 'add a line about tests', 'SKILL.md')).toThrow('not a unified diff');
  });

  it('removes lines and keeps a file without a final newline that way', () => {
    const d = ['@@ -1,2 +1,1 @@', ' a', '-b'].join('\n');
    expect(applyUnified('a\nb', d, 'f')).toBe('a');
  });
});
