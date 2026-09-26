# Task 41 probe — an unchanged copy resumes on a machine with the same home path

Run by the orchestrator on 2026-09-26, before any Task 41 code change. Plan Task 41 step 1: "copy one real Claude
session and one real Codex rollout unchanged into a linus-vault throwaway account whose home is the Mac's home path,
and resume each there. If either resume fails, stop and amend the spec." Both resumed, in both directions. The spec
stands.

## Setup

- Linux: `archi-m3b` on linus-vault, home `/Users/Shared/archi-m3b` (from Task 40b). The Mac test HOME is the same
  path.
- Claude: made on the Mac with the owner's normal login (approved) by `claude` 2.1.283, cwd
  `/Users/Shared/archi-m3b/probe/claude`, session `b6fe14c9-1739-4047-8f6a-32c1fef83f65`, prompt "Remember the code word
  PELICAN". The file lands at `~/.claude/projects/-Users-Shared-archi-m3b-probe-claude/<id>.jsonl` (30 lines). On
  archi-m3b: `claude` 2.1.283 linux-x64 downloaded from downloads.claude.ai with its manifest checksum into
  `~/agents/claude-2.1.283` (off PATH; `~/.local/bin/claude` stays the mock), and the owner's Mac keychain credential
  copied to `~/.claude/.credentials.json` (0600; 1.96 h left on the access token, unchanged after the run, so no
  refresh happened).
- Codex: made on the Mac by Codex 0.156.1 with a probe-only `CODEX_HOME=/Users/Shared/archi-m3b/probe/codex-home`
  (auth.json copy, no hooks), cwd `/Users/Shared/archi-m3b/probe/codex`, `codex exec --skip-git-repo-check`, session
  `01a0ddf1-4f61-71e3-bf22-3a40a04f4b26`, prompt "Remember the code word HERON". On archi-m3b: Codex 0.156.1 linux musl
  (Task 40b's copy), the same `CODEX_HOME` path with archi-m3b's own auth.json.
- Copy: `scp -p` of the one session file each, to the same absolute path (Claude: under the destination's
  `~/.claude/projects/<same slug>`), nothing else. sha256 equal on both sides before each resume.

## Results

| Step | Command | Result |
| --- | --- | --- |
| Mac → Linux, Codex | `codex exec --skip-git-repo-check resume 01a0ddf1-… "What was the code word…"` | exit 0, `HERON`, session id `01a0ddf1-…` unchanged, appended to the same rollout (29 lines) |
| Mac → Linux, Claude | `claude-2.1.283 --resume b6fe14c9-… -p "What was the code word…" --output-format json` | exit 0, `PELICAN`, `session_id` `b6fe14c9-…` unchanged, the same file grew 30 → 44 lines, no second session file |
| Linux → Mac, both | the grown files copied back unchanged (sha256 equal), then the same resumes on the Mac | Claude `PELICAN`, session id unchanged; Codex `HERON`, session id unchanged |

## Left behind

- Mac: `/Users/Shared/archi-m3b/probe/` (inside the test HOME; the teardown removes it) and the probe session in the
  owner's `~/.claude/projects/-Users-Shared-archi-m3b-probe-claude/` (one session, harmless; delete with that folder).
- archi-m3b: `~/agents/claude-2.1.283`, `~/.claude/.credentials.json` (the owner's Mac login — the account's teardown
  removes it), `~/probe/`, `~/.claude/projects/-Users-Shared-archi-m3b-probe-claude/`; a real Claude run leaves
  `/tmp/claude-1002`, which the teardown recipe covers.
