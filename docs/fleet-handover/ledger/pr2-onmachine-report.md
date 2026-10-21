# PR #2 on-machine round trip: report

Status: **DONE_WITH_CONCERNS**.

svall PR #2 (`worktree-port-pr-1`) ran on the real machines for the first time, between this Mac and linus-vault, from
two unsigned releases built from `git archive` snapshots: `b31fe003` and `a84bf57d`. The test account is `svall-m4`
on linus-vault and the test HOME on the Mac, both at `/Users/Shared/svall-m4`.

- **Installs.** m4 was added and doctored on `b31fe003`, then upgraded to `a84bf57d`, rolled back and upgraded again.
  Every unit and the fleet daemon ran the expected release each time. A repeat `host add` reported ready.
- **Round trip.** Mac → Linux went complete at generation 1 in 17.0 s; Linux → Mac at generation 2 in 19.0 s; 8/8
  characters `ok` each way. The terminal in a folder of unused repositories blocked with `repository_unused` both ways
  until `--carry-unused`.
- **Real agents.** Claude Code 2.1.296, Codex 0.162.1 and OpenCode 2.0.27 each answered on the Mac, on Linux and back
  on the Mac under one session id. This was the first real OpenCode handover.
- **Compare.** Git (HEAD, branch, status, index, staged and unstaged diffs, stash, worktree list, refs, fsck), files,
  entity docs and browser tabs compare equal both ways. Only expected fields differ.
- **New findings:** two defects and one hazard of the test environment.
  - D1 (Important): a Claude that starts at its trust prompt in a Svall terminal keeps its cursor hidden, so
    `svall char run` holds every prompt for it.
  - D2 (Minor): a repeat `host add` reinstalls and restarts what is already right.
  - R1 from the Archipelago run still holds, and its `incompatible_release` stop is reproduced here.
  - E1 needs the owner before the by-eye pass: the test build cannot be opened safely beside the owner's own Svall.

`S` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-svall/42c25ccc-6965-4cbf-aad4-74347a4f158c/scratchpad/m4`
(scripts in `$S/` and `$S/bin/`, logs in `$S/logs/`, snapshots in `$S/snaps/`). `TH` = `/Users/Shared/svall-m4`.
The environment is described in `pr2-onmachine-env.md`.

Rules kept:
- The product was not changed, nothing was pushed, and PR #2 was not touched.
- sudo on linus-vault ran only to create `svall-m4` and turn its lingering on. `linus`, `archi-m3b` and `tailscale serve`
  were not touched.
- The Mac side ran only under the test HOME, through the wrappers (`env -i`, `--no-launchctl`).
- No credential was printed or logged.
  - The two daemons' tokens: 0 hits (`logs/90-token-grep.log`).
  - `release-scan.mjs --secrets-only` passes over `$S/logs` (76 files), `$S/snaps` (6) and `$S/run` (5).
- `~/.ssh/known_hosts` is unchanged (md5 `1f403c13…`, Sep 14).

| Step | Result |
| --- | --- |
| Build and scan, both releases | PASS: 3 archives each `ok`; protocol 22, stateSchema 9, transferSchema 1, authoritySchema 1, Node 24.21.0, unsigned |
| Mac install `b31fe003`, `host add m4` (first) | PASS: still-to-do list as SMOKE §1 says (linger, Claude and Codex logins) |
| `host enable`, `host doctor` on `b31fe003` | PASS: gateway at generation 0; doctor fails nothing |
| Mac install `a84bf57d`, `host upgrade m4` (u1) | PASS: `ready` in 15 s, both units and the fleet daemon on `a84bf57d` |
| `host upgrade m4 --rollback` (rb1, rb2) | PASS: `ready` in 5 s, both units and the fleet daemon on `b31fe003`; R1 |
| `host upgrade m4` again (u2) | PASS: `ready` in 15 s, all on `a84bf57d` |
| `host add m4` again | PASS: `ready for handover`, gateway mark kept; D2 |
| `repository_unused` | PASS: blocks at Checks both ways, nothing moves; `--carry-unused` carries it |
| Mac → Linux | PASS: complete g1, 17.0 s, 8/8 `ok` |
| Linux → Mac | PASS: complete g2, 19.0 s, 8/8 `ok` |
| Compare | PASS: only expected fields differ (§4) |
| Real turns | PASS: each agent on Mac, Linux, Mac under one session id; D1 on Claude's prompt line |
| Credentials | copied 07:05:18Z, deleted 07:24:53Z, on both machines |
| Environment left | Mac owns at g2, nothing open, no credential copy, `svall-m4` kept; by-eye pass waits on E1 |

## 1. Builds

A subagent built both releases, one after the other, from 06:52:20Z to 06:58:02Z (summary `$S/build-summary.md`, logs
`$S/logs/<id>-NN-<step>.log`).

- **Snapshots.** `git archive <sha>` into `$S/build/<id>/src`, then `git init`, a fetch of that commit from the main
  repository and `git reset --mixed`. `git status` was empty before and after; `git describe --always` read `b31fe00`
  and `a84bf57`.
- **Caches copied in.** `vendor/{ghostty-kit,node,tmux,sparkle}` from the main checkout (kit `332b2aef…-r1`;
  `ghostty-kit.sh current` passed), and `vendor/rsync` from the `port-pr-1` worktree.
- **Release archives.** `scripts/release-build.sh --out $S/rel/<id> --version <id> --url-base
  https://github.com/linusroxbergh/svall/releases/download/<id>`, with `SVALL_RELEASE_KEY` unset. Then
  `release-scan.mjs` by hand over the archives: exit 0 for both.
