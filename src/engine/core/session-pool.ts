import type { SessionReuse, Target } from "../types/manifest.js";
import { createSession, type McpSession } from "../adapters/index.js";

export interface SessionPoolOptions {
  size: number;
  reuse: SessionReuse;
  target: Target;
  headers?: Record<string, string>;
  baseDir?: string;
  onSutPid?: (pid: number | null | undefined) => void;
  onStderr?: (line: string) => void;
}

export class SessionPool {
  private readonly warmSessions: McpSession[] = [];
  private readonly options: SessionPoolOptions;
  private readonly sutPids = new Set<number>();
  /** Every open session, idle or checked out, so `abort` can close them all. */
  private readonly live = new Set<McpSession>();
  private aborted = false;

  constructor(options: SessionPoolOptions) {
    this.options = options;
  }

  async acquire(): Promise<{ session: McpSession; reused: boolean }> {
    if (this.aborted) throw new Error("run aborted");
    if (this.options.reuse === "warm" && this.warmSessions.length > 0) {
      const session = this.warmSessions.pop()!;
      return { session, reused: true };
    }
    const session = await this.open();
    return { session, reused: false };
  }

  async release(session: McpSession, keepWarm: boolean): Promise<void> {
    if (!this.aborted && keepWarm && this.options.reuse === "warm" && this.warmSessions.length < this.options.size) {
      this.warmSessions.push(session);
      return;
    }
    await this.close(session);
  }

  async warmUp(): Promise<void> {
    if (this.options.reuse !== "warm") return;
    const needed = this.options.size - this.warmSessions.length;
    if (needed <= 0) return;
    const created = await Promise.all(Array.from({ length: needed }, () => this.open()));
    this.warmSessions.push(...created);
  }

  async drain(): Promise<void> {
    const sessions = this.warmSessions.splice(0, this.warmSessions.length);
    await Promise.all(sessions.map((session) => this.close(session)));
  }

  /** Close every session, including ones in use (this ends stdio children), and refuse new ones. */
  async abort(): Promise<void> {
    this.aborted = true;
    this.warmSessions.splice(0, this.warmSessions.length);
    await Promise.all([...this.live].map((session) => this.close(session)));
  }

  getSutPids(): number[] {
    return [...this.sutPids];
  }

  private async open(): Promise<McpSession> {
    const session = await createSession(this.options.target, this.options.headers, this.options.baseDir, this.options.onStderr);
    this.noteSutPid(session.childPid);
    if (this.aborted) {
      await session.close().catch(() => undefined);
      throw new Error("run aborted");
    }
    this.live.add(session);
    return session;
  }

  private async close(session: McpSession): Promise<void> {
    if (!this.live.delete(session) && this.aborted) return;
    await session.close();
  }

  private noteSutPid(pid: number | null | undefined): void {
    if (pid && pid > 0) {
      this.sutPids.add(pid);
      this.options.onSutPid?.(pid);
    }
  }
}
