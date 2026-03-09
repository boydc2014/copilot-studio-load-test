import { Config } from "./config";
import { MetricsCollector } from "./metrics";
import { RateLimiter } from "./rateLimiter";
import { runConversation } from "./conversation";
import { QUERIES } from "../data/queries";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return sleep(delay);
}

function pickRandomQuery(): string {
  return QUERIES[Math.floor(Math.random() * QUERIES.length)];
}

async function runWorkerLoop(
  config: Config,
  collector: MetricsCollector,
  rateLimiter: RateLimiter,
  phaseEnd: number,
  phase: "warmup" | "test"
): Promise<void> {
  while (Date.now() < phaseEnd) {
    await rateLimiter.acquire();
    if (Date.now() >= phaseEnd) break;
    const query = pickRandomQuery();
    const result = await runConversation(config, query, phase);
    collector.record(result);
    if (Date.now() < phaseEnd) {
      await jitter(50, 200);
    }
  }
}

function formatElapsed(startMs: number): string {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export async function runWarmupPhase(
  config: Config,
  collector: MetricsCollector
): Promise<void> {
  const phaseStart = Date.now();
  const phaseEnd = phaseStart + config.warmupDurationMs;
  const stepIntervalMs =
    config.targetConcurrency > 1
      ? config.warmupDurationMs / config.targetConcurrency
      : config.warmupDurationMs;

  console.log(
    `Warm-up: ramping from 1 to ${config.targetConcurrency} workers ` +
      `over ${config.warmupDurationMs / 1000}s ` +
      `(+1 worker every ${Math.round(stepIntervalMs / 1000)}s) ` +
      `| rate limit: ${config.maxRequestsPerMinute} req/min`
  );

  const rateLimiter = new RateLimiter(config.maxRequestsPerMinute);
  let activeWorkers = 0;
  const workerPromises: Promise<void>[] = [];

  // Progress reporter
  const progressInterval = setInterval(() => {
    const total = collector.getCount();
    const success = collector.getSuccessCount();
    const rate = total > 0 ? ((success / total) * 100).toFixed(1) : "—";
    const p95 = collector.getCurrentP95();
    console.log(
      `[WARMUP  ${formatElapsed(phaseStart)}] ` +
        `Workers: ${activeWorkers}/${config.targetConcurrency} | ` +
        `Conversations: ${total} | ` +
        `Success: ${rate}% | ` +
        `p95: ${p95}ms | ` +
        `rate: ${rateLimiter.currentRate()}/min`
    );
  }, 15000);

  for (let i = 0; i < config.targetConcurrency; i++) {
    activeWorkers++;
    workerPromises.push(
      runWorkerLoop(config, collector, rateLimiter, phaseEnd, "warmup").then(() => {
        activeWorkers--;
      })
    );
    if (i < config.targetConcurrency - 1 && Date.now() < phaseEnd) {
      await sleep(stepIntervalMs);
    }
  }

  await Promise.all(workerPromises);
  clearInterval(progressInterval);
  console.log(`[WARMUP  DONE] Total conversations: ${collector.getCount()}`);
}

export async function runTestPhase(
  config: Config,
  collector: MetricsCollector
): Promise<void> {
  const phaseStart = Date.now();
  const phaseEnd = phaseStart + config.testDurationMs;

  console.log(
    `Test: ${config.targetConcurrency} workers for ${config.testDurationMs / 1000}s` +
      ` | rate limit: ${config.maxRequestsPerMinute} req/min`
  );

  const rateLimiter = new RateLimiter(config.maxRequestsPerMinute);
  let activeWorkers = 0;
  const staggerMs =
    config.targetConcurrency > 1 ? 2000 / (config.targetConcurrency - 1) : 0;
  const workerPromises = Array.from(
    { length: config.targetConcurrency },
    (_, i) =>
      sleep(Math.round(i * staggerMs)).then(() => {
        activeWorkers++;
        return runWorkerLoop(config, collector, rateLimiter, phaseEnd, "test");
      }).then(() => {
        activeWorkers--;
      })
  );

  // Progress reporter
  const progressInterval = setInterval(() => {
    const total = collector.getCount();
    const success = collector.getSuccessCount();
    const rate = total > 0 ? ((success / total) * 100).toFixed(1) : "—";
    const p95 = collector.getCurrentP95();
    console.log(
      `[TEST    ${formatElapsed(phaseStart)}] ` +
        `Workers: ${activeWorkers}/${config.targetConcurrency} | ` +
        `Conversations: ${total} | ` +
        `Success: ${rate}% | ` +
        `p95: ${p95}ms | ` +
        `rate: ${rateLimiter.currentRate()}/min`
    );
  }, 15000);

  await Promise.all(workerPromises);
  clearInterval(progressInterval);
  console.log(`[TEST    DONE] Total conversations: ${collector.getCount()}`);
}