- **The app.** `SVALL_RELEASE_NAME=<id> pnpm app:build`, which is `release.sh --adhoc` named by commit, without its
  DMG, Finder and smoke steps. Copied to `$S/app.noindex/<id>/Svall.app`; `codesign -v` valid.

| Release | Archive | Bytes | sha256 | Scan |
| --- | --- | --- | --- | --- |
| `b31fe003` | `svall-companion-b31fe003-linux-x64.tar.gz` | 46,388,681 | `81ecae5b8b9c6210…` | ok, 328 files |
| | `svall-companion-b31fe003-linux-arm64.tar.gz` | 46,075,036 | `d41a859ccae92cd1…` | ok, 328 files |
| | `svall-controller-b31fe003-darwin-arm64.tar.gz` | 42,644,519 | `08d9f952663bf9ac…` | ok, 332 files |
| `a84bf57d` | `svall-companion-a84bf57d-linux-x64.tar.gz` | 46,390,416 | `15bc5070a10b3439…` | ok, 328 files |
| | `svall-companion-a84bf57d-linux-arm64.tar.gz` | 46,076,466 | `389e68d11cc31ba0…` | ok, 328 files |
| | `svall-controller-a84bf57d-darwin-arm64.tar.gz` | 42,645,688 | `8d6f0a47ec708f52…` | ok, 332 files |

- **The apps.** CFBundleVersion 799 (`b31fe003`) and 816 (`a84bf57d`). Each carries its own linux-x64 companion:
  `ca66786815d30b82…` (b31fe003) and `80e9e06ba0abddb3…` (a84bf57d). `pnpm app:build` builds that companion
  separately, so its archive differs from release-build's x64 one (tar mtimes), but the unpacked trees are identical
  (`diff -rq`).
- **What the installs used.** The Mac installs, `host add` and `host upgrade` all used the app's own release and
  companion. `host add` took the app's unsigned companion without `--allow-unsigned`, as setup.md says for the one the
  app carries ("checked by its digests alone").
- **Warnings, all benign.** An `.npmrc` variable missing under `env -i`, vite's chunk size, and SwiftPM's sparkle cache.

## 2. Installs, upgrades and the rollback

**The Mac** (`$S/11-install.sh <id>`): the app went into `$TH/Applications`. Its bundled CLI ran `setup --no-launchctl
--agents claude,codex,opencode` under the test HOME, writing the plist, hooks, Codex hooks, OpenCode plugin and shim
there. `$S/mac-daemon-start.sh` started the daemon as the plist would, on 127.0.0.1:47871.
- `b31fe003` installed at 06:56:09Z, `a84bf57d` at 07:00:30Z.
- After the second install, `system.info` read `a84bf57d`, protocol 22, stateSchema 9.

