import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/core.test.ts",
      "test/process.test.ts",
      "test/pid-file.test.ts",
      "test/lifecycle.integration.test.ts",
    ],
    clearMocks: true,
    restoreMocks: true,
  },
});
