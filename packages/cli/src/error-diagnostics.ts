/** Local preparation errors only; these intentionally disclose bounded messages and paths. */
const LIMIT = 512;
const TRUNCATED = "…[truncated]";
const OMITTED = "; [details omitted]";
const KEYS = ["message", "code", "errno", "syscall", "path", "dest", "cause"] as const;
type Key = typeof KEYS[number];
type Node = { fields: Partial<Record<Exclude<Key, "cause">, string>>; notices: string[]; wrapperEvidence: string[] };

function preparationFailureEvidence(message: string): string[] {
  // Recognize only core's fixed wrapper syntax; do not parse arbitrary JSON/errors.
  const matched = /^(Twin (?:copy|allocation) failed); cleanup=\{"status":"(removed|already-removed|refused|failed)"/.exec(message.slice(0, 128));
  if (!matched) return [];
  const marker = "; allocation=";
  const tail = message.slice(-256);
  const offset = tail.lastIndexOf(marker);
  return [matched[1]!, `cleanup.status=${matched[2]!}`, offset < 0
    ? "[allocation omitted]" : `allocation=${bounded(tail.slice(offset + marker.length), 128)}`];
}

/** Escape the receipt control set, with the truncation marker inside the byte limit. */
function bounded(value: string, limit: number): string {
  const parts: string[] = [];
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    const unsafe = point <= 0x1f || point >= 0x7f && point <= 0x9f
      || point >= 0xd800 && point <= 0xdfff || point >= 0x202a && point <= 0x202e
      || point >= 0x2066 && point <= 0x2069 || point === 0x200e || point === 0x200f
      || point === 0x2028 || point === 0x2029 || point === 0xfeff;
    const part = unsafe ? `\\u${point.toString(16).padStart(4, "0")}` : char;
    const size = Buffer.byteLength(part);
    if (bytes + size > limit) {
      const markerBytes = Buffer.byteLength(TRUNCATED);
      while (bytes + markerBytes > limit) bytes -= Buffer.byteLength(parts.pop()!);
      return parts.join("") + TRUNCATED;
    }
    parts.push(part);
    bytes += size;
  }
  return parts.join("");
}

export function preparationErrorDiagnostic(error: unknown): string {
  const nodes: Node[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    const node: Node = { fields: {}, notices: [], wrapperEvidence: [] };
    nodes.push(node);
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      if (typeof current === "string") node.fields.message = bounded(current, 128);
      else node.notices.push("unsupported value");
      break;
    }
    if (seen.has(current)) { node.notices.push("cause cycle"); break; }
    seen.add(current);
    let next: unknown;
    let hasCause = false;
    for (const key of KEYS) {
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(current, key); }
      catch { node.notices.push(`${key} inaccessible`); continue; }
      if (!descriptor) continue;
      if (!("value" in descriptor)) { node.notices.push(`${key} accessor omitted`); continue; }
      const value: unknown = descriptor.value;
      if (key === "cause") {
        if (value !== undefined) { next = value; hasCause = true; }
      } else if (key === "errno") {
        if (typeof value === "number" && Number.isSafeInteger(value)) node.fields.errno = String(value);
        else node.notices.push("errno unsupported");
      } else if (typeof value === "string") {
        node.fields[key] = bounded(value, key === "code" || key === "syscall" ? 32 : 128);
        if (depth === 0 && key === "message" && node.fields.message?.endsWith(TRUNCATED)) {
          node.wrapperEvidence = preparationFailureEvidence(value);
        }
      } else node.notices.push(`${key} unsupported`);
    }
    if (!hasCause) break;
    if ((typeof next === "object" && next !== null || typeof next === "function") && seen.has(next)) {
      node.notices.push("cause cycle"); break;
    }
    if (depth === 3) { node.notices.push("cause depth limit"); break; }
    current = next;
  }
  const tokens: string[] = [];
  const wrapper = nodes[0]!;
  if (wrapper.wrapperEvidence.length) tokens.push(...wrapper.wrapperEvidence);
  else if (wrapper.fields.message !== undefined) tokens.push(wrapper.fields.message);
  // Deepest filesystem evidence takes precedence over intermediate wrapper prose.
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]!;
    const prefix = index === 0 ? "" : `cause[${index}].`;
    for (const key of ["code", "errno", "syscall", "path", "dest"] as const) {
      if (node.fields[key] !== undefined) tokens.push(`${prefix}${key}=${node.fields[key]}`);
    }
    if (index !== 0 && node.fields.message !== undefined) tokens.push(`${prefix}message=${node.fields.message}`);
    for (const notice of node.notices) tokens.push(`[${prefix}${notice}]`);
  }
  if (wrapper.wrapperEvidence.length && wrapper.fields.message !== undefined) tokens.push(`message=${wrapper.fields.message}`);
  if (tokens.length === 0) tokens.push("[no own diagnostic fields]");
  const accepted: string[] = [];
  let bytes = 1; // Final newline belongs to the total budget.
  let omitted = false;
  for (const token of tokens) {
    const size = Buffer.byteLength(token) + (accepted.length ? 2 : 0);
    if (bytes + size + Buffer.byteLength(OMITTED) > LIMIT) { omitted = true; continue; }
    accepted.push(token);
    bytes += size;
  }
  return accepted.join("; ") + (omitted ? OMITTED : "") + "\n";
}
