import { describe, expect, it } from "vitest";
import { makeReportScrubber, scrubReport, targetSecretValues } from "./report-scrub.js";
import type { RunReport } from "../engine/types/run.js";

// Built by concatenation so the leakage check never sees a literal user path or token in this file.
const USER = "example" + "-user";
const home = ["", "home", USER].join("/");
const repo = `${home}/src/project`;
const WINDOWS_EXE = ["C:", "Users", "example", "app", "server.exe"].join("\\");
const SECRET = "tok" + "-abcdef123";

describe("report scrubber", () => {
  const scrub = makeReportScrubber({
    secrets: [SECRET, "x"],
    commands: [`${repo}/bin/server.sh`],
    home,
    repoRoot: repo,
    cwd: `${repo}/svc`,
    username: USER,
  });

  it("removes secrets, the stdio command path, user paths, and the username", () => {
    expect(scrub(`Bearer ${SECRET} failed`)).toBe("Bearer [redacted] failed");
    expect(scrub(`spawn ${repo}/bin/server.sh ENOENT`)).toBe("spawn server.sh ENOENT");
    expect(scrub(`read ${repo}/svc/data.json`)).toBe("read <cwd>/data.json");
    expect(scrub(`read ${repo}/README.md`)).toBe("read <repo>/README.md");
    expect(scrub(`cache ${home}/.cache/x`)).toBe("cache ~/.cache/x");
    expect(scrub("open /var/tmp/run/sock failed")).toBe("open sock failed");
    expect(scrub(`${WINDOWS_EXE} exited`)).toBe("server.exe exited");
    expect(scrub(`hello ${USER}`)).toBe("hello <user>");
    expect(scrub(`${home}2/other`)).not.toContain("~2");
  });

  it("keeps URLs, short values, and relative paths", () => {
    expect(scrub("http://127.0.0.1:3000/mcp/v1 timed out")).toBe("http://127.0.0.1:3000/mcp/v1 timed out");
    expect(scrub("x and/or mock-server/run.sh")).toBe("x and/or mock-server/run.sh");
  });

  it("scrubs every string in a report and redacts sensitive keys", () => {
    const report = {
      id: "r1",
      failReasons: [`Session warm-up failed: spawn ${repo}/bin/server.sh · ${SECRET}`],
      params: { message: "hi", apiToken: SECRET },
    } as unknown as RunReport;
    const clean = scrubReport(report, scrub);
    const text = JSON.stringify(clean);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(home);
    expect(clean.failReasons[0]).toContain("server.sh");
  });

  it("removes URL userinfo and secret query values, even inside error text and nested JSON", () => {
    const pass = "p" + "w-Xy7Qz";
    const key = "k" + "ey-Ab12Cd34";
    const url = `http://u1:${pass}@127.0.0.1:9/mcp?api_key=${key}&mode=fast&X-Amz-Signature=${key}&client_secret=${key}`;
    const scrubbed = scrub(`fetch failed (ECONNREFUSED) · ${url}`);
    expect(scrubbed).not.toContain(pass);
    expect(scrubbed).not.toContain(key);
    expect(scrubbed).not.toContain("u1");
    expect(scrubbed).toContain("http://[redacted]@127.0.0.1:9/mcp?api_key=[redacted]&mode=fast");
    expect(scrub(`https://bot@example.com/mcp?Token=${key}`)).toBe("https://[redacted]@example.com/mcp?Token=[redacted]");
    for (const name of ["apikey", "api-key", "key", "access_token", "password", "sig", "x-api-key", "subscription-key",
      "Ocp-Apim-Subscription-Key", "private_key", "client_key", "auth", "pwd", "session", "sid", "jwt", "bearer",
      "pass", "hmac", "code"]) {
      expect(scrub(`?${name}=${key}`)).toBe(`?${name}=[redacted]`);
    }
    expect(scrub(`GET /cb#access_token=${key}&token_type=bearer&state=s1`))
      .toBe("GET /cb#access_token=[redacted]&token_type=bearer&state=s1");
    expect(scrub(`GET /cb#code=${key}&state=s1`)).toBe("GET /cb#code=[redacted]&state=s1");
    expect(scrub("?auth_mode=none&author=me&max_tokens=128&page_token=abc&tokenizer=bpe&secretary=none"))
      .toBe("?auth_mode=none&author=me&max_tokens=128&page_token=abc&tokenizer=bpe&secretary=none");
    const nested = scrubReport({
      id: "r",
      failReasons: [JSON.stringify({ error: { message: `GET ${url}` } })],
    } as unknown as RunReport, scrub);
    expect(JSON.stringify(nested)).not.toContain(key);
    expect(JSON.stringify(nested)).not.toContain(pass);
  });

  it("removes Windows forward-slash, UNC, file URL, and colon-prefixed paths", () => {
    const forward = ["C:", "Users", "example", "app", "server.exe"].join("/");
    const unc = ["", "", "fileserver", "share", "example", "data.json"].join("\\");
    const fileUrl = "file://" + ["", "home", "other-example", "notes.txt"].join("/");
    expect(scrub(`spawn ${forward} failed`)).toBe("spawn server.exe failed");
    expect(scrub(`open ${unc} failed`)).toBe("open data.json failed");
    expect(scrub(`load ${fileUrl}`)).toBe("load notes.txt");
    expect(scrub("PATH=/usr/local/bin:/srv/tools/bin")).toBe("PATH=bin:bin");
    expect(scrub("mount:/srv/data/cache")).toBe("mount:cache");
  });

  it("replaces whole paths whose folder names hold spaces", () => {
    const winSpaced = ["C:", "Users", "Example Person", "My Projects", "app", "server.exe"].join("\\");
    const winForward = ["D:", "Work Files", "app", "run.cmd"].join("/");
    const posixSpaced = ["", "home", "other-example", "My Projects", "notes.txt"].join("/");
    const macSpaced = ["", "Users", "other-example", "Application Support", "tool", "config.json"].join("/");
    const unc = ["", "", "fileserver", "Team Share", "Q1 Reports", "data.json"].join("\\");
    expect(scrub(`spawn ${winSpaced} failed`)).toBe("spawn server.exe failed");
    expect(scrub(`spawn ${winForward} failed`)).toBe("spawn run.cmd failed");
    expect(scrub(`open ${posixSpaced} failed`)).toBe("open notes.txt failed");
    expect(scrub(`read ${macSpaced}`)).toBe("read config.json");
    expect(scrub(`open ${unc} failed`)).toBe("open data.json failed");
    expect(scrub(`cache ${home}/My Data/x.json`)).toBe("cache ~/My Data/x.json");
    const spacedHome = ["", "home", "Example Person"].join("/");
    const spaced = makeReportScrubber({ home: spacedHome, cwd: "/srv/cwd-example" });
    expect(spaced(`read ${spacedHome}/Docs Folder/a.txt`)).toBe("read ~/Docs Folder/a.txt");
  });

  it("scrubs object keys as well as values", () => {
    const keyed = scrubReport({ id: "r", failReasons: [], params: { [`${repo}/svc/x.json`]: "v" } } as unknown as RunReport, scrub);
    expect(Object.keys(keyed.params ?? {})).toEqual(["<cwd>/x.json"]);
  });

  it("lists header values and the credential after an auth scheme", () => {
    expect(targetSecretValues({
      transport: "streamable-http",
      url: "http://127.0.0.1/mcp",
      headers: { Authorization: "Bearer abc12345", "X-Key": "k" },
    })).toEqual(["Bearer abc12345", "abc12345", "k"]);
    expect(targetSecretValues({ transport: "stdio", command: "srv", env: { A: "v1" } })).toEqual(["v1"]);
  });
});
