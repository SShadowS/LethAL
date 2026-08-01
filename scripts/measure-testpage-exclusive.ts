/**
 * R69's go/no-go measurement: how many of a project's mutants are covered ONLY by tests that
 * open a `TestPage`?
 *
 * That set is exactly what the R69 client-services apparatus would recover, and it is the first
 * R69 figure stated in the unit that decides anything — every earlier one counted TEST FILES,
 * which says nothing about how much of the score is at stake.
 *
 * Two inputs, joined offline:
 *
 * 1. **The mutant denominator**, from `generateMutationSet` + `writeInstrumentedProject` — the
 *    same code path a real run takes, so the count is post-dedup and post-skip: the mutants that
 *    would actually be deployed, keyed by `(objectType, objectId, procedureName)`.
 * 2. **Per-test procedure coverage**, from a `bcdev_test_run` with `coverage: "procedure"` (the
 *    hub — the only runner that can execute a TestPage test at all, R57/R69). Supply it as a JSON
 *    file mapping a test's `Codeunit.Method` to the procedure keys it executed.
 *
 * A mutant is TESTPAGE-EXCLUSIVE when its site's covering-test set is NON-EMPTY and every test in
 * it opens a TestPage. Mutants no test covers are `no-coverage` today and stay `no-coverage`
 * after R69 — they are in the denominator, never the numerator.
 *
 * KNOWN LIMIT, stated because it bounds the result rather than decorating it: hub coverage cannot
 * resolve a LOCAL procedure's `methodId` to a name (locals are absent from `SymbolReference.json`
 * — R63), so mutants in local procedures can never appear covered here by ANY test. They are
 * reported separately; the exclusivity verdict is sound for public procedures and for triggers,
 * and silent about locals.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMutationSet, operatorTiers } from "../packages/runner/src/orchestrator";
import { writeInstrumentedProject } from "../packages/schemata/src/project";

interface CensusMutant {
  readonly mutantId: string;
  readonly file: string;
  readonly objectType: string;
  readonly codeunitId: number;
  readonly procedureName: string;
  readonly procedureScope?: "local" | "public";
  readonly triggerName?: string;
  readonly operatorName: string;
}

/** `objectType:objectId::procedure` — the grain coverage is reported at. */
function siteKey(m: {
  objectType: string;
  codeunitId: number;
  procedureName: string;
  triggerName?: string;
}): string {
  return `${m.objectType.toLowerCase()}:${m.codeunitId}::${(m.procedureName || m.triggerName || "").toLowerCase()}`;
}

export async function censusMutants(projectDir: string): Promise<readonly CensusMutant[]> {
  const set = await generateMutationSet(projectDir);
  const specCount = set.files.reduce((n, f) => n + f.specs.length, 0);
  console.log(
    `  ${set.totalFiles} .al file(s): ${set.files.length} instrumentable, ${set.skipped.length} skipped, ${specCount} raw spec(s)`,
  );
  const appJson = JSON.parse(await readFile(join(projectDir, "app.json"), "utf8"));
  const target = await mkdtemp(join(tmpdir(), "lethal-census-"));
  try {
    await writeInstrumentedProject({
      targetDir: target,
      files: set.files,
      selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
      artifactId: "00000000000000000000000000000000",
      targetAppId: appJson.id,
      operatorTiers,
    });
    const manifest = JSON.parse(await readFile(join(target, "mutant-manifest.json"), "utf8"));
    return manifest.mutants as readonly CensusMutant[];
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const projectDir = process.argv[2];
  const coveragePath = process.argv[3];
  if (!projectDir) {
    console.error(
      "usage: bun scripts/measure-testpage-exclusive.ts <project-dir> [per-test-coverage.json] [--out <path>]",
    );
    process.exit(2);
  }

  console.log(`project: ${projectDir}`);
  const mutants = await censusMutants(projectDir);

  const scope = new Map<string, number>();
  for (const m of mutants) {
    const k = m.triggerName ? "trigger" : (m.procedureScope ?? "unknown");
    scope.set(k, (scope.get(k) ?? 0) + 1);
  }
  console.log(`DEPLOYABLE MUTANTS: ${mutants.length}`);
  for (const [k, v] of [...scope].sort()) console.log(`  ${k.padEnd(8)} ${v}`);
  console.log(`distinct sites: ${new Set(mutants.map(siteKey)).size}`);

  if (coveragePath === undefined) {
    console.log("\nno coverage file given — denominator only, no verdict.");
    process.exit(0);
  }

  // { "<Codeunit.Method>": { testPage: boolean, procedures: ["codeunit:123::doit", ...] } }
  const coverage = JSON.parse(await readFile(coveragePath, "utf8")) as Record<
    string,
    { testPage: boolean; procedures: readonly string[] }
  >;

  const coveredBy = new Map<string, { any: number; testPageOnly: boolean }>();
  for (const [testName, entry] of Object.entries(coverage)) {
    for (const raw of entry.procedures) {
      const key = raw.toLowerCase();
      const cur = coveredBy.get(key);
      if (cur === undefined) coveredBy.set(key, { any: 1, testPageOnly: entry.testPage });
      else {
        cur.any += 1;
        cur.testPageOnly = cur.testPageOnly && entry.testPage;
      }
      void testName;
    }
  }

  let covered = 0;
  let exclusive = 0;
  let uncovered = 0;
  let localUnresolvable = 0;
  const exclusiveSites = new Map<string, number>();
  for (const m of mutants) {
    const hit = coveredBy.get(siteKey(m));
    if (hit === undefined) {
      uncovered += 1;
      if (m.procedureScope === "local") localUnresolvable += 1;
      continue;
    }
    covered += 1;
    if (hit.testPageOnly) {
      exclusive += 1;
      exclusiveSites.set(siteKey(m), (exclusiveSites.get(siteKey(m)) ?? 0) + 1);
    }
  }

  const pct = (n: number): string => `${((n / mutants.length) * 100).toFixed(2)}%`;
  console.log(`\ncovered by >=1 test:        ${covered} (${pct(covered)})`);
  console.log(`  of those, TESTPAGE-ONLY:  ${exclusive} (${pct(exclusive)} of all mutants)`);
  console.log(`covered by no test:         ${uncovered} (${pct(uncovered)})`);
  console.log(`  of those, local procedure:${localUnresolvable}  <- unresolvable by hub, R63`);
  console.log(
    `\nDECISION NUMBER (share of deployable mutants, TestPage-exclusive): ${pct(exclusive)}`,
  );
  for (const [site, n] of [...exclusiveSites].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${site}  ${n} mutant(s)`);
  }
}
