import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { swarmDataDir } from "../core/data-dirs.js";

export type AuditEventKind =
  | "sso_login"
  | "tool_filters_saved"
  | "server_update_check"
  | "server_update_accept"
  | "rerun_watch"
  | "fix_share"
  | "sso_logout"
  | "sso_denied_org"
  | "sso_denied_team"
  | "csrf_fail"
  | "iss_aud_fail"
  | "schedule_create"
  | "schedule_run"
  | "schedule_run_fail"
  | "legacy_stdio_allowlist_run"
  | "schedule_update"
  | "schedule_delete"
  | "optimize_accept"
  | "optimize_accept_fail"
  | "admin_denied"
  | "admin_policy_update"
  | "admin_allowlist_add"
  | "admin_allowlist_edit"
  | "admin_allowlist_remove"
  | "admin_allowlist_toggle"
  | "admin_gateway_allowlist_add"
  | "admin_gateway_allowlist_edit"
  | "admin_gateway_allowlist_remove"
  | "admin_gateway_allowlist_toggle"
  | "admin_schedule_create"
  | "admin_schedule_update"
  | "admin_schedule_delete"
  | "admin_webhook_update"
  | "admin_webhook_test"
  | "admin_otel_update"
  | "admin_session_ttl"
  | "admin_execution_ttl"
  | "admin_sessions_revoke"
  | "project_run"
  | "project_run_stop"
  | "project_run_delete"
  | "project_delete"
  | "project_sync_fail"
  | "catalogue_health"
  | "worker_token_mint"
  | "worker_token_revoke"
  | "worker_connect"
  | "worker_disconnect"
  | "worker_dispatch"
  | "worker_accept"
  | "worker_complete"
  | "worker_suite_fetch"
  | "worker_dispatch_fail"
  | "suite_analyse"
  | "suite_analyse_fail"
  | "suite_fix_accept"
  | "suite_fix_reject"
  | "admin_logs_clear"
  | "admin_model_change"
  | "mcp_oauth_connect"
  | "suite_eval_test"
  | "suite_eval_save"
  | "suite_version_toggle"
  | "suite_eval_autofix"
  | "otlp_ingest_denied";

export interface AuditEvent {
  ts: string;
  kind: AuditEventKind;
  principal?: string;
  detail?: string;
  iss?: string;
  aud?: string;
}

function logPath(): string {
  return join(swarmDataDir(), "audit.jsonl");
}

export async function appendAudit(event: Omit<AuditEvent, "ts">): Promise<void> {
  await mkdir(swarmDataDir(), { recursive: true });
  const line: AuditEvent = { ...event, ts: new Date().toISOString() };
  await appendFile(logPath(), `${JSON.stringify(line)}\n`, "utf8");
}

export async function readAuditLog(limit = 100): Promise<AuditEvent[]> {
  try {
    const raw = await readFile(logPath(), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => JSON.parse(l) as AuditEvent)
      .reverse();
  } catch {
    return [];
  }
}

/** A `project_run` audit entry, parsed: who started which run in which project, and when. */
export interface AuditRunStart {
  runId: string;
  projectId: string;
  suiteId?: string;
  dispatch?: string;
  principal?: string;
  ts: string;
}

/** Parse `project=<id> suite=<id> run=<id> dispatch=<d>` from a `project_run` entry; null for anything else. */
export function parseRunStartAudit(event: AuditEvent): AuditRunStart | null {
  if (event.kind !== "project_run" || !event.detail) return null;
  const field = (k: string) => new RegExp(`(?:^|\\s)${k}=(\\S+)`).exec(event.detail ?? "")?.[1];
  const runId = field("run");
  const projectId = field("project");
  if (!runId || !projectId) return null;
  const suiteId = field("suite");
  const dispatch = field("dispatch");
  return {
    runId,
    projectId,
    ...(suiteId ? { suiteId } : {}),
    ...(dispatch ? { dispatch } : {}),
    ...(event.principal ? { principal: event.principal } : {}),
    ts: event.ts,
  };
}

/** Find the `project_run` audit entry that started `runId` (newest first). Read-only scan of audit.jsonl. */
export async function findRunStartInAudit(runId: string, path: string = logPath()): Promise<AuditRunStart | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const needle = `run=${runId}`;
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes(needle) || !line.includes('"project_run"')) continue;
    try {
      const hit = parseRunStartAudit(JSON.parse(line) as AuditEvent);
      if (hit && hit.runId === runId) return hit;
    } catch {
      /* skip malformed line */
    }
  }
  return null;
}
