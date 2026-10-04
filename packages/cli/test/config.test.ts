import { link, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initConfig, loadConfig, parseConfig } from "../src/config.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open), link: vi.fn(original.link) };
});

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "twin-config-test-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("project config", () => {
  it.each(["codex", "claude"])("asks the mode and keeps %s interactive argv separate from one-shot argv", async agent => {
    for (const mode of ["interactive", "one-shot"]) {
      const path = await root();
      const task = "  λ 'quoted' $(never-run)  ";
      const answers = [agent, mode, ...(mode === "one-shot" ? [task] : []), '["--skip-git-repo-check", "two words", "", "--", "-i"]', "yes", "text"];
      const ask = vi.fn(async () => answers.shift()!);
      const config = await initConfig(path, ask);
      expect(ask.mock.calls.length).toBe(mode === "one-shot" ? 6 : 5);
      expect(ask).toHaveBeenCalledWith(expect.stringContaining("interactive chat or one-shot execution"));
      expect(config).toEqual({ command: [agent, ...(mode === "one-shot" ? [agent === "codex" ? "exec" : "-p", task] : []),
        "--skip-git-repo-check", "two words", "", "--", "-i"], interactive: mode === "interactive", review: true, receipt: "text" });
      expect(await loadConfig(path)).toEqual(config);
      expect(JSON.parse(await readFile(join(path, "twin.config.json"), "utf8"))).toEqual(config);
      if (mode === "one-shot") expect(ask).toHaveBeenCalledWith(expect.stringContaining("saved task repeats"));
    }
  });

  it("refuses overwrite before asking, including malformed existing config", async () => {
    const path = await root();
    await writeFile(join(path, "twin.config.json"), "broken");
    const ask = vi.fn();
    await expect(initConfig(path, ask)).rejects.toThrow("Refusing to overwrite");
    expect(ask).not.toHaveBeenCalled();
    expect(await readFile(join(path, "twin.config.json"), "utf8")).toBe("broken");
  });

  it("uses exclusive creation if a config appears during prompts", async () => {
    const path = await root();
    const answers = ["codex", "interactive", "[]", "no", "json"];
    const ask = async (): Promise<string> => {
      if (answers.length === 1) await writeFile(join(path, "twin.config.json"), "other");
      return answers.shift()!;
    };
    await expect(initConfig(path, ask)).rejects.toThrow("Refusing to overwrite");
    expect(await readFile(join(path, "twin.config.json"), "utf8")).toBe("other");
  });

  it.each(["write", "close", "link", "interrupt"] as const)("does not publish partial config on %s failure", async failure => {
    const path = await root();
    const controller = new AbortController();
    const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    if (failure === "link") vi.mocked(link).mockRejectedValueOnce(new Error("publication failed"));
    else vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await realFs.open(...args);
      if (failure === "close") vi.spyOn(handle, "close").mockRejectedValueOnce(new Error("close failed"));
      else vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
        await realFs.writeFile(handle, "partial bytes", "utf8");
        if (failure === "interrupt") controller.abort();
        else throw new Error("write interrupted");
      });
      return handle;
    });
    const answers = ["codex", "interactive", "[]", "no", "json"];
    await expect(initConfig(path, async () => answers.shift()!, controller.signal)).rejects.toThrow();
    expect(await readdir(path)).toEqual([]);
    expect(await loadConfig(path)).toBeUndefined();
  });

  it("closes complete private bytes before exclusive publication", async () => {
    const path = await root();
    const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let closed = false;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      expect(args[1]).toBe("wx");
      expect(args[2]).toBe(0o600);
      const handle = await realFs.open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed = true; });
      return handle;
    });
    vi.mocked(link).mockImplementationOnce(async (temporary, destination) => {
      expect(closed).toBe(true);
      expect(JSON.parse(await readFile(temporary, "utf8"))).toEqual({ command: ["codex"], interactive: true, review: false, receipt: "json" });
      await realFs.link(temporary, destination);
    });
    const answers = ["codex", "interactive", "[]", "no", "json"];
    await initConfig(path, async () => answers.shift()!);
    expect(await readdir(path)).toEqual(["twin.config.json"]);
  });

  it("loads absence and rejects malformed JSON", async () => {
    const path = await root();
    expect(await loadConfig(path)).toBeUndefined();
    await writeFile(join(path, "twin.config.json"), "{");
    await expect(loadConfig(path)).rejects.toThrow("malformed JSON");
  });

  it.each([null, [], {}, { command: [] }, { command: [""] }, { command: ["node", 1] },
    { command: ["node", "\0"] }, { command: ["node"], interactive: "true" }, { command: ["node"], review: 1 },
    { command: ["node"], receipt: "html" }, { command: ["node"], unknown: true },
    ...[0, -1, 3600001, 1.5, "100", null].map(timeoutMs => ({ command: ["node"], timeoutMs }))])("rejects invalid config %j", value => {
    expect(() => parseConfig(value)).toThrow("Invalid twin.config.json");
  });

  it.each([1, 60000, 3600000])("accepts timeoutMs %s", timeoutMs => {
    expect(parseConfig({ command: ["node"], timeoutMs }).timeoutMs).toBe(timeoutMs);
  });

  it.each([1, 30000, 3600000])("accepts independent scanTimeoutMs %s", scanTimeoutMs => {
    expect(parseConfig({ command: ["node"], timeoutMs: 7, scanTimeoutMs })).toEqual({ command: ["node"], timeoutMs: 7, scanTimeoutMs });
  });

  it.each([0, -1, 3600001, 1.5, Infinity, NaN, "100", null, true])("rejects invalid scanTimeoutMs %s", scanTimeoutMs => {
    expect(() => parseConfig({ command: ["node"], scanTimeoutMs })).toThrow("Invalid twin.config.json");
  });
});


