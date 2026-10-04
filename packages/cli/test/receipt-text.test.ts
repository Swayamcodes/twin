import { describe, expect, it } from "vitest";
import type { MinimalReceipt } from "@twin-cli/core";
import { MAX_TEXT_RECEIPT_BYTES, renderCompactReceipt, renderReceiptText } from "../src/receipt-text.js";

const watchIds = [".gitconfig", ".npmrc", ".bashrc", ".zshrc", ".codex/config.toml",
  ".claude/settings.json", ".gemini/settings.json"] as const;
const base: MinimalReceipt = {
  schemaVersion: 5,
  command: { coverage: "top-level-only", nestedCommands: "not-observed", admitted: true,
    processStart: "confirmed", executable: { status: "allowlisted-basename", value: "node" },
    arguments: { status: "omitted", count: 2, capped: false }, disposition: "exited", timeoutObserved: false,
    directChildSettled: true, exitCode: 0, signal: null },
  process: { coverage: "top-level-process-group", escapedDescendants: "not-observed",
    directChild: { start: "confirmed", settlement: "observed" }, groupAfterDirectExit: "absent",
    termination: [], finalGroup: "absent", capturedPipes: "closed" },
  files: { coverage: "complete", changes: [], issues: [] },
  dependencies: { declarations: { coverage: "complete", changes: [] }, lockfiles: { coverage: "complete", changes: [] }, issues: [] },
  globalNpm: { coverage: "complete", source: "env-prefix", changes: [], issues: [] },
  watch: watchIds.map(id => ({ id, before: { status: "missing" }, after: { status: "missing" }, comparison: "unchanged" })),
};

describe("human receipt presentation", () => {
  it("renders each observed category and keeps intervention separate from settlement", () => {
    const receipt: MinimalReceipt = { ...base,
      files: { coverage: "complete", issues: [], changes: [
        { path: { encoding: "utf8", value: "tracked.txt" }, change: "modified", category: "tracked", categoryReason: null },
        { path: { encoding: "utf8", value: "scratch.txt" }, change: "added", category: "untracked", categoryReason: null },
        { path: { encoding: "utf8", value: ".env" }, change: "deleted", category: "ignored", categoryReason: null },
        { path: { encoding: "base64", value: "//4=" }, change: "modified", category: "unclassified", categoryReason: "git-incomplete" },
      ] },
      dependencies: { declarations: { coverage: "complete", changes: [
        { field: "dependencies", name: "example", change: "changed", before: "1", after: "2" },
      ] }, lockfiles: { coverage: "complete", changes: [
        { path: "package-lock.json", change: "changed", beforeDigest: "a", afterDigest: "b" },
      ] }, issues: [] },
      globalNpm: { coverage: "complete", source: "env-prefix", changes: [
        { name: "@scope/tool", change: "changed", before: "1.0.0", after: "2.0.0" },
      ], issues: [] },
      watch: [{ id: ".npmrc", before: { status: "missing" }, after: { status: "present", size: "1", mode: 384, mtimeNs: "1" }, comparison: "changed" },
        ...base.watch.filter(item => item.id !== ".npmrc")],
      process: { ...base.process, groupAfterDirectExit: "present", termination: [
        { signal: "SIGTERM", target: "process-group", delivery: "sent" },
      ] },
    };
    const text = renderReceiptText(receipt);
    for (const expected of ["Coverage: COMPLETE", "modified [tracked] tracked.txt", "added [untracked] scratch.txt",
      "deleted [ignored] .env", "modified [unclassified] base64://4=", "changed dependencies example",
      "changed package-lock.json", "changed @scope/tool: 1.0.0 → 2.0.0", ".npmrc: changed; missing → present",
      "Top-level command — exited", "Group after direct-child exit: present; final group: absent",
      "Twin signal attempt: SIGTERM to process-group; delivery sent", "stop not established by delivery",
      "Nested commands: not observed", "Escaped descendants: not observed", "no rollback"]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("specifier values: 1");
  });

  it("prominently marks incomplete empty observations and process uncertainty", () => {
    const receipt: MinimalReceipt = { ...base,
      files: { coverage: "partial", changes: [], issues: [{ reason: "scan-unavailable" }] },
      dependencies: { declarations: { coverage: "incomplete", changes: [] }, lockfiles: { coverage: "unavailable", changes: [] },
        issues: [{ phase: "after", path: "package.json", reason: "unreadable" }] },
      globalNpm: { coverage: "unavailable", source: "unavailable", changes: [], issues: [
        { phase: "before", name: "", reason: "prefix-unavailable" },
      ] },
      watch: base.watch.map(item => item.id === ".npmrc" ? { ...item, after: { status: "unavailable" as const, reason: "unreadable" },
        comparison: "unknown" as const } : item),
      process: { ...base.process, directChild: { start: "confirmed", settlement: "unconfirmed" },
        groupAfterDirectExit: "not-observed", finalGroup: "unknown", capturedPipes: "open" },
      command: { ...base.command, disposition: "settlement-uncertain" },
    };
    const text = renderReceiptText(receipt);
    expect(text).toContain("Coverage: INCOMPLETE");
    expect(text).toContain("No file changes observed; coverage may be incomplete.");
    expect(text).toContain("Project dependency declarations — incomplete");
    expect(text).toContain("Project lockfiles — unavailable");
    expect(text).toContain("Global npm installed packages — unavailable");
    expect(text).toContain(".npmrc: unknown");
    expect(text).toContain("Top-level command — settlement-uncertain");
    expect(text).toContain("final group: unknown");
    expect(text).toContain("Captured pipes: open");
    expect(text).not.toContain("No file changes observed.\n");
  });

  it("escapes control characters and bounds values and collection lengths", () => {
    const hostile = `name\u001b[31m\n\r\u0085\u202e${"x".repeat(1000)}`;
    const receipt: MinimalReceipt = { ...base,
      files: { coverage: "complete", issues: [], changes: Array.from({ length: 1000 }, () => ({
        path: { encoding: "utf8", value: hostile }, change: "added" as const, category: "ignored" as const, categoryReason: null,
      })) },
      globalNpm: { coverage: "complete", source: "env-prefix", changes: [
        { name: hostile, change: "added", before: null, after: "1.0.0" },
      ], issues: [] },
    };
    const text = renderReceiptText(receipt);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_TEXT_RECEIPT_BYTES);
    expect(text).toContain("\\u001b");
    expect(text).toContain("\\u000a");
    expect(text).toContain("\\u0085");
    expect(text).toContain("\\u202e");
    expect(text).toContain("[truncated]");
    expect(text).toContain("988 more entries omitted");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0085");
    expect(text).not.toContain("\u202e");
  });
});


