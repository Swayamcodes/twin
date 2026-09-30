import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureTest, nodeOptions } from "./support.js";
import { buildCommandReceipt } from "../src/receipt.js";

describe("top-level command receipt", () => {
  it("reports a confirmed successful launch without publishing arguments or environment", async () => fixtureTest(async f => {
    const session = await f.create();
    const secret = "credential-and-private-source-text";
    const options = { executable: process.execPath, argv: ["-e", `process.stdout.write(${JSON.stringify(secret)})`],
      env: { API_TOKEN: secret } };
    const result = await session.run(options);
    expect(result.exitCode).toBe(0);
    expect(session.inspect().receipt?.command).toEqual({
      coverage: "top-level-only", nestedCommands: "not-observed", admitted: true,
      processStart: "confirmed", executable: { status: "allowlisted-basename", value: "node" },
      arguments: { status: "omitted", count: 2, capped: false }, disposition: "exited",
      timeoutObserved: false, directChildSettled: true, exitCode: 0, signal: null,
    });
    expect(JSON.stringify(session.inspect().receipt)).not.toContain(secret);
  }));

  it("reports nonzero exit, signal, timeout, and spawn failure separately", async () => {
    for (const behavior of ["exit", "signal", "wait", "missing"] as const) await fixtureTest(async f => {
      const session = await f.create();
      const options = behavior === "missing"
        ? { executable: join(f.path, "missing-executable"), argv: [], env: {} }
        : behavior === "wait" ? { ...nodeOptions("wait"), timeoutMs: 150 } : nodeOptions(behavior);
      await session.run(options);
      const report = session.inspect().receipt!.command;
      expect(report.admitted).toBe(true);
      expect(report.nestedCommands).toBe("not-observed");
      if (behavior === "exit") expect(report).toMatchObject({ processStart: "confirmed", disposition: "exited", exitCode: 7 });
      if (behavior === "signal") expect(report).toMatchObject({ processStart: "confirmed", disposition: "signaled", signal: "SIGTERM" });
      if (behavior === "wait") expect(report).toMatchObject({ processStart: "confirmed", disposition: "timed-out", timeoutObserved: true });
      if (behavior === "missing") expect(report).toMatchObject({ processStart: "not-confirmed", disposition: "spawn-failed",
        directChildSettled: true, executable: { status: "omitted" } });
    });
  });

  it("keeps a pre-launch interruption out of the attempted-command receipt", async () => fixtureTest(async f => {
    const session = await f.create();
    const abort = new AbortController();
    abort.abort("SIGTERM");
    await expect(session.run({ ...nodeOptions("echo"), interruptSignal: abort.signal })).rejects.toThrow("Interrupted before command launch");
    expect(session.inspect()).toMatchObject({ state: "ready" });
    expect(session.inspect().receipt).toBeUndefined();
  }));

  it("does not claim to trace a nested command", async () => fixtureTest(async f => {
    const session = await f.create();
    const nested = 'require("node:fs").writeFileSync("nested","done")';
    const script = `require("node:child_process").execFileSync(process.execPath,["-e",${JSON.stringify(nested)}]);`;
    const result = await session.run({ executable: process.execPath, argv: ["-e", script], env: {} });
    expect(result.exitCode).toBe(0);
    expect(session.inspect().receipt?.files.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: { encoding: "utf8", value: "nested" }, change: "added" }),
    ]));
    expect(session.inspect().receipt?.command).toMatchObject({ coverage: "top-level-only", nestedCommands: "not-observed",
      executable: { status: "allowlisted-basename", value: "node" }, arguments: { count: 2 } });
  }));

  it("bounds argument metadata and omits unrecognized executable basenames", () => {
    const report = buildCommandReceipt({ executable: "/private/credential-in-executable", argv: Array(300).fill("secret"),
      env: { PASSWORD: "secret" } }, undefined);
    expect(report).toMatchObject({ admitted: true, processStart: "unknown", disposition: "settlement-uncertain",
      executable: { status: "omitted" }, arguments: { status: "omitted", count: 256, capped: true },
      timeoutObserved: null, directChildSettled: null });
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(JSON.stringify(report)).not.toContain("credential");
  });
});
