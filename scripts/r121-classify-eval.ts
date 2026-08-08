#!/usr/bin/env bun
/**
 * R121 — evaluate every proposed false-kill discriminator against a REAL corpus of kills.
 *
 * R121 is "blocked on a corpus, not on code". The corpus now exists: R85's rung 2
 * (`docs/campaign/2026-08-08-r85-swap-population/`) deployed the whole `swap-call-arguments`
 * population on Continia Document Output and produced **73 kills, every one carrying its
 * `killingTestFailure`** (R86), each classified BY HAND in `rung2.result.md` before any rule was
 * written. That hand classification is the ground truth this script scores rules against — it was
 * performed for the campaign's own false-kill obligation, not for this evaluation, so it is not a
 * label invented to make a rule look good.
 *
 * GROUND TRUTH, restated so it can be argued with rather than trusted:
 *   FALSE kill  = BC rejected the mutated DATA on a field-width constraint before any assertion
 *                 ran (the "arm E" shape, R82). The same swap into a wider field would survive, so
 *                 the kill is a property of the data, not of the swap or of the suite.
 *   REAL kill   = everything else, which splits into a test's own `Assert.*` failing and the
 *                 mutated program erroring on its own wrong behaviour. Both are kills under
 *                 mutation testing's standard definition (the suite FAILED), and R82 spec §4
 *                 insists production validation catching a bad state reads as a real kill.
 *
 * The script prints precision and recall per rule. It deliberately does NOT pick a winner: R121's
 * whole history is a rule that looked obvious and was measured wrong at a 75% false-positive rate.
 *
 *   bun scripts/r121-classify-eval.ts [<report.json>]
 */
import { readFileSync } from "node:fs";
import { killMessageOf, looksLikeAssertionFailure } from "../packages/runner/src/assertion-screen";

interface Mutant {
  readonly mutantCode: string;
  readonly verdict: string;
  readonly codeunitName?: string;
  readonly procedureName?: string;
  readonly killingTestFailure?: string;
}

const DEFAULT_REPORT = "docs/campaign/2026-08-08-r85-swap-population/rung2.report.json";
const reportPath = process.argv[2] ?? DEFAULT_REPORT;
const report = JSON.parse(readFileSync(reportPath, "utf8")) as { mutants: Mutant[] };
const kills = report.mutants.filter(
  (m) => m.verdict === "killed" || m.verdict === "timeout-killed",
);

/**
 * The message and the callstack arrive as one field, message first, frames after, newline
 * separated. Splitting on the first newline is the only structure there is.
 *
 * Delegates to `killMessageOf` (packages/runner/src/assertion-screen.ts) rather than carrying its
 * own copy, and rule B2 below calls the SHIPPED `looksLikeAssertionFailure` for the same reason:
 * this script's whole value is that the numbers it prints describe the rule LethAL actually
 * applies. Two spellings would let the shipped screen drift away from its own measurement without
 * anything failing.
 */
function messageOf(m: Mutant): string {
  return killMessageOf(m.killingTestFailure);
}

/**
 * The top callstack frame, parsed. AL frames read
 * `Name(CodeUnit 6175287).ProcedureName line 6 - App Name by Publisher version X`.
 *
 * NOTE the line number is PROCEDURE-RELATIVE. That is the finding in the "half 1" section below:
 * the mutant's own `line` is a FILE line, so the two cannot be compared without the procedure's
 * start line, which no field of the report carries.
 */
function topFrame(m: Mutant): { procedure: string; app: string } | undefined {
  const lines = (m.killingTestFailure ?? "").split("\n").slice(1);
  for (const raw of lines) {
    const f = raw.trim();
    if (f === "") continue;
    const match =
      /^(.+?)\((?:CodeUnit|Table|Page|Report|Codeunit) \d+\)\.(\S+) line \d+ - (.+?) by /.exec(f);
    if (match === null) continue;
    const [, , procedure, app] = match;
    if (procedure === undefined || app === undefined) continue;
    return { procedure, app };
  }
  return undefined;
}

/** Ground truth: the arm-E length-constraint shape, and nothing else, is a FALSE kill. */
const LENGTH_OVERFLOW =
  /^The length of the string is \d+, but it must be less than or equal to \d+/;
const truth = new Map(kills.map((m) => [m.mutantCode, LENGTH_OVERFLOW.test(messageOf(m))]));

