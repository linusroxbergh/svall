Svall's public feedback endpoint creates issues in `FEEDBACK_REPO` using a GitHub App installation. CORS allows the
app's web view; direct HTTP clients can also submit, so it is not an authentication boundary.

POST requests consume the approximate per-IP limit of 5/minute before any body is read. Bodies are limited to
256 KiB of streamed bytes, including when Content-Length is absent or incorrect. Invalid reports never reserve a
submission slot. A second approximate, per-location limit of 30/minute sheds load before calling durable storage.

All locations reserve through the same `FeedbackBudget` Durable Object, named for `FEEDBACK_REPO`. It atomically
enforces rolling limits of 30/minute and 300/24 hours. Only timestamps are stored, at most 300 rows, with expired
rows pruned on the next reservation. Reservations survive object restarts and deployments. Failed GitHub calls
still consume a slot, so upstream failures cannot permit an unlimited retry loop. Budget failures return 503
without contacting GitHub. A denied reservation returns 429 with Retry-After.

Deploy with `pnpm exec wrangler deploy --config services/feedback/wrangler.jsonc`. This creates the SQLite-backed
Durable Object on the first deployment; keep the migration and class export in subsequent versions, including
any rollback. GitHub credentials remain Worker secrets (`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`,
`GITHUB_PRIVATE_KEY`). The workers.dev and preview URLs stay disabled.

For an emergency stop, set `FEEDBACK_ENABLED` to `false` in the config and deploy (or change the Worker variable
in Cloudflare). The configured value is reapplied on deployment. This returns 503 before reading POST bodies or
reserving slots. Keep `FEEDBACK_REPO` and the object name stable across deployments to preserve the existing
budget. The constants in `src/budget.ts` set the rolling limits; adjust them deliberately as feedback grows.

`pnpm test --project feedback` includes actual SQLite budget tests, streamed-body regressions, and a local
Cloudflare runtime test for concurrent reservations and persistence. None of these contact GitHub or production.
These limits bound submissions and GitHub work; requests rejected inside the Worker still count as invocations.
