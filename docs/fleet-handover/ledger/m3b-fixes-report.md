# M3b gate fix wave: G1 and m1 report

Branch `experimental-remote-sessions`, from `7bfb1666`. Two commits, one per item:

| Item | Commit | Subject |
| --- | --- | --- |
| m1 | `69b5411b` | A second archid refused for a running home says so on its own stderr and exit code, and leaves the running daemon's log alone |
| G1 | `1a07a72c` | Preflight warns where the destination's Claude will ask to trust a carried folder, and activation keeps a Claude waiting at that prompt up in its window with a notice naming the answer, instead of waiting out its SessionStart |

`$SP` = `/private/tmp/claude-502/-Users-linusroxbergh-linus-laboratory-archipelago--claude-worktrees-fleet-handover-impl/3739c9b8-51d0-4aa6-ac32-19bc0b56eee0/scratchpad`.
- The probe scripts and their logs are in `$SP/g1`.
- The test runs are in `$SP/fix`.

## What the real Claude 2.1.283 does about folder trust

**Setup.**
- The binary was a copy of the owner's `~/.local/share/claude/versions/2.1.283` (sha256 `d8cb1e5c…`, as at the gate).
- It ran in a scratch HOME (`$SP/g1/home`) inside a scratch tmux server, through a link named `claude`.
- Each run used `env -i` with `USER=archiscratch` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to a scratch path. So the keychain service and account Claude looks up exist nowhere, and the owner's `Claude Code-credentials` item was never read or written.
- `claude auth status` there answers `loggedIn: false`.
- A `SessionStart` hook in the scratch `~/.claude/settings.json` wrote to a log, so every run shows whether Claude reached SessionStart.

**The credential exception was not used.** The trust prompt shows logged out, so no credential was copied. The copied binary is deleted, and no scratch Claude process is left.

**How Claude decides.** I read the decision in the binary's bundled JS (`checkHasTrustDialogAccepted` and the walk it calls), then checked it by running each case below:
- **Trusted:** if `projects[K].hasTrustDialogAccepted` is set in its config, where K is the repository's main checkout, or the cwd when there is no repository.
- **Also trusted:** if it is set for the cwd or any folder above it, up to and including the top of the checkout that holds the cwd. Outside any checkout, the walk goes up to `/`.
- **Keys are real paths.** The cwd is the process's physical cwd, whatever `$PWD` says. Keys match exactly, so a key with a trailing slash matches nothing.
- **Which config:**
  - by default, `~/.claude.json`;
  - with `CLAUDE_CONFIG_DIR` set, `$CLAUDE_CONFIG_DIR/.claude.json`, and `~/.claude.json` is ignored;
  - a legacy `<config folder>/.config.json` wins over both whenever it exists.
- **Answering "Yes, I trust this folder"** writes `hasTrustDialogAccepted: true` under K. A worktree subfolder wrote the main checkout's key (`logs-05.txt`).
- **In the home folder** the answer is never saved, but a key set by hand is honoured.
- **What also suppresses the prompt:** `CLAUDE_CODE_SANDBOXED=1` does. `--dangerously-skip-permissions` does not.

| Case (logs-02/03) | Trusted key(s) | cwd | Claude |
| --- | --- | --- | --- |
| none | — | plain/a/b | asks |
| exact | plain/a/b | plain/a/b | resumes |
| exact, `false` | plain/a/b | plain/a/b | asks |
| folder above, no repo | plain | plain/a/b | resumes |
| home above, no repo | ~ | plain/a/b | resumes |
| `/` | / | plain/a/b | resumes |
| only a folder below | plain/a/b | plain/a | asks |
| trailing slash | plain/a/b/ | plain/a/b | asks |
| repo main checkout | repo | repo/sub/deep | resumes |
| folder inside the checkout | repo/sub | repo/sub/deep | resumes |
| folder above the repo | ~ | repo/sub | asks |
| main checkout, worktree | repo | repo/.claude/worktrees/x(/inner) | resumes |
| the worktree itself | repo/.claude/worktrees/x | …/x/inner | resumes |
| between worktree and main | repo/.claude | repo/.claude/worktrees/x | asks |
| worktree, for main | repo/.claude/worktrees/x | repo | asks |
| real path, cwd via a link | plain/a | link/b | resumes |
| link path only | link | link/b | asks |
| `/tmp` spelling of a `/private/tmp` cwd | /tmp/… | plain/a/b | asks |
| `CLAUDE_CONFIG_DIR`, trust only in `~/.claude.json` | | plain/a/b | asks |
| `CLAUDE_CONFIG_DIR`, trust in its `.claude.json` | | plain/a/b | resumes |
| legacy `.config.json` present (both layouts) | | plain/a/b | follows `.config.json` |
| `CLAUDE_CODE_SANDBOXED=1` | — | plain/a/b | resumes |
| `--dangerously-skip-permissions` | — | plain/a/b | asks |

