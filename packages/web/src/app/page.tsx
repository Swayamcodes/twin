import Link from "next/link";
import { TerminalPlayback } from "../components/terminal-playback";
import { comparisonLinks } from "../lib/comparison";

const features = [
  { number: "01", title: "clone · run · discard", copy: "Run a plain command in a full project copy, including ignored files and folders without Git. Discard the copy after a settled run." },
  { number: "02", title: "receipt", copy: "See observed file differences and bounded command, process, dependency, and outside-project observations, with coverage limits called out." },
  { number: "03", title: "apply", copy: "Review a settled copy and apply its changes through conflict checks in the same CLI invocation." },
  { number: "04", title: "scenario suite", copy: "Inspect scripted fixed actions across Twin, AgentTX, and plain Git with five independent evidence-based outcomes." },
];

export default function Home() {
  return (
    <main id="main-content">
      <section className="hero page-width">
        <div className="hero-copy">
          <span className="eyebrow"><span className="eyebrow-dot" /> a copy between your agent and your project</span>
          <h1>Run coding agents in a project copy and review what changed.</h1>
          <p className="hero-intro">Twin copies the whole project, runs your command there, and shows a receipt before you choose what to keep.</p>
          <div className="hero-actions"><Link className="primary-link" href="/results">explore the results <span aria-hidden="true">↗</span></Link><a className="quiet-link" href="https://github.com/Swayamcodes/twin/blob/3019b52bda3ed024f26d19256111797d83de90de/docs/cli-usage.md">read the usage guide</a></div>
          <div className="install-block" aria-label="Install Twin or build from this checkout">
            <div className="install-top"><span>install · checkout setup</span><span>Node 24.2+ · pnpm 12.6.0 for checkout</span></div>
            <pre><code>npm install --global @twin-cli/cli@0.1.1{"\n"}twin run -- node script.js{"\n\n"}# from this checkout{"\n"}pnpm install --frozen-lockfile{"\n"}pnpm run build:core{"\n"}pnpm exec tsc -p packages/cli/tsconfig.json</code></pre>
            <p>Twin CLI 0.1.1 is published on npm; core remains 0.1.0. For a checkout build, run <code>node /path/to/twin/packages/cli/dist/index.js run -- ...</code> from your project.</p>
          </div>
        </div>
        <div className="hero-product"><div className="product-caption"><span>inside the copy</span><span>real CLI receipt</span></div><TerminalPlayback /></div>
      </section>

      <section className="problem-section page-width" aria-labelledby="problem-heading">
        <div><span className="eyebrow">the problem</span><h2 id="problem-heading">A clean report can hide a missing input.</h2></div>
        <div className="problem-copy"><p>In documented AgentTX <strong>0.3.0</strong> hand tests, its clone omitted ignored inputs, and its S6 inspect report showed zero changes under different deletion preconditions. A home-file write in S9 stayed changed after rollback and was absent from its report.</p><p>These are bounded observations from specific attempts, not a general recovery ranking. <Link href="/results">Read the recorded comparison ↗</Link></p></div>
      </section>

      <section className="features-section page-width" aria-labelledby="features-heading">
        <div className="section-heading"><div><span className="eyebrow">what it does</span><h2 id="features-heading">A practical review loop.</h2></div><p>Keep the command workflow. Add a place to inspect its effects.</p></div>
        <div className="feature-grid">{features.map((feature) => <article key={feature.number} className="feature-card"><span className="feature-number">{feature.number}</span><h3>{feature.title}</h3><p>{feature.copy}</p></article>)}</div>
        <p className="boundary-note"><strong>This is project-copy isolation, not an OS sandbox.</strong> Commands retain your permissions. Watched outside-project paths can be reported but are not rolled back.</p>
      </section>

      <section className="compat-section page-width" aria-labelledby="compat-heading">
        <div><span className="eyebrow">compatibility</span><h2 id="compat-heading">Plain commands, observed limits.</h2></div>
        <div className="compat-cards">
          <article><span className="compat-badge">Codex CLI · verified scope</span><p>Headless <code>codex exec</code> was tested with an ignored input, Git apply, non-Git discard, and interruption on the recorded version.</p><a href={comparisonLinks.matrix}>view matrix ↗</a></article>
          <article><span className="compat-badge">Claude Code · partial verification</span><p>Launch, receipt, settlement, and discard were verified. Model-backed edit remains unverified because of insufficient API credit.</p><a href={comparisonLinks.claude}>read Claude limitation ↗</a></article>
        </div>
      </section>
      <section className="results-cta page-width"><div><span className="eyebrow">measured evidence</span><h2>Read the attempts, not a winner.</h2><p>Every S1–S13 attempt and every unknown stays visible, with reasons and evidence references.</p></div><Link className="primary-link" href="/results">open results <span aria-hidden="true">↗</span></Link></section>
      <footer className="site-footer page-width"><span>twin-cli · project-copy isolation</span><a href="https://github.com/Swayamcodes/twin">source on github ↗</a></footer>
    </main>
  );
}
