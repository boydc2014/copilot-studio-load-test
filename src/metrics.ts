import { DirectLineActivity } from "./directline";

export type ConversationStatus = "success" | "timeout" | "error";

export interface ConversationResult {
  phase: "warmup" | "test";
  status: ConversationStatus;
  query: string;
  latencyMs: number;
  shallow?: boolean; // true when latency < 2s — agent likely did not invoke full AI flow
  errorMessage?: string;
  conversationId?: string;
  startedAt: number;
  activities?: DirectLineActivity[];
}

export interface PercentileStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
}

export interface AggregateMetrics {
  phase: "warmup" | "test";
  totalConversations: number;
  successCount: number;
  timeoutCount: number;
  errorCount: number;
  shallowCount: number; // successful but latency < 2s — agent likely skipped full AI flow
  successRate: number;
  throughputRps: number;
  latency: PercentileStats;        // full AI responses only (non-shallow)
  shallowLatency: PercentileStats; // shallow responses only
  durationMs: number;
  startedAt: number;
  endedAt: number;
}

function computePercentiles(sorted: number[]): PercentileStats {
  if (sorted.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  }
  const idx = (pct: number) =>
    Math.min(
      Math.floor(sorted.length * pct),
      sorted.length - 1
    );
  const mean =
    sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return {
    p50: sorted[idx(0.5)],
    p95: sorted[idx(0.95)],
    p99: sorted[idx(0.99)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(mean),
  };
}

export class MetricsCollector {
  private results: ConversationResult[] = [];
  private readonly phase: "warmup" | "test";
  private readonly phaseStartMs: number;

  constructor(phase: "warmup" | "test") {
    this.phase = phase;
    this.phaseStartMs = Date.now();
  }

  record(result: ConversationResult): void {
    this.results.push(result);
  }

  summarize(): AggregateMetrics {
    const endedAt = Date.now();
    const durationMs = endedAt - this.phaseStartMs;

    const successful = this.results.filter((r) => r.status === "success");
    const timeouts = this.results.filter((r) => r.status === "timeout");
    const errors = this.results.filter((r) => r.status === "error");
    const shallow = successful.filter((r) => r.shallow);

    const fullAI = successful.filter((r) => !r.shallow);

    const sortedLatencies = fullAI
      .map((r) => r.latencyMs)
      .sort((a, b) => a - b);

    const sortedShallowLatencies = shallow
      .map((r) => r.latencyMs)
      .sort((a, b) => a - b);

    const successRate =
      this.results.length > 0
        ? successful.length / this.results.length
        : 0;

    const throughputRps =
      durationMs > 0 ? successful.length / (durationMs / 1000) : 0;

    return {
      phase: this.phase,
      totalConversations: this.results.length,
      successCount: successful.length,
      timeoutCount: timeouts.length,
      errorCount: errors.length,
      shallowCount: shallow.length,
      successRate,
      throughputRps,
      latency: computePercentiles(sortedLatencies),
      shallowLatency: computePercentiles(sortedShallowLatencies),
      durationMs,
      startedAt: this.phaseStartMs,
      endedAt,
    };
  }

  getRawResults(): ConversationResult[] {
    return this.results;
  }

  getCount(): number {
    return this.results.length;
  }

  getSuccessCount(): number {
    return this.results.filter((r) => r.status === "success").length;
  }

  getCurrentP95(): number {
    const latencies = this.results
      .filter((r) => r.status === "success")
      .map((r) => r.latencyMs)
      .sort((a, b) => a - b);
    if (latencies.length === 0) return 0;
    const idx = Math.min(
      Math.floor(latencies.length * 0.95),
      latencies.length - 1
    );
    return latencies[idx];
  }
}
