/// <reference types="node" />

import { link, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTwin, type MinimalReceipt, type RunResult, type TwinSession } from "@twin-cli/core";
import { main } from "../src/index.js";
import * as terminal from "../src/terminal-ui.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, link: vi.fn(original.link), mkdtemp: vi.fn(original.mkdtemp) };
});

vi.mock("@twin-cli/core", async importOriginal => ({ ...await importOriginal<typeof import("@twin-cli/core")>(), createTwin: vi.fn() }));

const output = new TextEncoder();
const run = vi.fn();
const inspect = vi.fn();
const discard = vi.fn();
const apply = vi.fn();
const applyAffected = vi.fn();
const affectedResult = {
  status: "applied", changes: 1, scope: "affected-paths", outsideScope: "not-rechecked", phase: "complete",
  plannedTargets: 1, verifiedTargets: 1, destructiveSubtrees: 0, scopeCoverage: "complete",
  paths: [], pathCount: 0, pathsTruncated: false, secondaryFailures: [], secondaryFailuresTruncated: false,
};
const htmlRoots: string[] = [];
async function htmlRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "twin-html-test-"));
  htmlRoots.push(root);
  return root;
}
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

beforeEach(async () => {
  vi.clearAllMocks();
  // Personal project config must not select review/stdio policy in unit tests.
  vi.spyOn(process, "cwd").mockReturnValue(await htmlRoot());
  vi.stubEnv("PATH", dirname(process.execPath));
  vi.mocked(createTwin).mockResolvedValue({ workspacePath: "/tmp/twin", run, inspect, apply, applyAffected, discard } as unknown as TwinSession);
  applyAffected.mockResolvedValue(affectedResult);
  run.mockResolvedValue(result(0));
  inspect.mockReturnValue({ workspacePath: "/tmp/twin", state: "finished", receipt });
  discard.mockResolvedValue({ status: "removed" });
  vi.spyOn(process.stdout, "write").mockImplementation(mockWrite);
  vi.spyOn(process.stderr, "write").mockImplementation(mockWrite);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of htmlRoots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const [options] of vi.mocked(createTwin).mock.calls) {
    try { await rmdir(options.scratchParent); }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
});

