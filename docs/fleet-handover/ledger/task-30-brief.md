### Task 30: Serve path-scoped fleet PWAs from the gateway

**Depends on:** M3 and Task 4 relay decisions

**Files:**

- Create: `packages/archid/src/gateway/http.ts`, `mobile-assets.ts`, `fleet-routes.ts`
- Modify: mobile Vite config/service worker/manifest generation
- Modify: existing `packages/archid/src/mobile.ts`
- Create: `packages/archid/test/gateway/mobile-assets.test.ts`

**Steps:**

- [ ] Move production mobile assets into the companion/gateway release; remove runtime pnpm builds
  from published `mobile on`.
- [ ] Serve each fleet under `/f/<fleetId>/` with correct base URLs, manifest `start_url/scope`, icons
  and service-worker registration confined to that path. Tailscale Serve strips its mapping prefix
  before proxying, so every absolute URL the gateway emits comes from a configured public base, not
  from `req.url`.
- [ ] Configure one Tailscale Serve HTTPS mapping for the gateway service rather than one special port
  per fleet: `tailscale serve --bg --yes --set-path <path> http://127.0.0.1:<port>`, removed with
  `tailscale serve --https=443 --set-path <path> off`, never the bare `--https=443 off` that drops
  every handler on the port.
- [ ] Add gateway fleet-route records with enabled/name/login policy/current generation; update them
  from authenticated controller/owner channels only.
- [ ] Keep legacy owner-local mobile serving available during migration but prevent both URLs being
  presented as canonical after gateway enablement.
- [ ] Return a stable offline shell when no owner relay is connected.

**Verify:** gateway asset tests plus mobile build; manual Add to Home Screen from the gateway URL.

**Commit:** `The gateway gives every fleet one stable phone origin`

