import { defineConfig } from "vitest/config";

// convex-test runs Convex functions in-memory, so the suite needs no
// deployment and never touches the local backend's data. The edge-runtime
// environment matches what Convex functions actually execute in.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
