import type { MinimalReceipt, ReceiptPath, WatchObservation } from "@twin-cli/core";

export const MAX_TEXT_RECEIPT_BYTES = 32 * 1024;
const MAX_ITEMS = 12;
const MAX_VALUE_BYTES = 128;
const TRUNCATED = "Presentation truncated; use the JSON receipt for remaining observations.";

export function safeTerminalValue(value: string, maxBytes = MAX_VALUE_BYTES): string {
  let result = "";
  for (const char of value) {
    const point = char.codePointAt(0)!;
    const unsafe = point <= 0x1f || point >= 0x7f && point <= 0x9f
      || point >= 0xd800 && point <= 0xdfff || point >= 0x202a && point <= 0x202e
      || point >= 0x2066 && point <= 0x2069 || point === 0x200e || point === 0x200f
      || point === 0x2028 || point === 0x2029 || point === 0xfeff;
    const part = unsafe ? `\\u${point.toString(16).padStart(4, "0")}` : char;
    if (Buffer.byteLength(result, "utf8") + Buffer.byteLength(part, "utf8") > maxBytes) {
      return `${result}…[truncated]`;
    }
    result += part;
  }
  return result;
}
const safe = safeTerminalValue;
function path(value: ReceiptPath): string {
  return value.encoding === "base64" ? `base64:${safe(value.value)}` : safe(value.value);
}
function observation(value: WatchObservation): string {
  return value.status === "refused" || value.status === "unavailable"
    ? `${value.status} (${safe(value.reason)})` : value.status;
}
function items<T>(lines: string[], values: readonly T[], render: (value: T) => string, empty: string): void {
  if (values.length === 0) { lines.push(`  ${empty}`); return; }
  for (const value of values.slice(0, MAX_ITEMS)) lines.push(`  ${render(value)}`);
  if (values.length > MAX_ITEMS) lines.push(`  … ${values.length - MAX_ITEMS} more entries omitted from text; use JSON receipt.`);
}
function complete(receipt: MinimalReceipt): boolean {
  return receipt.files.coverage === "complete"
    && receipt.dependencies.declarations.coverage === "complete"
    && receipt.dependencies.lockfiles.coverage === "complete"
    && receipt.globalNpm.coverage === "complete"
    && receipt.watch.length === 7 && receipt.watch.every(item => item.comparison !== "unknown")
    && receipt.command.disposition !== "observation-unavailable"
    && receipt.command.disposition !== "settlement-uncertain"
    && receipt.process.directChild.start !== "unknown"
    && receipt.process.directChild.settlement !== "unknown"
    && receipt.process.directChild.settlement !== "unconfirmed"
    && receipt.process.groupAfterDirectExit !== "unknown"
    && receipt.process.finalGroup !== "unknown" && receipt.process.finalGroup !== "present"
    && receipt.process.capturedPipes !== "unknown" && receipt.process.capturedPipes !== "open";
}
function bounded(lines: readonly string[]): string {
  const result: string[] = [];
  let bytes = 0;
  const reserve = Buffer.byteLength(`${TRUNCATED}\n`, "utf8");
  for (const line of lines) {
    const size = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes + size + reserve > MAX_TEXT_RECEIPT_BYTES) {
      result.push(TRUNCATED);
      break;
    }
    result.push(line);
    bytes += size;
  }
  return `${result.join("\n")}\n`;
}

export function renderReceiptText(receipt: MinimalReceipt): string {
  const allComplete = complete(receipt);
  const lines = [`Twin receipt (schema ${receipt.schemaVersion})`,
    `Coverage: ${allComplete ? "COMPLETE for stated observations" : "INCOMPLETE — see coverage and issues below"}`,
    "", `Files — ${receipt.files.coverage}`];
  items(lines, receipt.files.changes, change => `${change.change} [${change.category}] ${path(change.path)}`
    + (change.categoryReason ? ` (${safe(change.categoryReason)})` : ""),
  allComplete ? "No file changes observed." : "No file changes observed; coverage may be incomplete.");
  items(lines, receipt.files.issues, issue => `Issue: ${issue.path ? `${path(issue.path)}: ` : ""}${safe(issue.reason)}`,
    "No file observation issues reported.");

  lines.push("", `Project dependency declarations — ${receipt.dependencies.declarations.coverage}`);
  items(lines, receipt.dependencies.declarations.changes,
    change => `${change.change} ${change.field} ${safe(change.name)} (specifier values omitted)`,
    allComplete ? "No declaration changes observed." : "No declaration changes observed; coverage may be incomplete.");
  lines.push(`Project lockfiles — ${receipt.dependencies.lockfiles.coverage}`);
  items(lines, receipt.dependencies.lockfiles.changes, change => `${change.change} ${safe(change.path)} (whole-file digest change)`,
    allComplete ? "No lockfile changes observed." : "No lockfile changes observed; coverage may be incomplete.");
  items(lines, receipt.dependencies.issues, issue => `Issue ${issue.phase}: ${safe(issue.path)}: ${safe(issue.reason)}`,
    "No dependency observation issues reported.");

  lines.push("", `Global npm installed packages — ${receipt.globalNpm.coverage} (${receipt.globalNpm.source})`);
  items(lines, receipt.globalNpm.changes, change => `${change.change} ${safe(change.name)}: ${safe(change.before ?? "absent")}`
    + ` → ${safe(change.after ?? "absent")}`,
  allComplete ? "No global package changes observed." : "No global package changes observed; coverage may be incomplete.");
  items(lines, receipt.globalNpm.issues, issue => `Issue ${issue.phase}: ${safe(issue.name || "inventory")}: ${safe(issue.reason)}`,
    "No global npm observation issues reported.");

  lines.push("", "Outside-project watches — observations only; no rollback");
  items(lines, receipt.watch, item => `${safe(item.id)}: ${item.comparison}; ${observation(item.before)} → ${observation(item.after)}`,
    "No watch observations available.");

  const command = receipt.command;
  lines.push("", `Top-level command — ${command.disposition}`,
    `  Admission: ${command.admitted === null ? "unknown" : command.admitted ? "admitted" : "not attempted"}; process start: ${command.processStart}`,
    `  Executable: ${command.executable.status === "allowlisted-basename" ? safe(command.executable.value) : "omitted"}; arguments: omitted (${command.arguments.count === null ? "count unknown" : `${command.arguments.count}${command.arguments.capped ? "+" : ""} counted`})`,
    `  Exit code: ${command.exitCode ?? "unknown"}; signal: ${command.signal ?? "none observed"}; timeout: ${command.timeoutObserved === null ? "unknown" : command.timeoutObserved ? "observed" : "not observed"}`,
    "  Nested commands: not observed.");

  const process = receipt.process;
  lines.push("", "Process group — observed lifecycle only",
    `  Direct child: start ${process.directChild.start}; settlement ${process.directChild.settlement}`,
    `  Group after direct-child exit: ${process.groupAfterDirectExit}; final group: ${process.finalGroup}`,
    `  Captured pipes: ${process.capturedPipes}`);
  items(lines, process.termination, attempt => `Twin signal attempt: ${attempt.signal} to ${attempt.target}; delivery ${attempt.delivery} (stop not established by delivery)`,
    "No Twin termination signal attempt observed.");
  lines.push("  Escaped descendants: not observed. Group absence does not establish their absence.",
    "  Twin discard is clone cleanup; outside-project recovery is not established by this receipt.");
  return bounded(lines);
}
