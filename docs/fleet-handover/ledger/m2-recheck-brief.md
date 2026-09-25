# M2 gate — on-machine re-check after the fix wave (brief)

The first on-machine pass (m2-onmachine-report.md) ran at 11f3f3d. The fix wave (11f3f3d..349d161,
m2-fix-wave.md F1–F29, m2-fix-report.md) claims to fix what it found. Re-run the parts a real machine
can prove, at HEAD 349d161. Same authorisation and hard limits as m2-onmachine-brief.md — read its
"Authorised by the owner" section and obey it exactly (throwaway user `archi-m2` on linus-vault,
created and deleted by you; nothing else there changes; never tailscale serve/funnel/set; temp HOME +
ARCHI_APP_DEST + --no-launchctl on the Mac; never write the owner's known_hosts or real files).
Reuse the first report's scripts and hand steps where they still apply.

## Re-check, each PASS / FAIL / NOT RUN with evidence
R1 (F15) `host add` (bundled helper, --release, no tty) leaves archipelago-gateway.service enabled and
   active with no hand step; `host doctor` reports the gateway; `host enable` for a local test fleet
   seeds the authority without H1.
R2 (F17) kill -9 the archid main PID and `systemctl --user restart` it: the tmux server pid and pane
   pids survive both.
R3 (F18) the remote ~/.claude/settings.json hooks and statusline name a node under `current` that exists.
R4 (F19) a tmux pane's environment has no ARCHI_RELEASE_ROOT.
R5 (F3) with `archi connect --json` online for the remote-owned fleet (hand steps H2–H4 as before; H1 no
   longer needed), run `archi status` and `archi host doctor m2` from the same temp HOME: the helper's
   master, forward and a held remote attach all survive; each process's own master is gone afterwards.
R6 (F29) `-O cancel` the helper's forward: it emits connecting → online within its backoff.
R7 (F5) the master argv carries ServerAlive/ConnectTimeout (ps).
R8 (F4) SIGTERM an `archi host doctor m2` mid-run: no ssh -M -N left behind.
R9 (F11) `host remove m2 --forget` on the reachable machine: the remote units, releases and fleet are
   untouched (compare before/after); then re-add for the rest if needed.
R10 (F12) with a local fleet whose fleet.json names m2 as gateway, `host remove m2` refuses and lists it.
R11 (F16) if a second companion version can be built cheaply (e.g. a different version string), run
   `host upgrade m2` and confirm the archid and gateway pids change and the probe reports the new release;
   otherwise NOT RUN with the reason.
R12 cleanup exactly as the first pass: user, linger, processes, /home/archi-m2 gone; his serve mapping,
   services, unit files and crontab identical to baseline; no Mac ssh masters or helpers left.

Write W/m2-recheck-report.md and reply with the short contract (status, per-item tally, defects with
severity, cleanup confirmation, report path).
