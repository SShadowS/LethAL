import type { MutantManifestEntry } from "@lethal/schemata";
import type { CoverageMap, TestMethodRef } from "./backend";

export interface IdentityKey {
  readonly astHash: string;
  readonly codeunitName: string;
  readonly operatorName: string;
  readonly operatorMajor: number;
}

export function identityKeyOf(m: MutantManifestEntry): IdentityKey {
  return {
    astHash: m.astHash,
    codeunitName: m.codeunitName,
    operatorName: m.operatorName,
    operatorMajor: Number(m.operatorVersion.split(".")[0] ?? "0"),
  };
}

export function serializeKey(k: IdentityKey): string {
  return `${k.astHash}|${k.codeunitName}|${k.operatorName}|${k.operatorMajor}`;
}

export interface HistorySplit {
  readonly execute: MutantManifestEntry[];
  readonly knownSurvivors: MutantManifestEntry[];
}

export function filterHistory(
  mutants: readonly MutantManifestEntry[],
  priorSurvivorKeys: ReadonlySet<string>,
  opts: { skipKnownSurvivors: boolean },
): HistorySplit {
  if (!opts.skipKnownSurvivors) return { execute: [...mutants], knownSurvivors: [] };
  const execute: MutantManifestEntry[] = [];
  const knownSurvivors: MutantManifestEntry[] = [];
  for (const m of mutants) {
    if (priorSurvivorKeys.has(serializeKey(identityKeyOf(m)))) knownSurvivors.push(m);
    else execute.push(m);
  }
  return { execute, knownSurvivors };
}

/**
 * Both indexes are keyed on the (objectType, objectId) PAIR, never on the bare numeric id.
 *
 * A BC object id is unique only within its type: `table 50100 "Foo"` next to
 * `codeunit 50100 "Foo Mgt."` is ordinary AL. Keying on the id alone merges them, and the merge
 * is not merely imprecise — it defeats the safety net below. A test covers the codeunit, nothing
 * covers the table's `OnValidate`, the trigger mutant's member key misses, and a bare-id
 * `byObject` lookup then returns the CODEUNIT's covering tests. Non-empty, so the all-green-tests
 * fallback never fires, and the mutant runs against tests that cannot reach it: a silent false
 * survivor. `objectKeyOf`/`memberKeyOf` are the single construction point for both keys precisely
 * so the index build and the lookup cannot drift apart.
 *
 * `byMember` is the precise `<type>:<id>::<member>` index (exact, correct for every ordinary
 * procedure). `byObject` is a coarser `<type>:<id>` index carrying every test that covered
 * ANYTHING in that object — the finer of the two lookups that can match a trigger, since
 * `SymbolReference.json` never records a trigger at all (`AppMethodIndex.lookup` — see
 * `bcdev-backend.ts:606` — can therefore never name one; `app-package.ts:137-149` builds the
 * index exclusively from that file). When neither index names a TABLE trigger mutant,
 * `coverageFilter` falls back further still, to every green test — see its fallback branches.
 */