it.each(["codex", "claude"])("menu values preserve %s argv, and receipt defaults to Text", async agent => {
  for (const mode of ["interactive", "one-shot"]) {
    const path = await root();
    const task = "  λ 'quoted' $(never-run)  ";
    const answers = [...(mode === "one-shot" ? [task] : []), '["two words", "\\\"quoted\\\"", ""]'];
    const menus = [agent, mode, "yes", "text"];
    const choose = vi.fn(async () => menus.shift()!);
    const config = await initConfig(path, async () => answers.shift()!, undefined, choose);
    expect(choose.mock.calls).toHaveLength(4);
    expect(choose).toHaveBeenLastCalledWith(expect.objectContaining({ default: "text", choices: expect.arrayContaining([
      { name: "Text — readable receipt", value: "text" }, { name: "JSON — automation output", value: "json" },
    ]) }));
    expect(config.command).toEqual([agent, ...(mode === "one-shot" ? [agent === "codex" ? "exec" : "-p", task] : []), "two words", '"quoted"', ""]);
    expect(config.receipt).toBe("text");
  }
});

it.each([0, 1, 2, 3])("menu cancellation at selection %s publishes nothing", async at => {
  const path = await root();
  let index = 0;
  const values = ["codex", "interactive", "yes", "text"];
  await expect(initConfig(path, async () => "[]", undefined,
    async () => index++ === at ? null : values[index - 1]!)).rejects.toThrow("cancelled");
  expect(await readdir(path)).toEqual([]);
});

it("uses Text for an empty typed receipt preference and refuses overwrite before menus", async () => {
  const path = await root();
  const answers = ["claude", "interactive", "[]", "no", ""];
  expect((await initConfig(path, async () => answers.shift()!)).receipt).toBe("text");
  const choose = vi.fn();
  await expect(initConfig(path, vi.fn(), undefined, choose)).rejects.toThrow("Refusing to overwrite");
  expect(choose).not.toHaveBeenCalled();
});
