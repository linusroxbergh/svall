# PR #2 remote sessions: analysis at tip 4c11f026 (2026-10-20)

Five read-only sub-agent reports, each verified on a sample of claims by the orchestrator. Paths are
relative to the PR worktree unless marked ER (fleet-handover-impl). file:line cites are at 4c11f026; the
branch has since merged main (5eec82f4, protocol 24), so lines may shift slightly.

Orchestrator verifications:
- CONFIRMED: keep-awake holds nothing during a handover (web/src/awake.ts:58 needs status online + local + working agents).
- CONFIRMED: `fleet recover --force-owner local` is refused when the gateway is unreachable unless `--gateway <other>` (cmd/fleet-recover.ts:225); Mac cannot be a gateway; handover.md:244 overpromises.
- CONFIRMED: protocol 23 on both main and tip (now resolved: 24 on the PR branch).
- CONFIRMED: ER ledger had 38 untracked files; now committed on origin/handover-ledger (57cf4c54).
- CONFIRMED: 70fbc0f7 calls `await ctx.tool.transform(...)` unguarded; floor is OpenCode 2.0.22, API arrived 2.0.27.
- OVERSTATED (error-map C3): "Terminate and carry at Checks is a dead end". `shell_busy` is raised only in the rest phase (rest.ts:169-175), where the run asks and the app answers over attach stdin with the named characters. Dropping the list from start argv is by design (Handover.swift:45 comment, HandoverTests.swift:121-124). Not a bug.
- SOFTENED (arch R5): the connect helper does no SSH for a fleet with no gateway (connection.ts:279 returns LOCAL) and Swift falls back on helper exit/start failure; what stands is Node spawn per window and no timeout on a hung helper.

---
# Report 1: State, remaining work, verification gaps

Bottom line. Most of what the README listed as owed is still open. The two exceptions are the real-machine round trip after the fix wave (done) and the by-eye pass (started 10-20, not finished or recorded). Almost every deferred follow-up is still in the code.

Short codes: ER = fleet-handover-impl worktree (ledger now also on origin/handover-ledger). PL n = ledger/progress.md line n. DF §x = docs/fleet-handover/deferred.md at a84bf57d (`git show a84bf57d:…`), the merged list of every review's open findings, now the 4 "review follow-ups" cards on the MinimalPlans board "svall remote machines" (ktgz9BuiAz). TR = final-review-triage.md row. FR = final-review.md:52-57. Kit = /Users/Shared/svall-m4/kit.

## 1. The 7 items the README listed as owed

| Item | State | Evidence |
|---|---|---|
| By-eye pass in the built app | Partly | Never recorded as done (PL 765, PL 1089). Board card unticked. 10-20 session: test app ran; Kit/STEPS.md rewritten; Mac→Linux (generation 3) on ed3dda15; Linux→Mac (generation 4) on 4c11f026 with claude-r, codex-r, opencode-r all ok. The 7 commits after ed3dda15 are its findings. No written findings. SMOKE.md §5–9 (blockers, divergence, network, kill and relaunch, ssh-drop re-attach) have no evidence. |
| Real-machine round trip after fix wave | Done | pr2-onmachine-report.md:9-17 (a84bf57d): Mac→Linux 17.0 s, Linux→Mac 19.0 s, Claude 2.1.296, Codex 0.162.1, OpenCode 2.0.27. |
| Release signing key | Not done | scripts/release/allowed_signers holds only a comment. |
| CI | Not done | ci.yml workflow_dispatch only; release.yml on v* tags; `gh run list` empty. ci.yml has no Playwright step, never sets SVALL_TEST_GNU_TAR. |
| Licence decisions | Not done | docs/security/fleet-handover.md:186-198: GhosttyKit dependency licences, LGPL libintl, Flaticon art. Owner decisions. |
| Published download | Partly | Release builds carry Contents/Resources/release (~100 MB app). Never through a notarized `pnpm release`. No arm64 companion. Svall Dev carries none. |
| Deferred follow-ups | Not done | §2. |

Board "ship PR #2" column adds: scripted Mac⇄Linux handover test (container harness is Linux⇄Linux); test builds beside the owner's Svall (710a9f86 partial); tear down svall-m4.

## 2. Deferred follow-ups, deduplicated

UV = user-visible bug, R = robustness, P = polish.

