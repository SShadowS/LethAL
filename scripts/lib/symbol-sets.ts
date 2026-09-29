import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Same refusal as `validatePreprocessorSymbols` in `packages/runner/src/cli.ts` (R101 (c)). */
const SYMBOL_SEPARATOR_RE = /[,;\s]/;

/**
 * R321: the preprocessor symbol sets an AL project must compile under, from its committed
 * `symbol-sets.json` (for example `[[], ["LETHALA"], ["LETHALB"]]`). `undefined` when the project
 * has no such file, which is every project but the symbol fixture pair.
 *
 * Refuses rather than sanitising, for R101 (c)'s reason: an undefined symbol does not fail a
 * compile, it silently selects another branch, so a dropped or split symbol would compile a build
 * nobody asked for and report it as fine.
 */
export function readSymbolSets(project: string): string[][] | undefined {
  const path = join(project, "symbol-sets.json");
  if (!existsSync(path)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `${path}: must be a non-empty array of symbol lists, got ${JSON.stringify(raw)}`,
    );
  }
  const seen = new Set<string>();
  return raw.map((set: unknown) => {
    if (
      !Array.isArray(set) ||
      set.some((s) => typeof s !== "string" || s === "" || SYMBOL_SEPARATOR_RE.test(s))
    ) {
      throw new Error(
        `${path}: every entry must be an array of symbols with no whitespace, comma or semicolon, got ${JSON.stringify(set)}`,
      );
    }
    const symbols = set as string[];
    const key = [...symbols].sort().join(",");
    if (seen.has(key))
      throw new Error(`${path}: symbol set ${JSON.stringify(set)} is listed twice`);
    seen.add(key);
    return symbols;
  });
}
