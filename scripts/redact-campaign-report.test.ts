import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";

/**
 * The public-repo guard, and the two properties that make it worth having rather than a checklist
 * line.
 *
 * A campaign report against a commercial product carries that product's AL source in
 * `originalText`/`mutatedText`. Two were committed to this PUBLIC repository before anyone noticed.
 * The ruling (2026-08-09) is that filenames, paths, procedure names and test names are fine and
 * source code is not, so the script removes exactly two fields and must be provably incapable of
 * removing anything else — a redactor that also ate verdicts would destroy the record it exists to
 * protect.
 *
 * `--check` is asserted separately because it is the half that can be wired into a pre-commit path,
 * and a check that passes on an unredacted file is worse than no check.
 */

const SCRIPT = join(import.meta.dir, "redact-campaign-report.ts");
const MARKER = "[redacted: third-party source, see this directory's README]";

function reportFixture(): { path: string; original: Record<string, unknown> } {
  const dir = mkdtempSync(join(tmpdir(), "lethal-redact-"));
  const path = join(dir, "report.json");
  const original = {
    schemaVersion: 2,
    mutationScore: 0.5,
    counts: { killed: 1, survived: 1 },
    mutants: [
      {
        mutantCode: "M0001",
        verdict: "killed",
        file: ".dependencies/CDO/Codeunit/Thing.Codeunit.al",
        procedureName: "CheckAccess",
        coveringTests: ["CDO Tests.SomeBehaviour"],
        killingTestFailure:
          "Assert.IsTrue failed. it should return true\nThing(CodeUnit 1).P line 6",
        originalText: "Rec.Modify(true)",
        mutatedText: "",
      },
      {
        mutantCode: "M0002",
        verdict: "survived",
        file: ".dependencies/CDO/Codeunit/Thing.Codeunit.al",
        procedureName: "Other",
        originalText: "Total := Total + Delta",
        mutatedText: "Delta := Delta + Total",
      },
    ],
  };
  writeFileSync(path, JSON.stringify(original, null, 2), "utf8");
  return { path, original };
}

function run(args: string[]) {
  return spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8" });
}

describe("redact-campaign-report", () => {
  test("replaces the two source fields and NOTHING else", () => {
    const { path, original } = reportFixture();
    expect(run([path]).status).toBe(0);
    const after = JSON.parse(readFileSync(path, "utf8"));

    expect(after.mutants[0].originalText).toBe(MARKER);
    expect(after.mutants[1].originalText).toBe(MARKER);
    expect(after.mutants[1].mutatedText).toBe(MARKER);

    // Everything a reader needs to check the campaign's numbers against the artifact that produced
    // them must survive byte-identically. A redactor that quietly widened its scope would destroy
    // the record it exists to protect, and that is far harder to notice than an unredacted field.
    for (const [i, before] of (original.mutants as Record<string, unknown>[]).entries()) {
      for (const key of Object.keys(before)) {
        if (key === "originalText" || key === "mutatedText") continue;
        expect(after.mutants[i][key]).toEqual(before[key]);
      }
    }
    expect(after.mutationScore).toBe(0.5);
    expect(after.counts).toEqual({ killed: 1, survived: 1 });
  });

  test("leaves an EMPTY mutatedText alone — it is meaningful and reveals nothing", () => {
    // `mutatedText: ""` is a deletion operator's mutation, not a missing field. Stamping a marker
    // over it would turn a fact into a redaction and make deletions unreadable in the record.
    const { path } = reportFixture();
    run([path]);
    expect(JSON.parse(readFileSync(path, "utf8")).mutants[0].mutatedText).toBe("");
  });

  test("is idempotent — re-running does not re-count or double-mark", () => {
    const { path } = reportFixture();
    run([path]);
    const first = readFileSync(path, "utf8");
    expect(run([path]).stdout).toContain("0 field(s) redacted");
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  test("--check FAILS on an unredacted report", () => {
    // A check that passes on an unredacted file is worse than no check: it would certify exactly
    // the state it exists to catch.
    const { path } = reportFixture();
    const r = run(["--check", path]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("UNREDACTED");
  });

  test("--check PASSES once redacted", () => {
    const { path } = reportFixture();
    run([path]);
    expect(run(["--check", path]).status).toBe(0);
  });

  test("refuses a file that is not a SessionReport rather than reporting nothing to do", () => {
    // "nothing to redact" and "could not look" must not produce the same exit code.
    const dir = mkdtempSync(join(tmpdir(), "lethal-redact-bad-"));
    const path = join(dir, "not-a-report.json");
    writeFileSync(path, JSON.stringify({ hello: "world" }), "utf8");
    const r = run([path]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not a SessionReport");
  });

  test("EVERY committed campaign report is clean, and the set is DISCOVERED not listed", () => {
    // The regression guard that matters: if a future campaign commits a raw report here, this
    // reddens in `bun test` rather than waiting for someone to notice on GitHub.
    //
    // This used to name two paths by hand, and that hand-maintained pair is exactly how the guard
    // failed: the six reports in `docs/campaign/2026-08-03-do/` predate the 2026-08-09 ruling, were
    // never swept, and sat unguarded next to the two that were — 1,857 fields of a commercial
    // product's AL source in a PUBLIC repository, found 2026-08-16 and redacted the same day. A
    // list cannot cover a file nobody remembered to add to it, so the set is now globbed.
    const repoRoot = join(import.meta.dir, "..");
    const reports = [...new Glob("docs/campaign/**/*.report.json").scanSync({ cwd: repoRoot })];

    // A glob that stops matching — a directory rename, a changed suffix convention — would make
    // `--check` pass over NOTHING and read exactly like "everything is clean". That is this
    // repository's signature bug (CLAUDE.md), so the count is asserted before the content. The
    // floor is the number committed on 2026-08-16; raise it when a campaign adds reports, and
    // never lower it to make a red test green.
    expect(reports.length).toBeGreaterThanOrEqual(8);

    const r = run(["--check", ...reports.map((p) => join(repoRoot, p))]);
    expect(r.status).toBe(0);
  });
});