| # | Item | From | Sev | At the tip |
|---|---|---|---|---|
| 1 | Roots claimed once, then rsync --delete with no recheck: destination edits during copy lost (documented) | DF | UV | open, cli handover.ts:552, transfer.ts:273-286 |
| 2 | Journal rebuilt by adopt() has no landed list: return trip can raise false destination_diverged | PL 927 | UV | open, handover.ts:1016-1019 |
| 3 | Rebuilt committed journal hitting a plain error reports phase begin, offers resume and abort | DF | UV | open, handover.ts:315, :809 |
| 4 | Gateway down and no journal: status says "no handover … open anywhere" | TR 610 | UV | open, recovery.ts:159 |
| 5 | Preflight with only warnings goes straight to Begin; env_file/credential_file scroll past | DF | UV | open, handover.ts:294-300 |
| 6 | Forcing owner to an unfinished handover's destination gives no risk line | TR 516 | UV | open, fleet-recover.ts:150-155 |
| 7 | host enable while daemon runs on a fallback machine id: fleet starts read-only next time | PL 1077 | UV | open, cli host.ts:718, svalld main.ts:115-124 |
| 8 | Two roots differing only by case or Unicode merge on a case-folding destination | DF | UV | open, handover.ts:949-951, probe.ts:20-30 |
| 9 | objects/info/alternates not carried, nothing blocks | DF | UV | open |
| 10 | After destination crash, agent left at trust prompt becomes a plain shell | PL 889 | UV | open, destination.ts:744 |
| 11 | Round trip drops Mac's Codex -p/--profile | TR 677 | UV | open, validate.ts:130, dormancy.ts:156-160 |
| 12 | Idle agent with a child process (hook) is agent_unsettled at once | DF | UV | open, rest.ts:187-188 |
| 13 | Revived Codex quitting before first prompt marked failed resume | PL 889 | UV | open, poll.ts:155-163 |
| 14 | Held (queued) prompt neither holds rest nor travels; dropped silently | PL 1050 | UV | open, prompts.ts:219-221 |
| 15 | ctrl+z job beside a working agent reported only after the turn ends | PL 1101 | UV | open, rest.ts:176-194 |
| 16 | host upgrade --rollback reports "ready for handover" while far machine older; next handover hits incompatible_release | PL 906, 1089 | UV | open, host.ts:594-602, commands/host.ts:63 |
| 17 | Stopping Add Machine leaves its interactive ssh and askpass running | TR 284 | UV | open, commands/host.ts:30 |
| 18 | svall agent reads/sets local copy of a fleet another machine owns | DF | UV | open, commands/agent.ts:24 |
| 19 | Reserved-name mv advice neither stops fleet nor unloads old launchd agent; uninstall skips those homes (flag off too) | PL 903 | UV | open, setup.ts:210, uninstall.ts:248 |
| 20 | Flag off: setup/doctor warn about Claude < 2.1.251 and bundled rsync | DF | UV minor | open, preflight.ts:81-83, doctor.ts:369 |
| 21 | Attach/sheet edge states: handover_committed sticky error; frozen attach blank pane; detached result "Resting…" no badge; relaunched sheet "the other machine" no Try again; failed second terminal shows "resumed"; late preflight block no badge | TR 509 | UV | open, terminals.ts:16/:104, web handover.ts:252/:444, HandoverSheet.tsx:69, store/handover.ts:67 |
| 22 | handover attach exits 0 mid-run; "Check again" skips onMoved; launch during another run dropped (sheet stuck "Starting…") | TR 509 | UV | open, cli handover.ts:487-491, Handover.swift:126/:166 |
| 23 | Keep awake holds nothing during a handover | PL 1055 | UV | open, awake.ts:58 |
| 24 | Remote fleet online but svalld never answers: "Starting the fleet…" forever | PL 1037 | UV | open, App.tsx:72-75 |
| 25 | No gateway + unusable ~/.config/svall: banner says this Mac unreachable while fleet works | PL 1069 | UV | open, connection.ts:80, web host.ts:88 |
| 26 | handover.abort gets only the 30 s client timeout | DF | R | open, protocol messages.ts:101-115 |
| 27 | Closing a master that open() replaced sends -O exit and ends the new master | DF | R | open, ssh.ts:223-227 |
| 28 | Lost answer to force write onto replacement gateway: rerun refuses, fleet.json keeps lost gateway | DF | R | open, fleet-recover.ts:219/:273 |
| 29 | owner.json fleetId never compared with fleet.json's | TR 96/106 | R | open, ownership/state.ts:33 |
| 30 | Local squatting: Linux daemon lock abstract socket keyed by path hash; /tmp/svall-<uid> pre-creatable; tmux probe path guessable | DF | R | open, main.ts:86, ssh.ts:57-75, host.ts:274 |
| 31 | Destination fleet.json rewritten from parsed schema (unknown keys dropped); schema not strict | DF | R | open, destination.ts:670, provision.ts:127 |
| 32 | Git import replaces same-id registration unchecked; deletes registrations whose folder is absent (unmounted media) | DF | R | open, git-import.ts:65/:70 |
| 33 | lay() marks dormant before killWindow, swallows errors; pane recheck throw leaves slot dormant with no agent | DF | R | open, destination.ts:888-894, rest.ts:423 |
| 34 | Single-owner edges: settle() waits on neither recover() nor prompt lanes; Enter sent 100 ms after paste without ownership check | DF | R | open, control.ts:60, fleet.ts:177-182, tmux.ts:257-259 |
| 35 | HandoverService.open() hands another fleet's journal to status/steps | DF | R | open, service.ts:57/:266 |
| 36 | svall host saves registry loaded at start (lost update); host doctor never checks far machine id | DF | R | open, commands/host.ts:42, host.ts:470-487 |
| 37 | -N suffix can push machine name past 32 chars; next load sets machines.json aside | TR 57 | R | open, registry.ts:26-29 |
| 38 | Gateway fleet: svalld exits at start on bad ~/.config/svall; restart loop | PL 1062 | R | open, main.ts:119 |
| 39 | Concurrent config.json split: raw ENOENT, daemon exit; reserved name in fleet.json fails name check | DF | R | open, config.ts:133-135/:154 |
| 40 | Svall Dev and Svall share ~/.config/svall and Linux unit names; dev controller takes a companion of any release | PL 927 | R | open, machine.ts:13, install.ts:45 |
| 41 | Release pipeline: rsync without MACOSX_DEPLOYMENT_TARGET; local key never checked against signers; release.yml publishes without tests; --version .. deletes above --out | DF | R | open, release-stage.mjs:122/:374/:336, release.yml:205 |
| 42 | Install prunes a release a --no-launchctl daemon still runs from; currentRelease read uncaught, skips rollback | PL 891, 1040 | R | open, install-release.mjs:133, host.ts:558 |
| 43 | Every window starts Node connect helper even with no gateway (flag off too) | DF | R | open, RemoteConnection.swift:49-59 |
| 44 | OpenCode: remote auth probe runs in ssh env, can orphan its server; Mac daemon lacks OPENCODE_DB; frozen-source edits after export lost; pnpm compat skips export/import | PL 958/969/963 | R | open, host.ts:232, login-env.ts:7, source.ts:322, harnesses.ts:248 |
| 45 | Two controllers can drive one handover; late Begin leaves orphan transaction (no nonce) | PL 781 | R | open; documented handover.md:313-318 |
| 46 | Controller polish: plain errors retried ~7 s; dir mtime-only changes destabilise passes; Cancel waits on hashing; pathProblem accepts //; 10 s ssh -O check result never read; --interrupt-after overflow; handover local doesn't name source; machines nameable status/attach; one-party check after claim() | PL 896 | P | open |
| 47 | Dest/Git polish: letterless folder misleading external_writer; prunable reads dirty; dirty-worktree blocker text wrong; quadratic status compare | TR 699/588/602 | P | open |
| 48 | Machines/release polish (~15 items incl. repeat host add reinstalls vs setup.md:96) | PL 1077/1078/1089 | P | open |
| 49 | App polish: no terminal for sudo/login steps; no machine list; Fleet config button opens only fleet.json; agent_unsettled hint wording | FR I6, TR 240 | P | open |
| 50 | OpenCode polish: imported session left after abort; exports left in transcripts; blank reason on silent CLI exit; identical held copy re-imported | PL 963 | P | open |
| 51 | Test gaps: fault world never uses batchWritesWhile; no second terminal across a freeze; relay peer survival; CI never sets SVALL_TEST_GNU_TAR; harness splits OpenCode argv on spaces; L26 guard test hollow | PL 889/891, TR 738/851/867 | P | open |
| 52 | Refactors (L02, L03, L29, L30, L31, L37 repairBrief unused, L39, fleetHomes, resolveOwner, LineBuffer, five ps readers) | FR, PL 1094 | P | open |
| 53 | Docs: spec protocol surface stale; spec:207 adopt exceptions; README uninstall doesn't say ~/.config/svall stays | DF | P | open |

Fixed since ledgered: triage 717, 469, 788, 318, 132; two-controller stage leak; OpenCode server failpoint names. M19 fsync changed: durable but batched 250 ms while writable (store.ts:84-88).

## 3. Verification

No GitHub Actions run has ever happened (billing). Every suite ran only on the author's Mac.

| Suite | Size | CI job (never run) | Last run |
|---|---|---|---|
| typecheck | 2 tsconfigs | ci.yml | tip |
| vitest 5 projects | 5,850 | ci.yml | tip |
| Fault suites (pnpm test:faults) | 1,421 | part of pnpm test | tip |
| Playwright | 203 | none | tip |
| Swift | 89 | ci.yml | tip |
| Release build + scan | 3 archives | release.yml | tip |
| Container round trip (scripts/integration/fleet-handover.sh): 25 steps, 20 handovers, Linux⇄Linux | ~806 s | ci.yml; release.yml | ed3dda15, NOT at tip |
| fresh-install.sh | arm64; x86-64 via qemu | release.yml | arm64 ed3dda15; x86-64 b31fe003 |
| Opt-in gates: GNU_TAR ×2, TEST_SSH ×3, LIVE_REMOTE ×2, RSYNC_BUILD ×1 | 8 skips | never | by hand |
| SMOKE.md (10 sections) | manual | — | never in full |

Real machines (linus-vault): 890b1df, 896fc01 (spec acceptance 7/7), d0602dc on archi-m3b; a84bf57d on svall-m4; 10-20: Mac→Linux on ed3dda15, host upgrade to 4c11f026, Linux→Mac on 4c11f026. At the tip only one direction; no container run.

By-eye recipe: Kit/STEPS.md (17 steps); ER ledger/pr2-onmachine-env.md:31-75; scripts rebuild.sh <sha>, open-test-app.sh, close-test-app.sh, 60-creds-copy.sh/69-creds-delete.sh, teardown-*. Owner must quit own Svall and boot it out of launchd (STEPS 2-3).

## 4. The handover.enabled flag

Read only by the Mac app (SvallHome.swift:35-40 → shell.info, ShellRouter.swift:412-416). Schema protocol/handover.ts:93. svalld and CLI never read it.
Gates (web UI only): following the helper (boot.ts:95), Machines pane (SettingsCard.tsx:362), sheet (HandoverSheet.tsx:175), Add Machine (HostSetup.tsx:63), dock/side-card controls, Upgrade button (App.tsx:38), resume-error display (selectors.ts:88), connection banner except when another machine owns (host.ts:99-100).
Does NOT gate: every CLI command; config.json split; state v9 / protocol bump; reserved command names; second-terminal dormancy; machine.json; connect helper per window; ~100 MB companion; keep-awake local-only; freeze rules; launchctl bootout (710a9f86); OpenCode worktree_create removal (70fbc0f7); Claude 2.1.251 warnings; release.yml on every tag.
Removal needs: plan.md:1431-1432 (M0–M3b and M6 evidence); Ruling PL 817 (by-eye pass, signing key, first real GitHub run); board adds notarization.

