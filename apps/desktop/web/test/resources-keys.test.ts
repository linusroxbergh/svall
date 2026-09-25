import { describe, expect, it } from 'vitest';
import { step } from '../src/resources/keys.js';

// tree, list
const COUNTS = [6, 4];
const at = (col: number, row: number) => ({ col, row });

describe('step', () => {
  it('walks a column, stopping at both ends', () => {
    expect(step(at(0, 3), COUNTS, 'ArrowDown')).toEqual(at(0, 4));
    expect(step(at(0, 3), COUNTS, 'ArrowUp')).toEqual(at(0, 2));
    expect(step(at(0, 5), COUNTS, 'ArrowDown')).toBeUndefined();
    expect(step(at(0, 0), COUNTS, 'ArrowUp')).toBeUndefined();
  });
  it('starts on the first row when nothing in the column holds the keys', () => {
    expect(step(at(1, -1), COUNTS, 'ArrowDown')).toEqual(at(1, 0));
    expect(step(at(1, -1), COUNTS, 'ArrowUp')).toBeUndefined();
  });
  it('steps sideways, leaving the row to the column it lands in', () => {
    expect(step(at(0, 3), COUNTS, 'ArrowRight')).toEqual(at(1, -1));
    expect(step(at(1, 3), COUNTS, 'ArrowLeft')).toEqual(at(0, -1));
  });
  it('has nothing to the left of the tree, and the editor past the list', () => {
    expect(step(at(0, 2), COUNTS, 'ArrowLeft')).toBeUndefined();
    expect(step(at(1, 2), COUNTS, 'ArrowRight')).toBe('editor');
  });
  it('skips an empty list to the editor, and stays put when the column behind is empty', () => {
    expect(step(at(0, 2), [6, 0], 'ArrowRight')).toBe('editor');
    expect(step(at(1, 2), [0, 4], 'ArrowLeft')).toBeUndefined();
    expect(step(at(1, -1), [6, 0], 'ArrowDown')).toBeUndefined();
  });
});
