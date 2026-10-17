# Claude Code portability probe (2026-09-21)

## Verdict and scope

Claude Code **2.1.278** can resume a completed conversation after its JSONL and subagent sidecars
are copied to a new project-path slug and the live cwd metadata is remapped. This was verified with
both `-p --resume <id>` and interactive `--resume <id>` on macOS. The same session remembered a
pre-transfer marker, showed its earlier Bash and subagent turns, ran `pwd` in the destination, and
appended new turns only to the destination transcript (source: 41 lines before/after; destination:
41 before and 53 after the first resumed turn).

This is evidence for the session-format strategy, **not** a claim of cross-OS or independent-auth
compatibility. The live test used two different temporary workspace/home-shaped paths but the
same authenticated macOS Claude config directory. Setting a separate `HOME` or
`CLAUDE_CONFIG_DIR` reported `loggedIn: false`; a second machine must log in independently. We did
not copy credentials, user settings, plugins or real conversations into this repository.

## Reproducible observations

- A `SessionStart` hook received `session_id` and `transcript_path`; the latter pointed to an
  existing `<config>/projects/<cwd-slug>/<uuid>.jsonl`. The hook run used `--setting-sources project`
  plus an explicit disposable `--settings` hook, so the user's normal hooks were not required.
- For this version, the project slug replaced non-alphanumeric cwd characters with `-`.
- A completed `Agent` call produced
  `<project>/<uuid>/subagents/agent-*.jsonl` and a matching `agent-*.meta.json`. Those were copied.
  No `sessions-index.json` or file-history content was created by this disposable session, although
  both forms exist in other observed Claude projects. The test fixture covers a scoped index.
- A `session-env/<uuid>` directory existed but was empty. The probe deliberately excludes
  `session-env` because it could contain secrets; the real resume succeeded without it.
- The project transcript's `cwd` metadata changed to the destination path. Historical user text,
  tool arguments and Bash output still mention the source path; those are evidence and must not be
  blanket-rewritten. The handover's SessionStart context should tell the agent about new paths.
- Interactive resume prompted to trust the new project folder, then rendered prior turns and
  accepted a new prompt. Published setup must not treat that trust prompt as an auth failure.

## Commands and fixtures

Check the supported binary and login separately on each machine:

```bash
claude --version
claude auth status
```

The live source used a disposable cwd, `claude --safe-mode -p --session-id <uuid> --model haiku
--allowedTools 'Bash(pwd)' --output-format json <prompt>`, followed by a turn with
`--allowedTools Agent`. Safe mode avoided user hooks/plugins during the content test. The separate
hook test used `scripts/spikes/probe-claude-hook.mjs` with an explicit `SessionStart` command hook, and
recorded only hook name, session id and transcript path. To verify app integration, Svall's
installed `SessionStart` hook should be checked for the same fields, then the actual captured
`transcriptPath` passed to the adapter. Hook registration lives in `packages/svalld/src/setup.ts`
and normalization in `packages/svalld/src/hooks/receiver.ts`.

`scripts/spikes/probe-claude-handover.mjs <transcript> <source-cwd> <destination-cwd>
<destination-config-dir>` copies only the selected UUID transcript, its project-local sidecars,
an optional per-session index entry and optional file-history directory. It rejects existing
destination transcripts and session symlinks. It does not copy auth/config files or `session-env`.
This is a probe, not the production adapter. The adapter (`packages/svalld/src/handover/sessions/`)
copies the transcript and the session's own folder byte for byte to the same path, and carries every
Claude Code release from its minimum on.

The checked-in JSONL, index and sidecar fixtures are synthetic. They preserve observed structural
fields but contain no real prompt, tool result or credential. Run:

```bash
pnpm vitest run --project svalld test/handover/claude-portability.test.ts
pnpm typecheck
```

## Remaining gate for full release confidence

Run the same copied session under a separately authenticated Linux Claude Code installation at a
different user/home path and version-match the CLI. The current test demonstrates an actual moved
project path and interactive resume, but not a distinct account/config or OS. Treat those as
release integration checks, not as already proven by this fixture.

## Versioned session fixtures

`2.1.251/` and `2.1.280/` are real sessions laid out as a Claude config folder
(`projects/<slug>/<id>.jsonl` and the session's `subagents/`), one made by each release with
`--safe-mode -p`: a Bash `pwd`, an Edit and a general-purpose subagent. 2.1.280 ran on macOS and
2.1.251 on Ubuntu 24.04. They were sanitized by replacing the home and probe paths with
`/Users/source` or `/home/source`, emails with `user@example.invalid`, thinking signatures with a
placeholder, and any string over 600 characters with its first 200. Record structure is unchanged.
`test/handover/sessions.test.ts` checks the session adapter against each of them.
