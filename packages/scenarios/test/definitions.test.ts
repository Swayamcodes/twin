import { describe, expect, it } from "vitest";
import { fixtureContents, getCommand, getScenario } from "../dist/scenarios.js";

describe("fixed scenario definitions", () => {
  it("defines only S12 and S6 with separate action IDs and complete observation paths", () => {
    const expected = ["notes.txt", "app.js", ".gitignore", "scratch.txt", ".env",
      "node_modules/lib.txt", "control-created.txt"];
    expect(getScenario("S12")).toMatchObject({ id: "S12", actionId: "create-control-file", observedPaths: expected });
    expect(getScenario("S6")).toMatchObject({ id: "S6", actionId: "git-clean", observedPaths: expected });
    expect(Object.keys(fixtureContents).sort()).toEqual(expected.filter((path) => path !== "control-created.txt").sort());
    expect(() => getScenario("UNKNOWN" as "S12")).toThrow("Unknown scenario ID");
  });

  it("binds S6 to the exact git clean argv without accepting an arbitrary command", () => {
    expect(getCommand("git-clean")).toEqual({ executable: "git", args: ["clean", "-fdx"] });
    expect(() => getCommand("UNKNOWN" as "git-clean")).toThrow("Unknown command ID");
  });
});