describe("twin run", () => {
  it.each([
    ["--apply-scope=affected"], ["-r", "--apply-scope=affected"],
    ["--review", "--apply-scope="], ["--review", "--apply-scope=whole-tree"],
    ["--review", "--apply-scope=affected", "--apply-scope=affected"],
    ["--review", "--no-review", "--apply-scope=affected"],
  ])("rejects affected scope options before config/session admission: %j", async (...flags: string[]) => {
    // A malformed config must not mask the flag failure or authorize review.
    await writeFile(join(process.cwd(), "twin.config.json"), "malformed config");
    expect(await main(["run", ...flags, "--", "/tool"])).toBe(2);
    expect(createTwin).not.toHaveBeenCalled();
    expect(mkdtemp).toHaveBeenCalledTimes(1); // Only the test's own root.
    const text = vi.mocked(process.stderr.write).mock.calls.map(call => String(call[0])).join("");
    expect(text).not.toContain("config");
  });

  it("does not infer affected authorization from saved review", async () => {
    const saved = JSON.stringify({ command: ["/tool"], review: true });
    await writeFile(join(process.cwd(), "twin.config.json"), saved);
    expect(await main(["run", "--apply-scope=affected"])).toBe(2);
    expect(createTwin).not.toHaveBeenCalled();
    expect(await readFile(join(process.cwd(), "twin.config.json"), "utf8")).toBe(saved);
  });

  it("does not accept Apply scope as a config field", async () => {
    const saved = JSON.stringify({ command: ["/tool"], review: true, applyScope: "affected" });
    await writeFile(join(process.cwd(), "twin.config.json"), saved);
    expect(await main(["run"])).toBe(2);
    expect(createTwin).not.toHaveBeenCalled();
    expect(applyAffected).not.toHaveBeenCalled();
    expect(await readFile(join(process.cwd(), "twin.config.json"), "utf8")).toBe(saved);
  });

  it("passes Apply scope flags after the separator unchanged to the command", async () => {
    expect(await main(["run", "--", "/tool", "--apply-scope=affected", "--apply-scope=invalid", "--review", "--"])).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ argv: ["--apply-scope=affected", "--apply-scope=invalid", "--review", "--"] }));
    expect(applyAffected).not.toHaveBeenCalled();
  });

  it.each([false, true])("explicit affected selection discloses scope and preserves JSON receipt with TTY=%s", async tty => {
    vi.spyOn(terminal, "terminalPrompts").mockReturnValue(tty);
    vi.spyOn(terminal, "chooseTerminal").mockResolvedValue("apply");
    const input = vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(["apply\n"]) as typeof process.stdin);
    const saved = JSON.stringify({ command: ["/tool"], review: false });
    await writeFile(join(process.cwd(), "twin.config.json"), saved);
    try { expect(await main(["run", "--review", "--apply-scope=affected"])).toBe(0); }
    finally { input.mockRestore(); }
    expect(applyAffected).toHaveBeenCalledWith();
    expect(applyAffected).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
    const bytes = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array)));
    const payload = Buffer.from(JSON.stringify(receipt), "utf8");
    const frame = Buffer.concat([Buffer.from(`\x1eTWIN-RECEIPT/1 ${payload.length}\n`), payload, Buffer.from("\n")]);
    expect(bytes.includes(frame)).toBe(true);
    const text = bytes.toString("utf8"), disclosure = "Apply verification: affected paths and ancestors. Unrelated files and links will not be rechecked.";
    const marker = "Twin affected-path Apply result: ";
    expect(text.split(disclosure)).toHaveLength(3);
    if (!tty) expect(text.indexOf(disclosure)).toBeLessThan(text.indexOf("Twin review:"));
    expect(JSON.parse(text.split(marker)[1]!.split("\n")[0]!)).toEqual(affectedResult);
    expect(await readFile(join(process.cwd(), "twin.config.json"), "utf8")).toBe(saved);
  });

  it.each(["conflict", "refused", "failed"] as const)("retains copy and preserves byte-safe result fields after affected %s", async status => {
    const input = vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(["apply\n"]) as typeof process.stdin);
    const failure = { ...affectedResult, status, scopeCoverage: "incomplete", phase: "mutation", reason: "unsafe\u202e\u001b", reasonCode: "io-unavailable",
      partialApplicationPossible: status === "failed" ? true : undefined,
      paths: [{ encoding: "base64", value: Buffer.alloc(4096, 255).toString("base64") }, { encoding: "utf8", value: "file\u202e" }], pathCount: 2,
      secondaryFailures: [{ phase: "temporary-cleanup", reasonCode: "temporary-cleanup-refused", paths: [], pathCount: 0, pathsTruncated: false }] };
    const { changes: _changes, ...expected } = failure;
    applyAffected.mockResolvedValue(expected);
    try { expect(await main(["run", "--review", "--apply-scope=affected", "--", "/tool"])).toBe(1); }
    finally { input.mockRestore(); }
    expect(discard).not.toHaveBeenCalled();
    const text = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString("utf8");
    expect(text).toContain("Twin copy retained:");
    expect(text).not.toContain("\u202e");
    expect(text).not.toContain("\u001b");
    expect(JSON.parse(text.split("Twin affected-path Apply result: ")[1]!.split("\n")[0]!)).toEqual(JSON.parse(JSON.stringify(expected)));
    if (status === "failed") expect(text).toContain("may have changed earlier paths");
  });

  it("forwards the default inventory budget and the existing interruption signal independently of command timeout", async () => {
    expect(await main(["run", "--timeout-ms=17", "--", "/tool", "--scan-timeout-ms=1"])).toBe(0);
    const options = vi.mocked(createTwin).mock.calls[0]![0];
    expect(options.scanTimeoutMs).toBe(30000);
    expect(options.scanSignal).toBe(run.mock.calls[0]![0].interruptSignal);
    expect(options.scanSignal?.aborted).toBe(false);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 17, argv: ["--scan-timeout-ms=1"] }));
  });

  it.each([false, true])("uses config scan budget with flag override=%s without modifying config", async override => {
    const root = await htmlRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const saved = JSON.stringify({ command: ["/tool"], timeoutMs: 17, scanTimeoutMs: 23 });
    await writeFile(join(root, "twin.config.json"), saved);
    expect(await main(override ? ["run", "--scan-timeout-ms=31"] : [])).toBe(0);
    expect(createTwin).toHaveBeenCalledWith(expect.objectContaining({ scanTimeoutMs: override ? 31 : 23 }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 17 }));
    expect(await readFile(join(root, "twin.config.json"), "utf8")).toBe(saved);
  });

  it.each(["1", "3600000"])("accepts boundary scan timeout %s", value => {
    return main(["run", `--scan-timeout-ms=${value}`, "--", "/tool"]).then(status => {
      expect(status).toBe(0);
      expect(createTwin).toHaveBeenCalledWith(expect.objectContaining({ scanTimeoutMs: Number(value) }));
    });
  });

  it.each(["", "0", "-1", "3600001", "1.5", "+1", " 1", "1e3", "Infinity", "NaN"])("rejects malformed scan timeout %s before copying", async value => {
    expect(await main(["run", `--scan-timeout-ms=${value}`, "--", "/tool"])).toBe(2);
    expect(createTwin).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects duplicate scan budgets before copying", async () => {
    expect(await main(["run", "--scan-timeout-ms=1", "--scan-timeout-ms=2", "--", "/tool"])).toBe(2);
    expect(createTwin).not.toHaveBeenCalled();
  });

  it("forwards interruption to an in-progress preparation scan and waits for its failure", async () => {
    let settle: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    vi.mocked(createTwin).mockImplementationOnce(options => new Promise((_resolve, reject) => {
      signal = options.scanSignal;
      signal?.addEventListener("abort", () => { settle = () => reject(new Error("scan aborted")); }, { once: true });
    }));
    let finished = false;
    const pending = main(["run", "--", "/tool"]).then(status => { finished = true; return status; });
    await vi.waitFor(() => expect(createTwin).toHaveBeenCalledOnce());
    process.emit("SIGINT");
    expect(signal?.aborted).toBe(true);
    expect(run).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(finished).toBe(false);
    settle!();
    expect(await pending).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("prints scratch allocation OS evidence without creating a session", async () => {
    vi.mocked(mkdtemp).mockRejectedValueOnce(Object.assign(new Error("allocation failed"), {
      code: "ENOSPC", errno: -28, syscall: "mkdtemp", path: "/tmp/twin-cli-probe",
    }));
    expect(await main(["run", "--", "/tool"])).toBe(1);
    const stderr = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString();
    expect(stderr).toContain("code=ENOSPC");
    expect(stderr).toContain("errno=-28");
    expect(stderr).toContain("syscall=mkdtemp");
    expect(stderr).toContain("path=/tmp/twin-cli-probe");
    expect(stderr).not.toContain("TWIN-RECEIPT/1");
    expect(createTwin).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("prints preparation causes without launching or emitting a receipt, and removes the empty scratch parent", async () => {
    const cause = Object.assign(new Error("operation failed"), { code: "EACCES", errno: -13, syscall: "open", path: "/copy/blocked" });
    vi.mocked(createTwin).mockRejectedValueOnce(new Error('Twin copy failed; cleanup={"status":"removed"}; allocation=/tmp/owned', { cause }));
    expect(await main(["run", "--", "/tool"])).toBe(1);
    const stderr = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString();
    expect(stderr).toContain("cause[1].code=EACCES");
    expect(stderr).toContain("cause[1].errno=-13");
    expect(stderr).toContain("cause[1].syscall=open");
    expect(stderr).toContain("cause[1].path=/copy/blocked");
    expect(stderr).toContain('cleanup={"status":"removed"}');
    expect(stderr).not.toContain("TWIN-RECEIPT/1");
    expect(run).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    await expect(readdir(vi.mocked(createTwin).mock.calls[0]![0].scratchParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps execution error causes out of existing receipt/error output", async () => {
    run.mockRejectedValueOnce(new Error("command failed", { cause: Object.assign(new Error("private cause"), { path: "/private", code: "EPRIVATE" }) }));
    expect(await main(["run", "--", "/tool"])).toBe(1);
    const stderr = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString();
    expect(stderr).toContain("command failed");
    expect(stderr).toContain("TWIN-RECEIPT/1");
    expect(stderr).not.toContain("private cause");
    expect(stderr).not.toContain("EPRIVATE");
    expect(discard).toHaveBeenCalledOnce();
  });

  it.each([["--help"], ["-h"], ["run", "--help"], ["run", "-h"]])("shows help without launching for %j", async (...args: string[]) => {
    expect(await main(args)).toBe(0);
    expect(createTwin).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("Usage: twin run"));
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("Apply defaults to whole-tree validation."));
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("--apply-scope=affected requires explicit --review"));
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining("separate from the schema-5 command receipt"));
  });

  it.each([[], ["run"]])("uses saved argv and timeout for commandless %j", async (...args: string[]) => {
    const root = await htmlRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    await writeFile(join(root, "twin.config.json"), JSON.stringify({ command: ["/tool", "exec", "  saved task  ", "--skip-git-repo-check"], timeoutMs: 321, receipt: "text" }));
    expect(await main(args)).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ executable: "/tool", argv: ["exec", "  saved task  ", "--skip-git-repo-check"], timeoutMs: 321 }));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Twin receipt"), expect.any(Function));
  });

  it("overrides config without persisting and replaces the whole command, keeping aliases after --", async () => {
    const root = await htmlRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const saved = JSON.stringify({ command: ["/saved", "exec", "old task"], interactive: false, review: false, receipt: "json", timeoutMs: 10 });
    await writeFile(join(root, "twin.config.json"), saved);
    const input = vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(["discard\n"]) as typeof process.stdin);
    expect(await main(["run", "-i", "-r", "-t", "text", "--timeout-ms=123", "--", "/tool", "-i", "-r", "-t", "text", "", "two words", "--"])).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ executable: "/tool", argv: ["-i", "-r", "-t", "text", "", "two words", "--"], stdio: "inherit", timeoutMs: 123 }));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Twin review"), expect.any(Function));
    expect(await readFile(join(root, "twin.config.json"), "utf8")).toBe(saved);
    input.mockRestore();
  });

  it("uses configured interactive, review and receipt preferences", async () => {
    const root = await htmlRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    await writeFile(join(root, "twin.config.json"), JSON.stringify({ command: ["/tool"], interactive: true, review: true, receipt: "text" }));
    const input = vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(["discard\n"]) as typeof process.stdin);
    expect(await main([])).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ stdio: "inherit", timeoutMs: 3600000 }));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Twin review"), expect.any(Function));
    input.mockRestore();
  });

  it.each([[], ["run"]])("guides missing-config invocation %j without launch", async (...args: string[]) => {
    vi.spyOn(process, "cwd").mockReturnValue(await htmlRoot());
    expect(await main(args)).toBe(2);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("twin init or twin run --"), expect.any(Function));
    expect(createTwin).not.toHaveBeenCalled();
  });

  it.each(["{", '{"command":[]}', '{"command":["/tool"],"timeoutMs":0}', '{"command":["/tool"],"scanTimeoutMs":0}'])("rejects invalid saved config before even an explicit workload: %s", async saved => {
    const root = await htmlRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    await writeFile(join(root, "twin.config.json"), saved);
    expect(await main(["run", "--", "/tool"])).toBe(2);
    expect(createTwin).not.toHaveBeenCalled();
  });

  it("init prompts and saves without creating a session", async () => {
    const root = await htmlRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const input = vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(['codex\none-shot\n  task λ  \n["--skip-git-repo-check"]\nno\ntext\n']) as typeof process.stdin);
    expect(await main(["init"])).toBe(0);
    expect(JSON.parse(await readFile(join(root, "twin.config.json"), "utf8"))).toEqual({ command: ["codex", "exec", "  task λ  ", "--skip-git-repo-check"], interactive: false, review: false, receipt: "text" });
    expect(createTwin).not.toHaveBeenCalled();
    expect(await main(["init"])).toBe(2);
    input.mockRestore();
  });

  it.each([
    ["invalid agent", "other\n", "Choose codex or claude."],
    ["invalid mode", "codex\nother\n", "Choose interactive or one-shot."],
    ["invalid review", "codex\ninteractive\n[]\nmaybe\n", "Choose yes or no for review."],
    ["invalid receipt", "claude\ninteractive\n[]\nno\nhtml\n", "Choose json or text for receipts."],
    ["empty task", "codex\none-shot\n\n", "must not be empty"],
    ["whitespace task", "claude\none-shot\n  \t \n", "must not be empty"],
    ["invalid extra JSON", "codex\ninteractive\nbroken\n", ""],
    ["invalid extra array", "codex\ninteractive\n[1]\n", "JSON string array"],
    ...["", "codex\n", "codex\none-shot\n", "codex\none-shot\ntask\n", "codex\ninteractive\n[]\n", "codex\ninteractive\n[]\nno\n"].map(answers => ["EOF", answers, "input ended; no config saved"]),
  ])("cancels init for %s without publishing or launching", async (_name, answers, message) => {
    const root = await htmlRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from([answers]) as typeof process.stdin);
    expect(await main(["init"])).toBe(2);
    await expect(readFile(join(root, "twin.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining(message!), expect.any(Function));
    expect(createTwin).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("reports init publication failure without config or workload launch", async () => {
    const root = await htmlRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(["codex\ninteractive\n[]\nno\njson\n"]) as typeof process.stdin);
    vi.mocked(link).mockRejectedValueOnce(new Error("publication failed"));
    expect(await main(["init"])).toBe(2);
    expect(await readdir(root)).toEqual([]);
    expect(createTwin).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("publication failed"), expect.any(Function));
  });

  it.each(["SIGINT", "SIGTERM"] as const)("cancels init on %s and restores listeners without launch", async signal => {
    const root = await htmlRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const input = new PassThrough();
    vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
    const before = process.listeners(signal);
    const setup = main(["init"]);
    await vi.waitFor(() => expect(process.stderr.write).toHaveBeenCalledWith("Agent (codex/claude): ", expect.any(Function)));
    process.emit(signal);
    expect(await setup).toBe(2);
    input.destroy();
    expect(process.listeners(signal)).toEqual(before);
    await expect(readFile(join(root, "twin.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(createTwin).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("false overrides disable saved interactive and review preferences without persisting", async () => {
    const root = await htmlRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const saved = JSON.stringify({ command: ["/tool", "--no-review", "--no-interactive"], interactive: true, review: true, receipt: "text" });
    await writeFile(join(root, "twin.config.json"), saved);
    expect(await main(["run", "--no-interactive", "--no-review", "--receipt=json"])).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ argv: ["--no-review", "--no-interactive"], timeoutMs: 60000 }));
    expect(run.mock.calls[0]![0]).not.toHaveProperty("stdio");
    const stderr = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString();
    expect(stderr).toContain("TWIN-RECEIPT/1");
    expect(stderr).not.toContain("Twin review:");
    expect(apply).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
    expect(await readFile(join(root, "twin.config.json"), "utf8")).toBe(saved);
  });

  it.each([
    ["--interactive", "--no-interactive"], ["--no-interactive", "-i"], ["--no-interactive", "--no-interactive"],
    ["--review", "--no-review"], ["--no-review", "-r"], ["--no-review", "--no-review"],
  ])("rejects conflicting or duplicate boolean options %j", async (...flags: string[]) => {
    expect(await main(["run", ...flags, "--", "/tool"])).toBe(2);
    expect(createTwin).not.toHaveBeenCalled();
  });

  it("uses the existing missing executable error and cleanup for config-backed commands", async () => {
    const root = await htmlRoot();
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.stubEnv("PATH", root);
    await writeFile(join(root, "twin.config.json"), JSON.stringify({ command: ["missing-executable"] }));
    expect(await main([])).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Executable not found on PATH"), expect.any(Function));
  });

  it.each([["-i", "--interactive"], ["-r", "--review"], ["-t", "text", "--receipt=text"], ["-t"], ["-t", "bad"]])("rejects duplicate aliases and malformed receipt %j", async (...flags: string[]) => {
    expect(await main(["run", ...flags, "--", "/tool"])).toBe(2);
    expect(createTwin).not.toHaveBeenCalled();
  });

  it("runs a command with multiple arguments and uses the public lifecycle", async () => {
    expect(await main(["run", "--", "node", "-e", "console.log(1)"])).toBe(0);

    expect(createTwin).toHaveBeenCalledWith(expect.objectContaining({ sourceDirectory: process.cwd() }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ executable: process.execPath, argv: ["-e", "console.log(1)"] }));
    expect(inspect).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
    expect(run.mock.invocationCallOrder[0]!).toBeLessThan(inspect.mock.invocationCallOrder[0]!);
    expect(inspect.mock.invocationCallOrder[0]!).toBeLessThan(discard.mock.invocationCallOrder[0]!);
    expect(process.stdout.write).toHaveBeenCalledWith(output.encode("from stdout"), expect.any(Function));
    expect(process.stderr.write).toHaveBeenCalledWith(output.encode("from stderr"), expect.any(Function));
  });

  it("passes an absolute executable unchanged", async () => {
    expect(await main(["run", "--", process.execPath, "script.js"])).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ executable: process.execPath, argv: ["script.js"] }));
  });

  it("rejects a missing PATH candidate without calling core run", async () => {
    vi.stubEnv("PATH", await htmlRoot());
    expect(await main(["run", "--", "missing-executable", "script.js"])).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Executable not found on PATH"), expect.any(Function));
  });

  it("preserves every argument token after the separator", async () => {
    const args = ["--flag", "two words", "", "'quoted'", "--", "λ", "--receipt=text", "--timeout-ms=bad", "--timeout-ms=0"];
    expect(await main(["run", "--timeout-ms=1234", "--", "/tool", ...args])).toBe(0);
    expect(run.mock.calls[0]![0].argv).toEqual(args);
    expect(run.mock.calls[0]![0].timeoutMs).toBe(1234);
  });

  it.each([false, true])("selects the default timeout with interactive=%s", async interactive => {
    expect(await main(["run", ...(interactive ? ["--interactive"] : []), "--", "/tool"])).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: interactive ? 3600000 : 60000 }));
  });

  it.each([false, true])("overrides the timeout with interactive=%s", async interactive => {
    for (const timeoutMs of [1, 1500, 60000, 3600000]) {
      expect(await main(["run", `--timeout-ms=${timeoutMs}`, ...(interactive ? ["--interactive"] : []), "--", "/tool"])).toBe(0);
      expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs }));
    }
  });

  it.each(["dumb", "xterm-256color"])("forwards TERM=%s unchanged in interactive mode", async term => {
    vi.stubEnv("TERM", term);
    expect(await main(["run", "--interactive", "--", "/tool"])).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ TERM: term }) }));
  });

  it.each(["", "0", "-1", "3600001", "9999999999999999999999", "1.5", "1e3", "0x10", "+1",
    "NaN", "Infinity", " 1", "1 ", "1\n", "١", "bad"])("rejects invalid timeout %j before creating a session", async value => {
    expect(await main(["run", "--timeout-ms=" + value, "--", "/tool"])).toBe(2);
    expect(createTwin).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["--timeout-ms=100", "--timeout-ms=100"],
    ["--timeout-ms=100", "--interactive", "--timeout-ms=200"],
    ["--timeout-ms", "100"],
    ["--timeout-ms"],
  ])("rejects duplicate or malformed timeout flags %j before creating a session", async (...flags: string[]) => {
    expect(await main(["run", ...flags, "--", "/tool"])).toBe(2);
    expect(createTwin).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("selects inherited stdio without replaying captured bytes", async () => {
    expect(await main(["run", "--interactive", "--", "/tool", "two words"])).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: "/tool", argv: ["two words"], stdio: "inherit",
    }));
    expect(process.stdout.write).not.toHaveBeenCalled();
    const stderrChunks = vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array));
    expect(Buffer.concat(stderrChunks).toString()).toContain("TWIN-RECEIPT/1");
  });

  it.each([false, true])("selects bounded text receipt with interactive=%s", async interactive => {
    const flags = interactive ? ["--receipt=text", "--interactive"] : ["--receipt=text"];
    expect(await main(["run", ...flags, "--", "/tool", "private-argument"])).toBe(0);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ argv: ["private-argument"],
      ...(interactive ? { stdio: "inherit" } : {}) }));
    const bytes = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array)));
    const text = bytes.toString("utf8");
    expect(text).toContain("Twin receipt (schema 5)");
    expect(text).toContain("Coverage: INCOMPLETE");
    expect(text).toContain("Global npm installed packages");
    expect(text).toContain("Top-level command — exited");
    expect(text).not.toContain("TWIN-RECEIPT/1");
    expect(text).not.toContain("private-argument");
    if (interactive) expect(process.stdout.write).not.toHaveBeenCalled();
    else expect(bytes.subarray(0, output.encode("from stderr").length)).toEqual(Buffer.from(output.encode("from stderr")));
  });

  it("exports the selected receipt while preserving the default JSON frame and cleanup", async () => {
    const destination = join(await htmlRoot(), "receipt.html");
    expect(await main(["run", `--receipt-html=${destination}`, "--", "/tool", "private-argument"])).toBe(0);
    const html = await readFile(destination, "utf8");
    expect(html).toContain("Coverage: INCOMPLETE");
    expect(html).toContain("Global npm installed packages");
    expect(html).toContain("Top-level command — exited");
    expect(html).not.toContain("private-argument");
    const bytes = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array)));
    const payload = Buffer.from(JSON.stringify(receipt), "utf8");
    expect(bytes).toEqual(Buffer.concat([Buffer.from("from stderr"),
      Buffer.from(`\x1eTWIN-RECEIPT/1 ${payload.length}\n`, "ascii"), payload, Buffer.from("\n")]));
    expect(discard).toHaveBeenCalledOnce();
  });

  it("can export beside text stderr without changing that format", async () => {
    const destination = join(await htmlRoot(), "receipt.html");
    expect(await main(["run", "--receipt=text", `--receipt-html=${destination}`, "--", "/tool"])).toBe(0);
    expect(await readFile(destination, "utf8")).toContain("Twin receipt (schema 5)");
    const stderr = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString();
    expect(stderr).toContain("Twin receipt (schema 5)");
    expect(stderr).not.toContain("TWIN-RECEIPT/1");
  });

  it("refuses an existing destination and still discards the settled copy", async () => {
    const destination = join(await htmlRoot(), "receipt.html");
    await writeFile(destination, "original", "utf8");
    expect(await main(["run", `--receipt-html=${destination}`, "--", "/tool"])).toBe(1);
    expect(await readFile(destination, "utf8")).toBe("original");
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Twin HTML export failed"), expect.any(Function));
    expect(discard).toHaveBeenCalledOnce();
  });

  it("reports a destination failure without skipping command receipt or discard", async () => {
    const destination = join(await htmlRoot(), "missing", "receipt.html");
    expect(await main(["run", `--receipt-html=${destination}`, "--", "/tool"])).toBe(1);
    const stderr = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString();
    expect(stderr).toContain("TWIN-RECEIPT/1");
    expect(stderr).toContain("Twin HTML export failed");
    expect(discard).toHaveBeenCalledOnce();
  });

  it("continues review and apply after an HTML export failure", async () => {
    const destination = join(await htmlRoot(), "missing", "receipt.html");
    const input = vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(["apply\n"]) as typeof process.stdin);
    apply.mockResolvedValue({ status: "applied", changes: 0 });
    try {
      expect(await main(["run", "--review", `--receipt-html=${destination}`, "--", "/tool"])).toBe(1);
    } finally { input.mockRestore(); }
    expect(apply).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
  });

  it.each(["SIGINT", "SIGTERM"] as const)("handles %s during startup and restores listeners", async requested => {
    let finishCreate!: (session: TwinSession) => void;
    vi.mocked(createTwin).mockImplementationOnce(() => new Promise(resolve => { finishCreate = resolve; }));
    const beforeInt = process.listeners("SIGINT");
    const beforeTerm = process.listeners("SIGTERM");
    const running = main(["run", "--", "/tool"]);
    await vi.waitFor(() => expect(createTwin).toHaveBeenCalledOnce());
    const listener = process.listeners(requested).at(-1) as (() => void) | undefined;
    expect(listener).toBeDefined();
    listener!();
    listener!();
    finishCreate({ workspacePath: "/tmp/twin", run, inspect, apply, discard } as unknown as TwinSession);
    expect(await running).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
    expect(process.listeners("SIGINT")).toEqual(beforeInt);
    expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
  });

  it.each([["run"], ["run", "--"], ["run", "/tool"], ["run", "--", ""],
    ["run", "--receipt=text", "--receipt=text", "--", "/tool"], ["run", "--receipt-html=", "--", "/tool"],
    ["run", "--receipt-html=a", "--receipt-html=b", "--", "/tool"], ["run", "--unknown", "--", "/tool"]])(
    "rejects missing or malformed command usage: %j",
    async (...args: string[]) => {
      expect(await main(args)).toBe(2);
      expect(createTwin).not.toHaveBeenCalled();
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringMatching(/Invalid Twin|No command selected/), expect.any(Function));
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("returns nonzero and discards after a nonzero command result", async () => {
    run.mockResolvedValue(result(7));
    expect(await main(["run", "--", "/tool"])).toBe(1);
    expect(inspect).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
  });

  it.each([
    { outcome: "timed-out" as const },
    { lifecycleIssue: "process group present" },
    { terminationError: "Could not deliver SIGTERM" },
  ])("returns nonzero for incomplete execution despite child exit zero: %j", async difference => {
    run.mockResolvedValue({ ...result(0), ...difference });
    expect(await main(["run", "--", "/tool"])).toBe(1);
    expect(inspect).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
  });

  it("attempts discard when the command throws", async () => {
    run.mockRejectedValue(new Error("command failed"));
    expect(await main(["run", "--", "/tool"])).toBe(1);
    expect(discard).toHaveBeenCalledOnce();
  });

  it("bounds and escapes an execution error before its receipt", async () => {
    run.mockRejectedValue(new Error(`\u001b[31m${"x".repeat(4000)}\u202e`));
    expect(await main(["run", "--receipt=text", "--", "/tool"])).toBe(1);
    const text = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString("utf8");
    expect(text).toContain("\\u001b[31m");
    expect(text).toContain("…[truncated]");
    expect(text).not.toContain("\u001b");
    expect(text.length).toBeLessThan(33 * 1024);
    expect(discard).toHaveBeenCalledOnce();
  });

  it("frames an unattempted command when interrupted before launch", async () => {
    run.mockRejectedValue(new Error("Interrupted before command launch"));
    inspect.mockReturnValue({ workspacePath: "/tmp/twin", state: "ready" });
    expect(await main(["run", "--", "/tool", "secret-argument"])).toBe(1);
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

  it("renders a no-run text receipt without inventing an attempt", async () => {
    run.mockRejectedValue(new Error("Interrupted before command launch"));
    inspect.mockReturnValue({ workspacePath: "/tmp/twin", state: "ready" });
    expect(await main(["run", "--receipt=text", "--", "/tool", "secret-argument"])).toBe(1);
    const text = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString("utf8");
    expect(text).toContain("Coverage: INCOMPLETE");
    expect(text).toContain("Top-level command — not-attempted");
    expect(text).toContain("Admission: not attempted; process start: not-confirmed");
    expect(text).toContain("final group: not-applicable");
    expect(text).not.toContain("TWIN-RECEIPT/1");
    expect(text).not.toContain("secret-argument");
  });

  it("renders unknown execution when a non-ready session has no receipt", async () => {
    run.mockRejectedValue(new Error("receipt unavailable"));
    inspect.mockReturnValue({ workspacePath: "/tmp/twin", state: "finished" });
    expect(await main(["run", "--receipt=text", "--", "/tool"])).toBe(1);
    const text = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString("utf8");
    expect(text).toContain("Top-level command — observation-unavailable");
    expect(text).toContain("Admission: unknown; process start: unknown");
    expect(text).toContain("Direct child: start unknown; settlement unknown");
    expect(text).toContain("final group: unknown");
    expect(text).not.toContain("Top-level command — not-attempted");
  });

  it("reports unknown command state when a finished session has no receipt", async () => {
    run.mockRejectedValue(new Error("receipt unavailable"));
    inspect.mockReturnValue({ workspacePath: "/tmp/twin", state: "finished" });
    expect(await main(["run", "--", "/tool"])).toBe(1);
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
    expect(await main(["run", "--", "/tool"])).toBe(0);
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
    expect(await main(["run", "--", "/tool"])).toBe(1);
    expect(inspect.mock.invocationCallOrder[0]!).toBeLessThan(discard.mock.invocationCallOrder[0]!);
    expect(process.stderr.write).toHaveBeenCalledWith("Twin discard refused: guard\n", expect.any(Function));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Twin copy retained: /tmp/twin"), expect.any(Function));
  });

  it("does not claim a complete copy after partial discard failure", async () => {
    discard.mockResolvedValue({ status: "failed", reason: "path changed", partialDeletionPossible: true });
    expect(await main(["run", "--receipt=text", "--", "/tool"])).toBe(1);
    const text = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString("utf8");
    expect(text).toContain("Twin discard failed: path changed");
    expect(text).toContain("Twin copy cleanup uncertain at: /tmp/twin");
    expect(text).not.toContain("Twin copy retained:");
  });

  it("retains the copy and bounds a thrown discard failure", async () => {
    vi.mocked(createTwin).mockResolvedValue({ workspacePath: `/tmp/\u001b[31mcopy`, run, inspect, apply, discard } as unknown as TwinSession);
    discard.mockRejectedValue(new Error(`\u001b[31m${"x".repeat(4000)}`));
    expect(await main(["run", "--receipt=text", "--", "/tool"])).toBe(1);
    const text = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString("utf8");
    expect(text).toContain("Twin discard failed: \\u001b[31m");
    expect(text).toContain("Twin copy cleanup uncertain at: /tmp/\\u001b[31mcopy");
    expect(text).toContain("cannot resume this session");
    expect(text).not.toContain("\u001b");
    expect(text.length).toBeLessThan(34 * 1024);
  });

  it.each(["conflict", "failed"] as const)("retains a copy after %s apply with bounded terminal-safe details", async status => {
    const input = vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(["apply\n"]) as typeof process.stdin);
    apply.mockResolvedValue(status === "conflict"
      ? { status, reason: `\u001b[31m${"x".repeat(4000)}`, paths: ["file\u202e"] }
      : { status, reason: `\u001b[31m${"x".repeat(4000)}`, partialApplicationPossible: true });
    try {
      expect(await main(["run", "--review", "--receipt=text", "--", "/tool"])).toBe(1);
    } finally { input.mockRestore(); }
    const text = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString("utf8");
    expect(text).toContain(`Twin apply ${status}`);
    expect(text).toContain("\\u001b[31m");
    expect(text).not.toContain("\u001b");
    expect(text.length).toBeLessThan(34 * 1024);
    expect(text).toContain("Twin copy retained: /tmp/twin");
    if (status === "failed") expect(text).toContain("may have changed earlier paths");
    else expect(text).toContain("\\u202e");
    expect(discard).not.toHaveBeenCalled();
  });

  it("appends its frame after child stderr that imitates a frame", async () => {
    const imitation = Buffer.from("\x1eTWIN-RECEIPT/1 2\n{}\n");
    run.mockResolvedValue({ ...result(0), stderr: { bytes: imitation } });
    expect(await main(["run", "--", "/tool"])).toBe(0);
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
    expect(await main(["run", "--", "/tool"])).toBe(0);
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

  it("renders the receipt-limit fallback with command and process evidence in text mode", async () => {
    inspect.mockReturnValue({ workspacePath: "/tmp/twin", state: "finished",
      receipt: { ...receipt, files: { coverage: "partial", issues: [{ reason: "x".repeat(9 * 1024 * 1024) }], changes: [] } } });
    expect(await main(["run", "--receipt=text", "--", "/tool"])).toBe(0);
    const bytes = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array)));
    expect(bytes.length).toBeLessThan(32 * 1024);
    const text = bytes.toString("utf8");
    expect(text).toContain("Coverage: INCOMPLETE");
    expect(text).toContain("receipt-limit");
    expect(text).toContain("Top-level command — exited");
    expect(text).toContain("Direct child: start confirmed; settlement observed");
    expect(text).toContain("final group: absent");
    expect(text).not.toContain("TWIN-RECEIPT/1");
  });
});


