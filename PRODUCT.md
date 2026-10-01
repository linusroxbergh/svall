# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Marketing site: static HTML/CSS in `site/`, no build step. The product itself is a macOS app (Swift shell around a React webview) with a Node daemon and CLI.

## Users

Developers on a Mac who run several Claude Code or Codex agents at once, across projects, and lose track of which one is working, which is waiting on them and which is done.

## Product Purpose

Svall is a macOS map of your coding agents. Every terminal is a character on an island, so one glance shows which agents are working, blocked or done. Success is a developer running many agents without tab-hunting or losing sessions.

## Positioning

The fleet is a place, not a list: islands per project, characters per terminal, status you read from across the room. Sessions live in tmux under a daemon, so quitting the app loses nothing and a reboot resumes each agent's conversation.

## Operating Context

Runs on macOS 15.6+. Wraps the Claude Code and Codex CLIs the user already has; no AI account or billing of its own. Phone access over Tailscale. `svall` CLI scripts the fleet.

## Capabilities and Constraints

- Islands group characters; each card shows status, context use, model, PR and ticket links.
- Terminals are tmux windows; revive resumes with `claude --resume` or `codex resume`.
- Briefs carry instructions, links and agents' notes into every new session.
- Browser, file editor and working-tree diff beside each terminal.
- macOS banners with Approve and Deny; phone app with push notifications.
- Install today: `git clone` then `pnpm desktop:install`. The repository is private (invited testers). No downloadable build yet.
- Alpha 0.1.

## Brand Commitments

- Name: Svall (Swedish for the swell of water that washes in behind a boat).
- Visual world: the app's night sea, sand and sage-grass island (`apps/desktop/web/src/tokens.css`), and the bare round island icon (`apps/desktop/web/public/icons/icon.svg`).
- The animal portraits and lighthouse are licensed Flaticon art (`apps/desktop/web/public/animals/LICENSE`): never in a logo or icon. The site shows a few portraits on its demo cards, as the app does, at the owner's request.
- The site matches the app's map: its sea, grain, island drawing, label pills and cards at their real size.

## Evidence on Hand

- Real app screenshot: `assets/svall_overview.jpg` (shows work-specific names; not for the site).
- No users, stars, testimonials or benchmarks to cite. Do not invent any.

## Product Principles

- Glanceable over exhaustive: status first, detail on demand.
- Nothing is lost: sessions outlive the app, the daemon and reboots.
- Bring your own agents: wrap the CLIs people already trust.
