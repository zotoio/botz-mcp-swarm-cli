import type { McpServerOAuthConfig } from "../types/manifest.js";
import { getProject, updateProjectServerOAuth, type ProjectStoreOptions } from "../store/project-store.js";
import { oauthLoginStatus, refreshOAuthLogin, targetOAuthConfig, type OAuthLoginStatus } from "./mcp-oauth.js";

export interface ServerLoginStatus extends OAuthLoginStatus {
  serverId: string;
  serverName: string;
  /** True when the user must Reconnect (sign in again) before runs can use this server. */
  reconnectRequired: boolean;
}

export const LOGIN_EXPIRED_ERROR = "login_expired";

/** Login status of every OAuth server in a project, without network calls or tokens. */
export async function projectLoginStatus(projectId: string, store?: ProjectStoreOptions): Promise<ServerLoginStatus[] | null> {
  const project = await getProject(projectId, store);
  if (!project) return null;
  const out: ServerLoginStatus[] = [];
  for (const server of project.servers ?? []) {
    const status = oauthLoginStatus(server.target);
    if (status.state === "none") continue;
    out.push({
      ...status,
      serverId: server.id,
      serverName: server.name,
      reconnectRequired: status.state === "error" || (status.state === "expired" && !status.refreshable),
    });
  }
  return out;
}

export function loginExpiredMessage(failures: Array<{ serverName: string; expiresAt?: string }>): string {
  const names = failures.map((f) => `"${f.serverName}"${f.expiresAt ? ` (expired ${f.expiresAt})` : ""}`).join(", ");
  return `${LOGIN_EXPIRED_ERROR}: Login expired — Reconnect. The OAuth login for ${names} has expired and could not be renewed. `
    + "Open the project, Suite setup → Servers, and click Reconnect (or POST /api/projects/<id>/servers/<serverId>/reconnect), then run again.";
}

/**
 * Before a run: renew expired OAuth logins of the given servers with their refresh tokens and persist the
 * new tokens (sealed by the store). Returns failures for logins that cannot be renewed so the caller can
 * fail fast with a clear message instead of a bare 401 mid-run. Never logs or returns tokens.
 */
export async function preflightProjectOAuth(input: {
  projectId: string;
  serverIds?: string[];
  store?: ProjectStoreOptions;
  fetchImpl?: typeof fetch;
}): Promise<{ refreshed: string[]; failures: Array<{ serverId: string; serverName: string; expiresAt?: string; reason: string }> }> {
  const project = await getProject(input.projectId, input.store);
  const refreshed: string[] = [];
  const failures: Array<{ serverId: string; serverName: string; expiresAt?: string; reason: string }> = [];
  if (!project) return { refreshed, failures };
  const wanted = input.serverIds && input.serverIds.length > 0 ? new Set(input.serverIds) : null;
  for (const server of project.servers ?? []) {
    if (wanted && !wanted.has(server.id)) continue;
    const oauth = targetOAuthConfig(server.target);
    if (!oauth) continue;
    const status = oauthLoginStatus(server.target);
    if (status.state === "none" || status.state === "ok") continue;
    if (status.state === "expiring" && !status.refreshable) continue;
    const result = await refreshOAuthLogin(oauth, input.fetchImpl ?? fetch, { force: status.state === "error" });
    if (result.ok) {
      if (result.refreshed) {
        await updateProjectServerOAuth(project.id, server.id, result.oauth, input.store);
        refreshed.push(server.id);
      }
      continue;
    }
    if (status.state === "expiring") continue; // still valid for now
    if (oauth.status !== "error") {
      const marked: McpServerOAuthConfig = { ...oauth, status: "error" };
      await updateProjectServerOAuth(project.id, server.id, marked, input.store).catch(() => false);
    }
    failures.push({ serverId: server.id, serverName: server.name, expiresAt: oauth.expiresAt, reason: result.reason });
  }
  return { refreshed, failures };
}
