import type { ManifestSnapshot } from "./manifest.js";
import type { GitSnapshot } from "./git-classification.js";
import type { WatchCapture } from "./watch.js";
import { compareDependencies, type DependencyReceipt, type DependencySnapshot } from "./dependencies.js";
import { compareGlobalNpm, type GlobalNpmReceipt, type GlobalNpmSelection, type GlobalNpmSnapshot } from "./global-npm.js";

export type ReceiptPath = { readonly encoding: "utf8" | "base64"; readonly value: string };
export type FileCategory = "tracked" | "untracked" | "ignored" | "unclassified";
export type WatchId = ".gitconfig" | ".npmrc" | ".bashrc" | ".zshrc"
  | ".codex/config.toml" | ".claude/settings.json" | ".gemini/settings.json";
export type WatchObservation =
  | { readonly status: "missing" }
  | { readonly status: "present"; readonly size: string; readonly mode: number; readonly mtimeNs: string }
  | { readonly status: "refused" | "unavailable"; readonly reason: string };
export interface MinimalReceipt {
  readonly schemaVersion: 3;
  readonly dependencies: DependencyReceipt;
  readonly globalNpm: GlobalNpmReceipt;
  readonly files: {
    readonly coverage: "complete" | "partial" | "unavailable";
    readonly issues: readonly { readonly reason: string; readonly path?: ReceiptPath }[];
    readonly changes: readonly {
      readonly path: ReceiptPath;
      readonly change: "added" | "modified" | "deleted";
      readonly category: FileCategory;
      readonly categoryReason: string | null;
    }[];
  };
  readonly watch: readonly {
    readonly id: WatchId;
    readonly before: WatchObservation;
    readonly after: WatchObservation;
    readonly comparison: "changed" | "unchanged" | "unknown";
  }[];
}

function freezeReceipt(receipt: MinimalReceipt): MinimalReceipt {
  for (const issue of receipt.files.issues) {
    if (issue.path) Object.freeze(issue.path);
    Object.freeze(issue);
  }
  for (const change of receipt.files.changes) {
    Object.freeze(change.path);
    Object.freeze(change);
  }
  for (const item of receipt.watch) {
    Object.freeze(item.before);
    Object.freeze(item.after);
    Object.freeze(item);
  }
  Object.freeze(receipt.files.issues);
  Object.freeze(receipt.files.changes);
  Object.freeze(receipt.files);
  Object.freeze(receipt.watch);
  for (const item of receipt.dependencies.declarations.changes) Object.freeze(item);
  for (const item of receipt.dependencies.lockfiles.changes) Object.freeze(item);
  for (const item of receipt.dependencies.issues) Object.freeze(item);
  Object.freeze(receipt.dependencies.declarations.changes);
  Object.freeze(receipt.dependencies.lockfiles.changes);
  Object.freeze(receipt.dependencies.issues);
  Object.freeze(receipt.dependencies.declarations);
  Object.freeze(receipt.dependencies.lockfiles);
  Object.freeze(receipt.dependencies);
  for (const item of receipt.globalNpm.changes) Object.freeze(item);
  for (const item of receipt.globalNpm.issues) Object.freeze(item);
  Object.freeze(receipt.globalNpm.changes);
  Object.freeze(receipt.globalNpm.issues);
  Object.freeze(receipt.globalNpm);
  return Object.freeze(receipt);
}

function label(snapshot: GitSnapshot, key: string): { category: FileCategory; categoryReason: string | null } {
  const path = Buffer.from(key, "base64");
  if (path.equals(Buffer.from(".git")) || path.subarray(0, 5).equals(Buffer.from(".git/"))) {
    return { category: "unclassified", categoryReason: "git-metadata" };
  }
  if (snapshot.status !== "available") {
    return { category: "unclassified", categoryReason: snapshot.reason };
  }
  const values = snapshot.categories.get(key);
  if (!values || values.size === 0) return { category: "unclassified", categoryReason: "path-unlisted" };
  if (values.size !== 1) return { category: "unclassified", categoryReason: "ambiguous" };
  return { category: [...values][0]!, categoryReason: null };
}

export function buildReceipt(
  before: ManifestSnapshot,
  after: ManifestSnapshot,
  beforeGit: GitSnapshot,
  afterGit: GitSnapshot,
  beforeWatch: readonly WatchCapture[],
  afterWatch: readonly WatchCapture[],
  beforeDependencies: DependencySnapshot,
  afterDependencies: DependencySnapshot,
  globalSelection: GlobalNpmSelection,
  beforeGlobal: GlobalNpmSnapshot,
  afterGlobal: GlobalNpmSnapshot,
): MinimalReceipt {
  const coverage = before.coverage === "complete" && after.coverage === "complete"
    ? "complete" : before.coverage === "unavailable" || after.coverage === "unavailable"
      ? "unavailable" : "partial";
  const changes: Array<MinimalReceipt["files"]["changes"][number]> = [];
  const keys = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const key of [...keys].sort()) {
    const oldEntry = before.entries.get(key);
    const newEntry = after.entries.get(key);
    if (oldEntry && newEntry && oldEntry.kind === newEntry.kind && oldEntry.digest === newEntry.digest && oldEntry.mode === newEntry.mode) continue;
    if (!oldEntry && before.coverage !== "complete") continue;
    if (!newEntry && after.coverage !== "complete") continue;
    const change = !oldEntry ? "added" : !newEntry ? "deleted" : "modified";
    const category = label(change === "added" ? afterGit : beforeGit, key);
    changes.push({ path: (oldEntry ?? newEntry)!.path, change, ...category });
  }
  const watch = beforeWatch.map((first, index) => {
    const last = afterWatch[index] ?? { id: first.id, observation: { status: "unavailable", reason: "observation-failed" } as const };
    const comparison = first.observation.status === "unavailable" || first.observation.status === "refused"
      || last.observation.status === "unavailable" || last.observation.status === "refused"
      ? "unknown" : first.observation.status !== last.observation.status
        ? "changed" : first.observation.status === "missing"
          ? "unchanged" : first.digest === last.digest
            && first.observation.size === (last.observation as Extract<WatchObservation, { status: "present" }>).size
            && first.observation.mode === (last.observation as Extract<WatchObservation, { status: "present" }>).mode
            && first.observation.mtimeNs === (last.observation as Extract<WatchObservation, { status: "present" }>).mtimeNs
            ? "unchanged" : "changed";
    return { id: first.id, before: first.observation, after: last.observation, comparison } as const;
  });
  return freezeReceipt({
    schemaVersion: 3,
    files: { coverage, issues: [...before.issues, ...after.issues], changes },
    watch,
    dependencies: compareDependencies(beforeDependencies, afterDependencies),
    globalNpm: compareGlobalNpm(globalSelection, beforeGlobal, afterGlobal),
  });
}
