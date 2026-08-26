import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

interface FirstPartyEntry {
  readonly path: string;
  readonly projectDir: string;
  readonly reason: string;
}

/** The committed exemption list. Read fresh rather than imported so a malformed file fails the test
 *  that checks it rather than the module load of every test in this file. */
function firstParty(): readonly FirstPartyEntry[] {
  const raw = readFileSync(join(import.meta.dir, "redact-first-party-reports.json"), "utf8");
  return (JSON.parse(raw) as { reports: FirstPartyEntry[] }).reports;
}

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

    // WIDENED 2026-08-26. The glob was `docs/campaign/**/*.report.json`, and a measured report
    // committed at `examples/credit-limit/report.json` on 2026-08-24 was invisible to it for TWO
    // independent reasons: the wrong directory, and a bare `report.json` that does not match the
    // `*.report.json` suffix. That one was ours and MIT, so nothing leaked — but the same two
    // misses would hide a third party's source just as completely, and "a list cannot cover a file
    // nobody remembered to add" applies to a glob's SCOPE exactly as it applied to the old list.
    //
    // So: both roots where a MEASURED report can legitimately land, and any filename containing
    // `report`. Discovery then narrows by CONTENT rather than by name — a session report is one
    // with a `mutants` array — because `schemas/report-v2.schema.json` and
    // `scripts/redact-first-party-reports.json` also contain the word.
    //
    // Deliberately OUT of scope: `packages/**/tests/fixtures/**`. `golden-report-before.json` there
    // is a session report by shape and carries `Codeunit 50100 Sales Helper.al`, which is authored
    // test input rather than anything measured from a project. It cannot satisfy the first-party
    // proof (its files exist in no project directory) and redacting it would break the tests that
    // read it. That is a scope boundary stated here, not a gap nobody noticed.
    const candidates = [
      ...new Glob("docs/**/*report*.json").scanSync({ cwd: repoRoot }),
      ...new Glob("examples/**/*report*.json").scanSync({ cwd: repoRoot }),
    ];
    const reports = candidates.filter((p) => {
      try {
        const parsed = JSON.parse(readFileSync(join(repoRoot, p), "utf8")) as {
          mutants?: unknown;
        };
        return Array.isArray(parsed.mutants);
      } catch {
        return false;
      }
    });

    // A glob that stops matching — a directory rename, a changed suffix convention — would make
    // `--check` pass over NOTHING and read exactly like "everything is clean". That is this
    // repository's signature bug (CLAUDE.md), so the count is asserted before the content. The
    // floor is the number committed on 2026-08-16; raise it when a campaign adds reports, and
    // never lower it to make a red test green.
    // Raised from 8 to 9 when the scope widened to `examples/`. Never lower it to make a red test
    // green: a glob that stops matching makes `--check` pass over NOTHING and read exactly like
    // "everything is clean", which is this repository's signature bug.
    expect(reports.length).toBeGreaterThanOrEqual(9);

    // First-party reports are exempt, and the exemption is PROVEN rather than trusted — see the
    // test below. Everything else must be redacted.
    const exempt = new Set(firstParty().map((e) => e.path));
    const mustBeClean = reports.filter((p) => !exempt.has(p.replace(/\\/g, "/")));
    expect(mustBeClean.length).toBeGreaterThanOrEqual(8);

    const r = run(["--check", ...mustBeClean.map((p) => join(repoRoot, p))]);
    expect(r.status).toBe(0);
  });

  test("every first-party exemption is MECHANICALLY first-party, not just claimed", () => {
    // The exemption exists because our own MIT-licensed demo app's source is already in this
    // repository, so redacting a report of it would destroy the artifact — it is the sample report
    // the docs point `lethal explain` at — for no gain. The ruling is about THIRD-PARTY source.
    //
    // A comment saying "this one is ours" would be exactly the hand-maintained claim that let six
    // reports sit unswept. So each entry names a projectDir, and every mutant's `file` must resolve
    // inside it: a report of someone else's app cannot satisfy that, because their source is not in
    // this repository.
    const repoRoot = join(import.meta.dir, "..");
    const entries = firstParty();
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(entry.reason.length, `${entry.path} needs a reason`).toBeGreaterThan(40);
      expect(existsSync(join(repoRoot, entry.path)), `${entry.path} does not exist`).toBe(true);
      expect(
        existsSync(join(repoRoot, entry.projectDir)),
        `${entry.projectDir} does not exist`,
      ).toBe(true);

      const report = JSON.parse(readFileSync(join(repoRoot, entry.path), "utf8")) as {
        mutants?: Array<{ file?: string }>;
      };
      const mutants = report.mutants ?? [];
      expect(mutants.length, `${entry.path} has no mutants to check`).toBeGreaterThan(0);
      const foreign = mutants
        .map((m) => m.file ?? "")
        .filter((f) => !existsSync(join(repoRoot, entry.projectDir, f)));
      expect(foreign, `${entry.path} mutates files outside ${entry.projectDir}`).toEqual([]);
    }
  });
});
