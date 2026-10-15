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
  private firstServerInfo?: { name?: string; version?: string };

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

  /** Name and version from the first session's `initialize` result. */
  serverInfo(): { name?: string; version?: string } | undefined {
    return this.firstServerInfo;
  }

  getSutPids(): number[] {
    return [...this.sutPids];
  }

  private async open(): Promise<McpSession> {
    const session = await createSession(this.options.target, this.options.headers, this.options.baseDir, this.options.onStderr);
    this.noteSutPid(session.childPid);
    if (!this.firstServerInfo) {
      const info = session.getServerMeta().serverInfo;
      if (info?.name || info?.version) this.firstServerInfo = { name: info.name, version: info.version };
    }
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

/** One pool per server alias, for runs whose steps call more than one server. */
export class SessionPoolSet {
  private readonly pools = new Map<string, SessionPool>();

  constructor(
    readonly defaultAlias: string,
    private readonly targets: Map<string, Target>,
    options: Omit<SessionPoolOptions, "target" | "onSutPid" | "onStderr"> & {
      onSutPid?: (pid: number | null | undefined, alias: string) => void;
      onStderr?: (line: string, alias: string) => void;
    },
  ) {
    for (const [alias, target] of targets) {
      this.pools.set(alias, new SessionPool({
        ...options,
        target,
        onSutPid: options.onSutPid ? (pid) => options.onSutPid!(pid, alias) : undefined,
        onStderr: options.onStderr ? (line) => options.onStderr!(line, alias) : undefined,
      }));
    }
    if (!this.pools.has(defaultAlias)) throw new Error(`no target for default server ${defaultAlias}`);
  }

  target(alias: string = this.defaultAlias): Target {
    const target = this.targets.get(alias);
    if (!target) throw new Error(`unknown server ${alias}`);
    return target;
  }

  aliases(): string[] {
    return [...this.pools.keys()];
  }

  pool(alias: string = this.defaultAlias): SessionPool {
    const pool = this.pools.get(alias);
    if (!pool) throw new Error(`unknown server ${alias}`);
    return pool;
  }

  acquire(alias: string = this.defaultAlias): Promise<{ session: McpSession; reused: boolean }> {
    return this.pool(alias).acquire();
  }

  release(alias: string, session: McpSession, keepWarm: boolean): Promise<void> {
    return this.pool(alias).release(session, keepWarm);
  }

  /** Warms each pool in turn; the error names the server that failed. */
  async warmUp(aliases: string[] = this.aliases()): Promise<void> {
    for (const alias of aliases) {
      try {
        await this.pool(alias).warmUp();
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { serverAlias: alias });
      }
    }
  }

  async drain(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.drain()));
  }

  async abort(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.abort()));
  }

  serverInfo(alias: string = this.defaultAlias): { name?: string; version?: string } | undefined {
    return this.pools.get(alias)?.serverInfo();
  }
}
