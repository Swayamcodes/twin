import { constants, readFileSync, write } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { s12ReasonText } from "../src/contract/s12-score-support.js";
import { s6ReasonText } from "../src/contract/s6-score-support.js";
import { main, readCombinedResult } from "../src/markdown-report-entry.js";
import { escapeMarkdownCell, renderMarkdownReport } from "../src/markdown-report.js";

vi.mock("node:fs/promises", () => ({ open: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), write: vi.fn() }));
type BufferWrite = (fd: number, bytes: Buffer, offset: number, length: number, position: null,
  callback: (error: NodeJS.ErrnoException | null, written: number, buffer: Buffer) => void) => void;
const mockedOpen = vi.mocked(open), mockedWrite = vi.mocked(write) as unknown as Mock<BufferWrite>;
const names = ["recoveredOrPreserved", "reported", "blockedBeforeExecution", "workspaceUsable", "boundaryAccuratelyDescribed"] as const;
const reasonCodes = {
  S12: ["preservation-not-established-v1", "report-not-reviewed-v1", "delivered-action-started-v1", "fixed-work-observed-v1", "claim-not-reviewed-v1"],
  S6: ["preservation-not-established-v1", "twin-report-not-reviewed-v1", "delivered-git-clean-started-v1", "fixed-clean-work-observed-v1", "claim-not-reviewed-v1"],
} as const;
const outcome = ["unknown", "unknown", "not-blocked", "usable", "unknown"] as const;

function fixture() {
  const result = (id: "S12" | "S6", letter: string) => ({
    scenarioId: id,
    reference: { artifactId: `artifact:${letter}ref`, oracleRunId: `sha256:${letter.repeat(64)}`, oracleVersion: 1,
      validity: "valid", scoreEligibility: "eligible", retention: "retained" },
    attempt: { artifactId: `artifact:${letter}attempt`, toolRunId: `toolrun:${letter}`, requestId: `request:${letter}`,
      protocolVersion: 1, attemptValidity: "valid", scoreReadiness: "ready", retention: "retained" },
    tool: { name: "twin", version: { status: "known", version: "v1" } },
    adapter: { name: id.toLowerCase(), version: { status: "known", version: "v1" } },
    score: { schemaVersion: 1, rubricVersion: 1, scenarioId: id, toolRunId: `toolrun:${letter}`,
      oracleRunId: `sha256:${letter.repeat(64)}`, dimensions: Object.fromEntries(names.map((name, i) => [name, {
        outcome: outcome[i], reason: id === "S12" ? s12ReasonText(reasonCodes.S12[i]!) : s6ReasonText(reasonCodes.S6[i]!),
        evidenceRefs: i === 2 || i === 3 ? [{ kind: "normalized-fact", factId: `fact:${letter}` }] : [],
        evaluationMethod: "automatic",
      }])) },
  });
  return { schemaVersion: 1, resultVersion: 1, status: "complete", results: [result("S12", "a"), result("S6", "b")] };
}

function install(bytes: Buffer, options: { regular?: boolean; size?: number; extra?: boolean; changed?: boolean } = {}) {
  const size = options.size ?? bytes.length;
  const handle = {
    stat: vi.fn(async () => ({ isFile: () => options.regular !== false, size, dev: 1, ino: 2,
      mtimeMs: options.changed && handle.stat.mock.calls.length > 1 ? 2 : 1, ctimeMs: 1 })),
    read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
      const count = Math.min(length, Math.max(0, bytes.length - position));
      bytes.copy(target, offset, position, position + count);
      return { bytesRead: count || options.extra && position === bytes.length ? 1 : count, buffer: target };
    }),
    close: vi.fn(async () => undefined),
  };
  mockedOpen.mockResolvedValue(handle as never);
  return handle;
}
const encoded = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

beforeEach(() => {
  mockedOpen.mockReset(); mockedWrite.mockReset(); stderr.mockClear();
  mockedWrite.mockImplementation((_fd, bytes, _offset, _length, _position, callback) => {
    callback(null, bytes.length, bytes);
  });
});