## 5. Merge path
Pick B: merge behind the flag after the main merge (done), suites + container round trip at the new head, scoped review of the 7 unreviewed commits, a short real-machine pass (STEPS 6-9 and 12) and one notarized `pnpm release` dry run.

---
# Report 2: Architecture risk review

Verdict. The ownership protocol holds up. The gateway compare-and-swap is the single point where ownership moves. The source writes its freeze to disk before any commit, and the destination only activates after reading the committed record back from the gateway. The fault suite covers every step's failpoint. Real risks sit at the edges.

## 1. Commit point
- CAS atomic: transition() serialised per fleet (gateway/authority.ts:292-296); record temp-file + fsync + rename + dir fsync before reply (authority.ts:236-242, handover/durable.ts:43-48, gateway/server.ts:78-82).
- Lost reply / gateway restart: repeated commit returns committed record (authority.ts:152-154); controller re-reads before deciding (cli/controller/handover.ts:679-699); never re-commits after cancel (:693-695); phase journaled before call (:677).
- Freeze before commit: source writes journal then surrendered mark before answering freeze (source.ts:294-302); on restart journal = read-only (startup.ts:54-58); commit requires ready-to-commit (authority.ts:158).
- Trust assumption: sourceFrozen is a value the controller asserts (authority.ts:34).
- Clocks: no leases/TTLs; only 24 h temp cleanup (durable.ts:120-131).
- Corrupt files: gateway record quarantined, ops refused (authority.ts:253-285), daemons start from cached record (startup.ts:99-101); corrupt owner.json moved aside, daemon owns nothing until gateway names owner (ownership/state.ts:36-48); corrupt journal quarantined, source surrenders (journal.ts:78-81, startup.ts:41-52); lower generation never rolls back (state.ts:60-63); routing does not compare generations (connection.ts:301-310).

## 2. Both or neither owner
Both: (a) owner.json restored from backup on old owner with gateway unreachable at start (startup.ts:99-101; adoption only at start, main.ts:192). (b) machine.json synced to the other machine: both pass isOwner() (state.ts:65-67); duplicate refused only at host add (registry.ts:107). (c) fleet recover --force-owner X --gateway Y while old owner alive but unreachable (fleet-recover.ts:150-154). (d) ownership.adopt relaying a record when named gateway does not answer (service.ts:101-116). Normal path cannot (source.ts:508-526, destination.ts:971-983).
Neither: (e) commit landed but destination cannot read it back (destination.ts:647-666, gateway/client.ts:181-210), or destination journal quarantined (service.ts:134, recovery.ts:171-176). (f) gateway record corrupt mid-handover. (g) crash between closing journal and unfreezing (source.ts:586-595) recoverable only while controller journal survives (recovery.ts:187-189).

## 3. Transfer integrity
Hashed: SHA-256 of every file at freeze (manifest.ts:60-70); modes, symlink targets; git index by staged entries (git-graph.ts:285-345); session files on install (sessions/registry.ts:79-82).
Trusted: pass 1 rsync quick check (transfer.ts:321-322); later passes --checksum (rsync.ts:128); destination re-hashes vs what controller saw land (destination.ts:429-443): end-to-end in push; in pull only rsync checksum dry run vouches for source. objects/, refs/remotes, FETCH_HEAD skipped (divergence.ts:22).
Escapes freeze: IDEs/Finder/git maintenance on source (three-pass check or external_writer, transfer.ts:236-257); writes after last verified pass before commit; orphaned background jobs; not carried by design: tmux scrollback, Claude file-history/session-env/todos/plans (sessions/claude.ts:93-99), OpenCode data folder. Edits on destination copy during transfer overwritten (R1).
Partial copies: rsync temp files recognised (replicas.ts:111-117), earlier verified pass reused (transfer.ts:225-234); no --partial.

## 4. Same home path
Covered: home equality (destination.ts:339-345, host.ts:360); cwd via symlink or different case blocks (inventory.ts:229-243); case/NFD collisions (probe.ts:17-23, handover.ts:956); non-UTF-8 names (manifest.ts:96-97); core.ignorecase/precomposeunicode re-probed (git-import.ts:97-110); missing parent blocks.
Degraded silently: -rlpt without -X/-A/-H (rsync.ts:123) drops xattrs/ACLs/Finder tags, splits hard links; symlinks to Mac-only absolute paths only warn (handover.ts:171-184); sparse files expanded.

## 5. Git
Carried: reflog, stash (git-import.ts:195-198), untracked/ignored, LFS, submodules, linked worktrees (inventory.ts:50-54). Blocks: tracked files under excludes (git-graph.ts:154-157); work in unused worktrees (git-graph.ts:254-269). Gaps: blobs referenced only by a destination-kept worktree's index deleted by --delete (R11); repo config hooks run during validation (R13); git status on destination re-hashes whole tree (GIT_OPTIONAL_LOCKS=0, links/git.ts:16), 5-minute timeout per git command.

## 6. Migration v9 and config split
Ungated. v7/v8 lifted to v9, .v8-<ts> copy kept (migrate.ts:54-61, store.ts:52-57). config.json renamed config.json.bak and split (config.ts:126-147). Downgrade: old daemon refuses v9, runs on default config. Re-upgrade after old build rewrote config.json: InvalidConfig, daemon will not start (config.ts:113-118, 132-133).

## 7. Flag gating
Read only by web UI. Ungated: machine.json on every start (main.ts:115-125,168); owner.json + ownership guard on every RPC (main.ts:169, api/methods.ts:143); synchronous fsynced writes when not writable (main.ts:171); Node svall connect helper per window, terminals .pending until it answers (ShellRouter.swift:64-78, RemoteConnection.swift:49-64), fallback only on error not hang (:115-118); protocol bump; second terminals persist dormant; new CLI commands; larger bundle.

## 8. SSH masters
Each master detached ssh -M -N, ControlPersist=no, keepalive 15 s ×3 (ssh.ts:141-158); killed only on exit/handled signal (ssh.ts:96-105). SIGKILL orphans it; sockets keyed by pid (ssh.ts:82-83), stale removed only on reuse (:135-139). Helper re-resolves every 30 s (connect.ts:9); after wake terminals dead ~30–75 s. Every svall CLI call on a gateway fleet opens SSH to gateway first (connection.ts:276-295). Tailscale SSH "check" mode not handled (ssh.ts:21-29).

## 9. Version skew
Handover needs exact release (source.ts:74-84); viewing exact protocol (connection.ts:132). Mac auto-update bumping protocol hides Linux-owned fleet until host upgrade. Companion rollback after schema bump hits NewerStateVersion (migrate.ts:56). No signing key (host.ts:299 allowUnsigned ||= unsignedBuild; install.ts:137-143 unpinned). Trust rests on app codesign + release.json digest (install.ts:74-95).

## 10. Security
svalld 127.0.0.1; gateway Unix socket 0600 in 0700 dir (server.ts:29,48). Linux account (or bypass-mode agent there) holds authority (authority.ts:39-42). Carried .git/config (core.fsmonitor, filter.*.clean) runs on destination during svall's git status (git-import.ts:161-177, links/git.ts:15-31). Any fleet-token holder can run ownership.adopt, fleet recover, handover (ownership/guard.ts:99). Multi-user Linux: abstract-socket daemon lock squattable (main.ts:85-95).

## Ranked risks

