import dotenv from "dotenv";
dotenv.config();

export interface Config {
  directlineSecret: string;
  directlineBaseUrl: string;
  targetConcurrency: number;
  skipWarmup: boolean;
  warmupCooldownMs: number;
  warmupDurationMs: number;
  testDurationMs: number;
  pollIntervalMs: number;
  responseTimeoutMs: number;
  maxRequestsPerMinute: number;
  outputFile: string;
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optionalInt(key: string, defaultVal: number): number {
  const val = process.env[key];
  if (!val) return defaultVal;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed)) throw new Error(`Invalid integer for ${key}: "${val}"`);
  return parsed;
}

export function loadConfig(): Config {
  return {
    directlineSecret: requireEnv("DIRECTLINE_SECRET"),
    directlineBaseUrl:
      process.env.DIRECTLINE_BASE_URL ||
      "https://directline.botframework.com/v3/directline",
    targetConcurrency: optionalInt("TARGET_CONCURRENCY", 20),
    skipWarmup: process.env.SKIP_WARMUP === "true",
    warmupCooldownMs: optionalInt("WARMUP_COOLDOWN_SECONDS", 120) * 1000,
    warmupDurationMs: optionalInt("WARMUP_DURATION_SECONDS", 300) * 1000,
    testDurationMs: optionalInt("TEST_DURATION_SECONDS", 600) * 1000,
    pollIntervalMs: optionalInt("POLL_INTERVAL_MS", 1000),
    responseTimeoutMs: optionalInt("RESPONSE_TIMEOUT_MS", 30000),
    maxRequestsPerMinute: optionalInt("MAX_REQUESTS_PER_MINUTE", 100),
    outputFile: process.env.OUTPUT_FILE || "./results/load-test",
  };
}