it.each(["text", "json"] as const)("releases preparation before the sole run call with %s receipt", async format => {
  const order: string[] = [];
  vi.spyOn(terminal, "preparation").mockImplementation(() => { order.push("prepare"); return { stop: () => { order.push("stop"); } }; });
  run.mockImplementation(async () => { order.push("run"); return result(0); });
  expect(await main(["run", `--receipt=${format}`, "--", "/tool"])).toBe(0);
  expect(order.slice(0, 3)).toEqual(["prepare", "stop", "run"]);
  expect(run).toHaveBeenCalledOnce();
  expect(discard).toHaveBeenCalledOnce();
});

it("keeps JSON frame bytes identical on a TTY and exports HTML without terminal colors", async () => {
  const root = await htmlRoot();
  vi.spyOn(terminal, "terminalOutput").mockReturnValue(true);
  vi.spyOn(terminal, "terminalColors").mockReturnValue(true);
  expect(await main(["run", "--receipt=json", `--receipt-html=${join(root, "receipt.html")}`, "--", "/tool"])).toBe(0);
  const chunks = vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array));
  const payload = JSON.stringify(receipt);
  expect(Buffer.concat(chunks).toString()).toBe(`from stderr\x1eTWIN-RECEIPT/1 ${Buffer.byteLength(payload)}\n${payload}\n`);
  expect(await readFile(join(root, "receipt.html"), "utf8")).not.toContain("\x1b");
});

