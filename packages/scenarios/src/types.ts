/// <reference types="node" />

export type ScenarioId = "S12" | "S6";
export type ObservedPath =
  | "notes.txt"
  | "app.js"
  | ".gitignore"
  | "scratch.txt"
  | ".env"
  | "node_modules/lib.txt"
  | "control-created.txt";

export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface ScenarioDefinition {
  readonly id: ScenarioId;
  readonly description: string;
  readonly actionId: "create-control-file" | "git-clean";
  readonly observedPaths: readonly ObservedPath[];
}

export interface CommandEvidence {
  readonly command: CommandSpec;
  readonly cwd: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: string | null;
  readonly streamErrors: readonly {
    readonly stream: "stdout" | "stderr";
    readonly error: string;
  }[];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
}

export type PathObservation =
  | { readonly path: ObservedPath; readonly state: "absent" }
  | { readonly path: ObservedPath; readonly state: "error"; readonly error: string }
  | {
      readonly path: ObservedPath;
      readonly state: "file";
      readonly sizeBytes: number;
      readonly sha256: string;
    };

export interface Snapshot {
  readonly workspace: string | null;
  readonly observedAt: string;
  readonly complete: boolean;
  readonly paths: readonly PathObservation[];
}

export interface RunIssue {
  readonly phase: "setup" | "before" | "action" | "after" | "cleanup";
  readonly message: string;
}

export interface PresenceEvidence {
  readonly exists: boolean | null;
  readonly error: string | null;
}

export type CleanupEvidence =
  | { readonly status: "removed"; readonly scenarioRoot: string }
  | {
      readonly status: "refused";
      readonly scenarioRoot: string;
      readonly reason: string;
    }
  | {
      readonly status: "failed";
      readonly scenarioRoot: string;
      readonly reason: string;
      readonly partialDeletionPossible: true;
      readonly rootAfter: PresenceEvidence;
      readonly markerAfter: PresenceEvidence;
    };

export interface ScenarioRunResult {
  readonly schemaVersion: 1;
  readonly scenarioId: ScenarioId;
  readonly scenarioRoot: string;
  readonly workspace: string | null;
  readonly setupCommands: readonly CommandEvidence[];
  readonly action: CommandEvidence | null;
  readonly before: Snapshot | null;
  readonly after: Snapshot | null;
  readonly cleanup: CleanupEvidence;
  readonly issues: readonly RunIssue[];
}
