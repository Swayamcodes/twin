import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { produceComparison } from "./comparison-runner.js";
import { renderComparison } from "./comparison-result.js";

const jsonPath = fileURLToPath(new URL("../../../docs/phase-2-comparison.json", import.meta.url));
const markdownPath = fileURLToPath(new URL("../../../docs/phase-2-comparison.md", import.meta.url));
if (process.argv.length !== 2) throw new Error("Comparison entry takes no arguments");
const result = await produceComparison();
await fs.writeFile(jsonPath, `${JSON.stringify(result)}\n`, { flag: "w", mode: 0o600 });
await fs.writeFile(markdownPath, renderComparison(result), { flag: "w", mode: 0o600 });
process.stdout.write("Phase 2 comparison: 39 attempts written.\n");
