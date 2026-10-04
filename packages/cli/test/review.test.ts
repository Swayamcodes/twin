import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["apply", "apply-links", "discard", "cancel", "eof", "other", "conflict"] as const)("prints a live receipt before %s and settles the review choice", async selected => {
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
    if (selected === "apply-links") {
      await mkdir(join(source, "real")); await mkdir(join(source, "node_modules"));
      await writeFile(join(source, "real/file"), "before");
      await symlink(join(source, "real"), join(source, "absolute"));
      await symlink("../real", join(source, "node_modules/pkg"));
    }
    await writeFile(join(source, "choice.txt"), selected === "eof" ? "" : `${selected === "conflict" || selected === "apply-links" ? "apply" : selected}\n`);
    const log = await open(join(source, "receipt.log"), "w+");
    const choice = await open(join(source, "choice.txt"), "r");
    let code: number | null;
    try {
      const script = selected === "conflict"
        ? 'const fs=require("node:fs");fs.writeFileSync("file","after");fs.writeFileSync(process.argv[1],"concurrent")'
        : selected === "apply-links" ? 'const fs=require("node:fs");fs.writeFileSync("absolute/file","after");fs.writeFileSync("file","after")'
        : 'require("node:fs").writeFileSync("file","after")';
      const child = spawn(process.execPath, [cli, "run", "--review", "--receipt=text", "--", process.execPath,
        "-e", script, join(source, "file")], { cwd: source, env: { ...process.env, TMPDIR: scratch }, stdio: [choice.fd, "ignore", log.fd] });
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
    const retained = selected === "cancel" || selected === "eof" || selected === "other" || selected === "conflict";
    if (code !== (retained ? 1 : 0)) throw new Error(`CLI exited ${code}: ${output}`);
    expect(output).toContain("Twin receipt (schema 5)");
    expect(output).toContain("Twin review:");
    if (selected === "apply" || selected === "apply-links") expect(output).toContain("Twin apply applied");
    if (selected === "conflict") expect(output).toContain("Twin apply conflict");
    if (selected === "eof") expect(output).toContain("Twin review eof; no apply or discard requested.");
    if (selected === "cancel") expect(output).toContain("Twin review cancel; no apply or discard requested.");
    if (selected === "other") expect(output).toContain("Twin review other; no apply or discard requested.");
    if (retained) {
      expect(output).toContain("Twin copy retained:");
      expect(output).toContain("same --review invocation");
      const copies = await readdir(scratch);
      expect(copies).toHaveLength(1);
      const roots = await readdir(join(scratch, copies[0]!));
      expect(roots).toHaveLength(1);
      expect(await readFile(join(scratch, copies[0]!, roots[0]!, "workspace", "file"), "utf8")).toBe("after");
    }
    expect(await readFile(join(source, "file"), "utf8")).toBe(selected === "apply" || selected === "apply-links" ? "after" : selected === "conflict" ? "concurrent" : "before");
    if (selected === "apply-links") {
      expect(await readFile(join(source, "real/file"), "utf8")).toBe("after");
      expect(await readlink(join(source, "absolute"))).toBe(join(source, "real"));
      expect(await readlink(join(source, "node_modules/pkg"))).toBe("../real");
    }
  } catch (error) { failure = error; }
  if (!cliClosed) throw new Error(`CLI closure unconfirmed; retained ${base}`, { cause: failure });
  if ((selected === "apply" || selected === "apply-links" || selected === "discard") && (await readdir(scratch)).length !== 0) failure ??= new Error("CLI scratch cleanup incomplete");
  if (!failure) await rm(base, { recursive: true });
  if (failure) throw failure;
}, 25000);

it("retains the copy when interrupted at the review prompt", async () => {
  const base = await mkdtemp(join(tmpdir(), "twin-cli-review-interrupt-test-"));
  const source = join(base, "source");
  const scratch = join(base, "scratch");
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  await mkdir(source);
  await mkdir(scratch);
  await writeFile(join(source, "file"), "before");
  const child = spawn(process.execPath, [cli, "run", "--review", "--receipt=text", "--", process.execPath,
    "-e", 'require("node:fs").writeFileSync("file","after")'],
  { cwd: source, env: { ...process.env, TMPDIR: scratch }, stdio: ["pipe", "ignore", "pipe"] });
  let closed = false;
  const close = new Promise<number | null>(resolve => child.once("close", code => { closed = true; resolve(code); }));
  let launchError: Error | null = null;
  child.once("error", error => { launchError = error; });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Review CLI close timed out")), ms);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  let failure: unknown;
  try {
    await within(new Promise<void>(resolve => {
      const onData = (): void => {
        if (!Buffer.concat(stderr).toString().includes("Twin review:")) return;
        child.stderr.off("data", onData);
        resolve();
      };
      child.stderr.on("data", onData);
      onData();
    }), 8000);
    expect(child.kill("SIGINT")).toBe(true);
    expect(await within(close, 8000)).toBe(1);
    const output = Buffer.concat(stderr).toString();
    expect(output).toContain("Twin review interrupted; no apply or discard requested.");
    expect(output).toContain("Twin copy retained:");
    expect(await readFile(join(source, "file"), "utf8")).toBe("before");
    expect(await readdir(scratch)).toHaveLength(1);
  } catch (error) { failure = launchError ?? error; }
  if (!closed) {
    child.kill("SIGKILL");
    try { await within(close, 8000); }
    catch (error) { throw new Error(`CLI closure unconfirmed; retained ${base}`, { cause: error }); }
  }
  if (failure) throw new Error(`Review interruption failed; retained ${base}; stderr: ${Buffer.concat(stderr).toString()}`, { cause: failure });
  await rm(base, { recursive: true });
}, 25000);
