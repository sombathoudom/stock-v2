import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// convex-test runs Convex functions in-memory, so the suite needs no
// deployment and never touches the local backend's data. The edge-runtime
// environment matches what Convex functions actually execute in.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    server: { deps: { inline: ["convex-test"] } },
  },
  // Same aliases as tsconfig — src tests import through the component tree.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@convex": fileURLToPath(new URL("./convex", import.meta.url)),
    },
  },
});
