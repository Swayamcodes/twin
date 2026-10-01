import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ComparisonAttemptFailure, ComparisonPrerequisiteFailure, produceComparison,
  type ComparisonRootAccounting } from "./comparison-runner.js";
import { ComparisonArtifactSchema, IncompleteComparisonSchema, renderComparisonArtifact,
  comparisonSequence, type ComparisonArtifact, type ComparisonExecutionMetadata, type ComparisonRow } from "./comparison-result.js";

export async function runComparisonEntry(argv: readonly string[], run = produceComparison): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "--output-dir" || !isAbsolute(argv[1] ?? ""))
    throw new Error("Usage: comparison-entry --output-dir ABSOLUTE_NEW_DIRECTORY");
  const directory = resolve(argv[1]!);
  assert.equal(directory, argv[1], "Output directory must be canonical");
  const parent = dirname(directory);
  assert.equal(await fs.realpath(parent), parent, "Output parent must be canonical");
  const parentStat = await fs.lstat(parent);
  assert(parentStat.isDirectory() && !parentStat.isSymbolicLink(), "Output parent must be a directory");
  await fs.mkdir(directory, { mode: 0o700 });
  const rows: ComparisonRow[] = [];
  const accounting: ComparisonRootAccounting = { allocated: 0, removed: 0 };
  let ready = false;
  let executionMetadata: ComparisonExecutionMetadata | undefined;
  let artifact: ComparisonArtifact;
  try {
    artifact = await run(row => { rows.push(row); }, () => { ready = true; }, accounting,
      metadata => { executionMetadata = metadata; });
  } catch (error: unknown) {
    const failureStage = ready ? error instanceof ComparisonAttemptFailure ? error.stage : "observation" : "prerequisite";
    const retained = accounting.allocated - accounting.removed;
    const rootDisposition = retained > 0
      ? ready && error instanceof ComparisonAttemptFailure ? error.rootDisposition === "retained" ? "retained" : "unknown" : "retained"
      : accounting.allocated > (ready ? rows.length + 1 : 0) ? "removed" : "not-allocated";
    artifact = IncompleteComparisonSchema.parse({ schemaVersion: 1, comparisonVersion: 1,
      status: "incomplete", reason: ready ? "attempt-failed" : "prerequisite-failed",
      failureStage, rootDisposition,
      rootAccounting: { allocated: accounting.allocated, removed: accounting.removed,
        retained },
      ...(executionMetadata ? { executionMetadata } : {}),
      prerequisiteCode: ready ? null : error instanceof ComparisonPrerequisiteFailure ? error.code : "other",
      completedRows: rows, failedAttempt: ready ? comparisonSequence[rows.length] : null });
  }
  const checked = ComparisonArtifactSchema.parse(artifact);
  const json = `${JSON.stringify(checked)}\n`;
  const markdown = renderComparisonArtifact(checked);
  const jsonPath = join(directory, "comparison.json");
  const markdownPath = join(directory, "comparison.md");
  await fs.writeFile(jsonPath, json, { flag: "wx", mode: 0o600 });
  await fs.writeFile(markdownPath, markdown, { flag: "wx", mode: 0o600 });
  const reopenedJson = await fs.readFile(jsonPath, "utf8");
  const reopenedMarkdown = await fs.readFile(markdownPath, "utf8");
  assert.equal(reopenedJson, json);
  const reopened = ComparisonArtifactSchema.parse(JSON.parse(reopenedJson) as unknown);
  assert.equal(reopenedMarkdown, renderComparisonArtifact(reopened));
  process.stdout.write(`Comparison ${"status" in reopened ? "incomplete" : "complete"}: ${"status" in reopened ? reopened.completedRows.length : reopened.rows.length} attempts; artifacts verified.\n`);
  if ("status" in reopened) process.stderr.write(`Comparison stopped: ${reopened.prerequisiteCode ?? reopened.failureStage}.\n`);
  return "status" in reopened ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runComparisonEntry(process.argv.slice(2)); }
  catch { process.stderr.write("Comparison refused or artifact publication failed. Inspect the explicit output directory.\n"); process.exitCode = 2; }
}
