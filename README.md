# Copilot Studio Agent Load Test

A load testing framework for [Microsoft Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/) agents using the [DirectLine v3](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-direct-line-3-0-concepts) channel.

Each virtual user starts an independent conversation, sends a query, polls for the bot response, and records latency. The framework runs in two phases: a gradual warm-up ramp followed by a full-concurrency real test.

## Prerequisites

- Node.js 18+
- A Copilot Studio agent with the DirectLine channel enabled
- A DirectLine secret from the **Configure web security** page in Copilot Studio

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

## Customizing Queries

Edit `data/queries.ts` to replace the default query pool with questions relevant to your bot. The pool can be any size — queries are sampled randomly at runtime.

```typescript
export const QUERIES: string[] = [
  "What is the refund policy?",
  "How do I contact support?",
  // ...
];
```
