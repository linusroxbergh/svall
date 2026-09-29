import { describe, expect, it } from 'vitest';
import { isGeneratedName, randomName } from '../src/names.js';

describe('randomName', () => {
  it('is two lowercase words', () => {
    for (let n = 0; n < 50; n++) expect(randomName()).toMatch(/^[a-z]+ [a-z]+$/);
  });

  it('avoids names already taken', () => {
    const taken = new Set<string>();
    for (let n = 0; n < 200; n++) taken.add(randomName(taken));
    expect(taken.size).toBe(200);
  });

  it('recognises a generated name and nothing else', () => {
    for (let n = 0; n < 20; n++) expect(isGeneratedName(randomName())).toBe(true);
    expect(isGeneratedName('robin review')).toBe(false);
    expect(isGeneratedName('#542 golden heron')).toBe(false);
    expect(isGeneratedName('golden')).toBe(false);
  });
});
