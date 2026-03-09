function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxPerMinute: number;

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      const windowStart = now - 60_000;

      // Drop timestamps outside the 1-minute window
      this.timestamps = this.timestamps.filter((t) => t > windowStart);

      if (this.timestamps.length < this.maxPerMinute) {
        this.timestamps.push(now);
        return;
      }

      // Wait until the oldest timestamp in the window expires
      const waitMs = this.timestamps[0] + 60_000 - now + 1;
      await sleep(waitMs);
    }
  }

  currentRate(): number {
    const windowStart = Date.now() - 60_000;
    return this.timestamps.filter((t) => t > windowStart).length;
  }
}
