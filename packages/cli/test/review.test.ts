import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["apply", "discard"] as const)("prints a live receipt before %s and removes the settled copy", async selected => {
  const base = await mkdtemp(join(tmpdir(), "twin-cli-review-test-"));
  const source = join(base, "source");
  const scratch = join(base, "scratch");
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  let failure: unknown;
  let cliClosed = false;
  try {
    await mkdir(source, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });
    await writeFile(join(source, "file"), "before");
    await writeFile(join(source, "choice.txt"), `${selected}\n`);
    const log = await open(join(source, "receipt.log"), "w+");
    const choice = await open(join(source, "choice.txt"), "r");
    let code: number | null;
    try {
      const child = spawn(process.execPath, [cli, "run", "--review", "--receipt=text", "--", process.execPath,
        "-e", 'require("node:fs").writeFileSync("file","after")'], { cwd: source, env: { ...process.env, TMPDIR: scratch }, stdio: [choice.fd, "ignore", log.fd] });
      const closed = new Promise<void>(resolve => child.once("close", () => { cliClosed = true; resolve(); }));
      let completionTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        code = await new Promise<number | null>((resolve, reject) => {
          const clear = (): void => { if (completionTimeout) clearTimeout(completionTimeout); completionTimeout = undefined; };
          child.once("error", error => { clear(); reject(error); });
          child.once("close", exitCode => { clear(); resolve(exitCode); });
          completionTimeout = setTimeout(() => {
            clear();
            if (cliClosed) return;
            try { child.kill("SIGKILL"); }
            catch (error) { reject(error); return; }
            reject(new Error("review timed out"));
          }, 15000);
        });
      } catch (error) {
        if (!cliClosed) {
          let shutdownTimeout: ReturnType<typeof setTimeout> | undefined;
          const shutdownConfirmed = await Promise.race([
            closed.then(() => true),
            new Promise<false>(resolve => { shutdownTimeout = setTimeout(() => resolve(false), 2000); }),
          ]);
          if (shutdownTimeout) clearTimeout(shutdownTimeout);
          if (!shutdownConfirmed) throw new Error(`CLI closure unconfirmed; retained ${base}`, { cause: error });
        }
        throw error;
      } finally { if (completionTimeout) clearTimeout(completionTimeout); }
    } finally { await choice.close(); await log.close(); }
    const output = await readFile(join(source, "receipt.log"), "utf8");
    if (code !== 0) throw new Error(`CLI exited ${code}: ${output}`);
    expect(output).toContain("Twin receipt (schema 5)");
    expect(output).toContain("Twin review:");
    if (selected === "apply") expect(output).toContain("Twin apply applied");
    expect(await readFile(join(source, "file"), "utf8")).toBe(selected === "apply" ? "after" : "before");
  } catch (error) { failure = error; }
  if (!cliClosed) throw new Error(`CLI closure unconfirmed; retained ${base}`, { cause: failure });
  if ((await readdir(scratch)).length !== 0) failure ??= new Error("CLI scratch cleanup incomplete");
  if (!failure) await rm(base, { recursive: true });
  if (failure) throw failure;
}, 25000);
