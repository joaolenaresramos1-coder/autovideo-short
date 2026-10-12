import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
        },
      },
      {
        test: {
          name: "sql",
          // fake narration is not speech: skip the speech recognition there
          env: { CAPTION_ALIGN: "off" },
          include: ["tests/sql/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          // Every SQL test file creates its own database, but keep them serial
          // so the shared server is not overloaded.
          fileParallelism: false,
        },
      },
    ],
  },
});
