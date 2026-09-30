/// <reference types="node" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTwin, type MinimalReceipt, type RunResult, type TwinSession } from "@twin-cli/core";
import { main } from "../src/index.js";

vi.mock("@twin-cli/core", () => ({ createTwin: vi.fn() }));

const output = new TextEncoder();
const run = vi.fn();
const inspect = vi.fn();
const discard = vi.fn();
const receipt: MinimalReceipt = {
  schemaVersion: 1,
  files: { coverage: "unavailable", issues: [{ reason: "λ" }], changes: [] },
  watch: [],
};

function mockWrite(...args: unknown[]): boolean {
  const callback = args.find(value => typeof value === "function") as ((error?: Error) => void) | undefined;
  callback?.();
  return true;
}

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
  inspect.mockReturnValue({ workspacePath: "/tmp/twin", state: "finished", receipt });
  discard.mockResolvedValue({ status: "removed" });
  vi.spyOn(process.stdout, "write").mockImplementation(mockWrite);
  vi.spyOn(process.stderr, "write").mockImplementation(mockWrite);
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
    expect(process.stdout.write).toHaveBeenCalledWith(output.encode("from stdout"), expect.any(Function));
    expect(process.stderr.write).toHaveBeenCalledWith(output.encode("from stderr"), expect.any(Function));
  });

  it("preserves every argument token after the separator", async () => {
    const args = ["--flag", "two words", "", "'quoted'", "--", "λ"];
    expect(await main(["run", "--", "tool", ...args])).toBe(0);
    expect(run.mock.calls[0][0].argv).toEqual(args);
  });

  it("selects inherited stdio without replaying captured bytes", async () => {
    expect(await main(["run", "--interactive", "--", "tool", "two words"])).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: "tool", argv: ["two words"], stdio: "inherit",
    }));
    expect(process.stdout.write).not.toHaveBeenCalled();
    const stderrChunks = vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array));
    expect(Buffer.concat(stderrChunks).toString()).toContain("TWIN-RECEIPT/1");
  });

  it.each([["run"], ["run", "--"], ["run", "tool"], ["run", "--", ""]])(
    "rejects missing or malformed command usage: %j",
    async (...args: string[]) => {
      expect(await main(args)).toBe(2);
      expect(createTwin).not.toHaveBeenCalled();
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Usage: twin run [--interactive] --"));
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

  it("frames exact UTF-8 receipt bytes on stderr before discard", async () => {
    expect(await main(["run", "--", "tool"])).toBe(0);
    const chunks = vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array));
    const bytes = Buffer.concat(chunks);
    const commandBytes = output.encode("from stderr");
    expect(bytes.subarray(0, commandBytes.length)).toEqual(Buffer.from(commandBytes));
    const payload = Buffer.from(JSON.stringify(receipt), "utf8");
    expect(bytes.subarray(commandBytes.length)).toEqual(Buffer.concat([
      Buffer.from(`\x1eTWIN-RECEIPT/1 ${payload.length}\n`, "ascii"), payload, Buffer.from("\n"),
    ]));
    expect(vi.mocked(process.stderr.write).mock.invocationCallOrder[1]).toBeLessThan(discard.mock.invocationCallOrder[0]);
  });

  it("treats refused discard as failure", async () => {
    discard.mockResolvedValue({ status: "refused", reason: "guard" });
    expect(await main(["run", "--", "tool"])).toBe(1);
    expect(inspect.mock.invocationCallOrder[0]).toBeLessThan(discard.mock.invocationCallOrder[0]);
  });

  it("appends its frame after child stderr that imitates a frame", async () => {
    const imitation = Buffer.from("\x1eTWIN-RECEIPT/1 2\n{}\n");
    run.mockResolvedValue({ ...result(0), stderr: { bytes: imitation } });
    expect(await main(["run", "--", "tool"])).toBe(0);
    const bytes = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array)));
    expect(bytes.subarray(0, imitation.length)).toEqual(imitation);
    const payload = Buffer.from(JSON.stringify(receipt), "utf8");
    expect(bytes.subarray(imitation.length)).toEqual(Buffer.concat([
      Buffer.from(`\x1eTWIN-RECEIPT/1 ${payload.length}\n`, "ascii"), payload, Buffer.from("\n"),
    ]));
  });

  it("emits a bounded unavailable frame if receipt serialization exceeds its cap", async () => {
    inspect.mockReturnValue({
      workspacePath: "/tmp/twin", state: "finished",
      receipt: { ...receipt, files: { coverage: "partial", issues: [{ reason: "x".repeat(9 * 1024 * 1024) }], changes: [] } },
    });
    expect(await main(["run", "--", "tool"])).toBe(0);
    const bytes = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array)));
    expect(bytes.length).toBeLessThan(8 * 1024 * 1024);
    expect(bytes.toString("utf8")).toContain("receipt-limit");
    expect(discard).toHaveBeenCalledOnce();
  });
});
