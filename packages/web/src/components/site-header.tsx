import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner page-width">
        <Link className="brand" href="/" aria-label="Twin home">
          <span className="brand-mark" aria-hidden="true">t</span>
          <span>twin<span className="brand-suffix">.cli</span></span>
        </Link>
        <nav aria-label="Main navigation" className="header-nav">
          <Link href="/results">results</Link>
          <a href="https://github.com/Swayamcodes/twin/blob/3019b52bda3ed024f26d19256111797d83de90de/README.md">docs</a>
          <a className="header-github" href="https://github.com/Swayamcodes/twin">github <span aria-hidden="true">↗</span></a>
        </nav>
      </div>
    </header>
  );
}
