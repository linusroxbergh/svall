# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Marketing site: a static page in `site/`, with a demo map `pnpm site:build` builds from the app's own code. The product itself is a macOS app (Swift shell around a React webview) with a Node daemon and CLI.

## Users

Developers on a Mac who run several Claude Code, Codex or OpenCode agents at once, across projects, and lose track of which one is working, which is waiting on them and which is done.

## Product Purpose

Svall is a macOS map of your coding agents. Every terminal is a character on an island, so one glance shows which agents are working, blocked or done. Success is a developer running many agents without tab-hunting or losing sessions.

## Positioning

The fleet is a place, not a list: islands per project, characters per terminal, status you read from across the room. Sessions live in tmux under a daemon that runs while the app is open; quitting stops them, and opening a character resumes its agent's conversation, as after a reboot.

## Operating Context

Runs on macOS 15+ on Apple silicon. Wraps the Claude Code, Codex and OpenCode CLIs the user already has; no AI account or billing of its own. Phone access over Tailscale. `svall` CLI scripts the fleet.

## Capabilities and Constraints

- Islands group characters; each card shows status, context use, model, PR and ticket links.
- Terminals are tmux windows; revive resumes with `claude --resume`, `codex resume` or `opencode -s`.
- Briefs carry instructions, links and agents' notes into every new session.
- Browser, file editor and working-tree diff beside each terminal.
- macOS banners with Approve and Deny; phone app with push notifications.
- Install: the notarized DMG from svall.dev, `curl -fsSL https://svall.dev/install.sh | sh`, or from source with `git clone` then `pnpm desktop:install`. The repository is public.
- Alpha.

## Brand Commitments

- Name: Svall (Swedish for the swell of water that washes in behind a boat).
- Visual world: the app's night sea, sand and sage-grass island (`apps/desktop/web/src/tokens.css`), and the bare round island icon (`apps/desktop/web/public/icons/icon.svg`).
- The animal portraits and lighthouse are licensed Flaticon art (`apps/desktop/web/public/animals/LICENSE`): never in a logo or icon. The site's demo cards show the portraits, as the app's cards do, at the owner's request.
- The site matches the app's map: its sea, grain, island drawing, label pills and cards at their real size.

## Evidence on Hand

- Real app screenshot: `assets/svall_overview.jpg` (shows work-specific names; not for the site).
- No users, stars, testimonials or benchmarks to cite. Do not invent any.

## Product Principles

- Glanceable over exhaustive: status first, detail on demand.
- Nothing is lost: a character resumes its agent's conversation after a quit or a reboot.
- Bring your own agents: wrap the CLIs people already trust.
