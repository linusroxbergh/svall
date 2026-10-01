---
name: publish
description: Use when the user wants to publish, release or ship a new Svall version to svall.dev, or asks what has changed since the last release.
---

# Publish Svall

Merged PRs reach users only through a release: `pnpm release` builds, signs, notarizes and uploads the DMG and update feed to svall.dev, then tags `v<version>`. The user decides each step; change nothing before they answer.

## 1. Show what's unreleased

- `git fetch origin main 'refs/tags/v*:refs/tags/v*'`. The last release is the newest tag: `git describe --tags --abbrev=0 --match 'v*' origin/main`.
- List the PRs merged since: `git log --merges --first-parent --format='%s%n%b' <tag>..origin/main`, and `git diff --stat <tag>..origin/main`.
- Changes that ship are everything except `site/`, `.claude/`, `.impeccable/`, Markdown files, tests (`test/`, `e2e/`), `scripts/release.sh` and `scripts/site-deploy.sh`. Say which PRs ship and which don't.
- Read `CFBundleShortVersionString` in `apps/desktop/mac/Info.plist` on origin/main. If it is above the tag, it was bumped and not yet released.
- The landing page is live if `curl -s https://svall.dev/ | shasum` matches `git show origin/main:site/index.html | shasum`.
- If nothing ships and no unreleased bump is waiting, there is nothing to release: offer `pnpm site:deploy` if the live page differs, and stop.

## 2. Ask

First AskUserQuestion call:
1. **Publish now?** Yes / Not yet (stop). If nothing ships, say users would get no changes.
2. **Version**: if an unreleased bump is waiting, offer it as is first. Otherwise, counting from the tag: Patch (fixes and small changes) / Minor (a notable feature, or anything that changes behaviour or migrates data) / 1.0.0 (public launch). Show the resulting numbers.
3. **What's new**, shown in the update dialog: your draft of 1–5 plain bullets on what users notice, from the PR titles (show it) / I'll write it / None. Recommend None when nothing users notice changed.
4. **Checks first**: Full (`pnpm test`, `pnpm typecheck`, `pnpm e2e`, ~10 min) / Skip (the release still smoke-tests the built app).

Second call, only for what applies: redeploy the landing page (live page differs); the server, when `SVALL_HOST` (its ssh host) or `SVALL_SITE_DIR` (its site folder) is unset, suggesting both go in the shell profile.

## 3. Bump the version

Skip this when releasing an unreleased bump as is. Otherwise EnterWorktree off origin/main, set `CFBundleShortVersionString`, `plutil -lint` it, commit `Svall <version>.`, push, open a PR (one-line body, no attribution), `gh pr merge --merge`, and ExitWorktree with remove.

## 4. Release from the main checkout

- Leave any worktree first: a worktree-isolated session can't run git in the main checkout, the first path in `git worktree list`.
- There: `git pull --ff-only origin main`. It must be on `main` with `git status --porcelain` empty, or the release refuses; if not, show what's there and ask.
- Write the notes to an absolute path such as `<scratchpad>/Svall-<version>.md`, as Markdown bullets with no heading.
- Shell state doesn't carry between Bash calls, so put the setup, the checks and the release in one background command, logging to the scratchpad: `unset -f node npm npx pnpm 2>/dev/null; export PATH="$(ls -d ~/.nvm/versions/node/v24.*/bin | tail -1):$PATH"; unset SVALL_HOME SVALL_CHAR_ID TMUX TMUX_PANE`, then the checks if chosen, then `SVALL_HOST=… SVALL_SITE_DIR=… SVALL_NOTES=<notes file> pnpm release`.
- It takes ~15 minutes, mostly notarization. A macOS dialog may ask to let `sign_update` use the Sparkle key: the user clicks Always Allow.
- On failure, show the log's last lines. Nothing is uploaded or tagged until the final steps, so fix and rerun with the same version. If it says the DMG is on the server already, that version is used up: bump again.

## 5. Verify and report

- `curl -s https://svall.dev/latest.json` names the new version, and `https://svall.dev/appcast.xml` lists it with the notes.
- If chosen, `pnpm site:deploy` with the same `SVALL_HOST` and `SVALL_SITE_DIR`.
- Tell the user the version and build, and that installed copies offer the update within a day, or at once from Svall → Check for Updates….
