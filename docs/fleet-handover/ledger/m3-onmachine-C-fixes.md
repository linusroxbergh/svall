# M3 Part C fix wave: Q1–Q3 (binding)

Source: W/m3-onmachine-C-report.md, the "Defects (so far)" section (C-D1–C-D3) and steps 2a/2b (logs
x1/x2). Each item carries the controller's ruling. The spec wins over anything here that contradicts it.

Q1 (Important, C-D1). No carried Codex character is ever activated.
- Codex 0.156.1 sends no SessionStart when `codex resume <id>` starts; it runs that hook with the
  session's first turn.
- The destination waits up to 60 s for a SessionStart for every agent kind (destination.ts:526
  `waitStart`, SESSION_START_MS at :73), so every Codex character ends `ok:false`.
- `lay()` then closes a healthy Codex window that is idle at its prompt, and the error blames a trust
  prompt that was never shown (:532-535).
- Evidence (x2): the folder was trusted and Codex had resumed and sat idle 6 s into activate; it still
  failed at 60 s.

Ruling: activation readiness depends on the agent kind.
- Claude keeps the SessionStart wait: Claude sends SessionStart on `--resume`.
- A kind whose resume sends no SessionStart (Codex, per its adapter) counts as up once its pane's
  foreground process is that agent's kind and has stayed so for a short settle period. `holding()` /
  ProcessTable already classify kinds.
- A slot whose process exits or never appears within the wait still fails. It stays dormant with its
  transcript and an error that names what was actually seen.
- When the destination does not trust the folder (see Q2), a Codex slot that is up at its trust prompt
  is up. Its row carries a notice that the prompt waits in the window, and the window stays open.
- The trust-prompt wording appears only when that is the cause.

Put the "sends SessionStart on resume" fact in the session adapter for each kind, not as a
kind-name check in destination.ts.

Test: a Codex slot with no SessionStart activates `ok` inside the settle period, and its window is kept.
A Codex slot whose process exits still fails dormant.

Q2 (Minor, C-D2, folded because Q1's notice depends on it). The `codex_trust` preflight warning fires
whether or not the destination already trusts the folder. In x2 it warned while the Mac's config.toml
held `trust_level = "trusted"` for that path.

Ruling: the destination's inspect reads its own Codex config (CODEX_HOME honoured). It warns only for
carried Codex cwds it does not already trust, and exposes the same fact to activation for Q1's notice.

Test: a trusted path gets no warning; an untrusted one does.

Q3 (Minor, C-D3, promoted: fails open against the spec). A failed resume's error does not outlive the
handover. After Complete, neither machine's state.json holds the error for the character. It is dormant
with `revive`, and the text survives only in the handover result, the controller's events.ndjson
(rewritten by the next run) and archid.log. The spec says such characters "remain dormant with their
transcript and a visible error".

Ruling: the destination records the activation error on the character in fleet state and keeps it
until that character's next successful revive or start. The app shows it wherever it shows a dormant
character's state; find the existing per-character error or notice mechanism, and add one only if
none exists. The field is optional and additive.

Test: after a failed activation and Complete, state holds the error. A later successful revive clears it.

Not in this wave:
- The Claude onboarding step that empties the credentials it finds is a test-environment risk, not
  product code. The pass seeds `hasCompletedOnboarding`.
- The owner's Mac Claude auto-updated to 2.1.281, and preflight correctly blocks it
  (`incompatible_adapter`). Keeping the supported range current is the Task 38/39 process already
  carried.

Verification: a failing test first for each item. Run the covering suites while iterating. At the
end, run typecheck and the archid, cli and protocol full suites once. If you touch the web, also run
the web unit suite and the Playwright specs that cover the changed UI. Known load flakes (rerun them
alone; they are not findings):
- archid: fleet.test.ts revive tests, "marks the agent working" and "deactivate timeout"; e2e "two
  turns against a fake claude"; the processes.test.ts real-ps case; the source.test.ts FIFO timer.
- cli: the cli.test.ts browser test; the ssh.test.ts spawn-count test.
- web: e2e/ide.spec.ts:136 and e2e/keys.spec.ts:3.
