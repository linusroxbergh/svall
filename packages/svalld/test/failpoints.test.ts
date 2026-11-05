import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { armHomeFailpoints, homePoint } from '../src/failpoints.js';
import { cleanHomes, makeHome } from './helpers.js';

const [home0, faults0] = [process.env.SVALL_HOME, process.env.SVALL_HOME_FAULTS];
afterEach(() => {
  vi.restoreAllMocks();
  cleanHomes();
  for (const [k, v] of [['SVALL_HOME', home0], ['SVALL_HOME_FAULTS', faults0]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('a home move\'s fault file', () => {
  const armed = () => {
    const home = makeHome();
    process.env.SVALL_HOME = home;
    const file = path.join(home, 'home-fault');
    fs.writeFileSync(file, 'adopt.file\n');
    return { file, kill: vi.spyOn(process, 'kill').mockReturnValue(true) };
  };

  it('kills nothing without the integration image\'s switch, whoever could write it', () => {
    delete process.env.SVALL_HOME_FAULTS;
    const { file, kill } = armed();
    homePoint('adopt.file');
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('with the switch, dies once at the point it names', () => {
    process.env.SVALL_HOME_FAULTS = '1';
    const { file, kill } = armed();
    homePoint('adopt.dropped');
    expect(kill).not.toHaveBeenCalled();
    homePoint('adopt.file');
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('with a second point after the first, that one waits its turn', () => {
    process.env.SVALL_HOME_FAULTS = '1';
    const { file, kill } = armed();
    fs.writeFileSync(file, 'adopt.dropped\nrestore.file\n');
    homePoint('restore.file');
    expect(kill).not.toHaveBeenCalled();
    homePoint('adopt.dropped');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('restore.file\n');
    homePoint('restore.file');
    expect(kill).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a test\'s hook falls first, with no switch', () => {
    delete process.env.SVALL_HOME_FAULTS;
    const seen: string[] = [];
    const disarm = armHomeFailpoints((n) => seen.push(n));
    homePoint('join.done');
    disarm();
    expect(seen).toEqual(['join.done']);
  });
});
