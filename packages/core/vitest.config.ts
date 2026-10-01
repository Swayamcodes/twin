import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
    include: ["packages/core/test/{copy,run,discard,twin,receipt,dependencies,global-npm,command-receipt,apply}.test.ts"],
  pool: "forks", fileParallelism: false, maxWorkers: 1,
  disableConsoleIntercept: true,
  sequence: { concurrent: false }, testTimeout: 15000, hookTimeout: 15000,
} });
