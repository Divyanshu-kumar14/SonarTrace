import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // WebAudio does not exist in Node; unit tests inject a fake AudioContext
    // (tests/helpers/webaudio-fake.ts) so no DOM environment is required.
    environment: "node",
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});