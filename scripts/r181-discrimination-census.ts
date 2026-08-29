#!/usr/bin/env bun
/**
 * R181 — measure operators by DISCRIMINATION rather than by marginal site count.
 *
 *   bun scripts/r181-discrimination-census.ts
 *
 * R13's bar asks "how many sites does this operator add that nothing else already mutates". R181
 * measured that bar tightening itself as operators ship: `swap-additive` cleared it at 3.7x when it
 * was built and scores 3 against a bar of 13 today, so applied now it would refuse work this project
 * is glad it did. R181's option 3 says the axis may be wrong, and that what a reader actually wants
 * is whether an operator SEPARATES suites the existing ones score identically.
 *
 * That is measurable from evidence already committed, with no new runs: every campaign report
 * carries `file`, `line`, `operatorName` and `verdict` for every mutant, live-measured on real
 * projects. Where two operators put a mutant on the SAME site, their verdicts either agree or they
 * do not, and disagreement is discrimination — the same evidence shape `itest:tables` already pins
 * for `flip-filter-literal` (two sites where the flip and the deletion disagree in opposite
 * directions) and that R159 recorded for `flip-boolean-literal` against `empty-block`.
 *
 * ## What this does NOT measure
 *
 * An operator alone at a site cannot disagree with anything, so it scores no discrimination here
 * while possibly being very valuable — that is exactly what the marginal-site count is for. The two
 * numbers answer different questions and this script prints both. Read them together: an operator
 * with many solo sites is adding REACH, one with a high disagreement rate is adding RESOLUTION, and
 * an operator with neither is the one R13's bar should refuse.
 *
 * Verdicts are compared only where BOTH mutants were executed and judged. A `no-coverage` beside a
 * `killed` is a coverage difference, not a behavioural one, and counting it would measure
 * attribution rather than the operators.
 */
import { readFile } from "node:fs/promises";

/**
 * One report per distinct mutant SET. `rung1`, `rung1.resumed-run` and `rung3.redcheck` are the same
 * 148 mutants of the same project measured repeatedly, so including all three would treble-count
 * that project's sites and silently weight the corpus toward it.
 */
const REPORTS = [
  "docs/campaign/2026-08-03-do/rung3.independent-confirm.report.json",
  "docs/campaign/2026-08-03-do/rung2.report.json",
  "docs/campaign/2026-08-07-r85-swap-rate/rung1.report.json",
  "docs/campaign/2026-08-08-r85-swap-population/rung2.report.json",
  "docs/campaign/2026-08-16-gift-card/rehearsal.report.json",
  "examples/credit-limit/demo.report.json",
];

interface Mutant {
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly verdict: string;
}

/** Executed and judged. A `no-coverage` says nothing about behaviour. */
const SCORED: ReadonlySet<string> = new Set(["killed", "survived", "timeout-killed"]);
/** `timeout-killed` is a kill: the mutant was distinguished, by the clock rather than an assertion. */
const isKill = (v: string): boolean => v === "killed" || v === "timeout-killed";

interface Stat {
  mutants: number;
  scored: number;
  solo: number;
  pairs: number;
  disagreements: number;
}
const stats = new Map<string, Stat>();
const stat = (op: string): Stat => {
  const s = stats.get(op) ?? { mutants: 0, scored: 0, solo: 0, pairs: 0, disagreements: 0 };
  stats.set(op, s);
  return s;
};

let totalMutants = 0;
let totalSites = 0;
let sharedSites = 0;

for (const path of REPORTS) {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    console.error(`skipped (unreadable): ${path}`);
    continue;
  }
  const mutants = (JSON.parse(raw) as { mutants?: Mutant[] }).mutants ?? [];
  totalMutants += mutants.length;

  // Group by SITE. `file:line` is the grain two operators have to share before their verdicts can
  // be compared at all; a coarser grain (the procedure) would pair mutants that are not about the
  // same code, and a finer one is not recorded.
  const bySite = new Map<string, Mutant[]>();
  for (const m of mutants) {
    const key = `${m.file}:${m.line}`;
    const list = bySite.get(key);
    if (list === undefined) bySite.set(key, [m]);
    else list.push(m);
  }
  totalSites += bySite.size;

  for (const group of bySite.values()) {
    const operators = new Set(group.map((m) => m.operatorName));
    for (const m of group) {
      const s = stat(m.operatorName);
      s.mutants++;
      if (SCORED.has(m.verdict)) s.scored++;
      if (operators.size === 1) s.solo++;
    }
    if (operators.size < 2) continue;
    sharedSites++;
    // Every ordered pair of co-located mutants from DIFFERENT operators, both scored.
    for (const a of group) {
      if (!SCORED.has(a.verdict)) continue;
      for (const b of group) {
        if (a === b || a.operatorName === b.operatorName) continue;
        if (!SCORED.has(b.verdict)) continue;
        const s = stat(a.operatorName);
        s.pairs++;
        if (isKill(a.verdict) !== isKill(b.verdict)) s.disagreements++;
      }
    }
  }
}

