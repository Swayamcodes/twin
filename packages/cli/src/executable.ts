import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

/** Resolve only bare names; core remains responsible for absolute-path admission. */
export async function resolveExecutable(
  executable: string,
  env: Readonly<Record<string, string>>,
  cwd: string,
): Promise<string> {
  if (isAbsolute(executable)) return executable;
  if (!executable || executable.includes("/") || executable.includes("\0")) {
    throw new Error("Expected a bare executable name or an absolute path");
  }
  for (const entry of env.PATH?.split(delimiter) ?? []) {
    const candidate = resolve(cwd, entry, executable);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error
          && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))) continue;
      throw error;
    }
  }
  throw new Error("Executable not found on PATH");
}
