"use client";

import { useMemo, useState } from "react";
import type { ComparisonRow, ScoreField } from "../lib/comparison";

const dimensions: { key: keyof ComparisonRow["score"]; label: string }[] = [
  { key: "recoveredOrPreserved", label: "Recovered or preserved" },
  { key: "reported", label: "Reported" },
  { key: "blockedBeforeExecution", label: "Blocked before execution" },
  { key: "workspaceUsable", label: "Workspace usable" },
  { key: "boundaryAccuratelyDescribed", label: "Boundary accurately described" },
];

const toolLabels: Record<string, string> = {
  twin: "Twin",
  agenttx: "AgentTX",
  "plain-git": "plain Git",
};

function evidenceValue(row: ComparisonRow, reference: string): string {
  if (reference === "action") return row.action;
  if (reference === "recovery") return row.recovery;
  if (reference.startsWith("observations.")) {
    return row.observations[reference.slice("observations.".length)] ?? "unknown";
  }
  return "unknown";
}

function Score({ field, row }: { field: ScoreField; row: ComparisonRow }) {
  return (
    <div className="score-value">
      <span className={`outcome outcome-${field.outcome}`}>{field.outcome}</span>
      <p>{field.reason}</p>
      {field.evidenceRefs.length > 0 ? (
        <ul className="evidence-list" aria-label="Evidence references">
          {field.evidenceRefs.map((reference) => (
            <li key={reference}><code>{reference}</code><span> → {evidenceValue(row, reference)}</span></li>
          ))}
        </ul>
      ) : <span className="no-evidence">No row-local evidence reference</span>}
    </div>
  );
}

export function ResultsExplorer({ rows, scenarioLinks }: { rows: ComparisonRow[]; scenarioLinks: Record<string, string> }) {
  const [scenario, setScenario] = useState("all");
  const [tool, setTool] = useState("all");
  const scenarios = useMemo(() => [...new Set(rows.map((row) => row.scenarioId))], [rows]);
  const tools = useMemo(() => [...new Set(rows.map((row) => row.tool))], [rows]);
  const visibleRows = rows.filter((row) =>
    (scenario === "all" || row.scenarioId === scenario) && (tool === "all" || row.tool === tool),
  );
  const visibleScenarios = [...new Set(visibleRows.map((row) => row.scenarioId))];

  return (
    <section className="results-explorer" aria-labelledby="attempts-heading">
      <div className="section-heading results-heading">
        <div><span className="eyebrow">attempts</span><h2 id="attempts-heading">Every recorded attempt</h2></div>
        <span className="result-count" aria-live="polite">{visibleRows.length} of {rows.length} attempts</span>
      </div>
      <div className="filter-bar" aria-label="Filter comparison attempts">
        <label>scenario
          <select value={scenario} onChange={(event) => setScenario(event.target.value)}>
            <option value="all">all scenarios</option>
            {scenarios.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label>tool
          <select value={tool} onChange={(event) => setTool(event.target.value)}>
            <option value="all">all tools</option>
            {tools.map((id) => <option key={id} value={id}>{toolLabels[id] ?? id}</option>)}
          </select>
        </label>
        {(scenario !== "all" || tool !== "all") && <button type="button" className="quiet-button" onClick={() => { setScenario("all"); setTool("all"); }}>clear filters</button>}
      </div>
      {visibleRows.length === 0 ? <p className="empty-results">No attempts match these filters.</p> : null}
      <div className="scenario-list">
        {visibleScenarios.map((id) => (
          <section className="scenario-group" key={id} aria-labelledby={`heading-${id}`}>
            <div className="scenario-title">
              <h3 id={`heading-${id}`}>{id}</h3>
              <a href={scenarioLinks[id]}>scenario definition <span aria-hidden="true">↗</span></a>
            </div>
            <div className="attempt-grid">
              {visibleRows.filter((row) => row.scenarioId === id).map((row) => (
                <article className="attempt-card" key={`${id}-${row.tool}`}>
                  <div className="attempt-topline"><h4>{toolLabels[row.tool] ?? row.tool}</h4><code>{row.toolVersion}</code></div>
                  <div className="attempt-meta">
                    <span>action <strong>{row.action}</strong></span>
                    <span>exit <strong>{row.actionExitCode ?? "unknown"}</strong></span>
                    <span>recovery <strong>{row.recovery}</strong></span>
                  </div>
                  {row.compatibility.length > 0 && <p className="compat-note">compatibility: {row.compatibility.join(", ")}</p>}
                  <dl className="score-list">
                    {dimensions.map(({ key, label }) => (
                      <div key={key} className="score-row">
                        <dt>{label}</dt>
                        <dd><Score field={row.score[key]} row={row} /></dd>
                      </div>
                    ))}
                  </dl>
                  <details className="observation-details">
                    <summary>all recorded observations</summary>
                    <dl>{Object.entries(row.observations).map(([key, value]) => (
                      <div key={key}><dt><code>{key}</code></dt><dd>{value}</dd></div>
                    ))}</dl>
                  </details>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
