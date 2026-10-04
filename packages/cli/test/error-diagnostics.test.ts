import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { preparationErrorDiagnostic } from "../src/error-diagnostics.js";

describe("bounded local preparation diagnostics", () => {
  it("exposes native filesystem fields and preserves the cleanup wrapper", async () => {
    let cause: unknown;
    try { await readFile("/dev/null/twin-nonexistent-child"); } catch (error) { cause = error; }
    const output = preparationErrorDiagnostic(new Error('Twin copy failed; cleanup={"status":"removed"}; allocation=/tmp/owned', { cause }));
    expect(output).toContain('cleanup={"status":"removed"}');
    expect(output).toContain("allocation=/tmp/owned");
    expect(output).toContain("cause[1].code=ENOTDIR");
    expect(output).toMatch(/cause\[1\].errno=-\d+/);
    expect(output).toContain("cause[1].syscall=open");
    expect(output).toContain("cause[1].path=/dev/null/twin-nonexistent-child");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(512);
  });

  it("does not invent code or path for policy errors", () => {
    const output = preparationErrorDiagnostic(new Error("copy failed", { cause: new Error("Unsupported symlink: path") }));
    expect(output).toContain("cause[1].message=Unsupported symlink: path");
    expect(output).not.toContain("code=");
    expect(output).not.toContain("path=");
    expect(output).not.toContain("stack");
  });

  it.each(["copy", "allocation"])("prioritizes cleanup status and allocation beyond a long %s wrapper reason", kind => {
    const cause = { code: "EIO", errno: -5, syscall: "write", path: "/operation/path" };
    const message = `Twin ${kind} failed; cleanup={"status":"failed","reason":"` + "long".repeat(1000)
      + '"}; allocation=/tmp/still-owned';
    const output = preparationErrorDiagnostic(new Error(message, { cause }));
    expect(output).toContain(`Twin ${kind} failed`);
    expect(output).toContain("cleanup.status=failed");
    expect(output).toContain("allocation=/tmp/still-owned");
    expect(output).toContain("cause[1].path=/operation/path");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(512);
  });

  it.each(["copy", "allocation"])("explicitly marks absent allocation evidence in a truncated %s wrapper", kind => {
    const output = preparationErrorDiagnostic(new Error(`Twin ${kind} failed; cleanup={"status":"failed","reason":"` + "x".repeat(1000)));
    expect(output).toContain("[allocation omitted]");
  });

  it.each(["copy", "allocation"])("bounds tail inspection and sanitizes untrusted %s wrapper evidence", kind => {
    const prefix = `Twin ${kind} failed; cleanup={"status":"failed","reason":"` + "x".repeat(10000) + '"}; allocation=';
    const long = preparationErrorDiagnostic(new Error(prefix + "a".repeat(1000)));
    expect(long).toContain("[allocation omitted]");
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(512);
    const controls = preparationErrorDiagnostic(new Error(prefix + "/tmp/\u001b\n\u202e"));
    expect(controls).toContain("allocation=/tmp/\\u001b\\u000a\\u202e");
    expect(controls).not.toContain("\u001b");
    const fake = preparationErrorDiagnostic({ message: "fake " + prefix + "/private" });
    expect(fake).not.toContain("allocation=/private");
    expect(fake).not.toContain("cleanup.status=");
  });

  it("detects cycles and caps traversal at four nodes", () => {
    const cycle: { message: string; cause?: unknown } = { message: "cycle" };
    cycle.cause = cycle;
    expect(preparationErrorDiagnostic(cycle)).toContain("cause cycle");
    let error: unknown = new Error("hidden fifth");
    for (let count = 0; count < 4; count++) error = new Error(`wrapper ${count}`, { cause: error });
    const output = preparationErrorDiagnostic(error);
    expect(output).toContain("cause depth limit");
    expect(output).not.toContain("hidden fifth");
  });

  it("never invokes accessors, coercion, custom inspection, or unrelated keys", () => {
    const hostile = Object.defineProperties({}, {
      message: { get: () => { throw new Error("getter invoked"); } },
      path: { value: { toString: () => { throw new Error("coercion invoked"); } } },
      errno: { value: Infinity },
      unrelated: { get: () => { throw new Error("unrelated getter invoked"); } },
      cause: { value: Symbol("undisclosed symbol") },
      [Symbol.for("nodejs.util.inspect.custom")]: { value: () => { throw new Error("inspection invoked"); } },
    });
    const output = preparationErrorDiagnostic(hostile);
    expect(output).toContain("message accessor omitted");
    expect(output).toContain("path unsupported");
    expect(output).toContain("errno unsupported");
    expect(output).toContain("unsupported value");
    expect(output).not.toContain("undisclosed symbol");
    expect(output).not.toContain("unrelated");
  });

  it("catches throwing and revoked descriptor proxies", () => {
    const hostile = new Proxy({}, { getOwnPropertyDescriptor: () => { throw "secret"; } });
    expect(preparationErrorDiagnostic(hostile)).toContain("message inaccessible");
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(preparationErrorDiagnostic(revoked.proxy)).toContain("cause inaccessible");
  });

  it.each([null, undefined, 1, true, Symbol("private")])("does not coerce unsupported primitive %s", value => {
    expect(preparationErrorDiagnostic(value)).toBe("[unsupported value]\n");
  });

  it("escapes controls, bidi, separators and lone surrogates", () => {
    const output = preparationErrorDiagnostic("\u001b\n\r\u0085\u202e\u2066\u200e\u2028\ufeff\ud800");
    expect(output).toBe("\\u001b\\u000a\\u000d\\u0085\\u202e\\u2066\\u200e\\u2028\\ufeff\\ud800\n");
  });

  it("includes truncation markers within field and total UTF-8 budgets", () => {
    const output = preparationErrorDiagnostic({ message: "λ".repeat(1000), code: "界".repeat(1000),
      syscall: "s".repeat(1000), path: "😀".repeat(1000), dest: "d".repeat(1000),
      cause: { message: "hidden".repeat(1000), code: "EIO", errno: -5, syscall: "write", path: "/important" } });
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(512);
    expect(output).toContain("[details omitted]");
    expect(output).toContain("cause[1].code=EIO");
    expect(output).toContain("cause[1].path=/important");
    expect(output).not.toContain("�");
    const wrapper = output.split("; ")[0]!;
    expect(Buffer.byteLength(wrapper)).toBeLessThanOrEqual(128);
    expect(wrapper).toContain("…[truncated]");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("caps code/syscall values including their markers", () => {
    for (const key of ["code", "syscall"] as const) {
      const output = preparationErrorDiagnostic({ [key]: "x".repeat(1000) });
      const value = output.slice(key.length + 1, -1);
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(32);
      expect(value).toContain("…[truncated]");
    }
  });
});
