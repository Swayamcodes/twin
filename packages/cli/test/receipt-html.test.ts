import { describe, expect, it } from "vitest";
import type { MinimalReceipt } from "@twin-cli/core";
import { MAX_HTML_RECEIPT_BYTES, renderReceiptHtml } from "../src/receipt-html.js";

const watchIds = [".gitconfig", ".npmrc", ".bashrc", ".zshrc", ".codex/config.toml",
  ".claude/settings.json", ".gemini/settings.json"] as const;
const complete: MinimalReceipt = {
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

describe("standalone HTML receipt", () => {
  it("includes all current receipt sections and observation limits for a complete receipt", () => {
    const html = renderReceiptHtml(complete);
    for (const section of ["Coverage: COMPLETE", "Files — complete", "Project dependency declarations — complete",
      "Project lockfiles — complete", "Global npm installed packages — complete", "Outside-project watches",
      "Top-level command — exited", "Process group — observed lifecycle only", "Nested commands: not observed",
      "Escaped descendants: not observed", "no rollback"]) expect(html).toContain(section);
    expect(html).toContain("No file changes observed.");
    expect(html).toContain("<meta http-equiv=\"Content-Security-Policy\"");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link|@import|url\(/);
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(MAX_HTML_RECEIPT_BYTES);
  });

  it("marks incomplete evidence and escapes hostile values without disclosing argument values", () => {
    const hostile = `a<svg onload="alert(1)">&'\u001b[31m`;
    const receipt: MinimalReceipt = { ...complete,
      files: { coverage: "partial", changes: [{ path: { encoding: "utf8", value: hostile },
        change: "added", category: "ignored", categoryReason: hostile }], issues: [{ reason: hostile }] },
      dependencies: { declarations: { coverage: "incomplete", changes: [] }, lockfiles: { coverage: "unavailable", changes: [] },
        issues: [{ phase: "after", path: "package.json", reason: hostile }] },
      globalNpm: { coverage: "unavailable", source: "unavailable", changes: [], issues: [{ phase: "after", name: hostile, reason: hostile }] },
      command: { ...complete.command, disposition: "settlement-uncertain" },
      process: { ...complete.process, finalGroup: "unknown", capturedPipes: "open" },
    };
    const html = renderReceiptHtml(receipt);
    expect(html).toContain("Coverage: INCOMPLETE");
    expect(html).toContain("Files — partial");
    expect(html).toContain("Top-level command — settlement-uncertain");
    expect(html).toContain("final group: unknown");
    expect(html).toContain("&lt;svg onload=&quot;alert(1)&quot;&gt;&amp;&#39;");
    expect(html).toContain("\\u001b");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("\u001b");
  });

  it("refuses an HTML document that exceeds its byte limit", () => {
    const large = '"'.repeat(120);
    const receipt: MinimalReceipt = { ...complete,
      files: { coverage: "complete", changes: Array.from({ length: 12 }, () => ({
        path: { encoding: "utf8" as const, value: large }, change: "added" as const,
        category: "ignored" as const, categoryReason: large })),
        issues: Array.from({ length: 12 }, () => ({ reason: large, path: { encoding: "utf8" as const, value: large } })) },
      dependencies: { declarations: { coverage: "complete", changes: Array.from({ length: 12 }, () => ({
        field: "dependencies" as const, name: large, change: "added" as const, before: null, after: "1" })) },
        lockfiles: { coverage: "complete", changes: Array.from({ length: 12 }, () => ({
          path: "pnpm-lock.yaml" as const, change: "added" as const, beforeDigest: null, afterDigest: "x" })) },
        issues: Array.from({ length: 12 }, () => ({ phase: "after" as const, path: large, reason: large })) },
      globalNpm: { coverage: "complete", source: "env-prefix", changes: Array.from({ length: 12 }, () => ({
        name: large, change: "changed" as const, before: large, after: large })),
        issues: Array.from({ length: 12 }, () => ({ phase: "after" as const, name: large, reason: large })) },
    };
    expect(() => renderReceiptHtml(receipt)).toThrow("HTML receipt exceeds size limit");
  });
});
