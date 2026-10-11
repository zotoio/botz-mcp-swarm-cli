import type { QuotasSchema } from "../types/manifest.js";
import { z } from "zod";

export type Quotas = z.infer<typeof QuotasSchema>;

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export class QuotaTracker {
  private callCount = 0;
  private maxPayloadBytesSeen = 0;
  private activeConcurrency = 0;
  private peakConcurrency = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private readonly startTime = Date.now();

  constructor(private readonly quotas: Quotas) {}

  get concurrencyUsed(): number {
    return this.peakConcurrency;
  }

  get calls(): number {
    return this.callCount;
  }

  get largestPayload(): number {
    return this.maxPayloadBytesSeen;
  }

  assertWithinDuration(): void {
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.quotas.maxDurationMs) {
      throw new QuotaExceededError(
        `Run exceeded max duration of ${this.quotas.maxDurationMs}ms`,
      );
    }
  }

  async acquireConcurrency(opts?: { wait?: boolean }): Promise<void> {
    this.assertWithinDuration();
    while (this.activeConcurrency >= this.quotas.maxConcurrency) {
      if (!opts?.wait) {
        throw new QuotaExceededError(
          `Concurrency limit of ${this.quotas.maxConcurrency} exceeded`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
      this.assertWithinDuration();
    }
    this.activeConcurrency++;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.activeConcurrency);
  }

  releaseConcurrency(): void {
    this.activeConcurrency = Math.max(0, this.activeConcurrency - 1);
    const next = this.waiters.shift();
    next?.resolve();
  }

  recordCall(payloadBytes = 0): void {
    this.assertWithinDuration();
    this.callCount++;
    if (this.callCount > this.quotas.maxCallCount) {
      throw new QuotaExceededError(
        `Call count limit of ${this.quotas.maxCallCount} exceeded`,
      );
    }
    if (payloadBytes > this.quotas.maxPayloadBytes) {
      throw new QuotaExceededError(
        `Payload size ${payloadBytes} exceeds limit of ${this.quotas.maxPayloadBytes} bytes`,
      );
    }
    this.maxPayloadBytesSeen = Math.max(this.maxPayloadBytesSeen, payloadBytes);
  }
}
