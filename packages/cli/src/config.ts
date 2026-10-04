import { randomUUID } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { validScanTimeoutMs } from "@twin-cli/core";

export interface TwinConfig {
  command: string[];
  interactive?: boolean;
  review?: boolean;
  receipt?: "json" | "text";
  timeoutMs?: number;
  scanTimeoutMs?: number;
}

export function validTimeout(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 3600000;
}

export function parseConfig(value: unknown): TwinConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid twin.config.json: expected an object.");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => !["command", "interactive", "review", "receipt", "timeoutMs", "scanTimeoutMs"].includes(key))
      || !Array.isArray(config.command) || config.command.length === 0
      || config.command.some(arg => typeof arg !== "string" || arg.includes("\0")) || !config.command[0]
      || (config.interactive !== undefined && typeof config.interactive !== "boolean")
      || (config.review !== undefined && typeof config.review !== "boolean")
      || (config.receipt !== undefined && config.receipt !== "json" && config.receipt !== "text")
      || (config.timeoutMs !== undefined && (typeof config.timeoutMs !== "number" || !validTimeout(config.timeoutMs)))
      || (config.scanTimeoutMs !== undefined && (typeof config.scanTimeoutMs !== "number" || !validScanTimeoutMs(config.scanTimeoutMs)))) {
    throw new Error("Invalid twin.config.json: expected command argv, boolean interactive/review, receipt json/text, and optional timeoutMs/scanTimeoutMs (1–3600000).");
  }
  return config as unknown as TwinConfig;
}

export async function loadConfig(root: string): Promise<TwinConfig | undefined> {
  let contents: string;
  try { contents = await readFile(join(root, "twin.config.json"), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("Cannot read twin.config.json.");
  }
  let value: unknown;
  try { value = JSON.parse(contents) as unknown; }
  catch { throw new Error("Invalid twin.config.json: malformed JSON."); }
  return parseConfig(value);
}

export type Ask = (prompt: string) => Promise<string>;
export type Choose = (menu: { message: string; choices: readonly { name: string; value: string }[]; default: string }) => Promise<string | null>;

export async function initConfig(root: string, ask: Ask, signal?: AbortSignal, choose?: Choose): Promise<TwinConfig> {
  const checkInterrupted = (): void => {
    if (signal?.aborted) throw new Error("Twin init cancelled: interrupted; no config published.");
  };
  checkInterrupted();
  // Check before prompting as well as using exclusive creation against races.
  try {
    await readFile(join(root, "twin.config.json"));
    throw new Error("Refusing to overwrite existing twin.config.json.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const choice = async (prompt: string, message: string, values: readonly [string, string][], initial: string): Promise<string> => {
    if (!choose) return (await ask(prompt)).trim();
    const selected = await choose({ message, choices: [...values.map(([name, value]) => ({ name, value })),
      { name: "Cancel setup", value: "cancel" }], default: initial });
    if (selected === null || selected === "cancel") throw new Error("Twin init cancelled; no config published.");
    checkInterrupted();
    return selected;
  };
  const agent = await choice("Agent (codex/claude): ", "Agent", [["Codex", "codex"], ["Claude", "claude"]], "codex");
  if (agent !== "codex" && agent !== "claude") throw new Error("Choose codex or claude.");
  const mode = await choice("Mode: interactive chat or one-shot execution? (interactive/one-shot): ", "Execution mode",
    [["Interactive chat", "interactive"], ["One-shot execution", "one-shot"]], "interactive");
  if (mode !== "interactive" && mode !== "one-shot") throw new Error("Choose interactive or one-shot.");
  const command = [agent];
  if (mode === "one-shot") {
    command.push(agent === "codex" ? "exec" : "-p");
    const task = await ask("One-shot task text (one line, preserved as one argument; saved task repeats unless explicitly overridden): ");
    if (!task.trim()) throw new Error("One-shot task text must not be empty or whitespace-only.");
    command.push(task);
  }
  const extra: unknown = JSON.parse(await ask('Additional arguments as a JSON string array (e.g. ["--skip-git-repo-check"] for Codex; [] for none): ')) as unknown;
  if (!Array.isArray(extra) || extra.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Additional arguments must be a JSON string array.");
  command.push(...extra as string[]);
  const review = await choice("Review changes after execution? (yes/no): ", "Review preference",
    [["Review changes", "yes"], ["Auto-discard after settlement", "no"]], "yes");
  if (review !== "yes" && review !== "no") throw new Error("Choose yes or no for review.");
  const receipt = await choice("Receipt format (text/json; default text): ", "Receipt preference",
    [["Text — readable receipt", "text"], ["JSON — automation output", "json"]], "text") || "text";
  if (receipt !== "json" && receipt !== "text") throw new Error("Choose json or text for receipts.");
  const config = parseConfig({ command, interactive: mode === "interactive", review: review === "yes", receipt });
  checkInterrupted();
  const temporary = join(root, `.twin-config-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.close();
    checkInterrupted();
    // Like HTML export: publish complete bytes via an exclusive sibling hard link.
    // A signal during link can leave a complete config, never a partial destination.
    await link(temporary, join(root, "twin.config.json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Refusing to overwrite existing twin.config.json.");
    throw error;
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary);
  }
  return config;
}
