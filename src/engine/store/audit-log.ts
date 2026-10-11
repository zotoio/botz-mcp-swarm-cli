import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type AuditEventKind =
  | "sso_login"
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
  | "project_run_delete"
  | "project_delete"
  | "project_sync_fail"
  | "catalogue_health"
  | "worker_token_mint"
  | "worker_token_revoke"
  | "worker_dispatch"
  | "worker_accept"
  | "worker_complete"
  | "worker_suite_fetch"
  | "worker_dispatch_fail";

export interface AuditEvent {
  ts: string;
  kind: AuditEventKind;
  principal?: string;
  detail?: string;
  iss?: string;
  aud?: string;
}

function logPath(): string {
  return join(process.cwd(), ".swarm-data", "audit.jsonl");
}

export async function appendAudit(event: Omit<AuditEvent, "ts">): Promise<void> {
  await mkdir(join(process.cwd(), ".swarm-data"), { recursive: true });
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
