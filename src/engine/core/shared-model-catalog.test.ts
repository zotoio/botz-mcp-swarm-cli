import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUNNER_CURSOR_RUNTIME,
  RUNNER_LOCAL_MODEL_CATALOG_JSON,
  readModelCatalogFromEnv,
  setModelCatalogListerForTests,
  withSharedModelCatalog,
} from "./shared-model-catalog.js";

const ENV = RUNNER_LOCAL_MODEL_CATALOG_JSON;
const RUNTIME = RUNNER_CURSOR_RUNTIME;

describe("withSharedModelCatalog", () => {
  afterEach(() => {
    delete process.env[ENV];
    delete process.env[RUNTIME];
    setModelCatalogListerForTests(null);
  });

  it("keeps a catalogue the caller already set", async () => {
    process.env[ENV] = '["keep-me"]';
  setModelCatalogListerForTests(async () => ["should-not-list"]);
    let seen = "";
    await withSharedModelCatalog("key", async () => {
      seen = process.env[ENV] ?? "";
    });
    expect(seen).toBe('["keep-me"]');
  });

  it("skips listing when RUNNER_CURSOR_RUNTIME=cloud", async () => {
    process.env[RUNTIME] = "cloud";
    const lister = vi.fn(async () => ["m1"]);
    setModelCatalogListerForTests(lister);
    await withSharedModelCatalog("key", async () => undefined);
    expect(lister).not.toHaveBeenCalled();
  });

  it("runs without a catalogue when listing fails", async () => {
    setModelCatalogListerForTests(async () => {
      throw new Error("list down");
    });
    await withSharedModelCatalog("key", async () => undefined);
    expect(process.env[ENV]).toBeUndefined();
  });

  it("clears env after fn throws", async () => {
    setModelCatalogListerForTests(async () => ["a"]);
    await expect(
      withSharedModelCatalog("key", async () => {
        expect(readModelCatalogFromEnv()).toEqual(["a"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.env[ENV]).toBeUndefined();
  });

  it("never shares an empty list", async () => {
    setModelCatalogListerForTests(async () => []);
    await withSharedModelCatalog("key", async () => undefined);
    expect(process.env[ENV]).toBeUndefined();
  });

  it("publishes listed ids for the duration of fn", async () => {
    setModelCatalogListerForTests(async () => ["gpt", "claude"]);
    await withSharedModelCatalog("key", async () => {
      expect(readModelCatalogFromEnv()).toEqual(["gpt", "claude"]);
    });
    expect(process.env[ENV]).toBeUndefined();
  });
});
