import fs from 'node:fs';
import path from 'node:path';
import { afterAll } from 'vitest';

// tests often run inside a live fleet's terminal: keep them off its home, its tmux server and the real gh
const home = fs.mkdtempSync('/tmp/archi-home-');
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "no pull requests found" >&2\nexit 1\n', { mode: 0o755 });
// a daemon looks at its phone link on start; this one answers its version, so the real CLI is never tried
fs.writeFileSync(path.join(bin, 'tailscale'), fs.readFileSync(path.join(import.meta.dirname, '../packages/archid/test/fixtures/bin/tailscale')), { mode: 0o755 });

process.env.HOME = home;
process.env.PATH = `${bin}:${process.env.PATH}`;
for (const k of ['ARCHI_HOME', 'ARCHI_RELEASE_ROOT', 'ARCHI_CHAR_ID', 'ARCHI_TERM', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TMUX', 'TMUX_PANE']) delete process.env[k];

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
