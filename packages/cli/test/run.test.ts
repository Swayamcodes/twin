/// <reference types="node" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTwin, type MinimalReceipt, type RunResult, type TwinSession } from "@twin-cli/core";
import { main } from "../src/index.js";

vi.mock("@twin-cli/core", async importOriginal => ({ ...await importOriginal<typeof import("@twin-cli/core")>(), createTwin: vi.fn() }));

const output = new TextEncoder();
const run = vi.fn();
const inspect = vi.fn();
const discard = vi.fn();
const receipt: MinimalReceipt = {
  schemaVersion: 5,
  command: { coverage: "top-level-only", nestedCommands: "not-observed", admitted: true,
    processStart: "confirmed", executable: { status: "allowlisted-basename", value: "node" },
    arguments: { status: "omitted", count: 2, capped: false }, disposition: "exited",
    timeoutObserved: false, directChildSettled: true, exitCode: 0, signal: null },
  process: { coverage: "top-level-process-group", escapedDescendants: "not-observed",
    directChild: { start: "confirmed", settlement: "observed" }, groupAfterDirectExit: "absent",
    termination: [], finalGroup: "absent", capturedPipes: "closed" },
  files: { coverage: "unavailable", issues: [{ reason: "λ" }], changes: [] },
  dependencies: { declarations: { coverage: "incomplete", changes: [] }, lockfiles: { coverage: "complete", changes: [] },
    issues: [{ phase: "before", path: "package.json", reason: "missing" }] },
  globalNpm: { coverage: "complete", source: "env-prefix", changes: [{ name: "probe", change: "added", before: null, after: "1.0.0" }], issues: [] },
  watch: [],
};

function mockWrite(...args: unknown[]): boolean {
  const callback = args.find(value => typeof value === "function") as ((error?: Error) => void) | undefined;
  callback?.();
  return true;
}

