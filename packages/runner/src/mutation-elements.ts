import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MutantOutcome, SessionReport } from "./report";

/**
 * R178: project a `SessionReport` into `mutation-testing-report-schema`, the interchange format the
 * Stryker ecosystem reads, so a LethAL run can be DISPLAYED by a CI system.
 *
 * LethAL emits four JSON surfaces of its own design and, until this, nothing any CI could render. A
 * user running it in a pipeline got a JSON file and a console score: no build tab, no trend, and no
 * way to click a survivor and see the mutated line, which is how mutation testing is actually read.
 *
 * **Why this format and not JUnit.** Azure DevOps has no native mutation-testing result type. Its
 * Tests tab takes JUnit/NUnit/VSTest/xUnit, and a mutant CAN be forced into a `<testcase>` with
 * killed=pass and survived=failure, but the semantics fight it: a survivor is a FINDING, not a
 * broken build; the tab adds flakiness tracking, ownership and duration history that mean nothing
 * for a mutant; and mutation scores move for honest reasons, so it would redden builds when the code
 * improved. `PublishMutationReport@1` adds a report TAB instead and renders whatever HTML it is
 * given, and `mutation-testing-elements` renders that HTML from this JSON. The same file feeds the
 * Stryker dashboard and the GitLab/GitHub renderers, so one projection buys every ecosystem.
 *
 * **THE PROJECTION IS LOSSY, and that is the whole design problem.** The schema carries one `status`
 * per mutant and has no field for the qualifications this project spent months earning. Rather than
 * drop them, each one is written into the OPTIONAL `description`, which survives into the rendered
 * tab where a reader actually looks. `describe()` below is where that happens, and
 * `lossesFor()` reports what could not be carried at all, on every run, because a silent projection
 * is how a qualified verdict becomes an unqualified one — which is exactly what R175 was.
 */

/** The schema's status vocabulary. */
export type ElementsStatus =
  | "Killed"
  | "Survived"
  | "NoCoverage"
  | "CompileError"
  | "RuntimeError"
  | "Timeout"
  | "Ignored"
  | "Pending";

/**
 * Every LethAL verdict maps, and the lossy one is named here rather than in a comment far away.
 * `known-survivor` is a survivor CARRIED from a prior run rather than measured now; the schema has
 * no provenance, so it becomes `Survived` and `describe()` says so on the mutant itself.
 */
const STATUS: Readonly<Record<string, ElementsStatus>> = {
  killed: "Killed",
  survived: "Survived",
  "no-coverage": "NoCoverage",
  "timeout-killed": "Timeout",
  "known-survivor": "Survived",
  error: "RuntimeError",
};

export interface ElementsOptions {
  /** Directory the report's relative `file` paths resolve against. */
  readonly projectDir: string;
  /**
   * The schema REQUIRES thresholds and LethAL has no such concept: nothing in `lethal.config.json`
   * sets a mutation-score threshold. A caller that gates on them should choose deliberately rather
   * than inherit a number nobody picked.
   */
  readonly thresholds: { readonly high: number; readonly low: number };
  /** Reads a file's text. Injected so the projection is testable without a disk. */
  readonly readSource?: (absPath: string) => Promise<string>;
}

export interface ElementsReport {
  readonly schemaVersion: string;
  readonly thresholds: { readonly high: number; readonly low: number };
  readonly files: Record<string, unknown>;
}

export interface ElementsProjection {
  readonly report: ElementsReport;
  /** What could NOT be carried across, one sentence each. Never empty silently — see `lossesFor`. */
  readonly losses: readonly string[];
}

