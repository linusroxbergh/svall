# Codebase facts for Task 4 (gathered read-only, 2026-09-21)

Build/run today: no bundler. Root package.json: engines node >=22; `archid` = `tsx packages/archid/src/bin.ts`, `archi` = `tsx packages/cli/src/main.ts`; tsx ^4.19 devDependency. packages/archid and packages/cli have no `bin`/`main`/build; archid `exports` point at .ts source. The launchd plist (packages/archid/src/setup.ts:196-199) runs `node_modules/.bin/tsx packages/archid/src/bin.ts` from the repo checkout. apps/desktop/mac/build.sh copies only the Swift shell, Ghostty resources and apps/desktop/web/dist into the .app; no JS or Node runtime. scripts/desktop-install.sh runs pnpm install, builds web + mobile via vite, then `pnpm archi -p private setup`.

Runtime path resolution that breaks under a single-file bundle installed elsewhere:
- packages/archid/src/setup.ts:134 hooksSrc = `<dir of setup.ts>/../hooks` (packages/archid/hooks) via import.meta.url
- packages/archid/src/setup.ts:151 template = `<dir of setup.ts>/../home` (packages/archid/home)
- packages/archid/src/api/bundle.ts:4 MOBILE_DIST = `../../../../apps/desktop/web/dist-mobile` from api/bundle.ts (monorepo root climb)
- packages/archid/src/mobile.ts:18 REPO_ROOT = `../../..` from mobile.ts; used as cwd for `pnpm --filter @archipelago/desktop-web build:mobile` (mobile.ts:47-48) and lazily at mobile.ts:105 when dist is missing
- tmux config is generated as a string (packages/archid/src/tmux/conf.ts:8-30), no file lookup; conf.ts:18 sets copy-command "pbcopy"

Dependencies (all pure JS): archid: @archipelago/protocol, fast-json-patch, qrcode, smol-toml, web-push, ws, zod. cli: @archipelago/archid, @archipelago/protocol, commander, qrcode, ws. No native addons.

Spawned binaries: claude (claude.ts:31), git (workspace/git.ts:9), tmux (tmux/control.ts:29), codex (scribe/codex.ts:34), tailscale + pnpm via execFile (mobile.ts:20 candidates incl. /Applications/Tailscale.app/Contents/MacOS/Tailscale), launchctl (setup.ts:200-203).

Mobile today: `tailscale serve --bg --yes --https=<port> <target>` (mobile.ts:60-61), off via `tailscale serve --https=<port> off`, status via `tailscale serve status --json`, host via `tailscale status --json`. VAPID at paths.vapid (home/vapid.json, push/vapid.ts), subscriptions at paths.push (home/push.json, push/store.ts), both mode 0600.

WebSocket: `ws` ^8.18 only. Server: packages/archid/src/api/server.ts:82 `new WebSocketServer({ noServer: true, maxPayload })` on a plain http server; hello/auth (close 4401 on timeout), JSON Request dispatch via ./methods.js; phone identity from Tailscale headers via identityOf/originAllowed (server.ts:55-66), key stripping stripKey (server.ts:44-52). Static phone assets via api/static.ts serveBundle.
