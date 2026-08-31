import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * R186's guard: a script somebody imports one helper out of must not RUN when imported.
 *
 * The measured failure, twice in one session and pointing away from its cause both times:
 *
 *   - `tables.itest.ts` calls `main()` at top level and `process.exit(0)` before it when its env
 *     gate is unset. Importing an assertion helper from it would have killed the `bun test` process
 *     at module load with no failure message, and importing it WITH the gate set would have fired a
 *     billed live BC run from a unit test.
 *   - `redact-campaign-report.ts` had its CLI body at top level. Importing one predicate for R184's
 *     committed-file guard made the test process inherit `bun test`'s argv, match no report path,
 *     and die on the usage error.
 *
 * The convention that prevents both already existed, in `changelog-section.ts` and
 * `operator-tables.ts`, and was written down nowhere. So the third instance was rediscovered by
 * hitting it. This test is the writing-down, in the same genre as `line-citations.test.ts`: it pins
 * a repo-wide convention rather than a behaviour.
 *
 * WHAT IT DOES NOT DO, stated because a guard that overstates its reach is worse than none:
 *
 *   - It is a HEURISTIC keyed on two identifiers, `process.argv` and `process.exit`, not a
 *     side-effect analysis. A module that does top-level I/O without touching either slips through.
 *     Those two are what a CLI body reaches for, and they caught both measured instances.
 *   - It judges only modules something ACTUALLY imports. An unimported CLI script is entitled to a
 *     top-level body and forbidding that would be wrong. The hazard needs an importer to exist.
 *   - Import detection is by module basename, so an unusual aliasing could evade it.
 *
 * A behavioural version of this test -- import each script in a subprocess and see what happens --
 * was considered and REJECTED as dangerous: it would execute whatever it imported, and this
 * directory holds `demo-reset.ts` and `build-binary.ts`.
 */

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * The guard, matched as SYNTAX rather than as a mention.
 *
 * This started as `src.includes("import.meta.main")` and was VACUOUS: the doc comment above a real
 * guard says the words, so removing the actual `if` and leaving the comment still passed. Found by
 * red-checking this test against a genuinely unguarded file, which is the only way that class of
 * defect surfaces. A file reading "TODO: add import.meta.main" would have satisfied the old form.
 */
const GUARD = /if\s*\([^)]*import\.meta\.main/;

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "*.ts"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .filter((f) => f.length > 0);
}

/** Modules that may legitimately carry a CLI body: standalone scripts and integration-test runners. */
function candidates(all: string[]): string[] {
  return all.filter(
    (f) => (f.startsWith("scripts/") || f.includes("/itest/")) && !f.endsWith(".test.ts"),
  );
}

/** Every tracked module that imports `cand`, by module basename. */
function importersOf(cand: string, sources: Map<string, string>): string[] {
  const name = basename(cand).replace(/\.ts$/, "");
  const pattern = new RegExp(`from\\s+["'][^"']*(?:/|\\./)${name}["']`);
  const out: string[] = [];
  for (const [file, src] of sources) {
    if (file === cand) continue;
    if (pattern.test(src)) out.push(file);
  }
  return out;
}

describe("R186: an imported script does not execute on import", () => {
  const all = tracked();
  const sources = new Map(all.map((f) => [f, readFileSync(join(REPO_ROOT, f), "utf8")] as const));

  test("every imported script with a CLI body guards it with import.meta.main", () => {
    const offenders: string[] = [];
    for (const cand of candidates(all)) {
      const src = sources.get(cand);
      if (src === undefined) continue;
      const hasCliBody = src.includes("process.argv") || src.includes("process.exit(");
      if (!hasCliBody) continue;
      if (GUARD.test(src)) continue;
      const importers = importersOf(cand, sources);
      if (importers.length === 0) continue; // an unimported CLI script is free to have a body
      offenders.push(`${cand} (imported by ${importers.join(", ")})`);
    }
    expect(offenders).toEqual([]);
  });

  test("the guard DETECTS one, so the assertion above is not vacuous", () => {
    // There are zero offenders today, so the test above passes whether the rule works or is broken
    // to always return an empty list. This proves the predicate fires. Same reasoning as the
    // committed-file guard's twin test in `redact-campaign-report.test.ts`.
    const synthetic = new Map<string, string>([
      ["scripts/fake-cli.ts", "const args = process.argv.slice(2);\nconsole.log(args);\n"],
      ["packages/runner/src/uses-it.ts", 'import { x } from "../../../scripts/fake-cli";\n'],
    ]);
    const cand = "scripts/fake-cli.ts";
    const src = synthetic.get(cand) ?? "";
    expect(src.includes("process.argv")).toBe(true);
    expect(GUARD.test(src)).toBe(false);
    expect(importersOf(cand, synthetic)).toEqual(["packages/runner/src/uses-it.ts"]);
  });

  test("a guarded script and a pure module are both accepted", () => {
    // Both shapes are correct and the rule must not push anyone toward the wrong one. `aor.ts` is
    // pure with no CLI at all; `redact-campaign-report.ts` has a CLI body behind the guard.
    const guarded = sources.get("scripts/redact-campaign-report.ts") ?? "";
    expect(guarded.includes("process.argv")).toBe(true);
    expect(GUARD.test(guarded)).toBe(true);

    const pure = sources.get("packages/runner/itest/baseline-guard.ts") ?? "";
    expect(pure.length).toBeGreaterThan(0);
    expect(pure.includes("process.argv")).toBe(false);
  });
});