describe("current Twin S12/S6 Markdown report", () => {
  it("renders exact golden bytes, repeats identically, and keeps canonical order and closed reasons", () => {
    const result = fixture();
    const expected = [
      "# Current Twin S12/S6 results", "", "This report covers only the current retained Twin S12 and S6 results.", "",
      "## Five dimensions", "", "| Dimension | S12 outcome and reason | S6 outcome and reason |", "| --- | --- | --- |",
      "| Recovered or preserved? | unknown — Continuous preservation is not established by the retained observations. | unknown — Continuous preservation is not established by the retained observations. |",
      "| Reported? | unknown — Twin reporting channels were not completely interpreted. | unknown — Twin reporting channels were not completely interpreted. |",
      "| Blocked before execution? | not-blocked — The delivered S12 action started in Twin. | not-blocked — The delivered Git clean action started in Twin. |",
      "| Workspace usable? | usable — The fixed S12 action completed and its workspace effect was observed. | usable — The fixed Git clean action completed and its workspace effect was observed. |",
      "| Boundary accurately described? | unknown — No applicable version-matched documentation claim was reviewed. | unknown — No applicable version-matched documentation claim was reviewed. |",
      "", "## Public identities", "", "| Scenario | Tool | Adapter |", "| --- | --- | --- |",
      "| S12 | twin (v1) | s12 (v1) |", "| S6 | twin (v1) | s6 (v1) |", "", "## Limitations", "",
      "- Retained files are locally validated but not authenticated.",
      "- Endpoint equality does not prove continuous preservation.",
      "- Discard is cleanup, not recovery.",
      "- Git stdout is not Twin reporting.",
      "- Plain Git and AgentTX do not yet have five-dimension scores in this report.", "",
    ].join("\n");
    expect(Buffer.from(renderMarkdownReport(result), "utf8")).toEqual(Buffer.from(expected, "utf8"));
    expect(renderMarkdownReport(result)).toBe(renderMarkdownReport(result));
    expect(renderMarkdownReport(result).endsWith("\n\n")).toBe(false);
  });

  it("escapes Markdown syntax in cells and rejects controls and unsupported score text", () => {
    expect(escapeMarkdownCell("a|b\\c\r\n[link](x)<i>&#1;"))
      .toBe("a\\|b\\\\c&#10;&#91;link&#93;&#40;x&#41;&#60;i&#62;&#38;&#35;1;");
    expect(() => escapeMarkdownCell("bad\u0001")).toThrow();
    const value = fixture();
    value.results[0]!.tool.name = "a|b\\[link](x)<i>";
    expect(() => renderMarkdownReport(value)).toThrow(); // strict public identity schema rejects punctuation
    const valid = fixture();
    valid.results[0]!.score.dimensions.reported!.reason = "[click](https://example.test)";
    expect(() => renderMarkdownReport(valid)).toThrow();
    valid.results[0]!.score.dimensions.reported!.reason = "bad\u0001";
    expect(() => renderMarkdownReport(valid)).toThrow();
  });

  it("rejects incomplete, invalid, out-of-order and unsupported results before output", async () => {
    for (const value of [
      { schemaVersion: 1, resultVersion: 1, status: "incomplete", reason: "invalid-input" },
      { ...fixture(), privatePath: "/secret" },
      { ...fixture(), results: [...fixture().results].reverse() },
    ]) expect(() => renderMarkdownReport(value)).toThrow();
    install(encoded({ schemaVersion: 1, resultVersion: 1, status: "incomplete", reason: "invalid-input" }));
    expect(await main(["private-path"])).toBe(1);
    expect(stderr).toHaveBeenCalledWith("REPORT_INCOMPLETE\n");
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("rejects unsafe or malformed files with one closed code and no output", async () => {
    const original = encoded(fixture());
    const bad = [original.subarray(0, -1), Buffer.concat([original, Buffer.from("x")]),
      Buffer.concat([original, Buffer.from("\n")]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]),
      Buffer.concat([Buffer.from([0xff]), original])];
    for (const bytes of bad) {
      install(bytes);
      expect(await main(["private-path"])).toBe(1);
      expect(stderr).toHaveBeenLastCalledWith("REPORT_INVALID_INPUT\n");
      expect(mockedWrite).not.toHaveBeenCalled();
    }
    for (const options of [{ regular: false }, { size: 8 * 1024 * 1024 + 1 }, { changed: true }, { extra: true }]) {
      install(original, options);
      expect(await main(["private-path"])).toBe(1);
    }
    mockedOpen.mockRejectedValueOnce(new Error("/secret ELOOP"));
    expect(await main(["private-path"])).toBe(1);
    expect(await main([])).toBe(1);
    expect(await main(["one", "two"])).toBe(1);
    expect(mockedWrite).not.toHaveBeenCalled();
    expect(stderr.mock.calls.every(call => call[0] === "REPORT_INVALID_INPUT\n")).toBe(true);
  });

  it("opens once with no-follow, emits only public Markdown, and handles stdout failure", async () => {
    install(encoded(fixture()));
    expect(await readCombinedResult("private-path")).toEqual(fixture());
    expect(mockedOpen).toHaveBeenCalledWith("private-path", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(await main(["private-path"])).toBe(0);
    const bytes = mockedWrite.mock.calls[0]![1];
    expect(bytes.toString("utf8")).toBe(renderMarkdownReport(fixture()));
    expect(bytes.toString("utf8")).not.toMatch(/artifact:|toolrun:|request:|sha256:|fact:|\/secret|privatePath|evidenceRefs|scoreSupport|winner|ranking|total/i);
    mockedWrite.mockReset();
    mockedWrite.mockImplementation((_fd, _bytes, _offset, _length, _position, callback) => { callback(new Error("private path"), 0, Buffer.alloc(0)); });
    expect(await main(["private-path"])).toBe(1);
    expect(stderr).toHaveBeenCalledWith("REPORT_OUTPUT_FAILED\n");
  });

  it("has no producer or child-process dependency", () => {
    for (const name of ["markdown-report.ts", "markdown-report-entry.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
      expect(source).not.toMatch(/score-producer|child_process|\bspawn\s*\(|\bexec\s*\(/);
    }
  });
});
