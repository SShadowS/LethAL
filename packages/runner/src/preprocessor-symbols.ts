import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * R214: the build's preprocessor symbols, as alc 18.0.41 computes them (measured, the R-214 plan):
 * the `/define` list LethAL passes (the config's `preprocessorSymbols`) UNIONED with `app.json`'s own
 * `preprocessorSymbols`. Symbol names are case-sensitive. A file's own `#define` / `#undef` are
 * applied per file by `evaluateArms` (@lethal/engine), not here.
 */

// A symbol carrying a comma, a semicolon or whitespace would either be split by alc's `/define:A,B`
// list form into things nobody wrote, or reach al-runner as one unusable token.
const SYMBOL_SEPARATOR_RE = /[,;\s]/;

/** The one validation rule for a symbol list, wherever it is read from. `source` names the file
 *  in every message. Absent means `[]`. */
export function validateSymbolList(raw: unknown, source: string): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `${source}: "preprocessorSymbols" must be an array of strings, got ${JSON.stringify(raw)}`,
    );
  }
  const symbols: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(
        `${source}: "preprocessorSymbols" contains a non-string or empty entry (${JSON.stringify(entry)}) \u2014 every entry must be an AL preprocessor symbol`,
      );
    }
    if (SYMBOL_SEPARATOR_RE.test(entry)) {
      throw new Error(
        `${source}: "preprocessorSymbols" entry ${JSON.stringify(entry)} contains whitespace or a separator \u2014 list each symbol as its own array entry`,
      );
    }
    symbols.push(entry);
  }
  return symbols;
}

/**
 * `app.json`'s `preprocessorSymbols`, from the source snapshot when one is given (so the symbols
 * are read from the bytes the build compiles), else from disk. Only a MISSING `app.json`
 * reads as none, because several callers pass a `src` directory. Any other read error, bad JSON,
 * or a list the config would refuse throws, naming the file: alc would read a list we did not.
 */
export async function appJsonSymbols(
  projectDir: string,
  snapshot: ReadonlyMap<string, Buffer> | undefined,
  readFileFn: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<readonly string[]> {
  const path = join(projectDir, "app.json");
  let text: string;
  if (snapshot !== undefined) {
    // R205: a snapshot without `app.json` means the project has none; the disk is never read.
    const bytes = snapshot.get("app.json");
    if (bytes === undefined) return [];
    text = bytes.toString("utf8");
  } else {
    try {
      text = await readFileFn(path);
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return [];
      throw new Error(
        `${path}: cannot be read (${err instanceof Error ? err.message : String(err)}), so its preprocessor symbols are unknown`,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new Error(
      `${path}: not valid JSON (${err instanceof Error ? err.message : String(err)}), so its preprocessor symbols are unknown`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${path}: the root must be a JSON object, so its preprocessor symbols are unknown`,
    );
  }
  const raw = (parsed as { preprocessorSymbols?: unknown }).preprocessorSymbols;
  return validateSymbolList(raw, path);
}

/** The compiler a build symbol set is computed for: `bcdev` is alc. R586: al-runner v3 runs only
 *  what alc proved, and `runSession` refuses a v3 that predefines a symbol, so its build set is
 *  alc's: no predefined symbols. (R654 removed the .NET al-runner's variant, which carried its
 *  measured predefined symbols, R377 and R392.) */
export type BuildBackend = { readonly kind: "bcdev" } | { readonly kind: "al-runner-v3" };

/** The build's effective symbols: sorted and de-duplicated, so two equal sets compare equal.
 *  `backend` is required so a future backend that predefines symbols has one place to add them;
 *  neither of today's does. */
export async function effectiveBuildSymbols(
  projectDir: string,
  configSymbols: readonly string[],
  snapshot: ReadonlyMap<string, Buffer> | undefined,
  backend: BuildBackend,
): Promise<readonly string[]> {
  void backend;
  const fromApp = await appJsonSymbols(projectDir, snapshot);
  return [...new Set([...fromApp, ...configSymbols])].sort();
}

/** R214: `runSession` recorded one effective symbol set and generation enumerated under another.
 *  Both read the same snapshot, so this is a defect, never a user error: the run's history,
 *  resume and marks would be scoped to a build the mutants did not come from. */
export class BuildSymbolsDivergedError extends Error {
  constructor(recorded: readonly string[], generated: readonly string[]) {
    super(
      `R214: the run records preprocessor symbols [${recorded.join(", ")}] but generation used [${generated.join(", ")}]; refusing to run under a symbol set its mutants were not enumerated with.`,
    );
    this.name = "BuildSymbolsDivergedError";
  }
}

/** Whether two symbol lists name the same build. Order and repeats do not matter; case does. */
export function sameBuildSymbols(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((s, i) => s === y[i]);
}
