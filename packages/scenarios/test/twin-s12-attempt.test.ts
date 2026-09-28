import { describe, expect, it } from "vitest";
import { TwinS12AttemptRecordsSchema, validateTwinS12ArtifactParent } from "../src/capture/twin-s12-attempt.js";

describe("2.6R-1 private Twin artifact contract", () => {
  it("rejects an absent prepublication disposition", () => {
    expect(TwinS12AttemptRecordsSchema.safeParse({ identity: {}, attempt: {}, outcome: {
      artifactBeforePublication: "retained" } }).success).toBe(false);
  });
  it("does not accept a nonexistent parent", async () => {
    expect(await validateTwinS12ArtifactParent("/this-directory-should-not-exist-twin-s12-score")).toBe(false);
  });
  it("does not accept a relative parent", async () => {
    expect(await validateTwinS12ArtifactParent(".")).toBe(false);
  });
});
