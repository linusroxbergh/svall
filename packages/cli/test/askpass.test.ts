import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { askpassPath } from '@svall/svalld/release';
import { interactiveEnv } from '../src/commands/host.js';
import { cleanHomes, makeHome } from '../../svalld/test/helpers.js';

afterEach(cleanHomes);

describe('the first, interactive ssh', () => {
  const env = { PATH: '/usr/bin:/bin' };

  it('asks in a dialog when there is no terminal to ask in, as when the app runs it', () => {
    expect(interactiveEnv({ tty: false, platform: 'darwin', askpass: '/r/bin/svall-askpass', env }))
      .toEqual({ PATH: '/usr/bin:/bin', SSH_ASKPASS: '/r/bin/svall-askpass', SSH_ASKPASS_REQUIRE: 'force' });
  });

  it('asks in the terminal when there is one, and leaves Linux alone', () => {
    expect(interactiveEnv({ tty: true, platform: 'darwin', askpass: '/r/bin/svall-askpass', env })).toEqual(env);
    expect(interactiveEnv({ tty: false, platform: 'linux', askpass: '/r/bin/svall-askpass', env })).toEqual(env);
  });
});

describe('the askpass dialog', () => {
  /** An osascript that records the words it was handed and answers what a user typed. */
  function ask(prompt: string): { answer: string; words: string[] } {
    const dir = makeHome();
    const log = path.join(dir, 'words');
    fs.writeFileSync(path.join(dir, 'osascript'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\necho typed\n`, { mode: 0o755 });
    const answer = execFileSync(askpassPath(), [prompt], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin` } });
    return { answer, words: fs.readFileSync(log, 'utf8').split('\n').slice(0, -1) };
  }

  it('asks for a password with the answer hidden, and hands the prompt over as data', () => {
    const prompt = "linus@h's password: $(touch /tmp/x)";
    const { answer, words } = ask(prompt);
    expect(answer).toBe('typed\n');
    expect(words.join('\n')).toContain('with hidden answer');
    expect(words.at(-1)).toBe(prompt);
    expect(words.slice(0, -1).join('\n')).not.toContain(prompt);
  });

  it('asks about a new host key in the open', () => {
    const { words } = ask('Are you sure you want to continue connecting (yes/no/[fingerprint])? ');
    expect(words.join('\n')).not.toContain('hidden answer');
  });
});
