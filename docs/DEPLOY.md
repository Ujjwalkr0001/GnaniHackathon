# Deployment

The active deployment is on Render. Follow [the Render deployment guide](../deploy/render/README.md). GitHub Actions runs CI checks; Render deploys from the connected repository. The Fly.io plan below is retained as historical design notes and is not an active deployment workflow.

## Status

The original Fly.io staging and production plan was not run. The current Render setup and required environment variables are documented in the Render guide linked above.

## Topology

One always-on container serves REST, browser WebSockets, Twilio Media Streams and the built SPA. Postgres stores tenant-scoped durable records, opaque session hashes and pg-boss jobs. Active media sockets stay on their owning process. Start with **one machine**: `fly scale count 1 --app <app>`.

Vercel Functions are unsuitable for this WebSocket server: [Vercel limitations](https://vercel.com/docs/functions/limitations). The prototype works locally because its dev runner forwards upgrade events; exporting an `http.Server` from a function does not deploy that topology.

Fly's [current regions list](https://docs.fly.io/reference/regions) includes Singapore (`sin`), with managed Postgres support, and does not list Mumbai. `fly.toml` selects Singapore provisionally. Confirm availability with `fly platform regions`; measure Gnani and Twilio paths before claiming a latency advantage. Twilio's [Media Streams regions](https://www.twilio.com/docs/voice/media-streams) differ from its edge choices; Singapore hosting is not proof of nearest media routing.

## Local source run

Requires Node 22+, pnpm 10.28 and Docker. The example local database password is intentionally public and must never be used remotely.

```sh
corepack enable
corepack prepare pnpm@10.28.0 --activate
pnpm install --frozen-lockfile
docker compose up -d postgres
cp .env.example .env
# Set DATABASE_URL to the compose caller URL. For offline testing explicitly set MOCK_MODE=true.
# Set SEED_ADMIN_EMAIL and a local SEED_ADMIN_PASSWORD with 12+ characters.
pnpm db:migrate
pnpm seed
pnpm build
pnpm start
```

Compose database user is `caller`; the tests' default test URL uses `postgres`. Set `TEST_DATABASE_URL=postgres://caller:local-development-only@localhost:54329/caller` when using Compose. The local verification environment used a separate container with user `postgres` on that port. Do not run both on the same port.

`docker compose up --build -d` runs the complete app + DB in explicit local simulation mode. `docker compose exec app node scripts/dist/seed.js` creates sample data. Open http://localhost:3000. API keys are not required for simulation. Stop with `docker compose down` (omit `-v` to keep data).

## Provision staging and production

1. Sign in to Fly (`fly auth login`), create two unique apps, and set each GitHub environment's `FLY_APP` and `PUBLIC_BASE_URL` variables. Override the placeholder app name using `--app`.
2. Provision separate managed Postgres databases in a nearby region. Enable and verify point-in-time recovery in the provider console; this repository cannot enable an account's backup plan. Use a least-privilege application role that can create the application's tables and pg-boss schema during release.
3. **pg-boss needs persistent PostgreSQL sessions and advisory locks.** Use a direct connection or a session-mode pool. Do not point the entire application at a Neon transaction-mode pooled URL. To use Neon, use its direct endpoint for this implementation. This is a deliberate correction to the proposed pooled-URL topology.
4. Set secrets separately for each app. Never paste real values into git, workflow YAML, screenshots, issue comments or logs.

```sh
fly secrets set --app <staging-app> DATABASE_URL='<managed-direct-url>' PUBLIC_BASE_URL='https://<staging-host>' SESSION_SECRET='<random-32+-character-secret>' WEBHOOK_SIGNING_SECRET='<independent-random-secret>' GNANI_STT='<prisma-key>' GNANI_TTS='<timbre-key>' GROQ_API_KEY='<groq-key>' SEED_ADMIN_EMAIL='<admin-email>' SEED_ADMIN_PASSWORD='<strong-initial-password>'
fly secrets set --app <staging-app> TWILIO_ACCOUNT_SID='<sid>' TWILIO_AUTH_TOKEN='<token>' TWILIO_PHONE_NUMBER='<e164>'
fly deploy --remote-only --app <staging-app>
fly scale count 1 --app <staging-app>
fly status --app <staging-app>
```

`fly.toml` runs `node scripts/migrate.mjs` as the release command. It contains health checks, non-autostopping configuration and a starting shared CPU/1 GB VM size; those are deployment settings, **not capacity claims**. The non-root image runs under `tini` and includes production dependencies only.

Gnani speech is the default. `GROQ_API_KEY` powers Groq's Qwen 3.8 27B dialogue and post-call notes. Explicit `DIALOGUE_PROVIDER`, `DIALOGUE_MODEL`, `DIALOGUE_URL` and `DIALOGUE_API_KEY` can select another compatible model. Text streaming and JSON-object support must be verified for a chosen model. Gnani handles STT and TTS.

For an explicitly simulated public staging demo only, additionally set `MOCK_MODE=true ALLOW_DEPLOYED_SIMULATION=true`. The UI must keep its simulation banner. Remove them and verify live providers before claiming a live demo.

## Twilio wiring

Set the number's Voice webhook to `POST https://<host>/twilio/voice`; outbound calls attach the internal call ID query parameter through the adapter. Status callback: `/twilio/status`; stream: `wss://<host>/twilio/media`. In deployment, `PUBLIC_BASE_URL` can also be the webhook origin. For local tunnel development, keep `PUBLIC_BASE_URL` as the dashboard origin and set `TWILIO_WEBHOOK_BASE_URL` to the exact public HTTPS origin without a trailing slash. Twilio signs the full URL, including its query string. Do not disable signature checks to debug a mismatch. Inspect proxy path/scheme and Twilio's [signature guidance](https://www.twilio.com/docs/usage/security), including the documented WSS trailing-slash caveat.

Trial accounts restrict verified destinations. Commercial India outbound calling requires suitable provider routing, permissions and operator compliance; verify with Twilio before any commercial campaign. Only teammates' consented phones belong on test allowlists. No live phone calls were placed during this build.

## CI/CD and checks

`ci.yml` runs Node/pnpm installation, typecheck, lint, unit and Postgres integration tests, build, migration/seed, browser E2E tests, and a Docker build. Render handles deployment from GitHub. The former Fly.io `deploy.yml` workflow was removed because this repository has no Fly app or token configured.

```sh
SMOKE_BASE_URL=https://<staging-host> pnpm smoke
# Optionally set SMOKE_DESTINATION_ID for an approved synthetic public receiver.
RUN_LIVE_GNANI=true GNANI_SPIKE_PCM=<synthetic-pcm-file> pnpm spike:gnani
RUN_LIVE_EVAL=true pnpm eval
MOCK_MODE=true pnpm exec tsx scripts/loadtest-media.ts
```

Smoke creates and deletes a sample campaign, verifies login and browser handshake, but does not start chargeable speech. Destination test-send is explicit and is skipped without `SMOKE_DESTINATION_ID`.

## Draining, scaling and recovery

Deploy outside calling windows. A restart ultimately drops a socket. SIGTERM stops new dial reservations, waits up to `DRAIN_SECONDS` (25 by default), finalizes remaining calls as failed, flushes results and stops pg-boss. Fly waits 45s. A maintenance worker marks unowned calls stale after 12 minutes. It retries persisted delivery outboxes and callback scheduling. It does not magically restore an interrupted conversation.

The measured local media observation is in [LOADTEST.json](LOADTEST.json) and [EVAL.md](EVAL.md). No Fly/live-provider concurrency N has been established. Raise concurrency only after a sustained staging load test with actual resources and explicit budget limits. Connection limits in `fly.toml` include dashboard/monitor connections and are not an audio-call capacity guarantee.

Do not scale to multiple machines without sticky ownership for active calls and monitor fan-out. Database records are shared, but live monitor subscriptions are process-local; Postgres LISTEN/NOTIFY fan-out is not implemented. Queued calls use durable reservations and must not be resumed on a different machine as if audio survived.

## Alternatives

Railway or Render: persistent web service, WebSocket support, same image, external managed Postgres, always-on billing tier. VPS: Docker + Caddy TLS/reverse proxy, Postgres with verified backups, graceful shutdown and uptime monitoring. Do not replace the persistent service with a serverless function.
