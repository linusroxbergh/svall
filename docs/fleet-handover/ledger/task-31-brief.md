### Task 31: Implement the authenticated owner relay and phone RPC proxy

**Depends on:** Tasks 16, 30

**Files:**

- Create: `packages/archid/src/gateway/relay-server.ts`, `relay-protocol.ts`
- Create: `packages/archid/src/relay/client.ts`
- Modify: `packages/archid/src/main.ts`, `api/server.ts`, phone viewer handling
- Create: `packages/archid/test/gateway/relay.test.ts`, `packages/archid/test/relay-client.test.ts`

**Interfaces:** multiplexed frames for register/RPC/response/event/terminal/heartbeat; fleet relay
secret; signed/contained viewer identity; one active relay matching authority generation.

**Steps:**

- [ ] Generate the relay secret on first gateway mobile enable, store it mode 0600 and provision it
  to current/future owners outside portable state and rsync. Derive the viewer-identity signing key
  from it rather than adding a second provisioned secret.
- [ ] Have an owner connect outbound over WSS, authenticate fleet/machine/generation and reject a
  second owner or stale generation.
- [ ] Authenticate phone requests only through Tailscale Serve identity, enforce `mobile.logins`,
  and strip/ignore client-supplied identity headers.
- [ ] Proxy the existing mobile RPC surface and terminal binary/base64 stream with request ids,
  cancellation, backpressure limits and disconnect cleanup.
- [ ] On the owner, trust forwarded login only inside the authenticated relay context; ordinary API
  sockets cannot claim it. Task 4's contract test covers the gateway side only, so this needs its
  own test: an ordinary API socket presenting a relay-shaped identity frame must be refused.
- [ ] Heartbeat/reconnect with bounded backoff; show the stable offline page rather than redirecting
  to an owner-specific origin.

**Verify:** relay contract/unit tests, mobile terminal e2e through gateway, stale-generation attack
test.

**Commit:** `The phone securely follows the current fleet owner`

