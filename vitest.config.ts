import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.join(repoRoot, "src", "engine");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@zotoio\/botz-mcp-swarm-engine\/(.+)$/,
        replacement: `${engineRoot}/$1`,
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: [
      /** Requires platform-core `otel/trace-query` (not in the vendored engine intersection). */
      "src/engine/adapters/client-traceparent.test.ts",
    ],
    testTimeout: 30000,
  },
});
