import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 5000,
  },
});