**linus-vault** (`logs/02-create-user.log`, `03-remote-agents.log`, `31-linger.log`):
- `svall-m4` (uid 2001) was created at 06:51:50Z. Its home is `/Users/Shared/svall-m4` (0750), and its
  `authorized_keys` holds only the key made in the test HOME. The Mac reaches it through the test HOME's own ssh-agent.
- Claude Code 2.1.296 (native installer), Codex 0.162.1 and OpenCode 2.0.27 (`opencode.ai/files/bin`, sha256 checked)
  are in its home.
- Lingering was turned on at 06:59:49Z, after the first `host add` had listed it.

Each m4 row below logs both units' pid and argv, `current`, the kept releases, `svall version`, the fleet daemon's
`system.info` and the gateway's record (`$S/units-far.sh`).

| Run | Log | Command | Result | svalld@private | gateway | Kept |
| --- | --- | --- | --- | --- | --- | --- |
| add 1 | `30-host-add-1.log` | `host add m4 --ssh svall-m4@100.117.42.24` (06:59:24Z) | still to do: linger, `claude auth login`, `codex login` + `/hooks`; registry and probe ok | `b31fe003` | `b31fe003` | `b31fe003` |
| enable | `32-host-enable.log` | `host enable m4 --fleet private` | `ready for handover`; record at g0 naming the Mac | 2785556 on `b31fe003` | 2783893 on `b31fe003` | |
| doctor | `33-doctor-b31.log` | `host doctor m4` | no ✗; ! tmux 3.4, claude and codex not signed in, path, gh | | | |
| u1 | `41-upgrade-u1.log` | `host upgrade m4 --json` (07:01:05Z) | `ready`, 15 s: release, upload, install, probe "m4 answers on release a84bf57d" | 2804737 on `a84bf57d` | 2804746 on `a84bf57d` | `a84bf57d b31fe003` |
| rb1 | `42-rollback-rb1.log` | `host upgrade m4 --rollback --json` (07:01:32Z) | `ready`, 5 s: "current -> …/b31fe003; … the private fleet's daemon answers from release b31fe003" | 2806722 on `b31fe003` | 2806731 on `b31fe003` | the same |
| rb2 | `43-rollback-rb2.log` | `host upgrade m4 --rollback b31fe003` (text) | ✓ machine, master, rollback, probe; `ready for handover`, exit 0 | `b31fe003` | `b31fe003` | the same |
| u2 | `44-upgrade-u2.log` | `host upgrade m4 --json` (07:02:17Z) | `ready`, 15 s | 2811977 on `a84bf57d` | 2811986 on `a84bf57d` | the same |
| add 2 | `45-host-add-2.log` | `host add m4 --ssh …` again (07:17:54Z, logins in place) | `ready for handover` in 17 s; every agent logged in; gateway mark kept | 2883792 on `a84bf57d` | 2883802 on `a84bf57d` | the same (D2) |

- **After rb1.** `host doctor m4` fails `release` ("b31fe003, protocol 22; this controller runs a84bf57d").
  `svall handover m4 --json` then stopped at Checks with `incompatible_release` ("the destination runs release
  b31fe003, this machine a84bf57d"), and nothing opened. This is R1 (§6).
- **Two refusals.**
  - `--rollback 0000000`: ✗ rollback "no release at …/releases/0000000 to go back to", exit 1; m4 stayed on `b31fe003`.
  - `--rollback --release x`: "--rollback installs nothing, so it takes no --release or --allow-unsigned".
- **The gateway record** stayed at generation 0, naming the Mac, through every install, upgrade and rollback.
- **Doctor after add 2** (`45-host-add-2.log`). No ✗. ✓ claude, codex and opencode "signed in", ✓ codex hooks, ✓
  release `a84bf57d`. ! tmux 3.4, path and gh.

## 3. The fleet

Built under the test HOME with the release's own CLI (`$S/10-repos.sh`, `20-fleet.sh`, `21-extras.sh`; ids in
`$S/run/ids.sh` and `agents.sh`):

- **Islands.** `m4 repos` (`i_dk0tvc`, file context `$TH/notes/f1.txt`), `m4 agents` (`i_5739iq`) and `m4 shells`
  (`i_5bw6rt`), besides mission control. The scribe is off.
- **Repo alpha.** It has a nested worktree `.wt/feat` (in `info/exclude`), a committed link, a repo `.env`, and a
  partly staged index, unstaged edits, an untracked file and a stash in both checkouts.
