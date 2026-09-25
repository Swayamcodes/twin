import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/scenarios/test/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
  },
});
