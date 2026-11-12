import { describe, expect, it } from 'vitest';
import { Mutation } from '../src/journal.js';
import { aside, asideLine, checksAgain, CONFIG_WORD, convertLine, keyLabel, keyMask, notNeeded, toTick, wayOn, type SetupRow } from '../src/placement.js';
import { Robot } from '../src/state.js';

const minimalRobot = {
  id: 'c_1', islandId: 'home', cell: { x: 1, y: 1 }, name: 'n', portrait: 'owl', note: '', instructions: '', cwd: '/tmp', context: [], shell: { lastOutputAt: 0 }, unread: false,
};

describe('robot placement', () => {
  it('a robot without machine, placement or moving parses, as every state before 11 wrote it', () => {
    expect(Robot.safeParse({ ...minimalRobot }).success).toBe(true);
  });

  it('keepHere is no longer a field', () => {
    expect(Robot.parse({ ...minimalRobot, keepHere: true })).not.toHaveProperty('keepHere');
  });

  it('a mutation parses with its id, method and snapshot version; a bad id does not', () => {
    expect(Mutation.parse({ id: 'mu_0123456789', method: 'robot.close', params: { id: 'c_1' }, snapshotVersion: 3, at: 1 })).toMatchObject({ id: 'mu_0123456789', method: 'robot.close' });
    expect(Mutation.safeParse({ id: 'x', method: 'robot.close', params: {}, snapshotVersion: 3, at: 1 }).success).toBe(false);
  });

  it('a main checkout left for a worktree of its own names the changed files it keeps, and none when it has none', () => {
    const c = { main: '/Users/ada/code/svall', branch: 'kanban', keep: true as const };
    expect(convertLine({ ...c, changed: 1 })).toBe("it leaves svall's main checkout for a new branch kanban; the checkout keeps its 1 changed file");
    expect(convertLine({ ...c, changed: 0 })).toBe("it leaves svall's main checkout for a new branch kanban");
  });
});

describe('setup rows that stand aside', () => {
  const chrome = { key: 'maconly:claude:chrome', tick: undefined, gap: { name: 'chrome', what: 'runs only on a Mac' } };
  const xcode = { key: 'maconly:claude:xcode', tick: undefined, gap: { name: 'xcode', what: 'runs only on a Mac' } };
  const skip = (on: boolean) => ({ key: 'runtime:adlc', tick: { item: 'runtime:adlc', fields: ['skip'], on, preview: [] }, gap: { name: 'adlc', what: 'd' } });
  const linear = { key: 'claude:mcp:linear', tick: { item: 'claude:mcp:linear', fields: ['env.K'], on: false, preview: [] }, gap: { name: 'linear', what: 'd' } };

  it('a Mac-only row and a program row ticked not needed stand aside; a key row and an unticked program row do not', () => {
    expect([chrome, skip(true), skip(false), linear].map(aside)).toEqual([true, true, false, false]);
    expect([skip(false), linear].map(notNeeded)).toEqual([true, false]);
    // an unticked program row is a way on, as a key to tick is
    expect([skip(false), skip(true)].map(toTick)).toEqual([true, false]);
    expect([skip(false), skip(true), chrome].map(wayOn)).toEqual([true, false, false]);
  });

  it('one line counts them, or names them, by why they stand aside; none for none', () => {
    expect(asideLine([chrome, xcode, skip(true)])).toBe('2 run only on a Mac, and 1 is not needed there');
    expect(asideLine([chrome, xcode, skip(true)], true)).toBe('chrome, xcode run only on a Mac, and adlc is not needed there');
    expect(asideLine([chrome], true)).toBe('chrome runs only on a Mac');
    expect(asideLine([skip(true)])).toBe('1 is not needed there');
    expect(asideLine([linear, skip(false)])).toBeUndefined();
  });
});

describe('keyLabel and keyMask', () => {
  // as the mirror's report words a server's keys, two of them, and an item that travels whole
  const rb: Pick<SetupRow, 'tick' | 'gap'> = { tick: { item: 'claude:mcp:rb', name: 'rb', fields: ['env.RB_API_KEY'], on: false, preview: ['env.RB_API_KEY rb_…90'], ticked: [] } };
  const linear: Pick<SetupRow, 'tick' | 'gap'> = {
    tick: { item: 'claude:mcp:linear', name: 'linear', fields: ['env.LINEAR_API_KEY', 'headers.Authorization'], on: false, preview: ['env.LINEAR_API_KEY lin…90', 'headers.Authorization ••••'], ticked: ['env.LINEAR_API_KEY'] },
    gap: { name: 'linear (codex)', what: 'keys not copied (headers.Authorization)' },
  };
  const whole: Pick<SetupRow, 'tick' | 'gap'> = { tick: { item: 'claude:plugin:adlc', name: 'adlc', fields: ['env', 'command'], on: false, preview: ['env', 'command'] } };

  it('a key by its server and field, env. left out, and its masked value without the field', () => {
    expect(keyLabel(rb)).toBe("rb's RB_API_KEY");
    expect(keyMask(rb)).toBe('rb_…90');
  });

  it('a row of several keys names each, or one alone, by the name its row tells it apart by', () => {
    expect(keyLabel(linear)).toBe("linear (codex)'s LINEAR_API_KEY, headers.Authorization");
    expect(keyLabel(linear, 'env.LINEAR_API_KEY')).toBe("linear (codex)'s LINEAR_API_KEY");
    expect(keyMask(linear)).toBe('lin…90, ••••');
    expect(keyMask(linear, 'headers.Authorization')).toBe('••••');
  });

  it('what travels whole says so, with no mask', () => {
    expect(keyLabel(whole)).toBe('adlc, whole, keys included');
    expect(keyMask(whole)).toBeUndefined();
  });
});

describe('CONFIG_WORD', () => {
  it('names the paths a home move writes anew in a person\'s words', () => {
    expect([CONFIG_WORD.defaultCwd, CONFIG_WORD['home.cwd'], CONFIG_WORD['onboarding.firstProject']]).toEqual(["new robots' folder", "mission control's folder", 'first project folder']);
  });
});

describe('checksAgain', () => {
  it('reads Check again, with the machine named or not, and a note after it, as asking for a check; nothing else does', () => {
    const tick = { item: 'claude:mcp:rb', fields: ['env.RB_API_KEY'], on: false, preview: [] };
    for (const action of ['Check again', 'check studio again', "Check again. studio's own copy is in its backup folder"]) {
      expect([checksAgain({ action }), toTick({ action, tick })]).toEqual([true, false]);
    }
    for (const action of ['Tick to copy, or set RB_API_KEY on studio: svall worker env RB_API_KEY', 'Upgrade studio', undefined]) {
      expect([checksAgain({ action }), toTick({ action, tick })]).toEqual([false, true]);
    }
  });
});
