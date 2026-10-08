import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["apply", "apply-links", "discard", "cancel", "eof", "other", "conflict", "affected", "affected-conflict", "affected-cancel"] as const)("prints a live receipt before %s and settles the review choice", async selected => {
  const affected = selected.startsWith("affected");
  const conflict = selected === "conflict" || selected === "affected-conflict";
  const successfulApply = selected === "apply" || selected === "apply-links" || selected === "affected";
  const cancel = selected === "cancel" || selected === "affected-cancel";
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
    await writeFile(join(source, "choice.txt"), selected === "eof" ? "" : `${conflict || successfulApply ? "apply" : cancel ? "cancel" : selected}\n`);
    const log = await open(join(source, "receipt.log"), "w+");
    const choice = await open(join(source, "choice.txt"), "r");
    let code: number | null;
    try {
      const script = conflict
        ? 'const fs=require("node:fs");fs.writeFileSync("file","after");fs.writeFileSync(process.argv[1],"concurrent")'
        : selected === "apply-links" ? 'const fs=require("node:fs");fs.writeFileSync("absolute/file","after");fs.writeFileSync("file","after")'
        : 'require("node:fs").writeFileSync("file","after")';
      const child = spawn(process.execPath, [cli, "run", "--review", ...(affected ? ["--apply-scope=affected"] : []), "--receipt=text", "--", process.execPath,
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
    const retained = cancel || selected === "eof" || selected === "other" || conflict;
    if (code !== (retained ? 1 : 0)) throw new Error(`CLI exited ${code}: ${output}`);
    expect(output).toContain("Twin receipt (schema 5)");
    expect(output).toContain("Twin review:");
    if (affected) {
      const disclosure = "Apply verification: affected paths and ancestors. Unrelated files and links will not be rechecked.";
      expect(output.indexOf(disclosure)).toBeLessThan(output.indexOf("Twin review:"));
      if (!cancel) {
        const result = JSON.parse(output.split("Twin affected-path Apply result: ")[1]!.split("\n")[0]!) as Record<string, unknown>;
        expect(result).toMatchObject({ status: conflict ? "conflict" : "applied", scope: "affected-paths", outsideScope: "not-rechecked",
          plannedTargets: 1, scopeCoverage: conflict ? "incomplete" : "complete", verifiedTargets: conflict ? 0 : 1 });
        expect(output.split(disclosure)).toHaveLength(3);
      } else expect(output).not.toContain("Twin affected-path Apply result:");
    }
    if (selected === "apply" || selected === "apply-links") expect(output).toContain("Twin apply applied");
    if (selected === "conflict") expect(output).toContain("Twin apply conflict");
    if (selected === "eof") expect(output).toContain("Twin review eof; no apply or discard requested.");
    if (cancel) expect(output).toContain("Twin review cancel; no apply or discard requested.");
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
    expect(await readFile(join(source, "file"), "utf8")).toBe(successfulApply ? "after" : conflict ? "concurrent" : "before");
    if (selected === "apply-links") {
      expect(await readFile(join(source, "real/file"), "utf8")).toBe("after");
      expect(await readlink(join(source, "absolute"))).toBe(join(source, "real"));
      expect(await readlink(join(source, "node_modules/pkg"))).toBe("../real");
    }
  } catch (error) { failure = error; }
  if (!cliClosed) throw new Error(`CLI closure unconfirmed; retained ${base}`, { cause: failure });
  if ((successfulApply || selected === "discard") && (await readdir(scratch)).length !== 0) failure ??= new Error("CLI scratch cleanup incomplete");
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

it.each(["valid", "existing", "symlink", "in-source", "public-parent", "write-failure", "slow-writer"] as const)("keeps JSON receipt and Apply independent of stage diagnostics: %s", async selected => {
  const base = await mkdtemp(join(tmpdir(), "twin-cli-diagnostics-test-"));
  const identity = await lstat(base, { bigint: true });
  const source = join(base, "source"), scratch = join(base, "scratch"), trace = join(base, "trace.jsonl");
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  let closed = false, failed: unknown, child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await mkdir(source, { mode: 0o700 }); await mkdir(scratch, { mode: 0o700 });
    await writeFile(join(source, "file"), "PRIVATE_FILE_CONTENT");
    let destination = trace;
    if (selected === "existing") await writeFile(trace, "existing trace stays");
    if (selected === "symlink") { await writeFile(join(base, "target"), "target stays"); await symlink("target", trace); }
    if (selected === "in-source") destination = join(source, "trace.jsonl");
    if (selected === "public-parent") await chmod(base, 0o755);
    const launch: string[] = [];
    if (selected === "write-failure" || selected === "slow-writer") {
      const preload = join(base, "fault.mjs");
      const fault = selected === "write-failure" ? 'let release;const gate=new Promise(resolve=>{release=resolve});const stderrWrite=process.stderr.write.bind(process.stderr);process.stderr.write=(chunk,...params)=>{if(String(chunk).charCodeAt(0)===30)release();return stderrWrite(chunk,...params)};handle.write=async()=>{await gate;throw new Error("PRIVATE_ERROR_CONTENT")}'
        : 'const write=handle.write.bind(handle);let active=0;handle.write=async(...params)=>{if(++active>1)throw new Error("parallel trace writes");try{await new Promise(resolve=>setTimeout(resolve,25));return await write(...params)}finally{active--}}';
      await writeFile(preload, `import fs from "node:fs/promises";import {syncBuiltinESMExports} from "node:module";const original=fs.open;fs.open=async(...args)=>{const handle=await original(...args);if(String(args[0])===${JSON.stringify(trace)}){${fault}}return handle};syncBuiltinESMExports();`);
      launch.push("--import", preload);
    }
    child = spawn(process.execPath, [...launch, cli, "run", "--review", `--diagnostics-file=${destination}`, "--", process.execPath,
      "-e", 'require("node:fs").writeFileSync("file","PRIVATE_COMMAND_CONTENT")', "PRIVATE_ARG"],
    { cwd: source, env: { ...process.env, TMPDIR: scratch, PRIVATE_ENV: "PRIVATE_ENV_VALUE" }, stdio: ["pipe", "ignore", "pipe"] });
    let output = "";
    child.stderr!.on("data", bytes => { output += bytes.toString(); if (output.includes("Twin review:")) child!.stdin!.end("apply\n"); });
    const completion = new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject); child!.once("close", code => { closed = true; resolve(code); });
      timer = setTimeout(() => { child!.kill("SIGKILL"); }, 15000);
    });
    const code = await completion; clearTimeout(timer); timer = undefined;
    expect(code, output).toBe(0); expect(output).toContain("Twin apply applied");
    const marker = output.indexOf("\x1eTWIN-RECEIPT/1 "); expect(marker).toBeGreaterThanOrEqual(0);
    const start = output.indexOf("\n", marker) + 1;
    const length = Number(output.slice(marker, start).match(/TWIN-RECEIPT\/1 ([0-9]+)/)?.[1]);
    const payload = Buffer.from(output.slice(start));
    expect(JSON.parse(payload.subarray(0, length).toString()).schemaVersion).toBe(5);
    expect(payload[length]).toBe(10);
    expect(await readFile(join(source, "file"), "utf8")).toBe("PRIVATE_COMMAND_CONTENT");
    expect(await readdir(scratch)).toEqual([]);
    if (selected === "valid" || selected === "slow-writer") {
      const text = await readFile(trace, "utf8"); const records = text.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
      expect(text).not.toMatch(/PRIVATE_|twin-cli-diagnostics-test-|workspace|node:fs/);
      expect((await lstat(trace)).mode & 0o777).toBe(0o600);
      if (selected === "valid") expect(records.some(record => record.kind === "inventory" && record.stage === "preparation.original")).toBe(true);
      if (selected === "valid") expect(records.some(record => record.kind === "inventory" && record.stage === "apply.final-copy")).toBe(true);
      if (selected === "valid") expect(records.some(record => record.kind === "drained")).toBe(true);
      expect(records.at(-1)).toMatchObject({ kind: "summary" });
      if (selected === "slow-writer") expect(records.at(-1)).toMatchObject({ truncated: true, omitted: expect.any(Number) });
      expect((records.at(-1)?.snapshots as unknown[])).toHaveLength(5);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(262144);
      expect(records.every(record => Buffer.byteLength(JSON.stringify(record)) <= 4096)).toBe(true);
    } else {
      expect(output.lastIndexOf("Twin stage diagnostics unavailable or incomplete")).toBeGreaterThan(start + length);
      if (selected === "existing") expect(await readFile(trace, "utf8")).toBe("existing trace stays");
      if (selected === "symlink") expect(await readFile(join(base, "target"), "utf8")).toBe("target stays");
      if (selected === "in-source") expect(await readdir(source)).toEqual(["file"]);
    }
  } catch (error) { failed = error; }
  finally { if (timer) clearTimeout(timer); }
  if (!closed) throw new Error(`Diagnostic CLI settlement unconfirmed; retained ${base}`, { cause: failed });
  if (!failed) {
    const after = await lstat(base, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || identity.ino !== after.ino || identity.dev !== after.dev || (await readdir(scratch)).length) {
      throw new Error(`Fixture cleanup admission refused; retained ${base}`);
    }
    await rm(base, { recursive: true });
  }
  if (failed) throw failed;
}, 25000);
