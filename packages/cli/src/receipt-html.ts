import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MinimalReceipt } from "@twin-cli/core";
import { renderReceiptText } from "./receipt-text.js";

export const MAX_HTML_RECEIPT_BYTES = 64 * 1024;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

export function renderReceiptHtml(receipt: MinimalReceipt): string {
  const transcript = escapeHtml(renderReceiptText(receipt));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Twin receipt</title>
<style>
  :root { color-scheme: light; font-family: system-ui, sans-serif; background: #f7f5f0; color: #252724; }
  body { margin: 0; padding: clamp(1rem, 4vw, 3rem); }
  main { max-width: 76rem; margin: auto; }
  h1 { font-size: clamp(1.5rem, 3vw, 2rem); margin: 0 0 .5rem; }
  p { margin: 0 0 1.5rem; line-height: 1.5; }
  pre { box-sizing: border-box; overflow-x: auto; padding: clamp(1rem, 3vw, 2rem); border: 1px solid #c8c5bc; border-radius: .75rem; background: #fff; color: #252724; font: .9rem/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  @media print { body { padding: 0; } pre { border: 0; padding: 0; } }
</style>
</head>
<body>
<main>
<h1>Twin receipt</h1>
<p>Bounded presentation of observed changes and coverage. Arguments, environment values, and other omitted data remain undisclosed. The JSON receipt contains observations omitted by presentation limits.</p>
<pre aria-label="Receipt observations">${transcript}</pre>
</main>
</body>
</html>
`;
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_RECEIPT_BYTES) throw new Error("HTML receipt exceeds size limit");
  return html;
}

export async function exportReceiptHtml(receipt: MinimalReceipt, destination: string): Promise<void> {
  const html = renderReceiptHtml(receipt);
  const temporary = join(dirname(destination), `.twin-receipt-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(html, "utf8");
    await handle.close();
    await link(temporary, destination);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary);
  }
}
