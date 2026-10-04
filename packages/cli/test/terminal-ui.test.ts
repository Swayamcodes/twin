import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askTerminal, chooseTerminal, preparation, renderLogo, terminalColors, terminalOutput } from "../src/terminal-ui.js";

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(raw: boolean): this { this.isRaw = raw; return this; }
}
class Output extends PassThrough {
  isTTY = true;
  columns = 80;
  rows = 24;
  chunks: string[] = [];
  constructor() { super(); this.on("data", (chunk: Buffer) => this.chunks.push(chunk.toString())); }
  get text(): string { return this.chunks.join(""); }
}
const menu = { message: "Copy review", choices: [
  { name: "Apply changes", value: "apply" }, { name: "Discard copy", value: "discard" },
  { name: "Cancel and retain copy", value: "cancel" },
], default: "cancel" };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("terminal presentation", () => {
  it("gates output and colors without forcing color on redirected streams", () => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("NO_COLOR", undefined);
    expect(terminalOutput({ isTTY: false })).toBe(false);
    expect(terminalColors({ isTTY: false })).toBe(false);
    expect(terminalColors({ isTTY: true })).toBe(true);
    vi.stubEnv("NO_COLOR", "");
    expect(terminalColors({ isTTY: true })).toBe(false);
    vi.stubEnv("TERM", "dumb");
    expect(terminalOutput({ isTTY: true })).toBe(false);
  });

  it("keeps the approved square raster and reflected tight shadow static", () => {
    const text = renderLogo(80);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("████████▄██▄   ██▄████████▄██▄   ██▄   ▄░░   ▄░░▄░░░░░░░░▄░░   ▄░░▄░░░░░░░░");
    expect(renderLogo(80, true)).toContain("\x1b[38;2;182;140;255m");
    expect(renderLogo(80, true)).toContain("\x1b[38;2;68;44;84m");
    for (const columns of [50, 60, 80, 112, 120]) {
      for (const line of renderLogo(columns).split("\n")) expect([...line].length).toBeLessThanOrEqual(columns);
    }
    expect(renderLogo(30)).toBe("twin\n");
    expect(text).not.toContain("\x1b");
  });

  it("has stationary coarse preparation feedback, no input/timer ownership, and silence in JSON", () => {
    vi.useFakeTimers();
    const out = new Output();
    const inputListeners = process.stdin.listenerCount("data");
    const display = preparation("text", out as unknown as NodeJS.WriteStream);
    expect(out.text).toContain("Preparing project copy…");
    expect(out.text).not.toMatch(/%|stage|scanning|copying/i);
    display.stop(); display.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(process.stdin.listenerCount("data")).toBe(inputListeners);
    const json = new Output();
    preparation("json", json as unknown as NodeJS.WriteStream).stop();
    expect(json.text).toBe("");
    const pipe = new Output(); pipe.isTTY = false;
    preparation("text", pipe as unknown as NodeJS.WriteStream).stop();
    expect(pipe.text).toBe("");
  });

  it.each(["enter", "apply", "discard", "escape", "ctrl-c", "ctrl-d", "eof", "abort"] as const)(
    "settles %s and releases raw input and prompt listeners", async action => {
      const input = new Input(), output = new Output(), signal = new AbortController();
      const result = chooseTerminal(menu, signal.signal, input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
      await vi.waitFor(() => expect(output.text).toContain("Cancel and retain copy"));
      expect(input.isRaw).toBe(true);
      if (action === "apply") input.write("\x1b[A\x1b[A\r");
      else if (action === "discard") input.write("\x1b[A\r");
      else if (action === "enter") input.write("\r");
      else if (action === "escape") input.write("\x1b");
      else if (action === "ctrl-c") input.write("\x03");
      else if (action === "ctrl-d") input.write("\x04");
      else if (action === "eof") input.end();
      else signal.abort();
      expect(await result).toBe(action === "apply" ? "apply" : action === "discard" ? "discard" : action === "enter" ? "cancel" : null);
      expect(input.isRaw).toBe(false);
      expect(input.listenerCount("keypress")).toBe(0);
      expect(input.listenerCount("end")).toBe(0);
      // Node keeps a shared idle key decoder; no prompt keypress consumer
      // remains and the stream is paused before handoff.
      expect(input.isPaused()).toBe(true);
      expect(input.listenerCount("data")).toBeLessThanOrEqual(1);
      expect(output.text).toContain("\x1b[?25h");
      input.destroy(); output.destroy();
    });

  it("restores a previously raw input and shows a visible marker without color", async () => {
    vi.stubEnv("NO_COLOR", "1");
    const input = new Input(), output = new Output(); input.isRaw = true;
    const result = chooseTerminal(menu, new AbortController().signal, input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
    await vi.waitFor(() => expect(output.text).toContain("> Cancel and retain copy"));
    input.write("\r");
    expect(await result).toBe("cancel");
    expect(input.isRaw).toBe(true);
    expect(output.text).not.toMatch(/\x1b\[[0-9;]*m/);
    input.destroy(); output.destroy();
  });

  it.each(["answer", "ctrl-c", "eof", "abort"] as const)("typed task %s restores terminal ownership", async action => {
    const input = new Input(), output = new Output(), signal = new AbortController();
    vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
    vi.spyOn(process, "stderr", "get").mockReturnValue(output as unknown as typeof process.stderr);
    const result = askTerminal("Task: ", signal.signal);
    const settled = action === "answer" ? expect(result).resolves.toBe("  task 'quoted'  ") : expect(result).rejects.toThrow("cancelled");
    if (action === "answer") input.write("  task 'quoted'  \r");
    else if (action === "ctrl-c") input.write("\x03");
    else if (action === "eof") input.end();
    else signal.abort();
    await settled;
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("keypress")).toBe(0);
    input.destroy(); output.destroy();
  });
});