/** 1-based line/column for a 0-based character offset. */
export function positionOf(src: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const limit = Math.min(offset, src.length);
  for (let i = 0; i < limit; i++) {
    if (src.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * The qualification this mutant carries that the schema's `status` cannot express, or `undefined`.
 *
 * This is R178's answer to "what may a lossy export claim". The schema has one status and LethAL has
 * several things to say ABOUT a status, so they go in `description`, which the renderer shows on the
 * mutant. The alternative considered and rejected was exporting and warning on the console, where
 * CI eats it and the rendered tab still misleads.
 */
export function describe(
  m: MutantOutcome,
  ctx: {
    readonly unplaceable: ReadonlySet<string>;
    readonly likelyEquivalent: ReadonlySet<string>;
  },
): string | undefined {
  const parts: string[] = [];
  if (ctx.unplaceable.has(m.mutantCode)) {
    parts.push(
      "ATTRIBUTION COULD NOT PLACE THIS (R175). It is shown as NoCoverage because the schema has no " +
        "other status, but that is NOT a statement that your tests miss this code: coverage saw its " +
        "object execute a member LethAL could not name, and LethAL declined to guess. Re-run with " +
        'coverageMode "none" to score it.',
    );
  }
  if (ctx.likelyEquivalent.has(m.mutantCode)) {
    parts.push(
      "LIKELY EQUIVALENT (R172). This operator rewrites a value or bounds a loop, so where nothing " +
        "downstream depends on the change the mutant cannot be killed by any test. Read it as a lead " +
        "only after checking that something does.",
    );
  }
  if (m.verdict === "known-survivor") {
    parts.push(
      "Carried from a PRIOR run (--skip-known-survivors); it was not executed in this one. The " +
        "schema has no provenance, so it is shown as Survived.",
    );
  }
  if (m.coverageAttribution === "object" || m.coverageAttribution === "all-green") {
    parts.push(
      `Covering set is APPROXIMATE (coverageAttribution: ${m.coverageAttribution}). The tests listed executed something in this object, or were simply all of them; they are not known to reach this member.`,
    );
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** What the projection could not carry at all, for the caller to print. */
export function lossesFor(report: SessionReport): string[] {
  const losses: string[] = [];
  if (report.platformArtifactKills !== undefined) {
    losses.push(
      `${report.platformArtifactKills.killedCount} kill(s) screened as platform artifacts (R138) become ordinary kills: the schema has no field for a kill's mechanism.`,
    );
  }
  if (report.assertionScreen !== undefined) {
    losses.push(
      `the assertion screen's discrimination ("${report.assertionScreen.discrimination}", R121) has no schema equivalent.`,
    );
  }
  losses.push(
    "the run's validity caveats, reliability and scope narrowing are not represented: the schema " +
      "describes MUTANTS, not the run that produced them, so a narrowed run renders like a full one.",
  );
  return losses;
}

/** Project a report. Throws on an unmappable verdict rather than defaulting it. */
export async function toMutationElements(
  report: SessionReport,
  opts: ElementsOptions,
): Promise<ElementsProjection> {
  const read = opts.readSource ?? ((p: string) => readFile(p, "utf8"));
  const unplaceable = new Set(report.unplaceableMutants ?? []);
  const likelyEquivalent = new Set(
    (report.likelyEquivalentSurvivors?.byRisk ?? []).flatMap((g) => [...g.mutants]),
  );

  const byFile = new Map<string, MutantOutcome[]>();
  for (const m of report.mutants) {
    const list = byFile.get(m.file);
    if (list === undefined) byFile.set(m.file, [m]);
    else list.push(m);
  }

  const files: Record<string, unknown> = {};
  const unmapped = new Set<string>();
  for (const [relRaw, mutants] of byFile) {
    const rel = relRaw.replaceAll("\\", "/");
    let source: string;
    try {
      source = await read(join(opts.projectDir, rel));
    } catch (err) {
      throw new Error(
        `cannot read ${join(opts.projectDir, rel)} for its source, which the schema REQUIRES so the rendered report can highlight each mutant: ${err instanceof Error ? err.message : String(err)}. Pass the --project this report was produced against.`,
      );
    }
    files[rel] = {
      language: "al",
      source,
      mutants: mutants.map((m) => {
        const status = STATUS[m.verdict];
        if (status === undefined) unmapped.add(m.verdict);
        const description = describe(m, { unplaceable, likelyEquivalent });
        return {
          id: m.mutantCode,
          // Short name: the renderers group and filter by this, and `lethal.` on every row is noise.
          mutatorName: m.operatorName.replace(/^lethal\./, ""),
          location: {
            start: positionOf(source, m.startIndex),
            end: positionOf(source, m.endIndex),
          },
          status: status ?? "Pending",
          ...(m.mutatedText !== undefined ? { replacement: m.mutatedText } : {}),
          ...(m.coveringTests !== undefined && m.coveringTests.length > 0
            ? { coveredBy: [...m.coveringTests] }
            : {}),
          ...(m.killingTest !== undefined ? { killedBy: [m.killingTest] } : {}),
          ...(description !== undefined ? { description } : {}),
        };
      }),
    };
  }

  if (unmapped.size > 0) {
    throw new Error(
      `no schema status for LethAL verdict(s): ${[...unmapped].join(", ")}. Map them in \`mutation-elements.ts\` rather than letting them land on \`Pending\`, which a reader sees as 'not yet run'.`,
    );
  }

  return {
    report: { schemaVersion: "1", thresholds: opts.thresholds, files },
    losses: lossesFor(report),
  };
}
