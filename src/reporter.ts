import fs from "fs";
import path from "path";
import { AggregateMetrics, ConversationResult } from "./metrics";

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

export function printSummary(metrics: AggregateMetrics): void {
  const phaseLabel =
    metrics.phase === "warmup" ? "WARM-UP PHASE" : "TEST PHASE";
  const successPct = (metrics.successRate * 100).toFixed(1);
  const timeoutPct =
    metrics.totalConversations > 0
      ? ((metrics.timeoutCount / metrics.totalConversations) * 100).toFixed(1)
      : "0.0";
  const errorPct =
    metrics.totalConversations > 0
      ? ((metrics.errorCount / metrics.totalConversations) * 100).toFixed(1)
      : "0.0";

  const W = 50;
  const line = "═".repeat(W);
  const title = ` LOAD TEST RESULTS — ${phaseLabel} `;
  const titlePadded = title.padStart(
    Math.floor((W + title.length) / 2)
  ).padEnd(W);

  const row = (label: string, value: string) =>
    `║  ${pad(label, 22)}${pad(value, W - 26)}  ║`;

  console.log(`\n╔${line}╗`);
  console.log(`║${titlePadded}║`);
  console.log(`╠${line}╣`);
  console.log(row("Duration", formatDuration(metrics.durationMs)));
  console.log(row("Total Conversations", String(metrics.totalConversations)));
  const shallowPct =
    metrics.successCount > 0
      ? ((metrics.shallowCount / metrics.successCount) * 100).toFixed(1)
      : "0.0";

  console.log(
    row("Successful", `${metrics.successCount}  (${successPct}%)`)
  );
  console.log(
    row("  Shallow (<2s)", `${metrics.shallowCount}  (${shallowPct}% of success)`)
  );
  console.log(
    row("Timed Out", `${metrics.timeoutCount}  (${timeoutPct}%)`)
  );
  console.log(row("Errors", `${metrics.errorCount}  (${errorPct}%)`));
  console.log(row("Throughput", `${metrics.throughputRps.toFixed(2)} req/s`));
  console.log(`╠${line}╣`);
  const fullAICount = metrics.successCount - metrics.shallowCount;
  console.log(row(`LATENCY — Full AI (${fullAICount})`, "(ms)"));
  console.log(row("  Min", String(metrics.latency.min)));
  console.log(row("  Mean", String(metrics.latency.mean)));
  console.log(row("  p50", String(metrics.latency.p50)));
  console.log(row("  p95", String(metrics.latency.p95)));
  console.log(row("  p99", String(metrics.latency.p99)));
  console.log(row("  Max", String(metrics.latency.max)));
  if (metrics.shallowCount > 0) {
    console.log(`╠${line}╣`);
    console.log(row(`LATENCY — Shallow (${metrics.shallowCount})`, "(ms)"));
    console.log(row("  Min", String(metrics.shallowLatency.min)));
    console.log(row("  Mean", String(metrics.shallowLatency.mean)));
    console.log(row("  p50", String(metrics.shallowLatency.p50)));
    console.log(row("  p95", String(metrics.shallowLatency.p95)));
    console.log(row("  p99", String(metrics.shallowLatency.p99)));
    console.log(row("  Max", String(metrics.shallowLatency.max)));
  }
  console.log(`╚${line}╝\n`);
}

export async function saveResults(
  outputDir: string,
  warmup: AggregateMetrics,
  test: AggregateMetrics,
  rawResults: ConversationResult[]
): Promise<void> {
  fs.mkdirSync(outputDir, { recursive: true });

  // Summary JSON
  const summaryPath = path.join(outputDir, "summary.json");
  fs.writeFileSync(
    summaryPath,
    JSON.stringify({ warmup, test }, null, 2),
    "utf-8"
  );

  // CSV (no activities column — too large)
  const csvPath = path.join(outputDir, "results.csv");
  const headers = [
    "phase",
    "startedAt",
    "status",
    "shallow",
    "latencyMs",
    "query",
    "conversationId",
    "errorMessage",
  ];
  const csvRows = rawResults.map((r) =>
    [
      r.phase,
      r.startedAt,
      r.status,
      r.shallow ? "true" : "false",
      r.latencyMs,
      `"${r.query.replace(/"/g, '""')}"`,
      r.conversationId ?? "",
      `"${(r.errorMessage ?? "").replace(/"/g, '""')}"`,
    ].join(",")
  );
  fs.writeFileSync(
    csvPath,
    [headers.join(","), ...csvRows].join("\n"),
    "utf-8"
  );

  // Conversation histories JSONL — one JSON object per line, includes full activity array
  const jsonlPath = path.join(outputDir, "conversations.jsonl");
  const jsonlLines = rawResults.map((r) => JSON.stringify(r));
  fs.writeFileSync(jsonlPath, jsonlLines.join("\n"), "utf-8");

  console.log(`Results saved to: ${outputDir}`);
  console.log(`  summary.json        — aggregate metrics for both phases`);
  console.log(`  results.csv         — one row per conversation`);
  console.log(`  conversations.jsonl — full activity history per conversation`);
}
