import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rotateLog } from '../src/log.js';
import { cleanHomes, makeHome } from './helpers.js';

afterEach(cleanHomes);

describe('rotateLog', () => {
  it('keeps one previous log once the log passes the cap, emptying it in place', () => {
    const file = path.join(makeHome(), 'svalld.log');
    fs.writeFileSync(file, 'old line\n'.repeat(20));
    const fd = fs.openSync(file, 'a');
    rotateLog(file, 100);
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('old line\n'.repeat(20));
    // a writer that opened the log before the rotation, like launchd's stderr, keeps writing to it
    fs.writeSync(fd, 'after\n');
    fs.closeSync(fd);
    expect(fs.readFileSync(file, 'utf8')).toBe('after\n');
  });

  it('leaves a log under the cap, or a missing one, alone', () => {
    const home = makeHome();
    const file = path.join(home, 'svalld.log');
    rotateLog(file, 100);
    expect(fs.readdirSync(home)).toEqual([]);
    fs.writeFileSync(file, 'short\n');
    rotateLog(file, 100);
    expect(fs.readdirSync(home)).toEqual(['svalld.log']);
  });
});