/**
 * The target app under test. Read off the frames rather than configured: the mutated object is in
 * it by construction, so the app that appears beside the mutant's own codeunit name is the target.
 */
function targetApp(): string | undefined {
  for (const m of kills) {
    const frames = (m.killingTestFailure ?? "").split("\n").slice(1);
    for (const raw of frames) {
      const match = /^(.+?)\(\w+ \d+\)\.\S+ line \d+ - (.+?) by /.exec(raw.trim());
      const [, obj, app] = match ?? [];
      if (obj !== undefined && app !== undefined && obj === m.codeunitName) return app;
    }
  }
  return undefined;
}
const TARGET_APP = targetApp();

interface Rule {
  readonly name: string;
  readonly note: string;
  readonly flags: (m: Mutant) => boolean;
}

const RULES: readonly Rule[] = [
  {
    name: "A. top frame is inside the TARGET app",
    note: "R86's first proposal. Already falsified on run 148 at 75% false positives; scored here on a second, independent corpus.",
    flags: (m) => topFrame(m)?.app === TARGET_APP,
  },
  {
    name: "B1. top frame's PROCEDURE is not the mutated procedure",
    note: "R121's half 1, at the finest granularity the record actually supports (see the note on topFrame).",
    flags: (m) => {
      const f = topFrame(m);
      return f !== undefined && f.procedure !== m.procedureName;
    },
  },
  {
    name: "B2. the message is not an assertion (no `Assert.` prefix)",
    note: "R121's half 2, spelled as 'platform-class' = 'no test assertion fired'.",
    flags: (m) => !looksLikeAssertionFailure(messageOf(m)),
  },
  {
    name: "B. B1 AND B2 — the candidate rule R121 proposes",
    note: "The conjunction the row says 'the data does support' and asks to be measured.",
    flags: (m) => {
      const f = topFrame(m);
      return (
        f !== undefined &&
        f.procedure !== m.procedureName &&
        !looksLikeAssertionFailure(messageOf(m))
      );
    },
  },
  {
    name: "B1-inverted. top frame's PROCEDURE **IS** the mutated procedure",
    note: "Added after B1 measured 0/0: on this corpus the arm-E failure raises INSIDE the mutated procedure, which is the opposite of what R121 assumed.",
    flags: (m) => {
      const f = topFrame(m);
      return f !== undefined && f.procedure === m.procedureName;
    },
  },
  {
    name: "B-inverted. B1-inverted AND B2",
    note: "The best structural (non-text) rule this corpus supports. Reported with its precision, not recommended.",
    flags: (m) => {
      const f = topFrame(m);
      return (
        f !== undefined &&
        f.procedure === m.procedureName &&
        !looksLikeAssertionFailure(messageOf(m))
      );
    },
  },
  {
    name: "D. the message matches the field-length shape",
    note: "The text rule. Perfect by construction on this corpus because it IS the ground truth, and English-only by construction (R66). Listed so its ceiling is visible beside the others.",
    flags: (m) => LENGTH_OVERFLOW.test(messageOf(m)),
  },
];

const falseCount = [...truth.values()].filter(Boolean).length;
console.log(`corpus: ${reportPath}`);
console.log(`kills: ${kills.length}   target app: ${TARGET_APP ?? "<unresolved>"}`);
console.log(`ground truth: ${falseCount} FALSE kills, ${kills.length - falseCount} real\n`);

for (const rule of RULES) {
  const flagged = kills.filter((m) => rule.flags(m));
  const tp = flagged.filter((m) => truth.get(m.mutantCode) === true).length;
  const fp = flagged.length - tp;
  const fn = falseCount - tp;
  const precision = flagged.length === 0 ? 0 : tp / flagged.length;
  const recall = falseCount === 0 ? 0 : tp / falseCount;
  console.log(`${rule.name}`);
  console.log(`  ${rule.note}`);
  console.log(
    `  flagged ${flagged.length}  true-positive ${tp}  FALSE-POSITIVE ${fp}  missed ${fn}  |  precision ${(100 * precision).toFixed(1)}%  recall ${(100 * recall).toFixed(1)}%`,
  );
  if (fp > 0) {
    const sample = flagged
      .filter((m) => truth.get(m.mutantCode) !== true)
      .slice(0, 4)
      .map((m) => `${m.mutantCode} "${messageOf(m).slice(0, 60)}"`);
    console.log(`  false positives (first ${sample.length}): ${sample.join("; ")}`);
  }
  console.log();
}