describe("compact terminal receipt", () => {
  it("leads with command, observed changes and attention, without equating success and coverage", () => {
    const receipt: MinimalReceipt = { ...base, files: { coverage: "partial", issues: [{ reason: "scan-timeout" }], changes: [
      { path: { encoding: "utf8", value: "file" }, change: "modified", category: "ignored", categoryReason: null },
    ] }, watch: base.watch.map(item => item.id === ".npmrc" ? { ...item, comparison: "changed" as const } : item) };
    const text = renderCompactReceipt(receipt, true);
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain.split("\n").slice(0, 4).join("\n")).toMatch(/Command.*COMPLETED.*\nChanges.*1 modified.*\nAttention.*Incomplete.*Outside-project/);
    expect(text).toContain("\x1b[38;2;116;205;151m✓ COMPLETED");
    expect(text).toContain("\x1b[38;2;233;187;104m! Incomplete");
    for (const disclosure of ["INCOMPLETE", "scan-timeout", "modified [ignored] file", "no rollback", "Captured pipes: closed",
      "Command success is not a safety verdict", "Nested commands: not observed", "Escaped descendants: not observed", "Reads and writes reverted"]) expect(plain).toContain(disclosure);
    expect(plain).not.toMatch(/safe run|clean run/i);
  });

  it.each([false, true])("keeps hostile values escaped and all caps including colored=%s bytes", colors => {
    const hostile = `file\u001b[31m\n\u202e${"x".repeat(1000)}`;
    const receipt: MinimalReceipt = { ...base, files: { coverage: "partial", issues: [{ reason: hostile }],
      changes: Array.from({ length: 1000 }, () => ({ path: { encoding: "utf8", value: hostile },
        change: "deleted" as const, category: "unclassified" as const, categoryReason: hostile })) },
      dependencies: { ...base.dependencies, issues: [{ phase: "after", path: hostile, reason: hostile }] },
      globalNpm: { coverage: "incomplete", source: "env-prefix", changes: Array.from({ length: 1000 }, () => ({
        name: hostile, change: "changed" as const, before: hostile, after: hostile })), issues: [{ phase: "after", name: hostile, reason: hostile }] },
    };
    const text = renderCompactReceipt(receipt, colors);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TEXT_RECEIPT_BYTES);
    expect(text).toContain("\\u001b");
    expect(text).toContain("\\u202e");
    expect(text).toContain("[truncated]");
    expect(text).toContain("988 more entries omitted");
    expect(text).not.toContain("\u202e");
    if (!colors) expect(text).not.toContain("\x1b");
  });

  it("shows failure, intervention and uncertainty separately in monochrome", () => {
    const receipt: MinimalReceipt = { ...base, command: { ...base.command, exitCode: 1 },
      process: { ...base.process, finalGroup: "unknown", capturedPipes: "open", termination: [{ signal: "SIGTERM", target: "process-group", delivery: "sent" }] } };
    const text = renderCompactReceipt(receipt);
    expect(text).toContain("× FAILED");
    expect(text).toContain("INCOMPLETE");
    expect(text).toContain("final group: unknown");
    expect(text).toContain("Captured pipes: open");
    expect(text).toContain("stop not established by delivery");
    expect(text).not.toContain("\x1b");
  });
});
