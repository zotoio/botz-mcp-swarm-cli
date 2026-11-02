import type { Command } from "commander";
import { callSwarmMcpTool, resolveRemoteSwarmToken } from "./remote-run.js";
import { resolveSwarmServerUrl } from "./worker-transport.js";

export interface RemoteLoginOptions {
  server?: string;
  token?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

/** OAuth login state of each server in a central Swarm project (never includes tokens). */
export async function remoteLoginStatus(projectId: string, opts: RemoteLoginOptions = {}): Promise<Record<string, unknown>> {
  const env = opts.env ?? process.env;
  return callSwarmMcpTool(resolveSwarmServerUrl(opts.server, env), resolveRemoteSwarmToken(opts.token, env), "swarm_server_login_status", { project_id: projectId }, opts.fetchFn);
}

/** Start a Reconnect for one project server; returns an authorize URL to open (or `reconnected: true`). */
export async function remoteReconnect(projectId: string, serverId: string, opts: RemoteLoginOptions = {}): Promise<Record<string, unknown>> {
  const env = opts.env ?? process.env;
  return callSwarmMcpTool(resolveSwarmServerUrl(opts.server, env), resolveRemoteSwarmToken(opts.token, env), "swarm_server_reconnect", { project_id: projectId, server_id: serverId }, opts.fetchFn);
}

export function formatLoginStatus(status: Record<string, unknown>): string {
  const servers = Array.isArray(status.servers) ? (status.servers as Array<Record<string, unknown>>) : [];
  if (servers.length === 0) return "No OAuth servers in this project.";
  return servers
    .map((s) => {
      const flag = s.reconnect_required ? "  ← Login expired — Reconnect" : "";
      const exp = s.expires_at ? ` (expires ${String(s.expires_at)})` : "";
      return `${String(s.server_name)} [${String(s.server_id)}]: ${String(s.state)}${exp}${flag}`;
    })
    .join("\n");
}

/** `swarm login-status <project>` and `swarm reconnect <project> <server>` against the central Swarm server. */
export function registerLoginCommands(program: Command): void {
  program
    .command("login-status")
    .description("Show the OAuth login state of each server in a central Swarm project (expired logins need a Reconnect)")
    .argument("<project>", "Project id")
    .option("--server <url>", "Central Swarm server URL (default https://swarm.botz.ai or SWARM_SERVER_URL)")
    .option("--token <token>", "Swarm token (default SWARM_TOKEN / BOTZ_API_KEY)")
    .option("--json", "Print JSON")
    .action(async (project: string, opts: { server?: string; token?: string; json?: boolean }) => {
      const status = await remoteLoginStatus(project, opts);
      console.log(opts.json ? JSON.stringify(status, null, 2) : formatLoginStatus(status));
      if (status.login_expired) process.exitCode = 2;
    });
  program
    .command("reconnect")
    .description("Reconnect a project server whose OAuth login expired: prints a sign-in URL to open; Swarm saves the new login")
    .argument("<project>", "Project id")
    .argument("<serverId>", "Project server id (see `swarm login-status`)")
    .option("--server <url>", "Central Swarm server URL (default https://swarm.botz.ai or SWARM_SERVER_URL)")
    .option("--token <token>", "Swarm token (default SWARM_TOKEN / BOTZ_API_KEY)")
    .option("--json", "Print JSON")
    .action(async (project: string, serverId: string, opts: { server?: string; token?: string; json?: boolean }) => {
      const res = await remoteReconnect(project, serverId, opts);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.reconnected) console.log(`Reconnected ${serverId}.`);
      else console.log(`Open this URL in a browser to sign in (valid ${String(res.expires_in_seconds ?? 600)}s):\n${String(res.authorize_url)}`);
    });
}
