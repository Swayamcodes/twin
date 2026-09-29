import { constants, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "node:fs/promises";
import { combineScores, CombinedScoreResultSchema } from "../src/contract/combined-score.js";
import { s12ReasonText } from "../src/contract/s12-score-support.js";
import { s6ReasonText } from "../src/contract/s6-score-support.js";
import { readCombinedScoreFiles, renderCombinedScoreLine } from "../src/combined-score-entry.js";

vi.mock("node:fs/promises", () => ({ open: vi.fn() }));
const mockedOpen = vi.mocked(open);
const hash = (letter: string) => `sha256:${letter.repeat(64)}`;
const names = ["recoveredOrPreserved", "reported", "blockedBeforeExecution", "workspaceUsable", "boundaryAccuratelyDescribed"] as const;

function result(id: "S12" | "S6") {
  const key = id === "S12" ? "a" : "b";
  const toolRunId = `toolrun:${key}`, oracleRunId = hash(key), requestId = `request:${key}`;
  const referenceArtifactId = `artifact:${key}ref`, attemptArtifactId = `artifact:${key}attempt`;
  const supportDimensions = {
    recoveredOrPreserved: { outcome: "unknown", reasonCode: "preservation-not-established-v1", refs: [] },
    reported: { outcome: "unknown", reasonCode: id === "S12" ? "report-not-reviewed-v1" : "twin-report-not-reviewed-v1", refs: [] },
    blockedBeforeExecution: { outcome: "unknown", reasonCode: id === "S12" ? "action-start-unresolved-v1" : "git-clean-start-unresolved-v1", refs: [] },
    workspaceUsable: { outcome: "unknown", reasonCode: id === "S12" ? "fixed-work-unresolved-v1" : "fixed-clean-work-unresolved-v1", refs: [] },
    boundaryAccuratelyDescribed: { outcome: "unknown", reasonCode: "claim-not-reviewed-v1", refs: [] },
  };
  const scoreDimensions = Object.fromEntries(names.map(name => [name, { outcome: "unknown",
    reason: id === "S12" ? s12ReasonText(supportDimensions[name].reasonCode as Parameters<typeof s12ReasonText>[0])
      : s6ReasonText(supportDimensions[name].reasonCode as Parameters<typeof s6ReasonText>[0]),
    evidenceRefs: [], evaluationMethod: "automatic" }]));
  return { schemaVersion: 1, resultVersion: 1, status: "complete", scenarioId: id,
    reference: { artifactId: referenceArtifactId, oracleRunId, oracleVersion: 1, validity: "valid", scoreEligibility: "eligible", retention: "retained" },
    attempt: { artifactId: attemptArtifactId, toolRunId, requestId, protocolVersion: 1, attemptValidity: "valid", scoreReadiness: "ready", retention: "retained" },
    tool: { name: "twin", version: { status: "known", version: "v1" } },
    adapter: { name: id.toLowerCase(), version: { status: "known", version: "v1" } },
    scoreSupport: { schemaVersion: 1, supportVersion: 1, scenarioId: id, toolRunId, requestId, oracleRunId,
      referenceArtifactId, attemptArtifactId, score: { schemaVersion: 1, rubricVersion: 1, scenarioId: id,
        toolRunId, oracleRunId, dimensions: scoreDimensions }, dimensions: supportDimensions } };
}

function fakeFile(bytes: Buffer, ino: number, options: { regular?: boolean; size?: number } = {}) {
  const size = options.size ?? bytes.length;
  return { stat: vi.fn(async () => ({ isFile: () => options.regular !== false, size, dev: 1, ino, mtimeMs: 1, ctimeMs: 1 })),
    read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
      const count = Math.min(length, Math.max(0, bytes.length - position));
      bytes.copy(target, offset, position, position + count);
      return { bytesRead: count, buffer: target };
    }), close: vi.fn(async () => undefined) };
}
function install(a: Buffer, b: Buffer, options: { sameFile?: boolean; regular?: boolean; size?: number } = {}) {
  const files = [fakeFile(a, 1, options), fakeFile(b, options.sameFile ? 1 : 2)];
  mockedOpen.mockImplementation(async path => files[path === "first" ? 0 : 1] as never);
  return files;
}
const encoded = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
const failed = (reason: string) => ({ schemaVersion: 1, resultVersion: 1, status: "incomplete", reason });

beforeEach(() => mockedOpen.mockReset());