| # | Risk | Scenario | L | I | Current mitigation | Gap | Cheapest added mitigation |
|---|---|---|---|---|---|---|---|
| R1 | Destination edits silently overwritten | Pull back to Mac with editor open; save lands during rsync passes | M | H | Claim divergence (destination.ts:300-336); post-copy re-hash (:429-443) | transfer.ts:242-246 reads a changed pulled copy as "source moving" and re-copies over it | rsync --backup --backup-dir=<tx>/overwritten and report; or stop with destination_diverged |
| R2 | Idle replica touched blocks way back | .DS_Store, .idea, caches, git maintenance on Mac while Linux owns | H | M | Volatile git paths (divergence.ts:22); archive (replicas.ts:247-270) | No OS/IDE noise list (inventory.ts:38); only fix renames whole root | Default excludes; compare refs by resolved value; archive only diverged files |
| R3 | Split brain via identity | Backup-restored owner.json with gateway unreachable; machine.json synced | L-M | H | Lower generations ignored (state.ts:60-63); duplicates refused at host add | Gateway asked only at start (main.ts:192); machine.json not tied to hardware | Poll gateway ~60 s and on wake; hardware fingerprint in machine.json |
| R4 | Forced ownership non-interactive | Agent runs fleet recover --confirm <id> or ownership.adopt | L-M | H | Typed fleet id (fleet-recover.ts:253) | --confirm exists (:254,408); relay adopts when gateway silent (service.ts:108-113) | Require TTY; refuse inside fleet tmux pane; drop unanswered-gateway relay |
| R5 | Non-opt-in users not inert | v9 migration, config split, per-window helper; downgrade then re-upgrade | M | M | v8 copy kept; helper error falls back | No helper timeout; config.json gone on downgrade; InvalidConfig on re-upgrade (config.ts:132-133) | Skip helper when no gateway; keep config.json readable |
| R6 | CLI/app stall on reachable-only gateway | Linux off: every agent svall call waits 10–20 s; Tailscale SSH check mode | M | M | Cached-route fallback (connection.ts:236-267) | Gateway asked before trusting local daemon (:287-295) | Return LOCAL without SSH when local owner.json names this Mac, unfrozen, no journal |
| R7 | Unsynced copy committed | Destination power loss after commit; zero-length git objects; next handover back --deletes good copy | L | H | Re-hash before commit (destination.ts:439) | rsync does not fsync (rsync.ts:123) | sync per landed root in prepare before prepared journal |
| R8 | Stranded after commit | Linux→Mac: gateway/SSH down after commit; destination journal quarantined | L-M | M | Resume; force recovery | Activation confirms only through gateway (destination.ts:647-666) | handover.activate accepts controller-held commit record checked against tx id and preparedDigest |
| R9 | Linux reboot without linger | Gateway and svalld down until login | M | M | host add warns (host.ts:174-182) | Not a blocker | Make Linger=yes a preflight blocker |
| R10 | Version skew strands viewing/rollback | Mac auto-update bumps protocol; companion --rollback after schema bump | M | M | Upgrade offer (App.tsx:38) | Exact protocol (connection.ts:132); rollback ignores state version | Defer auto-update while remote owns a fleet; refuse rollback when state.json newer |
| R11 | Kept-worktree blobs deleted | git add in Mac-only worktree while Linux owns | L | M | HEAD check (git-import.ts:58-78) | Index blobs not checked | Protect objects/** from --delete |
| R12 | Archived linked worktree still live | git in the archive mutates live worktree | L-M | M | — | Archive keeps gitfile (replicas.ts:262-267) | Rename archived .git gitfile |
| R13 | Linux→Mac code execution | Carried core.fsmonitor, filter.*, hooks run by svall's git status | L | H | Paths validated | Repo config trusted (links/git.ts:15-31) | -c core.fsmonitor=false -c core.hooksPath=/dev/null; flag new filter/fsmonitor/sshCommand keys |
| R14 | SSH master leaks | Helper/CLI SIGKILLed | M | L | Kill on exit/signals | Detached session survives SIGKILL | ssh -O exit stale sockets at helper start |
| R15 | Large trees: downtime and timeouts | Multi-GB repos read 5–6× after terminals stopped | M | L-M | Caps (source.ts:176-186) | 10–15 min RPC caps | Reuse preflight hashes keyed by (path,size,mtime,inode) |
| R16 | Two controllers on one transaction | Mac app + --resume on Linux | L | L | Per-machine lock | Rebuilt journals adopt open tx (handover.ts:477-484) | Controller id on gateway transaction |

Fix before anyone outside the author uses it: R1, R5, R3+R4, R2, R7 (R6 sixth). Acceptable for experimental flag: R8–R16.

---
# Report 3: Error states and recovery map

Abbreviations: ctl/ = packages/cli/src/controller, cmd/ = packages/cli/src/commands, sd/ = packages/svalld/src, web/ = apps/desktop/web/src, mac/ = apps/desktop/mac/Sources/Svall. Docs: E = errors.md, H = handover.md, S = setup.md, M = migration.md, — = not documented.
NOTE: C3 (Terminate and carry at Checks) is overstated; shell_busy is a rest-phase blocker where the app answers per character over stdin. Not a bug.

## 1. State map

| # | State | How you get there | App shows | CLI shows | Recovery | Auto/manual | Source | Docs |
|---|---|---|---|---|---|---|---|---|
| A1 | ssh step fails | Add machine: cancel, bad key, changed host key | askpass dialog; then "ssh D exited 255"; ssh stderr dropped | ssh prompts and stderr | Run ssh D in Terminal, Add again | manual | ctl/host.ts:332; mac/ControllerProcess.swift:251 | E,S |
| A2 | master refused | Key not in agent / BatchMode | Detail + action ssh-copy-id / ssh-add | Same, exit 1 | Terminal | manual | ctl/host.ts:341-345; ctl/ssh.ts:164 | E |
| A3 | os/home/tools fail | Not Ubuntu, wrong home or >65 bytes, missing apt/systemd | × with action; no action for systemd; Tailscale action lost when apt also missing | Same | ssh + apt/useradd | manual | ctl/host.ts:136-161,355-367 | E,S |
| A4 | release fails | arm64, unsigned, digest mismatch | "…name one with --release", no action; app cannot pass --release/--allow-unsigned | Same | CLI only | manual | ctl/host.ts:294; ctl/install.ts:42-90 | E,S |
| A5 | install/service/probe/upload fail | Far setup/unit/tmux fails | × row no action; outcome "ended with exit 1" | Step + todo | host doctor, far logs | manual | ctl/install.ts:100-196; ctl/host.ts:197-284; web/host.ts:63 | E |
| A6 | identity fails | Far setup went back, alias reaches another machine | Action: read daemon log / host remove --forget | Same | Terminal / Forget | manual | ctl/host.ts:407-417 | E |
| A7 | Agent CLI missing/old/logged out/no hooks | Add / Check | Warn rows with action | Same | ssh + login | manual | ctl/host.ts:233-247 | E,S |
| A8 | Upgrade probe fails | Upgrade | probe warn + rollback warn | exit 1 | Automatic go-back | auto | ctl/host.ts:544-566 | E,S |
| A9 | Upgrade rollback fails or upgrade master fails | Upgrade | Raw message; action never names --rollback; no Rollback button | Same | svall host upgrade N --rollback (unnamed) | manual | ctl/host.ts:523-526,558-565,581-584 | E partly |
| A10 | Enable: fleet.json names another gateway, or record held/corrupt | Make gateway | Action fleet recover … --gateway / restore record | Same | CLI | manual | ctl/host.ts:725-781 | E |
| A11 | Remove refused: handover open, fleet owned away/there | Remove / Forget | Action handover --resume/--abort / handover local; also blocks --forget | Same | CLI | manual | ctl/host.ts:639-656 | E,S (forget-blocked: no) |
| A12 | Remove: far uninstall exits non-0, non-3 | e.g. inside tmux | "D could not be reached", steered to --forget | Same | — | — | ctl/host.ts:686-690 | no (misreport) |
| A13 | remove --forget succeeds | Forget | Skip row with action | exit 1 | — | — | ctl/host.ts:671-672 | no |
| A14 | machines.json unreadable | Corrupt registry | Nothing | stderr "moved to …broken-T" | Fix by hand | manual | ctl/registry.ts:58-86 | S only |
| B1 | auth/host_key/other at connect | Key, host key, alias | "<owner> is not reachable: ssh could not reach …"; no Retry; helper idles | exit 1 | ssh <host>, reopen window | manual | ctl/ssh.ts:22-25; ctl/connect.ts:157,177,207 | E |
| B2 | unreachable / daemon_down | Tailscale down, unit stopped | Banner; helper retries forever 1→16 s | 5 tries 1–8 s, exit 1 | Wait / host doctor | auto | ctl/connection.ts:18-22,137-150 | E (CLI backoff wrong) |
| B3 | Master dies / Mac wakes | Link drop | "svalld connection lost, reconnecting…" → "connecting to…" → re-attach; ~45 s + 30 s tick | — | — | auto | ctl/connect.ts:9,104,129,165 | H partly |
| B4 | Far companion on another protocol | Mac updated, Linux not | "<owner> is on another version" + Upgrade (flag on only) | exit 1 | host upgrade | manual | web/host.ts:80-96; mac/ShellRouter.swift:397-402 | E |
| B5 | Far daemon wedged / stale port file / remote outdated | Far crash/skew | "Starting the fleet…" forever; connection-info reports CLI's protocol not daemon's | Handshake timeout → other | Restart far unit by hand | none | ctl/connection.ts:72-82; web/App.tsx:73-75 | — |
| B6 | Far state.json newer than far daemon | Skew | Looks like daemon_down; retried forever | daemon_down | host upgrade; cause only in far svalld.log | futile auto | protocol/migrate.ts:9 | M (Mac only) |
| B7 | Far answers as another fleet/machine | Alias / enable missing | Banner; helper idles | exit 1 | host enable / fix alias | manual | ctl/connection.ts:129-131 | E |
| B8 | Gateway down at launch | Gateway off | Cached route used only if generations match; else "the gateway did not answer (…), and <detail>"; owner local → "svalld not running … run svall setup" | exit 1 no retry; --host bypasses | Restore gateway / --host | partial | ctl/connection.ts:236-267; web/App.tsx:77-97 | — |
| B9 | Stale replica (moved elsewhere, gateway down) | Two Macs / CLI move | Stays on old replica; raw toast; handover_committed attach Retry never succeeds | --host <owner> | CLI only | none | ctl/connect.ts:134-136; web/terminals.ts:16,71 | — |
| B10 | Attach while master down | Link drop | Waits, attaches on online | — | — | auto | mac/SurfaceManager.swift:37,105-109 | H |
| B11 | >10 sessions, or far tmux/session missing | Many terminals | "Session open refused by peer"; "ssh quit as soon as it started: <far line>" + Retry | — | Close terminals / Retry | manual | mac/SurfaceManager.swift:121-123 | H (MaxSessions only) |
| B12 | Mutation on read-only copy (not_owner/frozen/handover_committed) | Sleep, Delete | 2.6 s raw toast no action | exit 1 | Wait / handover status | manual | sd/ownership/guard.ts:96-103; web/actions.ts:272 | E (codes only) |
| C1 | No gateway | Sheet/start | "No machine is this fleet's gateway yet…" | "…svall host enable <host> --fleet …" | Enable | manual | web/HandoverSheet.tsx:136-140; cmd/handover.ts:77 | E,H |
| C2 | Preflight blockers | Checks | Rows; hint on ~17 codes; choice toggles; Try again | ✗ lines + menu/flags | Settle, choose, try again | manual | web/handover.ts:315-363; cmd/handover-view.ts:71-111 | E |
| C4 | transaction_open / generation_mismatch / identity_mismatch | Checks | Message only; no hint/button | ✗ + code | handover status / daemon restart (no command given) / fleet recover | manual CLI | ctl/handover.ts:246-262 | E |
| C5 | Gateway or daemon unreachable during preflight | Checks | "Stopped at Checks: <err>" + only Check again | interrupted, safe: [] | Check again | manual | ctl/handover.ts:289-291,827-832; web/handover.ts:236 | E (as commit-unknown only) |
| C6 | Source daemon cannot ask gateway (any reason) | Checks | ssh_interactive, even for timeout/corrupt record | Same | "Run ssh" (misleading) | manual | sd/handover/source.ts:207-213 | E (prompt case only) |
| C7 | Begin refused: authority_corrupt/internal/invalid_phase | Begin | Shown as transaction_open | Same | "status, resume/abort" (wrong) | — | ctl/handover.ts:464 | mismatch |
| C8 | Rest blocker (working, blocked, unsettled, busy) | Resting | Decision: Carry on / Try again / Abort; fleet given back while you decide | Menu; no TTY → blocked | Choose / abort | manual | ctl/handover.ts:503-509; sd/handover/source.ts:539-545 | E,H |
| C9 | Detached helper waits for a decision | --detach | Badge "waiting" | status names pid | attach / abort | manual | cmd/handover.ts:198-206 | E |
| C10 | Claim blockers (destination_occupied/diverged, worktree_unused) | Transferring | Decision with Archive | Menu / --archive | Archive / abort | manual | ctl/handover.ts:594-619 | E |
| C11 | rsync fails / external_writer | Transferring | Resume / Abort; external_writer opens decision | interrupted | Try again | manual | ctl/handover.ts:568-576 | E |
| C12 | Prepare blocked (git_mismatch etc.) | After full copy | Decision; Try again copies again | Same | Fix clean filter on dest | manual | ctl/handover.ts:417-424 | E,H |
| C13 | Ready refused / wrong answer | Verifying | Resume / Abort | Same | — | manual | ctl/handover.ts:655-665 | E |
| C14 | Commit answer lost and gateway down | Committing | "Whether the fleet moved … is not known yet … Check again asks the gateway." | safe: [] | Wait for gateway | manual | ctl/handover.ts:689-690; web/handover.ts:428 | E,H |
| C15 | Committed, then controller stops (push to Linux) | Lid closes / kill | On reopen: Retry only; fleet runs nowhere until clicked | --resume | Retry | manual | sd/handover/startup.ts:60-63; recovery.ts:174-176 | H (pull only) |
| C16 | Activate fails (dest daemon, tmux) | Resuming | "The fleet is X's now, and it stopped while resuming: …" + Retry | safe: ['resume'] | Retry | manual | ctl/handover.ts:709,819 | E |
| C17 | Character fails to resume | Resuming | Row × + Retry | "✗ X did not resume …; stays dormant" | Retry / revive | manual | sd/handover/destination.ts:756,773; web/HandoverSheet.tsx:74-86 | E,H |
| C18 | Trust / bypass prompt | Resuming | Notice "waits at its Trust this folder? prompt" | ! notice | Answer in terminal | manual | sd/handover/destination.ts:760 | E,H |
| C19 | Complete pending (source or gateway not told) | Last step | "<x> has not heard that it finished; Retry tells it" | "Still to finish…", exit 0 | Retry | manual | ctl/handover.ts:727-750 | E |
| C20 | Cancel / Ctrl-C before commit | Any | Abort → aborted | "Cancelling…" | — | auto abort | cmd/handover.ts:232-243 | H |
| C21 | Abort did not finish (dest unreachable) | Abort | Abort again | safe: ['abort'] | Abort again | manual | ctl/handover.ts:792-799,816 | E |
| C22 | Abort after commit | Abort | Not offered | "only a resume goes on" | Resume | — | ctl/handover.ts:344; sd/handover/service.ts:232-238 | E |
| D1 | App quit or killed | Any | Helper runs on; reopen replays | — | — | auto | mac/Handover.swift:155-169 | H |
| D2 | Helper killed before commit | Any | Resume / Abort; source read-only until you choose | Same | Resume / Abort | manual | ctl/recovery.ts:178 | H |
| D3 | ssh drop during a call | Any | "asking again (attempt n)", then Resume/Abort or Retry; 45 s – 2.5 min | Same | — | auto then manual | ctl/handover.ts:1066-1080 | H |
| D4 | Mac sleeps mid-handover | Laptop idle | No keep-awake hold; helper suspends, rsync dies; push leaves fleet frozen on Mac | Same | Resume / Abort after wake | manual | mac/ShellRouter.swift:349-350; web/awake.ts:58 | — |
| D5 | Controller journal unreadable | Disk/crash | Rebuilt from other journals; choices lost | Same | Choose again | — | ctl/recovery.ts:78-81 | H |
| D6 | Daemon journal unreadable (quarantined) | Disk/crash | Dest: unknown, "nothing is safe until someone looks at that machine"; Check again loops. Source: read-only; Abort reopens no terminals | Same | Nothing named | dead end | sd/handover/startup.ts:41-53; ctl/recovery.ts:171-172; sd/handover/source.ts:355 | E (vague) |
| D7 | Begin unanswered, cancelled, gateway down | Begin | Journal kept; Abort once gateway answers | Same | Abort later | manual | ctl/handover.ts:453 | E |
| E1 | Resume a superseded handover | Gateway moved on | Forget button | "…svall handover --forget" | Forget | manual | cmd/handover.ts:269-273 | E,H |
| E2 | Start while a journal is open | After moved/returned | Resume only, even pre-commit | "already open here; resume it" | Resume | — | ctl/handover.ts:287 | — |
| E3 | Resume/abort from a second Mac | Another Mac | n/a | "neither the source … run it on A or B", safe: [] | Run on the Mac | manual | ctl/handover.ts:1004-1007 | spec only |
| E4 | Resume/abort on the Linux machine (Mac gone) | ssh to Linux | n/a | "machine <mac> is not in the registry; add it with svall host add" — impossible | none | dead end | ctl/reach.ts:179-182; ctl/handover.ts:1015 | — |
| E5 | status with gateway down and no journals | — | "none" | "No handover of this fleet is open" | — | — | ctl/recovery.ts:159 | E (overclaims) |
| F1 | Gateway down temporarily | — | Cannot begin/commit; frozen source stays read-only | Same | Wait | auto | — | H |
| F2 | Gateway record corrupt | — | "Stopped at Checks: …put a readable record at <file>" | Same | Restore file / recover --gateway | manual | sd/gateway/authority.ts:278-282 | E |
| F3 | Gateway lost for good; fleet on Mac; no journal | — | — | — | host remove --forget | manual | ctl/host.ts:695-696 | S (implied) |
| F4 | Gateway lost; fleet on Linux or journal open; no second Linux machine | — | — | fleet recover --force-owner local refused; Mac cannot be gateway; --forget refused | none | dead end | cmd/fleet-recover.ts:225-226; ctl/host.ts:639-656 | H:244 implies it works |
| F5 | Recover incomplete | Some machines unreached | — | "next:" lines | Run again | manual | cmd/fleet-recover.ts:331-347 | E |
| F6 | Recover refused: gateway machine answers, authority does not | Unit down | — | "refused: its machine answered…", no action | systemctl --user start svall-gateway (unnamed) | manual | cmd/fleet-recover.ts:86,229-230 | E partly |
| F7 | Recover over a committed but unactivated handover | — | — | Destination drops prepared state; old replica runs | — | data-loss risk | sd/handover/service.ts:135-141 | risks line only |
| F8 | Mac lost, fleet on Linux | — | New Mac cannot take fleet (provision Linux-only) | — | none | — | cmd/fleet-provision.ts:26 | — |
| G1 | First start: config split, state v9 | Update | — | — | Backups kept | auto | — | M |
| G2 | config.json back beside fleet.json | Dotfiles | "svalld not running" + log | doctor | Move/delete | manual | — | M |
| G3 | Older build on v9 state | Downgrade | Older daemon waits with message | — | Manual downgrade | manual | — | M |
| G4 | Older app/CLI vs newer daemon | Skew | Local: "…quit and reopen Svall". Remote: Starting forever | — | Update | manual | web/App.tsx:32-34,73-75 | M partly |
| G5 | Update during open handover (Sparkle or host upgrade) | Update | No guard: upgradeHost has no open-journal check | — | — | — | mac/Updates.swift:78; ctl/host.ts:625-644 | — |

## 2. Dead ends
1. F4 single Linux machine lost while owning the fleet or with a journal open: recovery needs a second Linux machine.
2. E4 Mac gone mid-handover: Linux cannot run --resume/--abort; fleet recover on Linux supersedes prepared state (F7).
3. D6 quarantined daemon journal: no instruction; CLI adds a wrong "Nothing is safe until the gateway answers." (cmd/handover-view.ts:264); source abort reopens no terminals.
4. App vs CLI-only recoveries: generation_mismatch/transaction_open at Checks; ssh_interactive, master auth, agent logins, parent_missing → far Terminal; arm64/unsigned; rollback; stale replica (B9) → --host.
5. Remote banner dead ends: B1 (no Retry, never names ssh <host>), B8, B5, B6.
6. Messages that don't name the way out: C6, C7, F6, A12, A9, A1; far daemon_down text says "svall setup or pnpm svalld" on Linux (ctl/connection.ts:73).
7. D4/C15 "runs nowhere": a committed push whose controller died waits for Retry.

## 3. Code vs docs mismatches
- errors.md:187 interrupted with no safe action ≠ only commit-unknown: also no gateway, unknown machine, lock held (cmd/handover.ts:53), unexpected pre-commit errors (ctl/handover.ts:827-832), third machine (:1007), superseded (cmd/handover.ts:270).
- errors.md:68 ssh_interactive is about prompts; source.ts:212 raises it for any gateway failure.
- errors.md:64 transaction_open doesn't cover Begin refusals mapped there (ctl/handover.ts:464).
- errors.md:199 standing none also returned with gateway unreachable and no journal (recovery.ts:159).
- handover-view.ts:264 "Nothing is safe until the gateway answers." printed for quarantined-destination unknown.
- errors.md:179 exit codes: --detach exits 0 once launched, attach always 0, status 0 even when unknown; undocumented.
- errors.md:216/handover.md:216 "Resume or Abort before the commit": start finding a journal offers only resume (ctl/handover.ts:287).
- errors.md:235-237 retry to 16 s: app helper only; CLI 5 tries ≤8 s (connection.ts:137-150).
- handover.md:244 fleet recover --force-owner local alone is refused when gateway unreachable.
- handover.md:333-335 "runs nowhere" for pull only; push same (C15).
- Spec "resume or abort runs on source or destination": destination can't (E4).
- errors.md:250, :261, :263, :272, :292/setup.md:139 (see Report 3 original for each).
- Undocumented: cached-route refusal texts (connection.ts:243-264), "ssh quit as soon as it started: <far line>", synthetic svall host row (ShellRouter.swift:384-388), helper-death banners.

## 4. States the fault suites don't exercise
Every failpoint struck (472 cases) and every controller request struck. Missing: resume/abort through real connectHandover on Linux (CF:627 passes only because world.ts:534 gives trift a route to the Mac); Mac sleep or real ControlMaster drop mid-handover; half-written rsync tree then crash; git import under faults; a step failing without the party dying; character failing to resume in real-daemon world; quarantined journal → status/abort/recover end to end; fleet recover during live/committed handover; build/schema change mid-handover; third machine after prepare/commit; remote view states (wedged far daemon, remote outdated, gateway auth failure with owner local, schema refusal as daemon_down, handover_committed on attach, stale replica, mutation toasts); host failures (ssh step, upload/HTTP, registry write, master in upgrade/rollback, uninstall non-0/non-3, doctor unknown host, not-Linux os, systemd/Tailscale branches).

## 5. Top fixes by user impact
1. Hold KeepAwake while a handover helper is followed or a journal is open (D4).
2. Launch --resume on open and on wake when resume is the only safe action (web/store/handover.ts:63-73) (C15).
3. web/App.tsx:73-97 + ctl/connect.ts:157,177: render away/outdated before load and for a local owner; Reconnect on the banner; "run ssh <host>" in auth/host_key text.
4. cmd/fleet-recover.ts:225-226: standalone recovery for a lost sole gateway; fix handover.md:244.
5. sd/handover/source.ts:210-212 and ctl/handover.ts:464: classify gateway failures as authority_unreachable/authority_corrupt/identity_mismatch.
6. ctl/recovery.ts:171-172 + sd/handover/source.ts:355 (D6): name the .broken file and steps; revive terminals by restedBy; fix handover-view.ts:264.
7. ctl/reach.ts:179-182 / ctl/handover.ts:1015: let the destination complete a committed handover without a route to the source; drop the "svall host add" advice.
8. Host panel: stderr on ssh step failure (ControllerProcess.swift:251); failing detail in outcome line (web/host.ts:63); non-0 uninstall not "unreachable" (host.ts:686-690); --forget exit 0 (host.ts:671-672); name --rollback (host.ts:558-565).
9. Docs pass (errors.md, handover.md, setup.md) for every mismatch above.

---
# Report 4: Agent session carry/resume fragility

Bottom line. For Claude Code and Codex the PR checks only the version floor, file layout, login and Svall's hooks before the move. It never parses or test-resumes a session. A record-format change, resume-command change, or Mac/Linux version mismatch shows up only after the commit. OpenCode export/import breakage is caught before the commit, at prepare. No automated check covers the handover adapters.

## Per agent
| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Carried | <config>/projects/<slug>/<id>.jsonl + whole <id>/ folder (claude.ts:81-99). Not: file-history, session-env (claude.ts:94-96), tasks/<id>, ~/.claude.json, settings, MCP, plugins, credentials | Rollout sessions/yyyy/mm/dd/rollout-<ts>-<id>.jsonl only (codex.ts:29-46); destination rebuilds sqlite index; history.jsonl, auth.json, config.toml stay | Plugin log <fleet>/transcripts/opencode/<id>.jsonl + exports/<id>.json from opencode session export --standalone (opencode.ts:80-109). DB/config/state/cache stay |
| ID stability | Same relative path under destination config dir (registry.ts:58-63) | ID in filename at same dated path | ses_ ID kept by export/import; prepare requires "Imported session: <id>" (opencode.ts:37,134-140); earlier destination copy compared by message-ID prefix, removed, restored if import fails (opencode.ts:57-71,117-153) |
| Resume cmd | claude [--effort][--dangerously-skip-permissions] --resume <id> (dormancy.ts:20,75-78) | codex resume -c tui.resume_cwd=session [-m/-s/-a/--yolo…] <id>; -p/--profile and --local-provider dropped (dormancy.ts:19,81-97) | opencode --standalone [--auto/--yolo] -s <id> (dormancy.ts:20,87-91) |
| Version pin | ≥2.1.251 no max (agents.ts:26); trust/bypass logic "as Claude 2.1.283 decides" (claude.ts:43,65) | ≥0.156.0 no max (agents.ts:34) | ≥2.0.22 no max (agents.ts:41); adapterFor accepts 3.0.0 while compat calls 3.x unsupported (harnesses.ts:206-213) |
| Auth on Linux | Separate login; claude auth status → loggedIn in daemon env (registry.ts:156-159) | Separate login; exit code of codex login status (registry.ts:165) | Separate login; only whether opencode auth list --standalone exits 0 (registry.ts:162-163) |
| Known gaps | /rewind; task list; tool-output paths when config dir differs; trust/bypass prompts | No SessionStart until first turn: "up" = pane held 3 s (codex.ts:27, destination.ts:749-750,867); AppArmor not checked at preflight | Undo snapshots, subagent sessions, tool-output files not carried (spec.md:525-526); no fixture, no live probe; shared service can finish a cut-off turn on source (handover.md:301-305) |

## 2. When skew/format changes are caught
- Preflight: both sides ≥ minimum (registry.ts:251-256); adapter-number check (:257) can never fire (every adapter is 1). Layout via discover on source path (manifest.ts:218). OpenCode dry export (source.ts:431).
- Different versions on the two machines → config_difference WARNING only, direction-blind (cli/controller/handover.ts:131-141; web/handover.ts:342-343).
- Prepare (Abort possible): OpenCode check/drop/import (destination.ts:485-495). Claude/Codex bytes placed, never read (types.ts:27-29).
- Activate (after commit): first point a Claude/Codex break shows. Probe is --version + login + hooks only (registry.ts:149-168).
- Silent passes: pane held 3 s (Codex) / 10 s (Claude/OpenCode) counts as resumed (destination.ts:860-867); SessionStart under a different ID adopted as new session (sessions.test.ts:875-897), waiter matches old ID only (destination.ts:939) → notice not error.

## 3. Rest
- Idle agent: no /exit, no SIGTERM; viewers detached then tmux kill-window → SIGHUP (rest.ts:400,421). external_writer catches files still changing.
- OpenCode: each private serve --stdio gets ≤10 s then SIGKILL tree, then export (rest.ts:300-346; source.ts:322).
- Working agent: waited up to 3 min (rest.ts:67) then agent_working. Interrupt sends Escape (rest.ts:269-273). Claude sends no interrupt hook so rest = "no tool processes left" (rest.ts:181-183). Still running after 10 s → agent_unsettled; Terminate → SIGTERM then SIGKILL (rest.ts:274-287).
- Permission prompt pending: blocks at once (rest.ts:193); Interrupt answers Escape = reject; question dropped (dormancy.ts:32-35).
- ctrl+z: shell_busy until fg or Terminate (rest.ts:149-153,280-282).
- Lost: in-flight tool call, subagents, background agents/shells/monitors, scrollback. RESUME_NOTE deliberately removed for handover rests (rest.ts:414). A launch flag outside the known list → agent resumes with NO flags (dormancy.ts:119).

## 4. Resume failure surface
- Error text (destination.ts:756,773,817,874). Notices counting as success: "waits at its Trust this folder? prompt", "may be waiting at a prompt" (:760-761).
- Stored slot.resumeError (destination.ts:955); revives write it too (fleet/poll.ts:150-165).
- App: only when handoverEnabled (selectors.ts:88-89): TerminalArea text + "Revive <name>" (TerminalArea.tsx:86-93); SideCard "resume failed" (:149); Sidebar tooltip (:175); map marker. Phone: "asleep".
- CLI: only outcome lines "✗ <name> did not resume: …" (handover-view.ts:223); resumeError appears nowhere in packages/cli/src.
- Recovery: Revive reruns same resume. Manual: start agent fresh; hand fleet back.
- repair.ts: repairBrief (repair.ts:11-19) called nowhere except sessions.test.ts:1022. Spec.md:533 "separate repair action" unimplemented.

## 5. Platform differences
- Paths hold (same home). CLAUDE_CONFIG_DIR differing → tool output previews only.
- Credentials never carried; a root holding any blocks (errors.md:97).
- Login probes run in systemd unit env: shell-rc-only API key → probe and agent disagree.
- MCP servers, hooks, plugins, skills, Codex profiles/providers machine-local, never compared; warning fires only when versions differ (controller/handover.ts:135).
- Trust/bypass warnings read private config keys (claude.ts:46-72, codex.ts:14-20).
- AppArmor/Codex: doctor and host add warn (doctor.ts:314-327, host.ts:221); handover preflight does not.

## 6. Login/auth
Each agent must be logged in on Linux first (setup.md:16,76-90, handover.md:125, errors.md:75, web/handover.ts:356). Preflight probes destination fresh (service.ts:65), blocks agent_logged_out (registry.ts:258). Gaps: expired token, API-key-only, OpenCode with no provider pass the check, fail 401 after commit.

## 7. Test realism
Fixtures: Claude 2.1.251 (Ubuntu) and 2.1.280 (macOS); Codex 0.155.1 (macOS, below floor) and 0.156.1 (Ubuntu). Layout only. Installed now: Claude 2.1.304, Codex 0.162.1, OpenCode 2.0.32. OpenCode tested only against a fake modelled on 2.0.22 (fake-opencode.ts:1-4). Live test (sessions-live.test.ts) manual, Claude and Codex only, non-interactive (:76-86). compat-daily does NOT check: session export/import, "Imported session:" line, export keys, Claude/Codex directory layouts, tui.resume_cwd, trust keys, Linux side's CLIs.

## Fragility ranked, mitigations cheapest first
1. Claude/Codex break discovered after commit: (a) destination CLI older than source → blocker or named warning; (b) pre-commit canary in prepare; (c) wire repairBrief.
2. Weak "up" detection: SessionStart with different ID or none within window = failed; Codex: check rollout opened/grows on first turn.
3. No recovery beyond retry: show resumeError in svall status and char list; "Start fresh from summary" (repairBrief).
4. Config drift (MCP, plugins, hooks, providers): always warn, name-level diff.
5. Codex AppArmor: reuse doctor.ts:314-327 in destination system.info as preflight warning.
6. Background agents killed silently: keep RESUME_NOTE when rest interrupted/terminated (rest.ts:414).
7. Weak login probes: parse opencode auth list for ≥1 provider; note shell-env-only API key in setup.md.
8. OpenCode export JSON shape: add export/import --help and source greps to compat.
9. Uncarried state (tasks/<id>, file-history, Codex history.jsonl): document; check whether tasks/<id> safe to carry.
10. Private keys in commands: watch in compat.
11. Stale evidence: fixture per release from compat; nightly live test against gateway.

---
# Report 5: UX walk

Top 3: (1) relaunch mid-handover shows gateway's raw status text (UUIDs, "generation", "activation"); e2e fixtures use invented friendly reasons. (2) Clicking a machine freezes the fleet as soon as checks pass; user never sees size or how long characters stop. (3) Lost gateway or an already-open handover at Checks is a dead end in the app; the way out is the CLI and the app never names the command.

## A. Journey table
| Step | What the user sees | Friction | Sev | file:line |
|---|---|---|---|---|
| 1 Discover | Nothing in app; docs only. No "experimental" label | Docs only | annoys | SettingsCard.tsx:359-361, UtilityDock.tsx:104-108 |
| 1 Enable | Hand-edit handover.enabled, quit and reopen | JSON + relaunch; no toggle | annoys | setup.md:52, SvallHome.swift:35-40 |
| 2 Settings → Machines | Single row "another machine — Set up" | No machine list, gateway, health | annoys | SettingsCard.tsx:131-139 |
| 2 Machines panel | Empty name + ssh form; every action needs name retyped. arm64 → CLI | Name forgotten after relaunch | annoys | HostSetup.tsx:98-131 |
| 2 Add progress | Phases "Connect / Prerequisites / Companion / Service / Agent logins / Final probe / Registry". Rows named by step id. UUIDs | Jargon, raw ids | polish | host.ts:12-22, HostSetup.tsx:44-50, controller/host.ts:348,418,432 |
| 2 SSH key | "ssh refused the login…: install a key there with ssh-copy-id … then add the machine again" | Needs terminal | annoys | controller/host.ts:340-343 |
| 2 Home path wrong | Exact sudo useradd commands | Good | – | controller/host.ts:356-362 |
| 2 Add outcome | "ready for handover", or "still to do:" | "ready" false until Make gateway; no next-step button | annoys | HostSetup.tsx:21-29, host.ts:66-70 |
| 2 Make gateway | "studio holds fleet <uuid> for <uuid> at generation 0" | UUIDs; no button on to Handover | polish | controller/host.ts:734, HostSetup.tsx:30-34 |
| 2 Check (doctor) | Warns tmux/gh/path, then "Check: done" | Nothing says warnings don't block | polish | host.ts:66-70 |
| 2 Remove refused | Names CLI commands for things the app has buttons for | | polish | controller/host.ts:644-656 |
| 3 Sheet start | "Move this fleet to [This Mac] [studio]" | One click runs checks then freezes; size shown only after | annoys (risky) | HandoverSheet.tsx:129-134, controller/handover.ts:284-301 |
| 3 No gateway | Text only, no button | | polish | HandoverSheet.tsx:136-140 |
| 3 Blockers | ~20 codes have no hint; codes hidden | | annoys | handover.ts:315-363 |
| 3 transaction_open at Checks | "resume or abort it first" with only "Try again" | | blocks | handover.ts:234; controller/handover.ts:247,262,266 |
| 3 Big copy | Bar per row; no overall bar/ETA; placeholder shows no progress | | annoys | HandoverSheet.tsx:73-85; TerminalArea.tsx:75 |
| 3 Point of no return | "Verifying and committing" lumps abortable with not; Abort just disappears | | polish | handover.ts:15,220 |
| 3 Done | "The fleet runs on studio now…" | Good | – | handover.ts:417-423 |
| 4 Far side down | Banner with raw stderr, name twice, "cached route", "generation"; no action | | annoys | host.ts:81-92; connection.ts:119,172,239-261 |
| 4 Launch while far down | Connect screen with only that text | | annoys | App.tsx:72-79 |
| 4 Version mismatch | "…protocol 23, not 24" + Upgrade | Good | polish | App.tsx:37-41,101 |
| 4 Quit | Good | – | – | QuitFlow.swift:131-137 |
| 5 Relaunch, stopped part way | Headline is raw verdict with UUIDs | | annoys (H) | handover.ts:414; controller/recovery.ts:159-190; e2e/handover.spec.ts:292,303,336 |
| 5 Forget | Same | | annoys | recovery.ts:166,190 |
| 5 Lost machine/gateway | Banner forever; app never names fleet recover | | blocks | handover.md:241-245 |
| 6 Open another fleet | From a remote fleet's only window, user needs svall <name> | | annoys | FleetPicker.tsx:77 |
| 6 Sleep/Delete while frozen | Refused only after click | | polish | LoadPanel.tsx:52-53; ownership/state.ts:96-102 |

## B. Terminal drops not acceptable even for experimental
transaction_open/generation_mismatch at Checks (app could offer Resume/Abort). Lost gateway: app must name the command.

## C. Copy problems
Raw verdict reasons (handover.ts:414 ← recovery.ts:159-190; handover-view.ts:258). UUIDs in Machines panel (controller/host.ts:734, 418, 432; HostSetup.tsx:46). Jargon: "Companion", "Registry", "Final probe", "control master", "gateway", "generation", "manifest", "cached route". No next step: banner; generation_mismatch; transaction_open. Wrong next step: "ready for handover" before gateway. App vs CLI wording: Abort/"c) Cancel" (handover-view.ts:109); folders/"roots" (:150); Retry/--resume; Check/doctor; Forget/remove --forget.

## D. ce239b8d (sheet restructure, now on the PR branch)
Route header, scrolling body, fixed footer; blockers split problem/remedy/prompt with ✓/Undo; overall transfer bar; copy tweaks. Fixes none of the top three. Two regressions: claude_trust/claude_bypass folded into "N notes"; "Show in Finder" on destination blockers wrong both ways (ShellRouter.swift:242-244).

## E. Ranked improvements
| # | Improvement | Value | Cost | When |
|---|---|---|---|---|
| 1 | Headline from standing/safe/phase with machine names; real-shaped e2e fixtures | H | S | before merge |
| 2 | Point to fleet recover / handover status in "nothing is safe" and long-unreachable banner | H | S | before merge |
| 3 | transaction_open/generation_mismatch at Checks: status, Resume/Abort | H | S-M | before merge |
| 4 | Review step after Checks before freeze; preflight-only controller mode | H | M | before flag removal |
| 5 | Machines list with per-row actions | H | M | before flag removal |
| 6 | Next-step buttons after Add/Enable; no-gateway button | M | S | before merge |
| 7 | Copy pass for panel and banner | M | S | before flag removal |
| 8 | Hints for ~20 blocker codes, code shown small | M | S | before flag removal |
| 9 | Flag toggle in Settings | M | S | before flag removal |
| 10 | Transfer ETA; placeholder progress; trust warnings outside fold | M | M | before flag removal |
| 11 | macOS notification on decision wait / completion | M | S | later |
| 12 | Align CLI/app wording; Open Fleet from remote window; disable Sleep/Delete while frozen | L | S-M | later |