export interface CoverageIndex {
  readonly byMember: ReadonlyMap<string, ReadonlySet<string>>;
  readonly byObject: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Normalizes an AL object type for keying. Coverage entries carry BC's own spelling
 * (`objectTypeName` in `app-package.ts`: `"Table"`, `"Codeunit"`, `"XmlPort"`, ...) while a
 * manifest entry carries the source keyword already lowercased (`objectHeaderOf` in
 * `@lethal/schemata`), so the comparison must be case-insensitive.
 *
 * Throws on a missing/blank type instead of substituting one. A manifest written before
 * `objectType` existed parses to `undefined` here, and the whole point of keying on the pair is
 * that a wrong pair silently narrows a mutant to another object's tests — so an unusable type is
 * a caller-contract violation, never a default.
 */
function normalizeObjectType(objectType: string, context: string): string {
  if (typeof objectType !== "string" || objectType.trim() === "") {
    const why =
      "Coverage is keyed on (objectType, objectId) because BC object ids are unique only per " +
      "type; regenerate the instrumented artifact so its mutant-manifest.json carries objectType.";
    throw new Error(
      `${context}: object type is missing or blank (got ${JSON.stringify(objectType)}). ${why}`,
    );
  }
  return objectType.trim().toLowerCase();
}

/** Coarse object-level coverage key — `<type>:<id>`. */
export function objectKeyOf(objectType: string, objectId: number, context: string): string {
  return `${normalizeObjectType(objectType, context)}:${objectId}`;
}

/** Precise member-level coverage key — `<type>:<id>::<member>`, member case-insensitive. */
export function memberKeyOf(
  objectType: string,
  objectId: number,
  member: string,
  context: string,
): string {
  return `${objectKeyOf(objectType, objectId, context)}::${member.toLowerCase()}`;
}

export interface CoverageSplit {
  readonly covered: ReadonlyMap<string, readonly TestMethodRef[]>;
  readonly uncovered: MutantManifestEntry[];
}

export function testKeyOf(ref: TestMethodRef): string {
  return `${ref.codeunitId}::${ref.method}`;
}

export function buildCoverageIndex(
  baseline: ReadonlyArray<{ ref: TestMethodRef; coverage?: CoverageMap }>,
): CoverageIndex {
  const byMember = new Map<string, Set<string>>();
  const byObject = new Map<string, Set<string>>();
  for (const b of baseline) {
    for (const e of b.coverage?.entries ?? []) {
      const context = `coverage entry from ${testKeyOf(b.ref)} for object id ${e.objectId}`;
      const memberKey = memberKeyOf(e.objectType, e.objectId, e.procedure, context);
      let memberSet = byMember.get(memberKey);
      if (!memberSet) {
        memberSet = new Set();
        byMember.set(memberKey, memberSet);
      }
      memberSet.add(testKeyOf(b.ref));

      const objectKey = objectKeyOf(e.objectType, e.objectId, context);
      let objectSet = byObject.get(objectKey);
      if (!objectSet) {
        objectSet = new Set();
        byObject.set(objectKey, objectSet);
      }
      objectSet.add(testKeyOf(b.ref));
    }
  }
  return { byMember, byObject };
}

export function coverageFilter(
  mutants: readonly MutantManifestEntry[],
  index: CoverageIndex,
  allTests: readonly TestMethodRef[],
): CoverageSplit {
  const byKey = new Map(allTests.map((t) => [testKeyOf(t), t]));
  const covered = new Map<string, TestMethodRef[]>();
  const uncovered: MutantManifestEntry[] = [];
  // Task 5 amendment: how many TABLE trigger mutants fell through to the untargeted
  // (all-green-tests) fallback below, tallied so the warning fires once per run, not per mutant.
  let untargetedTriggerCount = 0;
  for (const m of mutants) {
    const context = `mutant ${m.mutantId} (${m.file})`;
    // Member-level first: precise, and correct for every ordinary procedure.
    let testKeys = index.byMember.get(
      memberKeyOf(m.objectType, m.codeunitId, m.procedureName, context),
    );
    // A TABLE trigger has no member-level entry to match — SymbolReference.json does not record
    // triggers at all, so AppMethodIndex can never name one. Fall back to "any test that covered
    // ANYTHING in this object". Deliberately conservative: it may run more tests than strictly
    // needed, but it never wrongly reports a table trigger mutant as no-coverage, which would
    // silently hide a live mutation site.
    //
    // Gated on the object being a TABLE, not merely on `triggerName` being set. `triggerNameOf`
    // (@lethal/schemata) walks to the nearest `trigger_declaration`, which also matches a
    // codeunit's `trigger OnRun()`, a page's `OnOpenPage`/`OnAction`, and report triggers — but
    // the measured fact that BC reports NO coverage for trigger code was established for table
    // triggers only (live gate 2026-07-25, fixtures/README.md §Tier-2 Phase 0). Widening these
    // fallbacks to unmeasured object kinds would flip a genuinely-uncovered codeunit `OnRun`
    // mutant from `no-coverage` (excluded from the score, honestly "we don't know") to
    // `survived` (scored) on a guess, and run it against every green test. `no-coverage` is the
    // right bucket until someone measures those kinds.
    const isTableTrigger =
      m.triggerName !== undefined && normalizeObjectType(m.objectType, context) === "table";
    if ((testKeys === undefined || testKeys.size === 0) && isTableTrigger) {
      testKeys = index.byObject.get(objectKeyOf(m.objectType, m.codeunitId, context));
    }
    // A live-gate run found real table trigger mutants BC's coverage index cannot name at ANY
    // precision — object-level came back empty too. We genuinely don't know which tests reach
    // that trigger, and the honest response to "I don't know" is to run every green test, not to
    // silently report no-coverage: skipping would hide a live mutation site, which is the exact
    // failure this layer exists to prevent. Over-running costs time; under-running hides bugs.
    if ((testKeys === undefined || testKeys.size === 0) && isTableTrigger) {
      covered.set(m.mutantId, [...allTests]);
      untargetedTriggerCount++;
      continue;
    }
    if (!testKeys || testKeys.size === 0) {
      uncovered.push(m);
      continue;
    }
    covered.set(
      m.mutantId,
      [...testKeys].flatMap((k) => byKey.get(k) ?? []),
    );
  }
  if (untargetedTriggerCount > 0) {
    console.warn(
      `[lethal] ${untargetedTriggerCount} table trigger mutant(s) could not be coverage-matched (BC does not report coverage for table trigger code) — running each against all ${allTests.length} green test(s).`,
    );
  }
  return { covered, uncovered };
}
