import { CombinedScoreCompleteSchema } from "./contract/combined-score.js";
import { s12ReasonText } from "./contract/s12-score-support.js";
import { s6ReasonText } from "./contract/s6-score-support.js";

const dimensions = [
  ["recoveredOrPreserved", "Recovered or preserved?"],
  ["reported", "Reported?"],
  ["blockedBeforeExecution", "Blocked before execution?"],
  ["workspaceUsable", "Workspace usable?"],
  ["boundaryAccuratelyDescribed", "Boundary accurately described?"],
] as const;

const expected = {
  S12: {
    recoveredOrPreserved: ["unknown", s12ReasonText("preservation-not-established-v1")],
    reported: ["unknown", s12ReasonText("report-not-reviewed-v1")],
    blockedBeforeExecution: ["not-blocked", s12ReasonText("delivered-action-started-v1")],
    workspaceUsable: ["usable", s12ReasonText("fixed-work-observed-v1")],
    boundaryAccuratelyDescribed: ["unknown", s12ReasonText("claim-not-reviewed-v1")],
  },
  S6: {
    recoveredOrPreserved: ["unknown", s6ReasonText("preservation-not-established-v1")],
    reported: ["unknown", s6ReasonText("twin-report-not-reviewed-v1")],
    blockedBeforeExecution: ["not-blocked", s6ReasonText("delivered-git-clean-started-v1")],
    workspaceUsable: ["usable", s6ReasonText("fixed-clean-work-observed-v1")],
    boundaryAccuratelyDescribed: ["unknown", s6ReasonText("claim-not-reviewed-v1")],
  },
} as const;

export function escapeMarkdownCell(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) throw new Error("invalid-input");
  return value.replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|")
    .replace(/[&<>[\]()`!*_#]/gu, character => `&#${character.codePointAt(0)};`)
    .replace(/\r\n|\r|\n|\u2028|\u2029/gu, "&#10;");
}

function identity(name: string, version: { status: "known"; version: string } | { status: "unknown"; reason: string }): string {
  return `${escapeMarkdownCell(name)} (${version.status === "known" ? escapeMarkdownCell(version.version) : "version unknown"})`;
}

/** Pure rendering of the current closed Twin S12/S6 score projection. */
export function renderMarkdownReport(input: unknown): string {
  const parsed = CombinedScoreCompleteSchema.safeParse(input);
  if (!parsed.success) throw new Error("invalid-input");
  const [s12, s6] = parsed.data.results;
  for (const result of [s12, s6]) {
    if (result.score.scenarioId !== result.scenarioId || result.score.toolRunId !== result.attempt.toolRunId
      || result.score.oracleRunId !== result.reference.oracleRunId) throw new Error("invalid-input");
    for (const [key] of dimensions) {
      const actual = result.score.dimensions[key], [outcome, reason] = expected[result.scenarioId][key];
      if (actual.outcome !== outcome || actual.reason !== reason || actual.evaluationMethod !== "automatic")
        throw new Error("invalid-input");
      escapeMarkdownCell(actual.reason);
    }
  }
  const lines = [
    "# Current Twin S12/S6 results",
    "",
    "This report covers only the current retained Twin S12 and S6 results.",
    "",
    "## Five dimensions",
    "",
    "| Dimension | S12 outcome and reason | S6 outcome and reason |",
    "| --- | --- | --- |",
  ];
  for (const [key, label] of dimensions) {
    const a = s12.score.dimensions[key], b = s6.score.dimensions[key];
    lines.push(`| ${label} | ${escapeMarkdownCell(a.outcome)} — ${escapeMarkdownCell(a.reason)} | ${escapeMarkdownCell(b.outcome)} — ${escapeMarkdownCell(b.reason)} |`);
  }
  lines.push("", "## Public identities", "", "| Scenario | Tool | Adapter |", "| --- | --- | --- |",
    `| S12 | ${identity(s12.tool.name, s12.tool.version)} | ${identity(s12.adapter.name, s12.adapter.version)} |`,
    `| S6 | ${identity(s6.tool.name, s6.tool.version)} | ${identity(s6.adapter.name, s6.adapter.version)} |`,
    "", "## Limitations", "",
    "- Retained files are locally validated but not authenticated.",
    "- Endpoint equality does not prove continuous preservation.",
    "- Discard is cleanup, not recovery.",
    "- Git stdout is not Twin reporting.",
    "- Plain Git and AgentTX do not yet have five-dimension scores in this report.");
  return `${lines.join("\n")}\n`;
}