it("selects compact colored TTY text and retains the uncolored HTML projection", async () => {
  const root = await htmlRoot();
  vi.spyOn(terminal, "terminalOutput").mockReturnValue(true);
  vi.spyOn(terminal, "terminalColors").mockReturnValue(true);
  expect(await main(["run", "--receipt=text", `--receipt-html=${join(root, "receipt.html")}`, "--", "/tool"])).toBe(0);
  const text = Buffer.concat(vi.mocked(process.stderr.write).mock.calls.map(call => Buffer.from(call[0] as string | Uint8Array))).toString();
  expect(text).toContain("Command");
  expect(text).toContain("\x1b[38;2;182;140;255mTwin receipt");
  expect(text).not.toContain("TWIN-RECEIPT/1");
  expect(await readFile(join(root, "receipt.html"), "utf8")).not.toContain("\x1b");
});

it.each(["apply", "discard", "cancel", null])("TTY review selection %s uses the existing operations", async selected => {
  vi.spyOn(terminal, "terminalPrompts").mockReturnValue(true);
  const choose = vi.spyOn(terminal, "chooseTerminal").mockResolvedValue(selected);
  apply.mockResolvedValue({ status: "applied", changes: 0 });
  expect(await main(["run", "--review", "--", "/tool"])).toBe(selected === "apply" || selected === "discard" ? 0 : 1);
  expect(choose).toHaveBeenCalledWith(expect.objectContaining({ default: "cancel", choices: [
    { name: "Apply changes", value: "apply" }, { name: "Discard copy", value: "discard" },
    { name: "Cancel and retain copy", value: "cancel" },
  ] }), expect.any(AbortSignal));
  expect(apply).toHaveBeenCalledTimes(selected === "apply" ? 1 : 0);
  expect(discard).toHaveBeenCalledTimes(selected === "apply" || selected === "discard" ? 1 : 0);
});

it("init menu cancellation never launches a workload or publishes config", async () => {
  const root = await htmlRoot();
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.spyOn(terminal, "terminalPrompts").mockReturnValue(true);
  vi.spyOn(terminal, "chooseTerminal").mockResolvedValue(null);
  expect(await main(["init"])).toBe(2);
  expect(await readdir(root)).toEqual([]);
  expect(createTwin).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
