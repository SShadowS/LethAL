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

/**
 * R377: the symbols al-runner PREDEFINES when it compiles a project, with no `--define` and nothing
 * in `app.json`: exactly CLEANSCHEMA1 .. CLEANSCHEMA25. Measured on al-runner v2.12.0 (2026-10-01,
 * one probe arm per candidate; CLEANSCHEMA26 and up, CLEANSCHEMA, NOTCLEANSCHEMA25 are NOT defined).
 * alc predefines nothing. A fact about that one release, so it is NOT what a run uses: since R392
 * every al-runner session measures the set (`probeAlRunnerPredefinedSymbols`), and this list is only
 * what that measurement is compared against for the `al-runner-predefined-symbols-changed` warning.
 */
export const AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0: readonly string[] = Array.from(
  { length: 25 },
  (_, i) => `CLEANSCHEMA${i + 1}`,
);

/** R377: the text to append to a message that shows two different symbol sets. It is non-empty
 *  only when the two sets differ by EXACTLY al-runner's predefined symbols (an al-runner build
 *  against an alc build of the same project). A `null` set (not recorded) gets no hint. */
export function predefinedSymbolsHint(
  a: readonly string[] | null,
  b: readonly string[] | null,
): string {
  if (a === null || b === null) return "";
  const inA = new Set(a);
  const inB = new Set(b);
  const diff = new Set([...inA, ...inB].filter((s) => inA.has(s) !== inB.has(s)));
  const same =
    diff.size === AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0.length &&
    AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0.every((s) => diff.has(s));
  return same ? " (al-runner v2.12.0 predefines CLEANSCHEMA1..CLEANSCHEMA25, R377)" : "";
}

/** R392: what one al-runner session MEASURED al-runner to predefine (`probeAlRunnerPredefinedSymbols`). */
export interface AlRunnerPredefinedProbe {
  /** Sorted. Only the probe's candidates (CLEANSCHEMA1..40, CLEANSCHEMA) can appear. */
  readonly symbols: readonly string[];
}

/** The compiler a build symbol set is computed for: `bcdev` is alc, `al-runner` is al-runner.
 *  R392: the al-runner variant cannot be built without a probe result, so no caller can fall back
 *  to an assumed list. */
export type BuildBackend =
  | { readonly kind: "bcdev" }
  | { readonly kind: "al-runner"; readonly predefined: AlRunnerPredefinedProbe };

/** The build's effective symbols: sorted and de-duplicated, so two equal sets compare equal.
 *  `backend` is required so no caller can forget it: an al-runner build also has al-runner's
 *  measured predefined symbols (R377, R392), an alc build does not. */
export async function effectiveBuildSymbols(
  projectDir: string,
  configSymbols: readonly string[],
  snapshot: ReadonlyMap<string, Buffer> | undefined,
  backend: BuildBackend,
): Promise<readonly string[]> {
  const fromApp = await appJsonSymbols(projectDir, snapshot);
  const predefined = backend.kind === "al-runner" ? backend.predefined.symbols : [];
  return [...new Set([...fromApp, ...configSymbols, ...predefined])].sort();
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