function result(exitCode: number): RunResult {
  return {
    schemaVersion: 1, outcome: "exited", started: true, directChildSettled: true,
    exitCode, signal: null, spawnError: null, terminationError: null,
    stdout: { bytes: output.encode("from stdout"), complete: true, truncated: false, error: null },
    stderr: { bytes: output.encode("from stderr"), complete: true, truncated: false, error: null },
  };
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
    expect(run.mock.invocationCallOrder[0]!).toBeLessThan(inspect.mock.invocationCallOrder[0]!);
    expect(inspect.mock.invocationCallOrder[0]!).toBeLessThan(discard.mock.invocationCallOrder[0]!);
    expect(process.stdout.write).toHaveBeenCalledWith(output.encode("from stdout"), expect.any(Function));
    expect(process.stderr.write).toHaveBeenCalledWith(output.encode("from stderr"), expect.any(Function));
  });

  it("preserves every argument token after the separator", async () => {
    const args = ["--flag", "two words", "", "'quoted'", "--", "λ"];
    expect(await main(["run", "--", "tool", ...args])).toBe(0);
    expect(run.mock.calls[0]![0].argv).toEqual(args);
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

  it.each(["SIGINT", "SIGTERM"] as const)("handles %s during startup and restores listeners", async requested => {
    let finishCreate!: (session: TwinSession) => void;
    vi.mocked(createTwin).mockImplementationOnce(() => new Promise(resolve => { finishCreate = resolve; }));
    const beforeInt = process.listeners("SIGINT");
    const beforeTerm = process.listeners("SIGTERM");
    const running = main(["run", "--", "tool"]);
    await vi.waitFor(() => expect(createTwin).toHaveBeenCalledOnce());
    const listener = process.listeners(requested).at(-1) as (() => void) | undefined;
    expect(listener).toBeDefined();
    listener!();
    listener!();
    finishCreate({ run, inspect, discard } as unknown as TwinSession);
    expect(await running).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
    expect(process.listeners("SIGINT")).toEqual(beforeInt);
    expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
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

  it.each([
    { outcome: "timed-out" as const },
    { lifecycleIssue: "process group present" },
    { terminationError: "Could not deliver SIGTERM" },
  ])("returns nonzero for incomplete execution despite child exit zero: %j", async difference => {
    run.mockResolvedValue({ ...result(0), ...difference });
    expect(await main(["run", "--", "tool"])).toBe(1);
    expect(inspect).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
  });

  it("attempts discard when the command throws", async () => {
    run.mockRejectedValue(new Error("command failed"));
    expect(await main(["run", "--", "tool"])).toBe(1);
    expect(discard).toHaveBeenCalledOnce();
  });

  it("frames an unattempted command when interrupted before launch", async () => {
    run.mockRejectedValue(new Error("Interrupted before command launch"));
    inspect.mockReturnValue({ workspacePath: "/tmp/twin", state: "ready" });
    expect(await main(["run", "--", "tool", "secret-argument"])).toBe(1);
    const bytes = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array)));
    const frameStart = bytes.indexOf(Buffer.from("\x1eTWIN-RECEIPT/1 "));
    expect(frameStart).toBeGreaterThanOrEqual(0);
    const frame = bytes.subarray(frameStart);
    const headerEnd = frame.indexOf(10);
    const length = Number(frame.subarray(16, headerEnd).toString("ascii"));
    const payload = JSON.parse(frame.subarray(headerEnd + 1, headerEnd + 1 + length).toString("utf8")) as MinimalReceipt;
    expect(payload).toMatchObject({ schemaVersion: 5, command: { admitted: false,
      processStart: "not-confirmed", disposition: "not-attempted", nestedCommands: "not-observed" },
    process: { directChild: { start: "not-confirmed", settlement: "not-applicable" }, finalGroup: "not-applicable",
      termination: [] } });
    expect(frame.length).toBe(headerEnd + 1 + length + 1);
    expect(JSON.stringify(payload)).not.toContain("secret-argument");
  });

  it("reports unknown command state when a finished session has no receipt", async () => {
    run.mockRejectedValue(new Error("receipt unavailable"));
    inspect.mockReturnValue({ workspacePath: "/tmp/twin", state: "finished" });
    expect(await main(["run", "--", "tool"])).toBe(1);
    const bytes = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array)));
    const frame = bytes.subarray(bytes.indexOf(Buffer.from("\x1eTWIN-RECEIPT/1 ")));
    const headerEnd = frame.indexOf(10);
    const length = Number(frame.subarray(16, headerEnd).toString("ascii"));
    const payload = JSON.parse(frame.subarray(headerEnd + 1, headerEnd + 1 + length).toString("utf8")) as MinimalReceipt;
    expect(payload.command).toEqual({ coverage: "top-level-only", nestedCommands: "not-observed", admitted: null,
      processStart: "unknown", executable: { status: "omitted" },
      arguments: { status: "omitted", count: null, capped: false }, disposition: "observation-unavailable",
      timeoutObserved: null, directChildSettled: null, exitCode: null, signal: null });
    expect(payload.process).toMatchObject({ directChild: { start: "unknown", settlement: "unknown" }, finalGroup: "unknown" });
  });

  it("frames exact UTF-8 receipt bytes on stderr before discard", async () => {
    expect(await main(["run", "--", "tool"])).toBe(0);
    const chunks = vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array));
    const bytes = Buffer.concat(chunks);
    const commandBytes = output.encode("from stderr");
    expect(bytes.subarray(0, commandBytes.length)).toEqual(Buffer.from(commandBytes));
    const payload = Buffer.from(JSON.stringify(receipt), "utf8");
    expect(JSON.parse(payload.toString("utf8"))).toMatchObject({ schemaVersion: 5,
      command: { coverage: "top-level-only", nestedCommands: "not-observed", disposition: "exited" },
      process: { directChild: { start: "confirmed", settlement: "observed" }, finalGroup: "absent" },
      dependencies: { declarations: { coverage: "incomplete" }, lockfiles: { coverage: "complete" } },
      globalNpm: { coverage: "complete", changes: [{ name: "probe", change: "added" }] } });
    expect(bytes.subarray(commandBytes.length)).toEqual(Buffer.concat([
      Buffer.from(`\x1eTWIN-RECEIPT/1 ${payload.length}\n`, "ascii"), payload, Buffer.from("\n"),
    ]));
    expect(vi.mocked(process.stderr.write).mock.invocationCallOrder[1]!).toBeLessThan(discard.mock.invocationCallOrder[0]!);
  });

  it("treats refused discard as failure", async () => {
    discard.mockResolvedValue({ status: "refused", reason: "guard" });
    expect(await main(["run", "--", "tool"])).toBe(1);
    expect(inspect.mock.invocationCallOrder[0]!).toBeLessThan(discard.mock.invocationCallOrder[0]!);
    expect(process.stderr.write).toHaveBeenCalledWith("Twin discard refused: guard\n", expect.any(Function));
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
    const frameStart = bytes.indexOf(Buffer.from("\x1eTWIN-RECEIPT/1 "));
    const frame = bytes.subarray(frameStart);
    const headerEnd = frame.indexOf(10);
    const length = Number(frame.subarray(16, headerEnd).toString("ascii"));
    expect(frame.length).toBe(headerEnd + 1 + length + 1);
    const payload = JSON.parse(frame.subarray(headerEnd + 1, headerEnd + 1 + length).toString("utf8")) as MinimalReceipt;
    expect(payload.files).toMatchObject({ coverage: "unavailable", issues: [{ reason: "receipt-limit" }] });
    expect(payload.command).toEqual(receipt.command);
    expect(payload.process).toEqual(receipt.process);
    expect(payload.command).toMatchObject({ admitted: true, processStart: "confirmed", disposition: "exited", exitCode: 0 });
    expect(discard).toHaveBeenCalledOnce();
  });
});
