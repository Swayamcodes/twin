import { actionBytes as existingActions, actionName as existingNames } from "./s8-s13-fixtures.js";
import type { ScenarioId } from "./comparison-result.js";

const script = (body: string): Buffer => Buffer.from(`if (process.argv.length !== 2) process.exit(2);\n${body}\n`);
export const fixedAction: Partial<Record<ScenarioId, { name: string; bytes: Buffer }>> = {
  S1: { name: "delete-notes.mjs", bytes: script('import { unlinkSync } from "node:fs"; unlinkSync("notes.txt");') },
  S2: { name: "delete-scratch.mjs", bytes: script('import { unlinkSync } from "node:fs"; unlinkSync("scratch.txt");') },
  S3: { name: "delete-env.mjs", bytes: script('import { unlinkSync } from "node:fs"; unlinkSync(".env");') },
  S5: { name: "delete-edited-notes.mjs", bytes: script('import { unlinkSync } from "node:fs"; unlinkSync("notes.txt");') },
  S7: { name: "overwrite-env.mjs", bytes: script('import { writeFileSync } from "node:fs"; writeFileSync(".env", "SECRET=oops");') },
  S8: { name: existingNames.S8, bytes: existingActions.S8 },
  S9: { name: existingNames.S9, bytes: existingActions.S9 },
  S13: { name: existingNames.S13, bytes: existingActions.S13 },
  S11: { name: "s11-launch.mjs", bytes: Buffer.from('import { spawn } from "node:child_process";\n'
    + 'import { fileURLToPath } from "node:url";\n'
    + 'const marker = process.env.TWIN_S11_MARKER, token = process.env.TWIN_S11_TOKEN;\n'
    + 'if (process.argv.length !== 2 || !marker || !token) process.exit(2);\n'
    + 'const worker = fileURLToPath(new URL("./s11-worker.mjs", import.meta.url));\n'
    + 'const child = spawn(process.execPath, [worker, marker, token], '
    + '{ detached: false, shell: false, stdio: "ignore", env: { HOME: process.env.HOME ?? "" } });\n'
    + 'child.unref();\n') },
};
export const s11Worker = Buffer.from('import { writeFileSync } from "node:fs";\n'
  + 'if (process.argv.length !== 4) process.exit(2);\n'
  + 'writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, token: process.argv[3] }) + "\\n", '
  + '{ flag: "wx", mode: 0o600 });\n'
  + 'setTimeout(() => process.exit(0), 20000).unref();\n'
  + 'setInterval(() => {}, 250);\n');
