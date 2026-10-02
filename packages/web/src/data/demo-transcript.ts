// Captured from a fixed Node command in an owned /tmp fixture on 2026-10-01.
// The child and process group settled before fixture removal. No AI agent ran.
export const demoCommand = "node /path/to/twin/packages/cli/dist/index.js run --receipt=text -- /path/to/node -e \"require('node:fs').writeFileSync('result.txt', 'demo=complete\\n'); console.log('fixed command wrote result.txt')\"";
export const demoOutput = "fixed command wrote result.txt";
export const demoReceipt = `Twin receipt (schema 5)
Coverage: INCOMPLETE — see coverage and issues below

Files — complete
  added [unclassified] result.txt (not-git)
  No file observation issues reported.

Project dependency declarations — incomplete
  No declaration changes observed; coverage may be incomplete.
Project lockfiles — complete
  No lockfile changes observed; coverage may be incomplete.
  Issue before: package.json: missing
  Issue after: package.json: missing

Global npm installed packages — complete (env-prefix)
  No global package changes observed; coverage may be incomplete.
  No global npm observation issues reported.

Outside-project watches — observations only; no rollback
  .gitconfig: unchanged; present → present
  .npmrc: unchanged; missing → missing
  .bashrc: unchanged; present → present
  .zshrc: unchanged; missing → missing
  .codex/config.toml: unchanged; present → present
  .claude/settings.json: unchanged; present → present
  .gemini/settings.json: unchanged; missing → missing

Top-level command — exited
  Admission: admitted; process start: confirmed
  Executable: node; arguments: omitted (2 counted)
  Exit code: 0; signal: none observed; timeout: not observed
  Nested commands: not observed.

Process group — observed lifecycle only
  Direct child: start confirmed; settlement observed
  Group after direct-child exit: absent; final group: absent
  Captured pipes: closed
  No Twin termination signal attempt observed.
  Escaped descendants: not observed. Group absence does not establish their absence.
  Twin discard is clone cleanup; outside-project recovery is not established by this receipt.`;

export const demoFrames = [
  [demoOutput],
  [demoOutput, "Twin receipt (schema 5)", "Coverage: INCOMPLETE — see coverage and issues below"],
  [demoOutput, "Twin receipt (schema 5)", "Coverage: INCOMPLETE — see coverage and issues below", "Files — complete", "  added [unclassified] result.txt (not-git)"],
  [demoOutput, "Files — complete", "  added [unclassified] result.txt (not-git)", "Top-level command — exited", "  Exit code: 0; signal: none observed; timeout: not observed"],
  [demoOutput, "Files — complete", "  added [unclassified] result.txt (not-git)", "Process group — observed lifecycle only", "  Direct child: start confirmed; settlement observed", "  Group after direct-child exit: absent; final group: absent"],
];
