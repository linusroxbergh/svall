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
// daemons probe the agent CLIs and panes type their resumes: these answer a supported release, logged in, and fail
// any resume as the real ones fail a session they do not hold
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
case "$1" in --version) echo '2.1.283 (Claude Code)'; exit 0 ;; auth) echo '{"loggedIn":true}'; exit 0 ;; esac
for a; do [ "$prev" = --resume ] && { echo "No conversation found with session ID: $a" >&2; exit 1; }; prev=$a; done
echo 'claude is a test double' >&2
exit 1
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
case "$1" in --version) echo 'codex-cli 0.156.1'; exit 0 ;; login) echo 'Logged in using ChatGPT'; exit 0 ;; esac
if [ "$1" = resume ]; then for a; do id=$a; done; echo "no rollout found for thread id $id" >&2; exit 1; fi
echo 'codex is a test double' >&2
exit 1
`, { mode: 0o755 });

process.env.HOME = home;
process.env.PATH = `${bin}:${process.env.PATH}`;
for (const k of ['ARCHI_HOME', 'ARCHI_RELEASE_ROOT', 'ARCHI_CHAR_ID', 'ARCHI_TERM', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TMUX', 'TMUX_PANE']) delete process.env[k];

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
