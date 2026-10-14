import { describe, expect, it } from "vitest";
import { formatRunServer, runServer, serverEndpoint } from "./run-server.js";

const home = ["", "home", "example"].join("/");
const macHome = ["", "Users", "example"].join("/");

describe("run server", () => {
  it("drops URL userinfo, query, and fragment", () => {
    const url = "https://" + "user:pa55word@" + "mcp.example:8443/v1/mcp?api_key=k3y-value&region=eu#access_token=t0k3n";
    expect(serverEndpoint({ transport: "streamable-http", url })).toBe("https://mcp.example:8443/v1/mcp");
    expect(serverEndpoint({ transport: "sse", url: "http://127.0.0.1:3000/sse" })).toBe("http://127.0.0.1:3000/sse");
  });

  it("records a stdio command and absolute path arguments by basename", () => {
    expect(serverEndpoint({
      transport: "stdio",
      command: `${home}/.nvm/versions/node/v22.13.0/bin/node`,
      args: [`${home}/work/server/dist/index.js`, `--config=${macHome}/cfg.json`, "--port", "3000", "./local.js", "two words"],
    })).toBe('node index.js --config=cfg.json --port 3000 ./local.js "two words"');
    expect(serverEndpoint({ transport: "stdio", command: "C:\\Tools\\mcp\\server.exe", args: ["C:\\data\\db.sqlite"] }))
      .toBe("server.exe db.sqlite");
    expect(serverEndpoint({ transport: "stdio", command: "npx" })).toBe("npx");
  });

  it("omits an unknown name and version and formats one line", () => {
    const bare = runServer({ transport: "stdio", command: "uvx", args: ["mcp-server-time"] });
    expect(bare).toEqual({ transport: "stdio", endpoint: "uvx mcp-server-time" });
    expect(formatRunServer(bare)).toBe("unknown · stdio uvx mcp-server-time");
    const named = runServer({ transport: "streamable-http", url: "https://mcp.example/mcp" }, { name: "demo", version: "1.2.0" });
    expect(formatRunServer(named)).toBe("demo 1.2.0 · streamable-http https://mcp.example/mcp");
  });
});
