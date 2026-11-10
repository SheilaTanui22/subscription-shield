# Subscription Shield

A small local web app for keeping free-trial renewals and a subscription from quietly costing you money. It tracks trial end dates with reminders and a calendar export, demonstrates pausing/resuming a real subscription against PayPal's **sandbox** API and adds a budget conversation that compares what you've tracked against a monthly budget you set, with every number calculated in code, never guessed by an AI model.

## Problem it addresses

Free trials and small subscriptions are easy to forget about and hard to reason about in aggregate: "what am I actually on the hook for next month, and what happens if I let this one lapse?" Subscription Shield keeps that information in one place, locally, without requiring a bank or email integration.

## What's implemented (and its limits)

| Feature | What it does | Limits |
|---|---|---|
| **PayPal sandbox subscription** | Shows the status, price and billing dates of **one** demo subscription created by this project's own setup scripts; pause/resume it from the dashboard. | Sandbox-only and scoped to the one subscription this project creates for itself. It cannot discover, list or act on a real user's own PayPal subscriptions, there is no such API call anywhere in this codebase. |
| **Free trial tracking** | Add, edit, delete and see day-count/"ending soon" status for trials you enter yourself or import from pasted text. | Tracking-only: dates and prices you (or an AI extraction) entered. Nothing here is connected to the provider and nothing cancels billing automatically. |
| **"Import from text" (AI-assisted)** | Pastes a confirmation email/receipt and extracts service name, end date, price, etc. via a local Ollama model. Every field is shown with its supporting quote for you to verify before saving. | Every extracted field still requires your review and an explicit Save — nothing is stored until you confirm it. Unavailable if Ollama isn't running. |
| **Upcoming trial deadlines** | In-dashboard alerts for trials nearing their reminder window. | Only visible while the dashboard tab is open — no email, push, or background notifications. |
| **Calendar export (.ics)** | Downloads a one-time calendar file with a single reminder alert for a trial. | A static snapshot: editing or deleting the trial afterward does not update or remove the calendar event, and re-downloading creates a duplicate, not a replacement. |
| **Budget conversation** | Set a monthly budget; see it compared against your tracked trial renewals (labeled as planned/potential costs, not bank spending); ask suggested or free-text questions, including "what if I don't renew X" hypotheticals. | All arithmetic happens in plain code — the AI model (when used) only classifies which question you're asking and which record you mean; it never computes or states a dollar amount itself. Hypothetical questions never change, pause, or cancel anything. The sandbox PayPal subscription's amount is never added into this total. |

## Architecture & stack

- **Runtime**: plain Node.js (`node:http`, ES modules, built-in `node:test`) — **zero npm dependencies**, no framework, no build step.
- **Frontend**: hand-written HTML/CSS/vanilla JS served as static files from `public/`; no bundler.
- **Storage**: local JSON files (`trials.json`, `budget.json`, `demo-state.json`), each written through an atomic temp-file-then-rename with an in-process write queue so concurrent requests can't corrupt them. All three are git-ignored and created automatically on first use.
- **PayPal**: the official sandbox REST API (`https://api-m.sandbox.paypal.com`), called directly via `fetch` — no PayPal SDK.
- **AI**: a single active provider, picked by `AI_PROVIDER`:
  - `ollama` (default) — calls a local Ollama server over loopback only; refuses to call anything else.
  - `anthropic` (optional) — the Claude API, only used if you explicitly opt in and supply a key.
  
  Both expose the same `createStructuredMessage({ system, messages, schema })` shape, so the rest of the app doesn't know which one is active.

```
server.mjs            HTTP server wiring
lib/                  Route handling, services, PayPal/AI clients, storage
public/               Static frontend + modules shared with the test suite
  (trial-dates.mjs, trial-validation.mjs, budget-*.mjs have no DOM
  dependency, so both the browser and node:test import them directly)
test/                 node:test suites (one file per module/route group)
setup-demo.mjs        One-time: creates the sandbox product + billing plan
subscribe-demo.mjs    One-time: creates + approves the sandbox subscription
pause-demo.mjs        CLI: pauses the sandbox subscription (same action the UI button does)
```

## Setup from a fresh clone (Windows, using `npm.cmd`)

1. Clone the repository and move into it:
   ```bash
   git clone https://github.com/SheilaTanui22/subscription-shield.git
   cd subscription-shield
   ```
