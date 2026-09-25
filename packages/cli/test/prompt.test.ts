import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ask } from '../src/prompt.js';

describe('ask', () => {
  it('answers with the line typed', async () => {
    const input = new PassThrough();
    const answer = ask('go? ', input, new PassThrough());
    input.end('y\n');
    await expect(answer).resolves.toBe('y');
  });

  it('answers empty when input ends first', async () => {
    const input = new PassThrough();
    const answer = ask('go? ', input, new PassThrough());
    input.end();
    await expect(answer).resolves.toBe('');
  });
});
