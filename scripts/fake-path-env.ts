import { delimiter } from "node:path";

/**
 * A child env for tests: `process.env` minus the `drop` keys, with `bin` first on PATH.
 * On Windows the variable is `Path`, so every key whose lower-case is `path` is read and removed
 * and the result is set as `PATH`; otherwise the child would lose the real path and not find bash.
 */
export function envWithFakeBin(bin: string, drop: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  let path = process.env.PATH ?? process.env.Path ?? "";
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || drop.includes(k)) continue;
    if (k.toLowerCase() === "path") continue;
    env[k] = v;
  }
  path = `${bin}${delimiter}${path}`;
  env.PATH = path;
  return env;
}
