import { fileURLToPath } from "node:url";
import type { CommandSpec, ObservedPath, ScenarioDefinition, ScenarioId } from "./types.js";

export const fixtureContents = Object.freeze({
  "notes.txt": "Scenario fixture notes.\n",
  "app.js": 'console.log("fixture");\n',
  ".gitignore": ".env\nnode_modules/\n",
  "scratch.txt": "Untracked scratch data.\n",
  ".env": "TWIN_SCENARIO_SECRET=fake-only\n",
  "node_modules/lib.txt": "Ignored dependency fixture.\n",
});

const observedPaths: readonly ObservedPath[] = Object.freeze([
  "notes.txt", "app.js", ".gitignore", "scratch.txt", ".env",
  "node_modules/lib.txt", "control-created.txt",
]);

export function getScenario(id: ScenarioId): ScenarioDefinition {
  switch (id) {
    case "S12":
      return { id, description: "Create one harmless control file", actionId: "create-control-file", observedPaths };
    case "S6":
      return { id, description: "Remove untracked and ignored fixture files", actionId: "git-clean", observedPaths };
    default:
      throw new Error("Unknown scenario ID");
  }
}

// Only these fixed commands can be executed. There is no arbitrary-command API.
export type CommandId = ScenarioDefinition["actionId"]
  | "init" | "add" | "commit" | "top-level" | "tracked" | "untracked" | "ignored";

export function getCommand(id: CommandId): CommandSpec {
  switch (id) {
    case "create-control-file":
      return {
        executable: process.execPath,
        args: [fileURLToPath(new URL("./actions/create-file.js", import.meta.url))],
      };
    case "git-clean": return { executable: "git", args: ["clean", "-fdx"] };
    case "init": return { executable: "git", args: ["init", "--initial-branch=main", "--template="] };
    case "add": return { executable: "git", args: ["add", "--", "notes.txt", "app.js", ".gitignore"] };
    case "commit":
      return {
        executable: "git",
        args: ["-c", "user.name=Twin Scenario", "-c", "user.email=twin-scenario@example.invalid",
          "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null",
          "commit", "-m", "Establish disposable scenario baseline"],
      };
    case "top-level": return { executable: "git", args: ["rev-parse", "--show-toplevel"] };
    case "tracked": return { executable: "git", args: ["ls-files", "-z"] };
    case "untracked": return { executable: "git", args: ["ls-files", "--others", "--exclude-standard", "-z"] };
    case "ignored": return { executable: "git", args: ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"] };
    default: throw new Error("Unknown command ID");
  }
}