console.log(
  `corpus: ${totalMutants} mutants over ${REPORTS.length} reports, ${totalSites} sites, ${sharedSites} of them shared by 2+ operators\n`,
);
console.log(
  `${"operator".padEnd(30)}${"mutants".padStart(8)}${"solo".padStart(7)}${"pairs".padStart(7)}${"disagree".padStart(10)}${"rate".padStart(8)}`,
);
const rows = [...stats.entries()].sort((a, b) => b[1].mutants - a[1].mutants);
for (const [op, s] of rows) {
  const rate = s.pairs === 0 ? "n/a" : `${((s.disagreements / s.pairs) * 100).toFixed(1)}%`;
  console.log(
    `${op.padEnd(30)}${String(s.mutants).padStart(8)}${String(s.solo).padStart(7)}${String(s.pairs).padStart(7)}${String(s.disagreements).padStart(10)}${rate.padStart(8)}`,
  );
}
console.log(
  "\nsolo   = mutants at a site no other operator claims (REACH: what the marginal-site bar counts)",
);
console.log(
  "pairs  = ordered co-located pairs with a different operator, both executed and judged",
);
console.log("rate   = share of those pairs whose kill/survive verdicts DISAGREE (RESOLUTION)");

// -----------------------------------------------------------------------------------------------
// The GRAIN experiment, and it is the load-bearing half of this script.
//
// R13's bar counts mutants that are "marginal", meaning nothing else already mutates there. R181
// asks whether that bar measures the operators or the question. Running the IDENTICAL corpus at
// three grains answers it: nothing about the operators changes between these rows.
const GRAINS: ReadonlyArray<{
  readonly name: string;
  readonly of: (m: Mutant & { procedureName?: string }) => string;
}> = [
  { name: "line (file:line)", of: (m) => `${m.file}:${m.line}` },
  { name: "procedure", of: (m) => `${m.file}:${m.procedureName ?? ""}` },
  { name: "file", of: (m) => m.file },
];

const all: (Mutant & { procedureName?: string })[] = [];
for (const path of REPORTS) {
  try {
    const r = JSON.parse(await readFile(path, "utf8")) as {
      mutants?: (Mutant & { procedureName?: string })[];
    };
    all.push(...(r.mutants ?? []));
  } catch {
    // Already reported when the per-report pass read it.
  }
}

console.log("\nMARGINALITY AT THREE GRAINS, same corpus, same mutants:");
console.log(
  `${"grain".padEnd(20)}${"groups".padStart(9)}${"solo mutants".padStart(15)}${"marginal".padStart(11)}`,
);
for (const g of GRAINS) {
  const by = new Map<string, (Mutant & { procedureName?: string })[]>();
  for (const m of all) {
    const k = g.of(m);
    const l = by.get(k);
    if (l === undefined) by.set(k, [m]);
    else l.push(m);
  }
  let solo = 0;
  for (const list of by.values()) {
    if (new Set(list.map((m) => m.operatorName)).size === 1) solo += list.length;
  }
  const pct = ((solo / all.length) * 100).toFixed(1);
  console.log(
    `${g.name.padEnd(20)}${String(by.size).padStart(9)}${String(solo).padStart(15)}${`${pct}%`.padStart(11)}`,
  );
}
console.log(
  "\nThe same operators, on the same mutants, are overwhelmingly marginal or overwhelmingly",
);
console.log(
  "redundant depending only on the grain the question is asked at. R13's bar fixes a threshold",
);
console.log("(>=13 sites) without ever fixing a grain, which is the gap R181 is about.");
