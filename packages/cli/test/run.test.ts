/// <reference types="node" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTwin, type RunResult, type TwinSession } from "@twin-cli/core";
import { main } from "../src/index.js";

vi.mock("@twin-cli/core", () => ({ createTwin: vi.fn() }));

const output = new TextEncoder();
const run = vi.fn();
const inspect = vi.fn();
const discard = vi.fn();

function result(exitCode: number): RunResult {
  return {
    exitCode,
    stdout: { bytes: output.encode("from stdout") },
    stderr: { bytes: output.encode("from stderr") },
  } as RunResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createTwin).mockResolvedValue({ run, inspect, discard } as unknown as TwinSession);
  run.mockResolvedValue(result(0));
  inspect.mockResolvedValue({});
  discard.mockResolvedValue({});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("twin run", () => {
  it("runs a command with multiple arguments and uses the public lifecycle", async () => {
    expect(await main(["run", "--", "node", "-e", "console.log(1)"])).toBe(0);

    expect(createTwin).toHaveBeenCalledWith(expect.objectContaining({ sourceDirectory: process.cwd() }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ executable: "node", argv: ["-e", "console.log(1)"] }));
    expect(inspect).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(inspect.mock.invocationCallOrder[0]);
    expect(inspect.mock.invocationCallOrder[0]).toBeLessThan(discard.mock.invocationCallOrder[0]);
    expect(process.stdout.write).toHaveBeenCalledWith(output.encode("from stdout"));
    expect(process.stderr.write).toHaveBeenCalledWith(output.encode("from stderr"));
  });

  it("preserves every argument token after the separator", async () => {
    const args = ["--flag", "two words", "", "'quoted'", "--", "λ"];
    expect(await main(["run", "--", "tool", ...args])).toBe(0);
    expect(run.mock.calls[0][0].argv).toEqual(args);
  });

  it.each([["run"], ["run", "--"], ["run", "tool"], ["run", "--", ""]])(
    "rejects missing or malformed command usage: %j",
    async (...args: string[]) => {
      expect(await main(args)).toBe(2);
      expect(createTwin).not.toHaveBeenCalled();
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Usage: twin run --"));
    },
  );

  it("returns nonzero and discards after a nonzero command result", async () => {
    run.mockResolvedValue(result(7));
    expect(await main(["run", "--", "tool"])).toBe(1);
    expect(inspect).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
  });

  it("attempts discard when the command throws", async () => {
    run.mockRejectedValue(new Error("command failed"));
    expect(await main(["run", "--", "tool"])).toBe(1);
    expect(discard).toHaveBeenCalledOnce();
  });
});
