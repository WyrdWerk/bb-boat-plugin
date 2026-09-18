# bb-boat-plugin

A bb plugin that manages a fleet of Boat (boat.dev) sandboxes from the bb web UI:
fork project boxes from a base snapshot, per-project repo manifests, start/stop/delete,
TTL management, and hosted bb URLs — from one console.

## Setup (fresh install)

1. **Boat API key** — create a key at boat.dev (dashboard → API keys) with the actions:
   `sandbox.create, sandbox.read, sandbox.update, sandbox.stop, sandbox.resume,
   sandbox.fork, sandbox.delete, agent.prompt, exec, file.read, file.write, ssh, host,
   snapshot.read, snapshot.write, environment.read`
   Paste it into the plugin's **Boat connection** settings (stored as a secret, 0600).
   A `BOAT_API_KEY` present in the bb server process environment is used as a fallback.

2. **Organization (billing wallet) — read this carefully.** Every Boat API request is
   scoped to a **wallet** via the `X-Boat-Org` header (or the `org` body/query parameter).
   The plugin sends this header on **every request**, using its **Billing org** setting
   (default: the Wyrdwerk LLP team wallet `team_df1a20c5-a1b7-4119-99b6-32cfce49847b`,
   which has an active standard subscription).
   - The org selector is **per-request**: API keys cannot be org-scoped at creation —
     set the org id in the plugin settings and every call runs against that wallet.
   - Without the selector, requests default to the account's personal wallet — which may
     impose trial limits (2-hour auto-stop cap, `trial_auto_stop_required` on
     `ttlSeconds: null`).
   - The Wyrdwerk LLP wallet has a full subscription (standard tier), so boxes created
     under it get the full limits.

3. **Base snapshot** — the fork source. Default: `bb-boat-base-pilot-v1` (a clean base
   with bb, persistent codex auth, boot machinery, no repos). Create boxes from it with
   per-project repo manifests.

4. **TTL default** — 4 hours (14400s) per fork. On wallets with trial limits, 2 hours is
   the maximum until the trial ends; the org wallet's subscription lifts the cap.

## Flows

- **Create fork**: `POST /sandboxes {from: <snapshot>, org: <team>, ttlSeconds, setupScript}`
  → the setup script writes the per-box repo manifest (`/home/user/.project-repos.txt`)
  → the boot sync clones them into `/home/user/workspace/repos/` → PATCH rename.
  Create is 202-async: the dashboard polls `GET /sandboxes/{id}` until usable.
- **Start/Stop**: resume (keeps tokens/state) / stop (snapshots first).
- **Delete**: irreversible; requires the confirm header (`X-Ascii-Confirm-Delete`).
- **Repos**: the manifest is the source of truth — the boot sync clones missing repos,
  refreshes clean ones, quarantines dirty trees, purges unmanaged dirs.
- **Codex auth (per fork)**: each fork needs its own one-time `codex login --device-auth`
  (tokens live in the fork's `~/.codex-persistent`, isolated from the platform agent's
  boot-time rewrite of the stock `~/.codex/auth.json`). Do not share one token family
  across simultaneously-running boxes.

## v1 scope

Dashboard (fleet table, create dialog, per-box actions), repo manifest editor + on-demand
sync, TTL management, hosted-URL reveal. Out of scope for v1: snapshot save/replace,
arbitrary fork, generic terminal, webhooks, ephemeral per-thread boxes (v2 via bb's
environment-provider API).
