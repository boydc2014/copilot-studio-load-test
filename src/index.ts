import path from "path";
import { loadConfig } from "./config";
import { getOAuthToken } from "./auth";
import { MetricsCollector } from "./metrics";
import { runWarmupPhase, runTestPhase } from "./scheduler";
import { printSummary, saveResults } from "./reporter";
import { QUERIES } from "../data/queries";

async function main(): Promise<void> {
  const config = loadConfig();

  console.log("=".repeat(52));
  console.log("  Copilot Studio Agent Load Test");
  console.log("=".repeat(52));
  console.log(`  DirectLine URL    : ${config.directlineBaseUrl}`);
  console.log(`  Target Concurrency: ${config.targetConcurrency} workers`);
  console.log(`  Warm-up Duration  : ${config.warmupDurationMs / 1000}s`);
  console.log(`  Test Duration     : ${config.testDurationMs / 1000}s`);
  console.log(`  Response Timeout  : ${config.responseTimeoutMs}ms`);
  console.log(`  Poll Interval     : ${config.pollIntervalMs}ms`);
  console.log(`  Query Pool Size   : ${QUERIES.length}`);
  if (config.ssoEnabled) {
    const grantLabel =
      config.ssoGrantType === "device_code"
        ? "DeviceCode"
        : config.ssoGrantType === "password"
          ? "ROPC"
          : "ClientCredentials";
    console.log(`  SSO               : ENABLED (${grantLabel})`);
    console.log(`  SSO Tenant        : ${config.ssoTenantId}`);
    console.log(`  SSO Timeout       : ${config.ssoTimeoutMs}ms`);
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(path.dirname(config.outputFile), `run-${runId}`);
  console.log(`  Output Dir        : ${outputDir}`);
  console.log("=".repeat(52));

  // For device_code SSO, sign in once here before the test begins.
  // The token is cached in auth.ts and reused (with silent refresh) for all conversations.
  if (config.ssoEnabled && config.ssoGrantType === "device_code") {
    try {
      await getOAuthToken(config);
      console.log("  Sign-in complete.\n");
    } catch (err) {
      console.error(`\nSSO sign-in failed: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    console.log();
  }

  // PHASE 1: WARM-UP
  const warmupCollector = new MetricsCollector("warmup");
  let warmupMetrics;
  if (config.skipWarmup) {
    console.log("─── PHASE 1: WARM-UP (skipped) ─────────────────────");
    warmupMetrics = warmupCollector.summarize();
  } else {
    console.log("─── PHASE 1: WARM-UP ───────────────────────────────");
    await runWarmupPhase(config, warmupCollector);
    warmupMetrics = warmupCollector.summarize();
    printSummary(warmupMetrics);
  }

  // COOLDOWN between phases
  if (!config.skipWarmup && config.warmupCooldownMs > 0) {
    console.log(`\nCooldown: waiting ${config.warmupCooldownMs / 1000}s before real test...`);
    await new Promise((resolve) => setTimeout(resolve, config.warmupCooldownMs));
  }

  // PHASE 2: REAL TEST
  console.log("─── PHASE 2: REAL TEST ──────────────────────────────");
  const testCollector = new MetricsCollector("test");
  await runTestPhase(config, testCollector);
  const testMetrics = testCollector.summarize();
  printSummary(testMetrics);

  // Save results
  const allResults = [
    ...warmupCollector.getRawResults(),
    ...testCollector.getRawResults(),
  ];
  await saveResults(outputDir, warmupMetrics, testMetrics, allResults);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