describe("combined S12 and S6 score", () => {
  it("emits exact canonical bytes and accepts reversed argument order", async () => {
    const s12 = result("S12"), s6 = result("S6");
    install(encoded(s6), encoded(s12));
    const combined = await readCombinedScoreFiles(["first", "second"]);
    const expected = { schemaVersion: 1, resultVersion: 1, status: "complete", results: [
      { scenarioId: "S12", reference: s12.reference, attempt: s12.attempt, tool: s12.tool, adapter: s12.adapter, score: s12.scoreSupport.score },
      { scenarioId: "S6", reference: s6.reference, attempt: s6.attempt, tool: s6.tool, adapter: s6.adapter, score: s6.scoreSupport.score },
    ] };
    expect(renderCombinedScoreLine(combined)).toBe(`${JSON.stringify(expected)}\n`);
    expect(combined).toEqual(CombinedScoreResultSchema.parse(expected));
    expect(renderCombinedScoreLine(combineScores(s12, s6))).toBe(renderCombinedScoreLine(combined));
    expect(mockedOpen).toHaveBeenCalledWith("first", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  });

  it("rejects argument count, duplicate files, symlinks, nonregular files and oversize files", async () => {
    expect(await readCombinedScoreFiles([])).toEqual(failed("invalid-input"));
    expect(await readCombinedScoreFiles(["one", "two", "three"])).toEqual(failed("invalid-input"));
    install(encoded(result("S12")), encoded(result("S6")), { sameFile: true });
    expect(await readCombinedScoreFiles(["first", "second"])).toEqual(failed("invalid-input"));
    mockedOpen.mockRejectedValueOnce(Object.assign(new Error("private-path"), { code: "ELOOP" }));
    expect(await readCombinedScoreFiles(["first", "second"])).toEqual(failed("invalid-input"));
    install(encoded(result("S12")), encoded(result("S6")), { regular: false });
    expect(await readCombinedScoreFiles(["first", "second"])).toEqual(failed("invalid-input"));
    install(encoded(result("S12")), encoded(result("S6")), { size: 8 * 1024 * 1024 + 1 });
    expect(await readCombinedScoreFiles(["first", "second"])).toEqual(failed("invalid-input"));
  });

  it.each([
    ["missing LF", (b: Buffer) => b.subarray(0, -1)],
    ["extra LF", (b: Buffer) => Buffer.concat([b, Buffer.from("\n")])],
    ["extra bytes", (b: Buffer) => Buffer.concat([b, Buffer.from("x")])],
    ["BOM", (b: Buffer) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b])],
    ["invalid UTF-8", (b: Buffer) => Buffer.concat([Buffer.from([0xff]), b])],
    ["malformed JSON", () => Buffer.from("{\n")],
    ["extra key", () => encoded({ ...result("S12"), privatePath: "/secret" })],
  ])("rejects %s without echoing input", async (_name, mutate) => {
    install(mutate(encoded(result("S12"))), encoded(result("S6")));
    expect(await readCombinedScoreFiles(["first", "second"])).toEqual(failed("invalid-input"));
  });

  it("rejects truncated and growing reads", async () => {
    const bytes = encoded(result("S12"));
    install(bytes, encoded(result("S6")), { size: bytes.length + 1 });
    expect(await readCombinedScoreFiles(["first", "second"])).toEqual(failed("invalid-input"));
    install(bytes, encoded(result("S6")), { size: bytes.length - 1 });
    expect(await readCombinedScoreFiles(["first", "second"])).toEqual(failed("invalid-input"));
  });

  it("rejects either incomplete result and mismatched nested identities", () => {
    const s12 = result("S12"), s6 = result("S6");
    expect(combineScores({ schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S12",
      stage: "preflight", reason: "operation-failed", identities: {} }, s6)).toEqual(failed("incomplete-input"));
    expect(combineScores(s12, { schemaVersion: 1, resultVersion: 1, status: "incomplete", scenarioId: "S6",
      stage: "preflight", reason: "operation-failed", identities: {} })).toEqual(failed("incomplete-input"));
    s12.scoreSupport.score.toolRunId = "toolrun:other";
    expect(combineScores(s12, s6)).toEqual(failed("invalid-input"));
    const trimmed = result("S12");
    trimmed.scoreSupport.score.dimensions.recoveredOrPreserved!.reason = " Unresolved. ";
    expect(combineScores(trimmed, s6)).toEqual(failed("invalid-input"));
  });

  it("rejects reused run, request and artifact IDs", () => {
    const cases = [
      (a: ReturnType<typeof result>, b: ReturnType<typeof result>) => { b.reference.oracleRunId = a.reference.oracleRunId; b.scoreSupport.oracleRunId = a.reference.oracleRunId; b.scoreSupport.score.oracleRunId = a.reference.oracleRunId; },
      (a: ReturnType<typeof result>, b: ReturnType<typeof result>) => { b.attempt.toolRunId = a.attempt.toolRunId; b.scoreSupport.toolRunId = a.attempt.toolRunId; b.scoreSupport.score.toolRunId = a.attempt.toolRunId; },
      (a: ReturnType<typeof result>, b: ReturnType<typeof result>) => { b.attempt.requestId = a.attempt.requestId; b.scoreSupport.requestId = a.attempt.requestId; },
      (a: ReturnType<typeof result>, b: ReturnType<typeof result>) => { b.reference.artifactId = a.attempt.artifactId; b.scoreSupport.referenceArtifactId = a.attempt.artifactId; },
    ];
    for (const change of cases) {
      const a = result("S12"), b = result("S6"); change(a, b);
      expect(combineScores(a, b)).toEqual(failed("identity-conflict"));
    }
  });

  it("keeps incomplete output private and has no producer or child-process dependency", () => {
    const line = renderCombinedScoreLine(failed("invalid-input") as never);
    expect(line).toBe('{"schemaVersion":1,"resultVersion":1,"status":"incomplete","reason":"invalid-input"}\n');
    expect(line).not.toMatch(/score|artifact|toolRun|request|\/secret|private-path/i);
    for (const path of ["../src/combined-score-entry.ts", "../src/contract/combined-score.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
      expect(source).not.toMatch(/score-producer|child_process|\bspawn\s*\(|\bexec\s*\(/);
    }
  });
});
