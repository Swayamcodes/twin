import select from "@inquirer/select";
import { createInterface } from "node:readline";

export type Tone = "orchid" | "plum" | "white" | "muted" | "green" | "amber" | "red" | "cyan";
type RGB = readonly [number, number, number];
const palette: Record<Tone, RGB> = {
  orchid: [182, 140, 255], plum: [112, 77, 145], white: [239, 235, 245], muted: [173, 168, 184],
  green: [116, 205, 151], amber: [233, 187, 104], red: [235, 128, 139], cyan: [118, 201, 220],
};
export function terminalOutput(output: Pick<NodeJS.WriteStream, "isTTY"> = process.stderr): boolean {
  return output.isTTY === true && process.env.TERM !== "dumb";
}
export function terminalPrompts(): boolean {
  return process.stdin.isTTY === true && terminalOutput();
}
export function terminalColors(output: Pick<NodeJS.WriteStream, "isTTY"> = process.stderr): boolean {
  return terminalOutput(output) && !Object.hasOwn(process.env, "NO_COLOR");
}
export function color(enabled: boolean, tone: Tone, text: string): string {
  return enabled ? `\x1b[38;2;${palette[tone].join(";")}m${text}\x1b[0m` : text;
}
function mix(from: RGB, to: RGB, amount: number): RGB {
  const channel = (i: 0 | 1 | 2): number => Math.round(from[i] + (to[i] - from[i]) * amount);
  return [channel(0), channel(1), channel(2)];
}
interface Pixel { kind: "main" | "shadow" | "reflection"; color: RGB }
type Point = readonly [number, number];

// Port of the approved saved preview: one column / half-row approximates a
// physical square. Reflection reverses the complete foreground-and-shadow mask.
export function renderLogo(columns = 80, colors = false): string {
  if (columns < 50) return `${color(colors, "orchid", "twin")}\n`;
  const compact = 113 > columns;
  const gap = compact ? 1 : 2;
  const availableWidth = Math.max(4, Math.floor((columns - 5 - gap * 6) / 8));
  const letterWidth = compact ? Math.min(8, availableWidth) : 12;
  const height = letterWidth;
  const stroke = Math.max(2, Math.round(height / 4));
  const width = letterWidth * 4 + gap * 3;
  const mask = Array.from({ length: height }, () => Array<boolean>(width).fill(false));
  const segmentDistance = (x: number, y: number, a: Point, b: Point): number => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  };
  for (let letter = 0; letter < 4; letter++) {
    const w = letterWidth, inset = stroke / 2;
    const diagonal: readonly [Point, Point] = [[inset, inset], [w - inset, height - inset]];
    const wPath: readonly Point[] = [[inset, inset], [inset + 0.5, height - inset],
      [w / 2, height * 0.53], [w - inset - 0.5, height - inset], [w - inset, inset]];
    for (let y = 0; y < height; y++) for (let x = 0; x < w; x++) {
      const stem = x >= Math.floor((w - stroke) / 2) && x < Math.floor((w - stroke) / 2) + stroke;
      const filled = letter === 0 ? y < stroke || stem
        : letter === 1 ? wPath.slice(1).some((point, i) => segmentDistance(x + 0.5, y + 0.5, wPath[i]!, point) <= stroke / 2)
        : letter === 2 ? y < stroke || y >= height - stroke || stem
        : x < stroke || x >= w - stroke || segmentDistance(x + 0.5, y + 0.5, ...diagonal) <= stroke / 2;
      mask[y]![letter * (w + gap) + x] = filled;
    }
  }
  const pixel = (x: number, y: number): boolean => y >= 0 && y < height && x >= 0 && x < width && mask[y]![x]!;
  const mainPixel = (x: number, y: number): Pixel | null => pixel(x, y)
    ? { kind: "main", color: mix([182, 140, 255], [108, 68, 137], x / Math.max(1, width - 1)) }
    : pixel(x - 1, y - 1) ? { kind: "shadow", color: [68, 44, 84] } : null;
  const reflectionPixel = (x: number, y: number): Pixel | null => {
    const original = mainPixel(width - x, y);
    if (!original) return null;
    const faint = mix([57, 38, 71], [22, 19, 29], x / Math.max(1, width));
    return { kind: "reflection", color: original.kind === "shadow" ? mix(faint, [22, 19, 29], 0.55) : faint };
  };
  const rgb = (value: RGB, text: string): string => colors ? `\x1b[38;2;${value.join(";")}m${text}\x1b[0m` : text;
  const cell = (top: Pixel | null, bottom: Pixel | null): string => {
    if (!top && !bottom) return " ";
    if (!colors) {
      if (top && bottom) return top.kind === "main" || bottom.kind === "main" ? "█" : "░";
      return top ? "▀" : "▄";
    }
    if (!bottom) return rgb(top!.color, "▀");
    if (!top) return rgb(bottom.color, "▄");
    if (top.color.every((value, i) => value === bottom.color[i])) return rgb(top.color, "█");
    return `\x1b[38;2;${top.color.join(";")};48;2;${bottom.color.join(";")}m▀\x1b[0m`;
  };
  return Array.from({ length: Math.ceil((height + 1) / 2) }, (_, row) => {
    const y = row * 2;
    const main = Array.from({ length: width + 1 }, (_, x) => cell(mainPixel(x, y), mainPixel(x, y + 1))).join("");
    const reflection = Array.from({ length: width + 1 }, (_, x) => cell(reflectionPixel(x, y), reflectionPixel(x, y + 1))).join("");
    return `${main}   ${reflection}`;
  }).join("\n") + "\n";
}

