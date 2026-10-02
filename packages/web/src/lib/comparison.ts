import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(process.cwd(), "../..");
const sourceCommit = "3019b52bda3ed024f26d19256111797d83de90de";
const sourceDirectory = "docs/phase-6-results-2297bf07";
const sourceBase = `https://github.com/Swayamcodes/twin/blob/${sourceCommit}`;

export const comparisonLinks = {
  json: `${sourceBase}/${sourceDirectory}/comparison.json`,
  markdown: `${sourceBase}/${sourceDirectory}/comparison.md`,
  phase2: `${sourceBase}/docs/phase-2-comparison.json`,
  hosted: "https://github.com/Swayamcodes/twin/actions/runs/36895684935",
  matrix: `${sourceBase}/docs/compatibility-matrix.md`,
  claude: `${sourceBase}/docs/claude-code-compatibility.md`,
};

export type ScoreField = {
  outcome: string;
  reason: string;
  evidenceRefs: string[];
};

export type ComparisonRow = {
  scenarioId: string;
  tool: string;
  toolVersion: string;
  action: string;
  actionExitCode: number | null;
  recovery: string;
  compatibility: string[];
  observations: Record<string, string>;
  score: {
    recoveredOrPreserved: ScoreField;
    reported: ScoreField;
    blockedBeforeExecution: ScoreField;
    workspaceUsable: ScoreField;
    boundaryAccuratelyDescribed: ScoreField;
  };
};

export type Comparison = {
  schemaVersion: number;
  comparisonVersion: number;
  gitRecoveryRecipe: string;
  rootAccounting: { allocated: number; removed: number; retained: number };
  executionMetadata: {
    source: { commit: string; workingTree: string; statusSha256: string };
    versions: { node: string; git: string; agenttx: string };
    executables: Record<string, string>;
    builds: Record<string, { sha256: string; fileCount: number }>;
    actions: { scenarioId: string; kind: string; sha256: string }[];
    s11WorkerSha256: string;
  };
  rows: ComparisonRow[];
};

export function loadComparison(): Comparison {
  const file = resolve(repositoryRoot, sourceDirectory, "comparison.json");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    typeof parsed !== "object" || parsed === null ||
    !("rows" in parsed) || !Array.isArray(parsed.rows) ||
    !("executionMetadata" in parsed) || !parsed.executionMetadata
  ) {
    throw new Error("Retained comparison JSON has an unexpected shape");
  }
  return parsed as Comparison;
}

export function scenarioDefinitionLinks(rows: ComparisonRow[]): Record<string, string> {
  const catalog = readFileSync(resolve(repositoryRoot, "docs/scenario-catalog.md"), "utf8").split("\n");
  return Object.fromEntries(
    [...new Set(rows.map((row) => row.scenarioId))].map((id) => {
      const line = catalog.findIndex((text) => text.startsWith(`| ${id} |`));
      if (line < 0) throw new Error(`Missing scenario definition: ${id}`);
      return [id, `${sourceBase}/docs/scenario-catalog.md#L${line + 1}`];
    }),
  );
}