- **Repo beta.** It has a sibling worktree `beta-wt1` and `node_modules/` (excluded by default). `beta-unused` (branch
  `unused-br`) is a registered worktree no character uses. Changes and two stash entries are spread over beta and
  `beta-wt1`.
- **`$TH/dev`** holds the repositories `gamma` and `delta`, which no character works in, and the terminal of `dev`.
- **Characters.**
  - Plain shells: `alpha-feat` (`.wt/feat`), `beta-main` (`src/beta`), `dev` (`dev`) and `notes` (`notes`, with the
    file context `work/shell/page.html`).
  - `shell` (`work/shell`) has a second terminal and two browser tabs: `file://$TH/work/shell/page.html` and
    `https://example.com/m4?tab=2`.
  - Real agents: `claude-r` (`c_19dqxb`, Claude in `src/alpha`), `codex-r` (`c_4ec0eg`, Codex in the worktree
    `src/beta-wt1`) and `opencode-r` (`c_z4a88x`, OpenCode in `src/beta`).
- **Entity docs** (`docs.create`): fleet `M4-FLEET-KESTREL`, island `M4-ISLAND-PLOVER`, character beta-main
  `M4-CHARACTER-WREN`, and repo beta `M4-REPO-HERON`.

## 4. The round trip

### Mac → Linux (`logs/70-m2l-a.log`, `71-m2l.log`, `m2l.ndjson`)

- **Without `--carry-unused`** (07:18:58Z): `blocked` at Checks in 3.4 s with `repository_unused` alone. The message:
  "dev's terminal is in /Users/Shared/svall-m4/dev, which holds 2 Git repositories no character works in (delta,
  gamma) …". The Mac kept running its 10 windows, m4 ran only `_keep`, and `handover status` said none open.
