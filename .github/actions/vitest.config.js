import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The tests of the release workflow run every action of it, as programs.
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
