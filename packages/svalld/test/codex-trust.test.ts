import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { askCodexTrust, ourTrust, recordedTrust } from '../src/codex/trust.js';

const SCRIPT = '/u/.svall/hooks/agent-hook.mjs';
const hook = (command: string, trustStatus: string) => ({ command, trustStatus, sourcePath: '/u/.codex/hooks.json' });
const ours = (s: string) => hook(`[ -z "$SVALL_CHAR_ID" ] || { node '${SCRIPT}' codex "$PPID"; }`, s);

describe('ourTrust', () => {
  it('counts only Svall hooks', () => {
    const res = { data: [{ cwd: '/u/.codex', hooks: [ours('trusted'), ours('untrusted'), hook('other.sh', 'untrusted')] }] };
    expect(ourTrust(res, SCRIPT)).toEqual({ trusted: 1, untrusted: 1 });
  });
  it('cannot tell when none of ours is listed, or the shape is unknown', () => {
    expect(ourTrust({ data: [{ cwd: '/u/.codex', hooks: [hook('other.sh', 'trusted')] }] }, SCRIPT)).toBeUndefined();
    expect(ourTrust({ nope: true }, SCRIPT)).toBeUndefined();
    expect(ourTrust(undefined, SCRIPT)).toBeUndefined();
    expect(ourTrust({ data: [null, { hooks: [null] }] }, SCRIPT)).toBeUndefined();
  });
});

describe('recordedTrust', () => {
  it("counts Svall's hooks by the trust records config.toml keeps for their place in hooks.json, without running codex", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-trust-'));
    const file = path.join(codexHome, 'hooks.json');
    const command = ours('').command;
    fs.writeFileSync(file, JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }, { hooks: [{ type: 'command', command }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }],
    } }));
    expect(recordedTrust(codexHome, SCRIPT)).toEqual({ trusted: 0, untrusted: 2 });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `[hooks.state."${file}:session_start:1:0"]\ntrusted_hash = "sha256:a"\n\n[hooks.state."${file}:user_prompt_submit:1:0"]\ntrusted_hash = "sha256:b"\n`);
    expect(recordedTrust(codexHome, SCRIPT)).toEqual({ trusted: 1, untrusted: 1 });
    expect(recordedTrust(codexHome, '/other/.svall/hooks/agent-hook.mjs')).toBeUndefined();
    for (const odd of ['{', '{"hooks":{"Stop":[{"hooks":{}}]}}', '{"hooks":{"Stop":{}}}']) {
      fs.writeFileSync(file, odd);
      expect(recordedTrust(codexHome, SCRIPT)).toBeUndefined();
    }
  });
});

// a codex whose app-server answers initialize, then runs `answer` for hooks/list
function fakeCodex(answer: string): { bin: string; codexHome: string } {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'svall-trust-'));
  const bin = path.join(codexHome, 'codex');
  fs.writeFileSync(bin, `#!${process.execPath}
const rl = require('node:readline').createInterface({ input: process.stdin });
console.log(JSON.stringify({ method: 'remoteControl/status/changed', params: {} }));
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
  if (m.id === 2) { ${answer} }
});
`, { mode: 0o755 });
  return { bin, codexHome };
}

describe('askCodexTrust', () => {
  it('asks codex app-server over stdio, whatever chunks its answer comes in', async () => {
    const reply = `${JSON.stringify({ id: 2, result: { data: [{ cwd: '/u/.codex', hooks: [ours('trusted')] }] } })}\n`;
    const f = fakeCodex(`const s = ${JSON.stringify(reply)}; process.stdout.write(s.slice(0, 10)); setTimeout(() => process.stdout.write(s.slice(10)), 20);`);
    expect(await askCodexTrust({ ...f, script: SCRIPT })).toEqual({ trusted: 1, untrusted: 0 });
  });
  it("can't tell from an answer it doesn't know", async () => {
    const f = fakeCodex(`console.log('null'); console.log(JSON.stringify({ id: 2, result: { data: [null, { hooks: [null] }] } }));`);
    expect(await askCodexTrust({ ...f, script: SCRIPT })).toBeUndefined();
  });
  it("can't tell without a codex, or from one that never answers", async () => {
    const f = fakeCodex('');
    expect(await askCodexTrust({ ...f, bin: path.join(f.codexHome, 'missing'), script: SCRIPT })).toBeUndefined();
    expect(await askCodexTrust({ ...f, script: SCRIPT, timeoutMs: 300 })).toBeUndefined();
  });
});