- **With it** (07:19:08.7Z): complete at **generation 1** (transaction `2b5cacaa-…`) in **17.0 s**.
  - Preflight: 9 roots, 212 files, 436,343 B and 3 sessions. 0 blockers. Warnings: `claude_trust`, `codex_trust`,
    `env_file`, `symlink_dangling` (alpha's `.wt/feat/link-to-f1`, dangling on the Mac too) and `worktree_unused`
    (beta-unused).
  - Phases: begin +3.2 s, freeze +3.2, transfer +5.9, verify +9.6, prepare +9.6, ready +11.2, commit +11.4,
    activate +11.6, complete +15.6.
  - Characters: 8/8 `ok`. claude-r and codex-r carry the notice that they wait at their "Trust this folder?" prompt.
- **After it** (`logs/72-after-linux.log`, `76-linux-checks.log`):
  - **m4 owns at g1.** It runs 9 windows: `_keep`, the 8 characters and shell's second terminal. Its agents are
    `claude --resume 2d38c2d0-…`, `codex resume --no-daemon -c tui.resume_cwd=session 01a13415-…` and `opencode
    --standalone -s ses_ecbe1aa1…`, with OpenCode's `serve --stdio` child.
  - **Shells.** Each one, and shell's second terminal, printed "Svall restarted this shell after a handover; whatever
    ran here before did not move." in its own folder. `hostname` printed `linus-vault`.
  - **Docs and folders.** The four doc keys are on m4. `dev/gamma`, `dev/delta` and `dev/todo.txt` arrived.
    `beta-unused` did not, as designed.
  - **The Mac is fenced.** It runs no tmux server, and its copy holds each terminal as a `revive`. `svall --host local
    island create x` and `--host local char run` answered "this fleet moved to another machine;
    2b5cacaa-… is committed", exit 1.

### Linux → Mac (`logs/77-l2m-a.log`, `78-l2m.log`, `l2m.ndjson`)

- **Without `--carry-unused`** (07:22:07Z): `blocked` in 7.7 s with `repository_unused` again, and nothing moved. A
  run must choose to carry the folder each time.
- **With it** (07:22:20.9Z): complete at **generation 2** (transaction `af4b51c2-…`) in **19.0 s**.
  - Preflight: 9 roots, 206 files, 482,296 B and 3 sessions. 0 blockers. Warnings: `env_file` and
    `symlink_dangling`.
  - Characters: 8/8 `ok`, with no notice (each folder was trusted on the Mac already).
- **After it** (`logs/79-after-mac.log`):
  - **The Mac owns at g2.** It runs the same 9 windows, with each agent resumed by its own session id.
  - **m4 is fenced.** It runs no tmux server and no agent, and `handover/` is empty.
  - **O6 holds.** `beta-unused` is still registered at `unused-br`, clean, and both stash entries are there.
  - `handover status`: none open anywhere.

### Compares (`$S/cmp.sh`, `logs/cmp-*.txt`)

| Compare | DIFF | What they are |
| --- | --- | --- |
| `b1-before-mac → b2-before-linux` | 52 | beta-unused's folder and registration (not carried); `core.ignorecase`/`core.precomposeunicode` true → false in each repo's config; link mode bits 755 → 777; `node_modules` (excluded); `restedBy`; the Linux turns; `owner.json` g0 → g1; `fleet.json` written with its defaults expanded; Claude's first, turn-less session `723af8ce-…` (9 records, Mac only); and the session of the Codex setup run on m4 |
| `b2-before-linux → b2-after-mac` | 50 | the same in reverse. Mission control's `AGENTS.md` differs by mode only: each daemon rewrites it at start under its own umask, 664 on m4 |
| `b1-before-mac → b2-after-mac` (the round trip) | 27 | link mode bits 755 → 777 (2); `restedBy` on every character and on shell's second terminal (9); each agent's `lastPrompt` (9); `fleet.json` with its defaults expanded; `owner.json` g0 → g2; Claude 35 → 56 records, Codex 16 → 46 records, OpenCode's log 169 → 559 B and Svall's `exports/ses_ecbe1aa1….json` |
| `b2-after-mac → c9-end-mac` (as left) | 7 | the three agents laid dormant (`revive` set, `brief` dropped); Claude +6 records at exit |

- **Every Git field is equal in the round-trip compare**, for `src/alpha`, `src/alpha/.wt/feat`, `src/beta`,
  `src/beta-wt1`, `src/beta-unused`, `dev/gamma` and `dev/delta`: HEAD, branch, `status --porcelain=v2 --branch` with
  untracked files, `ls-files -s`, the staged and unstaged diffs, the stash, the worktree list, refs, config and `fsck`.
- **So are** every file under the carried folders, the entity docs, the agent profiles, the islands and characters
  (names, folders, context, notes, second terminal) and both browser tabs, with the active one.
- **`fleet.json` means the same on both sides.** It keeps `handover.enabled: true` and the gateway. The destination
  writes it with every default spelled out (`home`, `defaultCwd`, `scribe`, `mobile`, `handover.exclude…`), and that
  form comes back to the Mac.

## 5. The agents' turns

Code words: Claude OSPREY, Codex MANGO, OpenCode LYNX. Each turn went through the Mac's `svall`, which routes to the
owner. The exception is Claude's on Linux, typed into its terminal (D1). Each answer below is from the agent's pane
(`logs/5x-*`, `7x-*`, `8x-*`).

| Where (UTC) | Agent | Answer | Session id | Records |
| --- | --- | --- | --- | --- |
| Mac 07:15:43 | claude-r | `OSPREY M4-MAC1` | `2d38c2d0-a6ab-4128-a21e-5193af95ae31` | 35 |
| Mac 07:15:55 | codex-r | `MANGO M4-MAC1` | `01a13415-24aa-70f0-a209-4726f9dc73dd` | 16 |
| Mac 07:16:04 | opencode-r | `LYNX M4-MAC1` | `ses_ecbe1aa12ffeY1NGovvpfW40DK` | log 169 B |
| Linux 07:20:46 | claude-r (typed) | `OSPREY M4-LINUX` | the same | 45 |
| Linux 07:20:58 | codex-r | `MANGO M4-LINUX` | the same | 31 |
| Linux 07:21:08 | opencode-r | `LYNX M4-LINUX` | the same | log 365 B |
| Mac 07:22:55 | claude-r | `OSPREY M4-MAC2` | the same | 56 |
| Mac 07:23:01 | codex-r | `MANGO M4-MAC2` | the same | 46 |
| Mac 07:23:11 | opencode-r | `LYNX M4-MAC2` | the same | log 559 B |

- **Claude.** One transcript on each side, named after the session; every record carries `2d38c2d0-…`.
  - On Linux it resumed at its "Trust this folder?" prompt, with "No, exit" preselected, as `claude_trust` warned.
    The prompt was answered there.
  - Its first launch on the Mac (`723af8ce-…`, no turn) was restarted because of D1. That session stays on the Mac
    and was never carried, since only a character's current session moves.
- **Codex.** One rollout, `rollout-2026-10-13T09-06-03-01a13415-….jsonl`, on both machines; no new rollout was made by
  a resume. On Linux it waited at "Trust this folder?", answered there.
- **OpenCode.** It moved as its export (`$FH/transcripts/opencode/exports/ses_ecbe1aa1….json` on the Mac).
  - Each machine's OpenCode imported it, and the TUI showed every earlier turn on both sides.
  - It asked nothing on either machine.
  - It ran on its default free model "Cat Jam Free" (OpenCode Zen), so the copied OpenAI login was present but not
    used by a turn.
- **Codex's hooks on m4.** `host add` lists trusting Codex's hooks with `/hooks` as still to do. That was done in a
  private tmux on m4 (`$S/rst.sh`), choosing "Trust all and continue", and it made the rollout `01a1341f-…` there.
  - The Linux single binary `codex-x86_64-unknown-linux-musl` refuses to start without its package unless given
    `--no-daemon`. So m4 got the packaged build (`codex-package-x86_64-unknown-linux-musl`, sha256 checked) in the
    standalone installer's layout.
  - Svall itself starts Codex with `--no-daemon`, so the fleet would not have met that refusal.
  - Run by hand, Codex left its own `app-server --managed-daemon` running on m4, holding the login. It was stopped.
- **The rest.** At 07:24:18Z the three agents' windows were closed while the Mac daemon was down (`$S/66-rest-agents.sh`).
  On restart it marked each dormant with its `revive`: `claude --resume 2d38c2d0-…`, `codex resume -c
  tui.resume_cwd=session 01a13415-…` and `opencode -s ses_ecbe1aa1…`. No agent process of the test HOME runs on either
  machine.

## 6. Credentials

- **Copied at 07:05:18Z** (`logs/60-creds-copy.log`), into both test homes, 0600:
  - Claude: the keychain item `Claude Code-credentials`, with 428 minutes left on `expiresAt` (14:13:59Z), into
    `~/.claude/.credentials.json`.
  - Codex: `~/.codex/auth.json` (last refresh 2026-10-07; the access token runs to 2026-10-17).
  - OpenCode: the `openai` row of OpenCode 2's `credential` table, which is where it keeps logins; its token runs to
    2026-10-14. The three MCP rows there (datadog, linear, slack) are integrations, not logins, and were left.
- **Checks.** Both machines held equal copies, and one OpenCode row each. No value was printed: checks compared
  digests and counted rows.
- **Used** from 07:05:18 to 07:24:18Z: the agents' first turns, `host add` again, both handovers and every turn.
- **Deleted at 07:24:53Z** on both machines, after the agents had stopped (`logs/69-creds-delete.log`). No
  `.credentials.json` or `auth.json` is left in either test home's `.claude` or `.codex`, and no `openai` row in either
  OpenCode database.
- **The owner's logins are unchanged.** Claude's `expiresAt` still reads 14:13:59Z, Codex's `auth.json` mtime is Oct 7,
  and OpenCode's row has not been updated. No test account refreshed a login.
- **No keychain.** The Mac test Claude made none under the test HOME.

## 7. Defects and findings (not fixed)

1. **D1, Important: `svall char run` holds every prompt for a Claude that started at its trust prompt in a Svall
   terminal.**
   - **What happened.**
     - claude-r's first launch on the Mac and its resume on m4 both began at "Trust this folder?". After the answer,
       each kept the terminal cursor hidden (`#{cursor_flag}` 0) at an empty prompt line, drawing its own
       reverse-video cursor, for as long as it ran. On m4 that included after a turn.
     - `readComposer` (`packages/svalld/src/agent/composer.ts:12`) reads a hidden cursor as a dialog. So `svall char
       run` answered "queued: it goes in once the prompt line is clear", and the prompt never went in. On the Mac it
       was still held after 5 minutes of idling, typing a key, Escape and a focus-in.
     - It went only when that Claude exited: `svalld.log` reads "1 held prompt(s) for c_19dqxb dropped: the terminal
       or its agent they were sent to is gone".
   - **What worked.** A Claude started without the prompt showed its cursor, and `char run` delivered at once: the
     Mac's second launch, and the resume on the Mac after Linux → Mac.
   - **Private tmux probes.** Three Claudes in a private tmux under the test HOME showed their cursor (flag 1): the
     default config with a trust prompt, the fleet's `tmux.conf`, and Svall's env. So the cause is in how a Svall
     terminal meets Claude's trust prompt. It was not narrowed further, as the logins had been deleted by then.
   - **Why it matters.** Every Claude a handover resumes on a machine where its folder is new starts at that prompt,
     as `claude_trust` warns. From then on, `char run`, `char new --run`, the phone and mission control cannot reach
     it until it restarts. Typing into its terminal works.
2. **D2, Minor: a repeat `host add` reinstalls and restarts what is already right.**
   - With m4 already on `a84bf57d`, `host add m4` again uploaded the same companion and ran `install`. It restarted
     both units: svalld 2811977 → 2883792, gateway 2811986 → 2883802.
   - setup.md says "Adding the same machine again runs every check again and changes nothing that is already right".
   - Nothing was lost: the gateway record, the kept releases and the registry are unchanged. While m4 owns a fleet,
     its daemon restarts under it.
3. **R1 (from the Archipelago run), Minor, still open: a rollback ends "ready for handover" while the machine runs
   another release.**
   - rb1 and rb2 ended `ready` / "ready for handover", exit 0, with m4 on `b31fe003` and the Mac on `a84bf57d`.
   - Doctor then failed `release`, and the next handover stopped with `incompatible_release`. That stop was not
     reproduced in the Archipelago run; it is here.
   - Code: `rollbackHost` (`packages/cli/src/controller/host.ts:578`) has no step comparing the far release with this
     Mac's, and `packages/cli/src/commands/host.ts:64` prints the line for every `ready`.
4. **Minor, cosmetic.**
   - `host add`/`upgrade` print "✓ install ! path …/.local/bin is not on PATH …", a passed step whose detail carries a
     warning (`packages/cli/src/commands/preflight.ts:56`). On Ubuntu, `~/.profile` puts `~/.local/bin` on PATH for
     login shells.
   - In the Mac → Linux stream, each trust notice arrives twice for the same character, 1 ms apart (`m2l.ndjson`
     +15542/+15544).

Notes, not defects:
- **`restedBy` stays** on every character, and on shell's second terminal, after a completed handover.
- **OpenCode's login check passes on an account with no login.** `opencode auth list` answers, and OpenCode's free
  models need none (setup.md says that is the check). So `host add` and doctor cannot tell an OpenCode provider login
  is missing.
- **A bad rollback names the release running** ("m4 runs release b31fe003"), but not the releases kept.

## 8. E1: the by-eye pass needs the owner first

The test fleet is the private fleet of the test HOME. Its app has the owner's bundle id (`io.github.linusroxbergh.svall`)
and its daemon the owner's launchd label (`io.github.linusroxbergh.svall.svalld`), and a launchd label is per user,
not per HOME. Opened against the test HOME while the owner's own Svall runs, the test build would act on the owner's
job:

- **Opening the window starts the daemon by label.** `FleetDaemon.start` (`apps/desktop/mac/Sources/Svall/FleetDaemon.swift:22`)
  runs `launchctl kickstart gui/501/<label>`.
- **Launch-time setup can replace the owner's job.** `setup --if-needed --login-shell`
  (`AppDelegate.swift:83`) rewrites a stale plist through `bootstrapAgent` (`packages/svalld/src/launchd.ts:107`). That
  is `launchctl bootout gui/501 <test plist>`, which unloads whatever job holds the label, then bootstraps the test
  plist in its place.
- **A quit can kill the owner's daemon.** A quit while the fleet runs on m4, or with the page down, calls
  `FleetDaemon.kill`, which is `launchctl kill SIGTERM gui/501/<label>`.

Moving the test plist aside stops those calls, but then the page opens on its setup screen only
(`apps/desktop/web/src/main.tsx:7`), whose Set up does the same.

LaunchServices had also registered the test copy (build 816, above the owner's 636), so `open -a Svall`, the `svall`
launcher or Sparkle could have picked it for the owner. It was unregistered (`lsregister -u`), with the
`Claude Code URL Handler.app` the test Claude made there.

Nothing of the owner's was touched. Their svalld still runs as pid 32586 since Oct 11, its job loaded from their own
plist. No test app was opened in this run.

Two ways on, for the owner to choose (details in `pr2-onmachine-env.md`):
- **(a) Their own Svall stopped for the duration.** Quit Svall, which stops every robot of their fleet, then `launchctl
  bootout` its job and use `$S/open-test-app.sh`. That script refuses while their Svall is open or their job is
  loaded. Afterwards run `$S/close-test-app.sh`, then open `/Applications/Svall.app`. Not run here: it would have
  stopped the fleet this run works in.
- **(b) A named test fleet.** A second fleet in the test HOME, such as `m4` (`~/.svall-m4`, label `…svalld.m4`), made
  m4's gateway and handed over once more. Its launchd calls never reach the owner's job, so their Svall keeps running.
  That is about an hour's work, and a fresh credential window for its agents' first turns.

## 9. End state (`logs/86-rest-agents.log`, `90-*`, `91-*`, `$S/baseline/linus-after.txt`)

- **Ownership.** The Mac owns at **generation 2**, and nothing is frozen. No transaction is open at the gateway, the
  Mac or m4, and `handover status` says none open anywhere.
- **The Mac.**
  - svalld 36262 runs `a84bf57d` on 127.0.0.1:47871, started by `$S/mac-daemon-start.sh`. Its tmux server is 21066,
    with control client 36284.
  - It runs 6 windows: `_keep`, the 5 shells and shell's second terminal. The 3 real agents are dormant with their
    sessions.
  - The test ssh-agent 41834 (`$TH/tmp/agent.sock`) holds the test key.
  - Nothing else runs: no app, ssh master, helper, watcher or agent of the test HOME. No test app is registered with
    LaunchServices.
- **m4.**
  - svalld@private and the gateway run `a84bf57d`, with `b31fe003` kept. The gateway's record is at g2, naming the Mac.
  - There is no tmux server or agent, `handover/` is empty, and linger is on.
  - Its copy of every folder, and OpenCode's copy of the session, stay there as replicas.
- **No credential copy** is on either machine.
- **linus-vault against its before-state** (`$S/linus-diff.sh`):
  - Added: `svall-m4` in passwd, group, linger and loginctl; `/Users/Shared/svall-m4`; svalld's listener
    127.0.0.1:38711; and `/tmp/claude-2001`.
  - `linus`'s units, listeners and home, `tailscale serve` (`/ proxy http://127.0.0.1:8787`) and `archi-m3b` are as
    they were.
  - **`archi-m3b` is still there,** lingering, with `archipelago-archid@private` and `archipelago-gateway` running
    `d0602dc`. Left as the brief says.
- **The owner's Mac** (stat only):
  - `~/.ssh/known_hosts` (md5 `1f403c13…`, Sep 14, 7,796 B), `~/Library/LaunchAgents` (Oct 11) and
    `/Applications/Svall.app` (Oct 11, build 636) are unchanged.
  - Their Svall preferences plist was written at 07:28:55Z by their own running Svall (pids 32331 and 93477). No test
    app was opened.

## Concerns

1. **D1 meets every first resume on a new machine.** Each such resume starts at the trust prompt, so a fleet driven by
   `char run`, robots or the phone stalls on that Claude after its first handover. Its cause is not pinned down.
2. **The by-eye pass cannot start until the owner picks (a) or (b) in §8.** SMOKE §1–§10 were not run, and the test app
   was never opened.
3. **OpenCode's real-provider path is untested.** The copied OpenAI login sat unused because the default model is a
   free OpenCode one.
4. **Only one round trip ran.** No link pull, controller kill, archive, `destination_diverged`, Interrupt or Terminate
   path ran on these releases. Those are SMOKE §5–§9.
5. **Both releases share every schema** (protocol 22, stateSchema 9, authoritySchema 1). A rollback across a schema
   change is still not exercised.
