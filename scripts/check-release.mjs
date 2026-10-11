#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ref = process.env.GITHUB_REF ?? "";
if (ref !== `refs/tags/v${pkg.version}`) throw new Error("publish requires a v<package-version> tag; select that tag for a manual run");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error("invalid release version");
const prerelease = pkg.version.includes("-");
if (process.env.GITHUB_EVENT_NAME === "release") {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (Boolean(event.release?.prerelease) !== prerelease || event.release?.draft) throw new Error("release prerelease status must match the package version");
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${prerelease ? "next" : "latest"}\n`);
console.log(`Validated ${pkg.version} for ${prerelease ? "next" : "latest"}`);