2. **Install nothing extra** — there are no npm dependencies, just Node.js itself (tested on Node 24; needs Node 20.6+ for the built-in `--env-file` flag). `npm.cmd install` is safe to run but has nothing to fetch.
3. Copy the environment template and fill in your own real values (this file is git-ignored — it's yours alone, never committed):
   ```bash
   copy .env.example .env
   ```
4. Fill in `.env`:
   - `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` — from your **own sandbox** REST API app at [developer.paypal.com](https://developer.paypal.com) (see **PayPal sandbox setup** below). The repository intentionally ships none of these — every clone needs its own.
   - Leave `AI_PROVIDER=ollama` for the free, local default, or see **Ollama setup** below.
5. Run the one-time sandbox setup scripts (creates your own demo product/plan, then a demo subscription — these write to `demo-state.json`, which is also git-ignored and created fresh per clone):
   ```bash
   node --env-file=.env setup-demo.mjs
   node --env-file=.env subscribe-demo.mjs
   ```
   `subscribe-demo.mjs` prints an approval link and starts a tiny local server on port 3002 to catch the redirect — open the link, approve with a **sandbox buyer** account (see below), then leave that window running until it prints the confirmed status (or just re-run it later; it's idempotent once `demo-state.json` has a subscription ID).
6. Start the app:
   ```bash
   npm.cmd start
   ```
7. Open **http://localhost:3001**.

### PayPal sandbox setup: merchant vs. buyer

PayPal sandbox testing needs **two different sandbox accounts**, created under **Sandbox → Accounts** at developer.paypal.com:

- A **Business (merchant)** sandbox account — this is whose REST API app gives you `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET`. This is the identity the server authenticates as, and whose one demo subscription the dashboard shows.
- A **Personal (buyer)** sandbox account — used only to click through the PayPal approval screen that `subscribe-demo.mjs` links you to. Log into developer.paypal.com's sandbox buyer credentials (not your real PayPal login) when prompted.

The app only ever acts on the single subscription these scripts create for the merchant account — it has no code path that lists or manages a buyer's other subscriptions.

### Ollama setup (local, free — the default)

1. Install [Ollama](https://ollama.com) and make sure it's running (`ollama serve`, or just launch the app — it runs as a background service on most installs).
2. Pull the model this project defaults to:
   ```bash
   ollama pull qwen3:8b
   ```
3. Leave `AI_PROVIDER=ollama` in `.env` (the default). `OLLAMA_BASE_URL` must stay a loopback address (`127.0.0.1`/`localhost`/`::1`) — anything else is refused outright rather than silently called.

**Realistic latency**: this is local CPU (or GPU, if your Ollama install uses one) inference, not a cloud API. Expect roughly **30 seconds to ~2 minutes** for the first request after Ollama has been idle (it has to load the model), and noticeably faster once it's warm — in this project's own testing, a cold run took about 83 seconds total, of which only ~6 seconds was model loading (the rest is generation). The UI's loading state says this explicitly rather than showing a fake progress bar. `OLLAMA_TIMEOUT_MS` (default 120000) caps how long the server will wait.

To use Anthropic's cloud API instead, set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `.env` — see the comments in `.env.example`. This is optional, paid, and never used unless you explicitly select it.

### What still works if Ollama is unavailable

Everything except the two features that explicitly call an AI model:
- ✅ Dashboard, PayPal sandbox status/pause/resume, manually adding/editing/deleting trials, deadline alerts, calendar export, setting/viewing a budget, and the budget's **suggested-question buttons** (no AI call at all).
- ❌ "Import from text" and typing a **free-text** budget question — both show a clear, specific error (e.g. "Could not reach Ollama…") rather than failing silently or falling back to a different provider.

## Running tests

```bash
npm.cmd test
```

Runs the full `node:test` suite (362 tests at the time of writing) — unit tests for validation/calculation/storage modules, and HTTP integration tests that spin up the real router against temp-file storage and a stubbed PayPal/AI client. No network access, real PayPal credentials, or a running Ollama instance are required for the test suite to pass.

## Troubleshooting

| Symptom | Fix |
|---|---|
| **Port 3001 already in use** | Something else (maybe a previous `npm.cmd start`) is already bound to it. Either stop that process, or set a different `PORT` in `.env` and restart. On Windows: `Get-NetTCPConnection -LocalPort 3001 \| Select OwningProcess` to find the PID, then `taskkill /PID <pid> /F`. |
| **"Missing PayPal credentials in .env"** | `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` are empty — fill them in from a sandbox REST API app. |
| **"This demo requires the PayPal sandbox URL"** | `PAYPAL_BASE_URL` must be exactly `https://api-m.sandbox.paypal.com` — this is enforced deliberately so the app can never accidentally hit production. |
| **"No subscription found. Run setup-demo.mjs and subscribe-demo.mjs first."** | Expected on a fresh checkout — run those two scripts (see Setup). The rest of the dashboard (trials, budget) works fine in the meantime. |
| **"Could not reach Ollama…" / "OLLAMA_UNAVAILABLE"** | Ollama isn't running — start it (`ollama serve`) or launch the Ollama app. |
| **"Ollama model … is not available locally"** | `ollama pull qwen3:8b` (or whatever `OLLAMA_MODEL` you set). |
| **"An AI extraction is already running locally"** | Only one Ollama request is handled at a time; wait for it to finish and retry. |
| **AI import / budget question silently does nothing useful** | Check `AI_PROVIDER` — an unrecognized value (typo, `openai`, etc.) is treated as a configuration error, never silently defaulted to Ollama or Anthropic. |

## Demo walkthrough

1. **Import** — click **Import from text**, paste a trial confirmation email, click **Extract details** (uses Ollama).
2. **Review / save** — the Add-trial dialog opens pre-filled, with each field's supporting quote from your text shown underneath it; adjust anything, click **Review**, confirm, then **Save trial**.
3. **Calendar export** — on the saved trial's card, click **Add to calendar**, pick a reminder date/time, and **Download .ics**.
4. **Budget scenario** — scroll to **Budget conversation**, set a monthly budget, then either click a suggested question or type "What if I don't renew \<that trial's name\>?" to see a hypothetical comparison (nothing is changed).
5. **PayPal sandbox resume/pause** — on the subscription card at the top, click **Pause subscription** / **Resume subscription** to see a real (sandbox) PayPal status transition, verified by polling PayPal's own API afterward.

## Environment variables

See `.env.example` for the full, commented list (PayPal credentials, `AI_PROVIDER` and its per-provider settings, optional storage-path overrides). It contains placeholders only — never commit a real `.env`.

## License

[MIT](LICENSE) — Copyright (c) 2026 Sheila Jemeli Tanui.
