# Copilot Studio Agent Load Test

A load testing framework for [Microsoft Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/) agents using the [DirectLine v3](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-direct-line-3-0-concepts) channel.

Each virtual user starts an independent conversation, sends a query, polls for the bot response, and records latency. The framework runs in two phases: a gradual warm-up ramp followed by a full-concurrency real test.

## Prerequisites

- Node.js 18+
- A Copilot Studio agent with the DirectLine channel enabled
- A DirectLine secret from Copilot Studio (see below)

## Getting Your DirectLine Secret

1. Open [Copilot Studio](https://copilotstudio.microsoft.com) and select your agent
2. Go to **Settings** → **Channels** → **DirectLine**
3. Under **Web channel security**, click **Configure web security** (or go to **Settings** → **Configure web security** directly)
4. Copy one of the secrets shown on the page

> The secret looks like a long alphanumeric string. Treat it like a password — do not commit it to source control. This project's `.gitignore` already excludes `.env` to prevent accidental exposure.

Reference: [Configure web channel security](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-web-security)

## Setup

```bash
git clone https://github.com/boydc2014/copilot-studio-load-test.git
cd copilot-studio-load-test
npm install
cp .env.example .env
```

Edit `.env` and set your DirectLine secret:

```
DIRECTLINE_SECRET=your_secret_here
```

## Running

```bash
# Run with ts-node (no build step)
npm run dev

# Or build first, then run
npm run build
npm start
```

## Configuration

All configuration is via environment variables in `.env`.

| Variable | Default | Description |
|---|---|---|
| `DIRECTLINE_SECRET` | *(required)* | DirectLine secret from Copilot Studio **Configure web security** page |
| `DIRECTLINE_BASE_URL` | `https://directline.botframework.com/v3/directline` | DirectLine endpoint — override for sovereign clouds |
| `TARGET_CONCURRENCY` | `20` | Number of simultaneous virtual users |
| `SKIP_WARMUP` | `false` | Set to `true` to skip the warm-up phase and go straight to the real test |
| `WARMUP_COOLDOWN_SECONDS` | `120` | Delay between warm-up and real test phases (2 minutes). Set to `0` to disable. Skipped automatically when `SKIP_WARMUP=true` |
| `WARMUP_DURATION_SECONDS` | `300` | Warm-up phase duration (5 minutes). Workers ramp up one at a time over this window |
| `TEST_DURATION_SECONDS` | `600` | Real test phase duration (10 minutes) |
| `MAX_REQUESTS_PER_MINUTE` | `100` | Global rate limit across all workers. Prevents hitting service throttle limits |
| `POLL_INTERVAL_MS` | `1000` | How often to poll for a bot response (milliseconds) |
| `RESPONSE_TIMEOUT_MS` | `30000` | Max time to wait for a bot response before marking the conversation as timed out |
| `OUTPUT_FILE` | `./results/load-test` | Base path for output. Each run creates a timestamped folder under this directory |

## How It Works

### Phases

**Warm-up** (default 5 min)
Starts with 1 worker and adds one more at regular intervals until `TARGET_CONCURRENCY` is reached. This primes the bot's underlying infrastructure before the real test begins.

**Cooldown** (default 2 min)
A configurable pause between warm-up and the real test. Gives the bot time to settle before measurements begin. Skipped when `SKIP_WARMUP=true` or `WARMUP_COOLDOWN_SECONDS=0`.

**Real test** (default 10 min)
All `TARGET_CONCURRENCY` workers start together (staggered by ~100ms each to avoid a thundering herd). Each worker runs conversations back-to-back until the timer expires.

### Per-conversation flow

```
1. POST /conversations           → create conversation, get token
2. POST /conversations/{id}/activities  → send user message  ← latency starts
3. GET  /conversations/{id}/activities  → poll every POLL_INTERVAL_MS
   └─ repeat until bot message arrives  ← latency stops (uses bot reply timestamp)
```

Latency is measured from when the user message is sent to the server timestamp on the first bot reply — polling interval overhead is excluded.

### Virtual users and queries

The `data/queries.ts` file contains a pool of 100 diverse queries. Each virtual user independently picks a random query from the pool for every conversation — the pool is not split or distributed between workers.

### Rate limiting

A sliding window rate limiter is shared across all workers. Before starting each conversation, a worker must acquire a token. If `MAX_REQUESTS_PER_MINUTE` has been reached in the last 60 seconds, the worker waits until capacity frees up. The current rate is shown in every progress log line.

## Output

Each run creates a timestamped folder under `results/`:

```
results/
└── run-2024-03-08T10-00-00-000Z/
    ├── summary.json        — aggregate metrics for warm-up and test phases
    ├── results.csv         — one row per conversation
    └── conversations.jsonl — full DirectLine activity history per conversation
```

### `summary.json`

```json
{
  "warmup": {
    "totalConversations": 1774,
    "successCount": 1774,
    "timeoutCount": 0,
    "errorCount": 0,
    "successRate": 1.0,
    "throughputRps": 5.88,
    "latency": {
      "p50": 1396,
      "p95": 1541,
      "p99": 2502,
      "min": 1353,
      "max": 5942,
      "mean": 1451
    },
    "durationMs": 301000
  },
  "test": { ... }
}
```

### `results.csv`

| phase | startedAt | status | latencyMs | query | conversationId | errorMessage |
|---|---|---|---|---|---|---|
| test | 1709888400000 | success | 1392 | How do I reset my password? | abc123 | |

### `conversations.jsonl`

One JSON object per line. Each object includes the full `activities` array from DirectLine — the raw sequence of messages exchanged in the conversation — useful for verifying bot responses.

```jsonl
{"phase":"test","status":"success","latencyMs":1392,"query":"How do I reset my password?","conversationId":"abc123","activities":[{"id":"...","type":"message","from":{"id":"vuser-...","role":"user"},"text":"How do I reset my password?","timestamp":"..."},{"id":"...","type":"message","from":{"id":"bot","role":"bot"},"text":"To reset your password...","timestamp":"..."}]}
```

## Console Output

Progress is logged every 15 seconds during each phase:

```
[TEST    2:30] Workers: 20/20 | Conversations: 1693 | Success: 100.0% | p95: 1522ms | rate: 87/min
```

A summary table is printed at the end of each phase:

```
╔══════════════════════════════════════════════════╗
║          LOAD TEST RESULTS — TEST PHASE          ║
╠══════════════════════════════════════════════════╣
║  Duration              10m 01s                   ║
║  Total Conversations   6840                      ║
║  Successful            6840  (100.0%)            ║
║  Timed Out             0  (0.0%)                 ║
║  Errors                0  (0.0%)                 ║
║  Throughput            11.37 req/s               ║
╠══════════════════════════════════════════════════╣
║  LATENCY (ms)                                    ║
║    Min                 1349                      ║
║    Mean                1422                      ║
║    p50                 1392                      ║
║    p95                 1510                      ║
║    p99                 2440                      ║
║    Max                 4275                      ║
╚══════════════════════════════════════════════════╝
```

## SSO Support

If your Copilot Studio agent requires user authentication (SSO), enable SSO mode to simulate authenticated users over the DirectLine channel.

### When to use SSO mode

Use SSO mode when your bot has a sign-in topic triggered on conversation start — the bot sends an OAuthCard before responding to queries. Without SSO, every conversation would time out waiting for the bot to get past the authentication step.

### How it works

When `SSO_ENABLED=true`, each conversation performs an SSO pre-flight before sending the actual query:

```
1. POST /conversations?sendWelcomeMessage=true  → bot receives conversationUpdate, starts sign-in topic
2. Acquire OAuth2 token from Azure AD           → cached across conversations
3. Poll until bot sends OAuthCard
4. POST signin/tokenExchange invoke             → exchange token with bot
5. Poll until invoke response status 200
6. → proceed to send query (latency measurement starts here)
```

Latency is still measured from the user query only — SSO setup is excluded.

### Getting Azure AD credentials

1. **SSO_TENANT_ID** — your Azure AD tenant GUID. Found in **Azure Portal** → **Azure Active Directory** → **Overview** → *Tenant ID*.
2. **SSO_CLIENT_ID** — the app registration client ID. In Azure Portal go to **App registrations**, find your bot's app registration, copy the *Application (client) ID*.
3. **SSO_CLIENT_SECRET** — create a secret under **App registrations** → your app → **Certificates & secrets** → **New client secret**.
4. **SSO_SCOPE** — the OAuth scope to request. For Copilot Studio SSO this is typically `api://<bot-app-id>/.default`.

### Grant types

| `SSO_GRANT_TYPE` | When to use | What happens |
|---|---|---|
| `auth_code` *(default)* | Interactive user sign-in (MFA supported); works even when device code is blocked | CLI opens a browser tab; you sign in; Azure AD redirects back to `localhost` automatically |
| `device_code` | Interactive user sign-in via URL + code (MFA supported) | CLI prints a URL + code; you open the browser, sign in once; token cached for the run |
| `client_credentials` | Bot accepts app-level tokens (service account / non-user scenario) | Token acquired silently from Azure AD using client secret |
| `password` (ROPC) | Automated pipelines with a dedicated test user; MFA must be off | Token acquired silently using stored username + password |

**Auth code (PKCE)** is the default — no credentials to store, supports MFA, and works with company policies that block device code flow.

> **`auth_code` setup** — Before using this flow, register `http://localhost:3000/callback` (or `http://localhost:{SSO_REDIRECT_PORT}/callback`) as a redirect URI in **Azure Portal → App registrations → your app → Authentication → Add a platform → Mobile and desktop applications**. `SSO_CLIENT_SECRET` is not required (uses PKCE).

> For `device_code` and `auth_code`, `SSO_CLIENT_SECRET` is not required (public client). Some confidential app registrations may still require it — set it if Azure AD returns an error asking for it.

### SSO environment variables

| Variable | Default | Description |
|---|---|---|
| `SSO_ENABLED` | `false` | Set to `true` to enable SSO mode |
| `SSO_TENANT_ID` | *(required when SSO enabled)* | Azure AD tenant GUID |
| `SSO_CLIENT_ID` | *(required when SSO enabled)* | App registration client ID |
| `SSO_SCOPE` | *(required when SSO enabled)* | OAuth scope, e.g. `api://your-bot-app-id/.default` |
| `SSO_GRANT_TYPE` | auto-detected | `auth_code` (default), `device_code`, `client_credentials`, or `password` |
| `SSO_CLIENT_SECRET` | *(empty)* | Required for `client_credentials` and `password`; optional for `device_code` and `auth_code` |
| `SSO_TIMEOUT_MS` | `10000` | Timeout for each SSO polling step (ms) |
| `SSO_REDIRECT_PORT` | `3000` | Local port for the `auth_code` callback server |
| `SSO_USERNAME` | *(empty)* | Test user UPN — triggers `password` grant when set together with `SSO_PASSWORD` |
| `SSO_PASSWORD` | *(empty)* | Test user password for `password` grant |

## Customizing Queries

Edit `data/queries.ts` to replace the default query pool with questions relevant to your bot. The pool can be any size — queries are sampled randomly at runtime.

```typescript
export const QUERIES: string[] = [
  "What is the refund policy?",
  "How do I contact support?",
  // ...
];
```