export interface Menu {
  message: string;
  choices: readonly { name: string; value: string }[];
  default: string;
}
// Awaiting the dependency's promise includes its raw-mode, screen and hook
// cleanup. Our cancellation listeners are also removed before returning.
export async function chooseTerminal(menu: Menu, signal: AbortSignal,
  input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string | null> {
  const local = new AbortController();
  const abort = (): void => local.abort();
  const cancelKey = (bytes: Buffer): void => {
    const key = bytes.toString();
    if (key === "\x1b" || key === "\x04") abort();
  };
  const previousRaw = input.isRaw === true;
  input.on("data", cancelKey);
  input.once("end", abort);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const paint = (tone: Tone) => (text: string): string => color(terminalColors(output), tone, text);
  try {
    return await select({ message: menu.message, choices: menu.choices.map(choice => ({
      name: paint("muted")(choice.name), short: choice.name, value: choice.value,
    })), default: menu.default, loop: false, pageSize: menu.choices.length,
    theme: { prefix: { idle: "", done: paint("orchid")("›") }, icon: { cursor: ">" },
      style: { message: paint("white"), answer: paint("white"),
        highlight: (text: string) => paint("orchid")(text.replace(/\x1b\[[0-9;]*m/g, "")),
        help: paint("muted"), error: paint("red"), description: paint("muted"),
        keysHelpTip: () => paint("muted")("↑/↓ choose · Enter select · Esc cancel") } },
    }, { input, output, signal: local.signal });
  } catch (error) {
    if (local.signal.aborted || error instanceof Error && ["ExitPromptError", "AbortPromptError", "CancelPromptError"].includes(error.name)) return null;
    throw error;
  } finally {
    input.off("data", cancelKey);
    input.off("end", abort);
    signal.removeEventListener("abort", abort);
    input.setRawMode(previousRaw);
    input.pause();
  }
}

export async function askTerminal(prompt: string, signal: AbortSignal): Promise<string> {
  const previousRaw = process.stdin.isRaw === true;
  const lines = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: string): void => {
      if (settled) return;
      settled = true;
      lines.off("close", end);
      signal.removeEventListener("abort", end);
      lines.close();
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      if (value === undefined) reject(new Error("Twin init cancelled: input ended or interrupted; no config published."));
      else resolve(value);
    };
    const end = (): void => finish();
    lines.once("SIGINT", end);
    lines.once("close", end);
    signal.addEventListener("abort", end, { once: true });
    if (signal.aborted) end();
    else lines.question(prompt, value => finish(value));
  });
}

export function preparation(format: "json" | "text", output: NodeJS.WriteStream = process.stderr): { stop: () => void } {
  // Latest approved identity is static: no timers, input listeners or artificial
  // delay. This is coarse feedback for the existing preparation, not progress.
  if (format === "text" && terminalOutput(output)) {
    output.write(renderLogo(output.columns || 80, terminalColors(output)));
    output.write(`${color(terminalColors(output), "orchid", "twin")}  Preparing project copy…\n`);
  }
  return { stop: () => {} };
}
