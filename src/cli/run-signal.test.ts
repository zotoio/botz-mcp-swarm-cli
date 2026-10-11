import { expect, it } from "vitest";
import { withRunSignal } from "./run-signal.js";
it("requests cancellation, preserves the signal exit code, and removes listeners", async () => {
  const oldCode = process.exitCode;
  const listeners = process.listenerCount("SIGINT");
  try {
    const result = await withRunSignal(async (signal) => {
      process.emit("SIGINT");
      expect(signal.aborted).toBe(true);
      return "partial report";
    });
    expect(result).toBe("partial report");
    expect(process.exitCode).toBe(130);
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  } finally { process.exitCode = oldCode; }
});