**`claude --resume <id>` in an untrusted folder** (`logs-05.txt`, a real 2.1.280 fixture transcript placed for the cwd):
- The prompt appears after about 2.3 s, with `❯ No, exit` preselected.
- No SessionStart came in the 8 s after.
- After Down and Enter, `SessionStart` came 0.5–0.6 s later with `source: "resume"` and the same session id and transcript, and the earlier turns showed.
- A trusted resume reports SessionStart after about 1.8 s.
- While the prompt waits, `ProcessTable` reads the pane's agent as `claude` (`logs-07-pane.txt`).

**The adapter against the binary.** `claudeAdapter.trusts` was run through tsx on the same scratch config for 15 of the cases, and agreed with the real binary on all 15 (`logs-06-crosscheck.txt`, `mismatches: 0`).

## G1: Claude's folder trust

**Change.**
- `sessions/claude.ts`:
  - `trusts(home, folder)` follows the rule above, reading the config file Claude would read.
  - `configOf` picks it:
    - `<home>/.config.json` if present;
    - else `~/.claude.json` when `home` is the default `~/.claude` (by `claudePaths()`, the daemon's own env, as its probe uses);
    - else `<home>/.claude.json`.
  - `trustAnswer: 'Yes, I trust this folder'`. The adapter interface gains an optional `trustAnswer`, for a CLI whose preselected choice does not go on.
- `ResumeFolder` gains `root?`, the top of the checkout holding the cwd, which bounds the walk. `resumeFolder()` sets `repo` and `root` together whenever the character's repository holds the cwd. Protocol, additive.
- `handover.inspect`'s `untrusted` now names `{ kind, cwd }`, not bare cwds. A Codex and a Claude character in the same folder can answer differently: the new controller test has exactly that.
- Preflight (`cli/src/controller/handover.ts`):
  - `destinationChecks` sends every carried session's folder (kind, cwd, repo, root), not only Codex's.
  - `trustWarnings` replaces `codexTrust`, with one entry per kind. The Codex text is unchanged.
  - New `claude_trust` code (protocol `HandoverIssueCode`), text: `Claude asks whether to trust its folder the first time <name> resumes on <machine>, with "No, exit" preselected; choose "Yes, I trust this folder" in that terminal`.
  - The sheet's hint for `claude_trust` says the same (`apps/desktop/web/src/handover.ts`).
- Activation (`destination.ts` `wakeSlot`):
  - Trust is decided before the wait: `reports = adapter.sessionStartOnResume && trusted`.
  - A Claude whose folder this machine trusts keeps the timed SessionStart wait and its error text.
  - A Claude whose folder it does not trust goes through `settles()`, as Codex does:
    - **up** once `claude` has held its pane for 3 s, or at once if its SessionStart comes first;
    - **failed** if it goes back to its shell, its window closes, or it never comes up within 60 s.
  - Up at the prompt, the row is ok, the window stays, and the notice reads `claude waits at its "Trust this folder?" prompt in bo's terminal; choose "Yes, I trust this folder" there`. Codex keeps `…; answer it there`.
  - The notice travels as Part C's does: journal row, result, events, CLI lines, sheet.
  - Once the row is written the terminal is no longer carried. So the SessionStart Claude sends after the answer goes to the fleet like any resume's, and binds the carried session's pid and transcript.
- Tests that relied on Claude never asking:
  - The shared scene's Claude home now trusts bo's folder (its `.claude.json`), so the existing Claude activation tests keep their SessionStart meaning.
  - `fleet-home.test.ts` lists `.config.json`/`.claude.json` in `claude.ts` as joined onto Claude's config folder, not a fleet home, as it does for Codex's `config.toml`.

**Tests.**
- `sessions.test.ts`, "Claude Code folder trust":
  - The 17-case table above, plus a key marked `false`, a config that does not parse, and no config.
  - The `~/.claude` layout reading `~/.claude.json`, and a legacy `.config.json` winning in either layout.
- `destination.test.ts`:
  - **inspect:** "names each carried folder this machine's Claude would ask to trust… apart from Codex's in the same folder". This covers:
    - a subfolder and a worktree trusted through the main checkout;
    - a plain folder trusted through a parent;
    - a repository under that parent, which is not trusted;
    - Codex in the same subfolder.

    The Codex inspect test now expects `{ kind, cwd }`.
  - **activate:** "counts a resumed Claude up at its trust prompt… without the SessionStart wait":
    - no SessionStart;
    - the activation answers within 5 s of the fake clock;
    - the row is ok with the exact notice, with no `kill c_bo`, the window kept and no `resumeError`;
    - the SessionStart that follows leaves the row as it was, and the terminal is no longer carried.
  - **activate, a guard:** "counts a resumed Claude up by its SessionStart, with no notice, when it comes before the settle…". It passes on HEAD too.
  - **Real tmux:** "keeps a resumed Claude at its trust prompt up in its window, and takes the carried session's SessionStart there once the prompt is answered":
    - a program named `claude` holds the pane;
    - the row is ok with the notice, and `ProcessTable` reads the pane as claude;
    - the real `Fleet`'s `SessionStart`, with pid and transcript, then binds the carried session in that window.
- `cli/test/controller/handover.test.ts`:
  - New: "warns that Claude asks to trust a carried folder with "No, exit" preselected… apart from Codex in the same folder". Once `claude /Users/ada/app` is trusted, only `codex_trust` is left.
  - The Codex test now expects every kind's folder, with `root`, to be asked.
- `apps/desktop/web/test/handover.test.ts`: "warns of the trust question Claude asks, whose preselected answer quits it".

**TDD RED** (`$SP/fix/g1-red-trusts.txt`, `g1-red-full.txt`)
```
× Claude Code folder trust > trusts a folder where Claude 2.1.283 resumes without asking…   TypeError: claudeAdapter.trusts is not a function
× Claude Code folder trust > reads ~/.claude.json for the ~/.claude config folder…           TypeError: claudeAdapter.trusts is not a function
× destination activate > counts a resumed Claude up at its trust prompt…                     AssertionError: expected 70000 to be less than or equal to 5000
× …on real terminals > keeps a resumed Claude at its trust prompt up in its window…          - "notice": StringMatching /Yes, I trust this folder/, - "ok": true, + "ok": false,
× destination inspect > names each carried folder this machine's Codex would ask to trust…   + "/private/tmp/…/home/work/demo", (bare cwds)
× destination inspect > names each carried folder this machine's Claude would ask to trust…  + [ "/private/tmp/…/home/work/app/sub" ] (Claude's repo folder missing)
× preflight > warns that Codex asks to trust a carried folder only where…                    expected [] to deeply equal [ ObjectContaining{…} ]
× preflight > warns that Claude asks to trust a carried folder with "No, exit" preselected…  expected [] to deeply equal [ Array(2) ]
× what each blocker and warning is explained with > warns of the trust question Claude asks…
```
**TDD GREEN** (`$SP/fix/g1-green.txt`): the same 12 tests pass, among them the guard and the Codex activation test. Every `packages/archid/test/handover/` test passes too: 445 passed and 2 skipped (`g1-handover-dir.txt`).

## m1: a refused second archid

**Change.**
- `main.ts`: the refusal is an `AlreadyRunning` error, from both the macOS `O_EXLOCK` lock and the Linux abstract socket.
- `bin.ts`: that refusal writes only `archid is already running for <home>` to the second process's stderr, whether or not it is a TTY, and exits 1. Every other start failure is reported as before.
- The running daemon's log is written by no one else. On Linux the unit's stderr is its own `log/archipelago-archid@….log`. Under launchd no second instance of a label runs.

**Tests.**
- `bin.test.ts`, new: "refuses a second archid for a running home on its own stderr and exit code, and leaves the running one's log alone". A real bin holds the home, and a second bin must exit 1 with exactly that stderr line. The log must not mention the refusal.
- `home-lock.test.ts`: "leaves the running daemon's log as it was, unrotated and with nothing added…" now expects the 6 MiB log byte-identical. It used to expect the refusal appended, which was the defect.

**TDD RED** (`$SP/fix/m1-red.txt`)
```
× refuses a second archid for a running home on its own stderr and exit code, and leaves the running one's log alone
… archid.log: 2026-09-26T20:09:19.457Z error archid failed to start: Error: archid is already running for /tmp/archi-t-edcda5
    at alreadyRunning (…/packages/archid/src/main.ts:57:49)   at lockFile (…/main.ts:71:63) … (10 stack lines)
```
Before that ordering, the first run had failed on stderr: `expected '' to be 'archid is already running for /tmp/…\n'`.

**GREEN** (`$SP/fix/m1-green.txt`): `bin.test.ts` and `home-lock.test.ts` pass, 9/9.

## Verification

At `1a07a72c`, in shells with nvm's Node 24.18.0 first on PATH and `ARCHI_HOME`, `ARCHI_CHAR_ID`, `TMUX` and `TMUX_PANE` unset.
- `pnpm typecheck`: exit 0.
- `pnpm vitest run --project protocol --project archid --project cli --project @archipelago/desktop-web`: exit 0, 190 files passed and 1 skipped, **2966 passed and 5 skipped** (`final-vitest.txt`).

  | Project | Files | Tests |
  | --- | --- | --- |
  | protocol | 10 | 137 |
  | archid | 85 | 1569 passed, 2 skipped |
  | cli | 32 | 543 passed, 3 skipped |
  | web | 64 | 717 |

  The per-project split comes from a second, JSON-reporter run (`final.json`); its cli count of 542 is 543 less the load flake below.
- In that second run, one cli test failed: `transfer.test.ts` "…keeps a dropped link's partial copy…" (`expected 6291456 to be less than 6291456`). The copy finished before the link dropped. It passed 3/3 alone (`transfer-rerun.txt`). Neither the test nor `transfer.ts` is touched.
- Playwright was not run: the only web change is a hint string, covered by the unit test.

## Concerns

1. **Other prompts that also come before SessionStart stall a carried Claude the same way. Neither is in this wave.** Both reproduce on the real binary in a folder Claude trusts:
   - **A project `.mcp.json` server** the destination's config has not approved. Claude opens "New MCP server found in this project: x" with "Continue without using this MCP server" preselected (`logs-08-mcp.txt`).
   - **A resume with `--dangerously-skip-permissions`** on a machine whose Claude has not accepted bypass mode. Claude opens "WARNING: Claude Code running in Bypass Permissions mode" with `❯ No, exit` preselected (`logs-09-bypass.txt`). The gate's `flags` character resumes with that flag.

   Either way the destination waits the 60 s, then leaves the character dormant with "it may have stopped at a prompt; revive it to see", as G1 did. Neither is warned about at preflight.
2. **A second trust question for folders trusted only from above.** A folder trusted only through a folder above it can still be asked. That applies when its key is not the main checkout's or its own, and its project grants permissions: a `permissions.allow` rule or `additionalDirectories` in `.claude/settings.json`, or in an untracked `settings.local.json`.
   - Claude then asks again, with "No, continue without these permissions" preselected. This was verified with a `permissions.allow` rule (`logs-04.txt`).
   - `trusts` counts such a folder trusted, so there is no warning, and activation fails after 60 s as before.
   - Claude's own "Yes" answers write the main checkout's key, which avoids this. It needs a hand-set or inherited parent key.
3. **Walk bound from the manifest.** The walk is bounded by `root` from the character's `repo`. A cwd that lies in a checkout the character's `repo` does not describe is walked to `/`. That could only be a second terminal's cwd in another repository. It may then be called trusted where Claude would stop at that checkout and ask.
4. **Config location from the daemon's env.** Which config is read depends on the daemon's own `CLAUDE_CONFIG_DIR` and `HOME`, the same env its probe uses. A `CLAUDE_CONFIG_DIR` set only inside Claude's settings is followed only through `auth status`'s `configDirectory` differing from `~/.claude`.
5. **Over-warning is possible where Claude does not ask**, for example with `CLAUDE_CODE_SANDBOXED=1` in the agent's env. Only the preflight warning can be wrong: at activation a SessionStart inside the 3 s settle (about 1.8 s measured) counts as `started`, with no notice.
6. **A pane a dead daemon left running Claude** in an untrusted folder counts as up with the notice at once, even if the user answered in between. This is as Part C does for Codex.
7. **Notice wording.** The notice keeps the shared `"Trust this folder?" prompt` wording. Claude's screen reads "Accessing workspace… Quick safety check…", but the answer the notice names, "Yes, I trust this folder", is on it.
8. **Wire change.** `untrusted` changed element type within protocol 17. Releases must match exactly (`incompatible_release`), so only an already-blocked mismatched preflight could misread it.
