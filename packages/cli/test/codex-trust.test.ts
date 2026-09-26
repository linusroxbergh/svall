import { describe, expect, it } from 'vitest';
import { ourTrust } from '../src/codex-trust.js';

const SCRIPT = '/u/.archipelago/hooks/agent-hook.mjs';
const hook = (command: string, trustStatus: string) => ({ command, trustStatus, sourcePath: '/u/.codex/hooks.json' });
const ours = (s: string) => hook(`[ -z "$ARCHI_CHAR_ID" ] || { node '${SCRIPT}' codex "$PPID"; }`, s);

describe('ourTrust', () => {
  it('counts only Archipelago hooks', () => {
    const res = { data: [{ cwd: '/u/.codex', hooks: [ours('trusted'), ours('untrusted'), hook('other.sh', 'untrusted')] }] };
    expect(ourTrust(res, SCRIPT)).toEqual({ trusted: 1, untrusted: 1 });
  });
  it('cannot tell when none of ours is listed, or the shape is unknown', () => {
    expect(ourTrust({ data: [{ cwd: '/u/.codex', hooks: [hook('other.sh', 'trusted')] }] }, SCRIPT)).toBeUndefined();
    expect(ourTrust({ nope: true }, SCRIPT)).toBeUndefined();
    expect(ourTrust(undefined, SCRIPT)).toBeUndefined();
  });
});
