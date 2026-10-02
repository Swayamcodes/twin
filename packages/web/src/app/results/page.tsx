import Link from "next/link";
import { ResultsExplorer } from "../../components/results-explorer";
import { comparisonLinks, loadComparison, scenarioDefinitionLinks } from "../../lib/comparison";

export const metadata = { title: "Fixed-action results" };

export default function ResultsPage() {
  const comparison = loadComparison();
  const links = scenarioDefinitionLinks(comparison.rows);
  const metadata = comparison.executionMetadata;
  const scenarios = new Set(comparison.rows.map((row) => row.scenarioId));
  const tools = new Set(comparison.rows.map((row) => row.tool));

  return (
    <main id="main-content" className="results-page page-width">
      <div className="results-intro"><Link href="/" className="back-link">← back to twin</Link><span className="eyebrow">retained Phase 6 comparison</span><h1>Fixed actions. Separate outcomes.</h1><p>This page renders the committed comparison JSON: {comparison.rows.length} disposable attempts across {scenarios.size} scenarios and {tools.size} tools. Each score keeps its own reason and evidence references. Unknown means the attempt did not establish a stronger claim.</p><div className="results-source-links"><a href={comparisonLinks.json}>underlying JSON ↗</a><a href={comparisonLinks.markdown}>deterministic Markdown ↗</a></div></div>

      <section className="identity-panel" aria-labelledby="identity-heading"><div className="identity-heading"><span className="eyebrow">source identity</span><h2 id="identity-heading">What this result records</h2></div><dl className="identity-grid"><div><dt>source commit</dt><dd><code>{metadata.source.commit}</code></dd></div><div><dt>working tree at execution</dt><dd><code>{metadata.source.workingTree}</code></dd></div><div><dt>Node</dt><dd><code>{metadata.versions.node}</code></dd></div><div><dt>Git</dt><dd><code>{metadata.versions.git}</code></dd></div><div><dt>AgentTX</dt><dd><code>{metadata.versions.agenttx}</code></dd></div><div><dt>fixture roots</dt><dd><code>{comparison.rootAccounting.allocated} allocated · {comparison.rootAccounting.removed} removed · {comparison.rootAccounting.retained} retained</code></dd></div></dl><details className="identity-more"><summary>execution digests and recipe</summary><dl><div><dt>status SHA-256</dt><dd><code>{metadata.source.statusSha256}</code></dd></div>{Object.entries(metadata.executables).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{value}</code></dd></div>)}{Object.entries(metadata.builds).map(([key, value]) => <div key={key}><dt>{key} build · {value.fileCount} files</dt><dd><code>{value.sha256}</code></dd></div>)}<div><dt>fixed action digests</dt><dd>{metadata.actions.map((action) => <span className="digest-item" key={action.scenarioId}><code>{action.scenarioId} · {action.kind} · {action.sha256}</code></span>)}</dd></div><div><dt>S11 worker SHA-256</dt><dd><code>{metadata.s11WorkerSha256}</code></dd></div><div><dt>plain Git recovery recipe</dt><dd><code>{comparison.gitRecoveryRecipe}</code></dd></div></dl></details></section>

      <section className="evidence-boundary" aria-labelledby="boundary-heading"><span className="eyebrow">read this result as recorded</span><h2 id="boundary-heading">Three different evidence sets</h2><p>The rows below are the retained Phase 6 result at the recorded source commit and working-tree state. The <a href={comparisonLinks.phase2}>Phase 2 JSON</a> is historical evidence; the <a href={comparisonLinks.hosted}>fresh hosted CI run</a> is a later, separate observation. Neither changes a score displayed here.</p></section>

      <ResultsExplorer rows={comparison.rows} scenarioLinks={links} />

      <section className="limits-section" aria-labelledby="limits-heading"><span className="eyebrow">known limits</span><h2 id="limits-heading">Where these attempts stop.</h2><div className="limits-grid"><p><strong>S9 · outside project.</strong> The fake-home dotfile remained changed after the recorded recovery steps. The displayed Twin, AgentTX, and plain-Git rows do not report that effect.</p><p><strong>S10 · global packages.</strong> The fixed local-tarball install left package state after recovery in this dataset. It is an owned global prefix, not a general registry test.</p><p><strong>S11 · processes.</strong> A background worker is observed in these attempts. Later harness cleanup is separate from tool recovery, and escaped descendants are not established by process-group observation.</p><p><strong>AgentTX S6 · preconditions.</strong> Its recorded workspace did not establish equivalent deletion inputs. The five fields remain unknown for that row.</p><p><strong>Claude Code · billing.</strong> Launch, receipt, settlement, and discard were verified separately. <a href={comparisonLinks.claude}>Model-backed edit remains unverified</a> because of insufficient API credit; no Claude model run is part of this comparison.</p></div></section>
      <footer className="site-footer"><span>retained comparison · schema {comparison.schemaVersion} · version {comparison.comparisonVersion}</span><a href={comparisonLinks.json}>view source JSON ↗</a></footer>
    </main>
  );
}
