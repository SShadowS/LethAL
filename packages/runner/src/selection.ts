import type { MutantManifestEntry } from "@lethal/schemata";
import type { CoverageMap, TestMethodRef } from "./backend";
import type { Interpretation } from "./interpretation";

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
 * ANYTHING in that object — including observations that name no member at all
 * (`CoverageEntry.procedure` absent), which join `byObject` alone and never `byMember`. It is the
 * finer of the two lookups that can match a trigger of ANY object
 * kind, since `SymbolReference.json` never records a trigger at all (`AppMethodIndex.lookup` —
 * see `bcdev-backend.ts:606` — can therefore never name one; `app-package.ts:137-149` builds the
 * index exclusively from that file). When neither index names a TABLE trigger mutant,
 * `coverageFilter` falls back further still, to every green test — see its fallback branches.
 */
export interface CoverageIndex {
  readonly byMember: ReadonlyMap<string, ReadonlySet<string>>;
  readonly byObject: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Only the PROCEDURE-LESS observations (`CoverageEntry.procedure` absent): "this test
   * executed SOME member coverage cannot name" — a local procedure or a trigger, the two
   * members SymbolReference.json never records. `coverageFilter`'s unnamed-member fallback
   * consumes it for ordinary-procedure mutants whose member key can never hit (their procedure
   * is `local`, so it has no public symbol entry), and ONLY there: an ordinary mutant whose
   * procedure is public simply did not execute when its member key misses, and widening it to
   * object level would manufacture vacuous `survived` verdicts (R63's measured failure).
   */
  readonly byObjectUnnamed: ReadonlyMap<string, ReadonlySet<string>>;
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
  /**
   * How many TABLE trigger mutants took FALLBACK 2 — "coverage could place this at no precision
   * at all, so run every green test". The single signal separating "coverage attributed the
   * trigger precisely" (FALLBACK 1, object-level) from "we gave up", and the two are otherwise
   * indistinguishable in the verdicts: on a fixture where nearly every test touches the table,
   * both fallbacks produce near-identical results, so a regression that re-empties `byObject`
   * (the bug `0a463fd` fixed) would not move a single verdict. Returned as DATA rather than left
   * as the `console.warn` below, so `SessionReport.untargetedTriggerCount` can carry it into a
   * gate that pins it — see `tables.itest.ts`, which asserts 0.
   */
  readonly untargetedTriggerCount: number;
  /**
   * Which of the three attribution paths produced each covered mutant's test list, keyed by
   * mutantId. Absent from the map means the mutant is in `uncovered`.
   *
   * `untargetedTriggerCount` above already tallies FALLBACK 2, but only as a session-wide COUNT
   * and only for table triggers. This is the per-mutant answer, and it changes what a survivor
   * MEANS — see `ATTRIBUTION_INTERPRETATIONS` below for what each of the three values means to a
   * reader. That prose lives there and ONLY there: an agent given a raw report once paid $18.56 to
   * re-derive that constant's `object` sentence by hand, and a second copy anywhere else (e.g. in
   * the `lethal explain` projection) is exactly how such prose rots out of step with this function.
   *
   * Without this the report presents all three as one undifferentiated `coveringTests` list, i.e.
   * approximate attribution wearing the costume of an exact one. That is the same shape as R29,
   * where coverage attribution produced 10 false survivors out of 20.
   */
  readonly attribution: ReadonlyMap<string, CoverageAttribution>;
}

/** How `coverageFilter` placed a mutant's covering tests — see `CoverageSplit.attribution`. */
export type CoverageAttribution = "exact" | "object" | "all-green";

/**
 * What each `CoverageAttribution` value MEANS for a reader, moved here verbatim from the prose
 * that used to live only in `CoverageSplit.attribution`'s doc comment — the sentence an agent once
 * paid $18.56 to re-derive by hand because a raw report could not carry it. This is now the single
 * home for that meaning: whoever edits `byObject`/`byMember` precedence in this file is looking at
 * the same constant that states what the result means, so the two cannot drift into two accounts
 * of one fact the way a copy living in a report-rendering module could. See `Interpretation`
 * (interpretation.ts) for the shape, and `packages/runner/tests/selection.test.ts`'s drift
 * tripwire for the behavioural defence — co-location alone is not provable against prose.
 */
export const ATTRIBUTION_INTERPRETATIONS: Record<CoverageAttribution, Interpretation> = {
  exact: {
    meaning:
      'A member-level coverage match. "These tests executed this procedure and did not notice ' +
      'the change" is a real assertion gap.',
    basis: "R29",
  },
  object: {
    meaning:
      "FALLBACK 1. The tests executed something in this OBJECT; whether they reached the " +
      "mutated member is unknown.",
    entailedNegative:
      '"Covered but survived" here may be no finding at all, and telling an agent to strengthen ' +
      "one of these tests can send it chasing a test that never ran the code.",
    basis: "R29",
  },
  "all-green": {
    meaning:
      "FALLBACK 2. Coverage placed it nowhere; every green test was run on the principle that " +
      "running too much beats hiding a live site.",
    entailedNegative: "Carries the least information of the three.",
    basis: "R29",
  },
};

export function testKeyOf(ref: TestMethodRef): string {
  return `${ref.codeunitId}::${ref.method}`;
}

export function buildCoverageIndex(
  baseline: ReadonlyArray<{ ref: TestMethodRef; coverage?: CoverageMap }>,
): CoverageIndex {
  const byMember = new Map<string, Set<string>>();
  const byObject = new Map<string, Set<string>>();
  const byObjectUnnamed = new Map<string, Set<string>>();
  for (const b of baseline) {
    for (const e of b.coverage?.entries ?? []) {
      const context = `coverage entry from ${testKeyOf(b.ref)} for object id ${e.objectId}`;
      // OBJECT level first, and unconditionally. EVERY observation — member-named or not — is
      // evidence that this test executed something in this object, which is precisely what
      // `coverageFilter`'s FALLBACK 1 consumes. An object-level-only entry (see `CoverageEntry`)
      // reaches this line and nothing else.
      const objectKey = objectKeyOf(e.objectType, e.objectId, context);
      let objectSet = byObject.get(objectKey);
      if (!objectSet) {
        objectSet = new Set();
        byObject.set(objectKey, objectSet);
      }
      objectSet.add(testKeyOf(b.ref));

      // MEMBER level only when the observation actually names a member. The skip is STRUCTURAL —
      // `procedure === undefined`, not a comparison against some sentinel string — so no member
      // key is ever synthesized for an observation that names no member.
      const { procedure } = e;
      if (procedure === undefined) {
        // Unnameable-member observation (a local procedure or a trigger): feed the
        // ordinary-mutant fallback — see CoverageIndex.byObjectUnnamed.
        let unnamedSet = byObjectUnnamed.get(objectKey);
        if (!unnamedSet) {
          unnamedSet = new Set();
          byObjectUnnamed.set(objectKey, unnamedSet);
        }
        unnamedSet.add(testKeyOf(b.ref));
        continue;
      }
      if (procedure.trim() === "") {
        // A blank-but-present name is a producer bug, and a uniquely dangerous one: it would key
        // `byMember` as `<type>:<id>::`, the SAME key `coverageFilter` builds for a trigger
        // mutant (`procedureName` is `""` there), so the object-level observation would be
        // returned as an exact member match and the trigger fallbacks would never run. Refuse it
        // rather than index it — absence is expressed by omitting `procedure`, never by "".
        const why =
          "A coverage observation that cannot name a member must OMIT `procedure` so it is " +
          "indexed at object level only; an empty name would collide with a trigger mutant's " +
          "own empty member key.";
        throw new Error(
          `${context}: procedure name is present but blank (got ${JSON.stringify(procedure)}). ${why}`,
        );
      }
      const memberKey = memberKeyOf(e.objectType, e.objectId, procedure, context);
      let memberSet = byMember.get(memberKey);
      if (!memberSet) {
        memberSet = new Set();
        byMember.set(memberKey, memberSet);
      }
      memberSet.add(testKeyOf(b.ref));
    }
  }
  return { byMember, byObject, byObjectUnnamed };
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
  // (all-green-tests) fallback below, tallied so the warning fires once per run, not per mutant —
  // and RETURNED on `CoverageSplit` (see its doc) so a gate can assert it instead of a human
  // having to notice a stderr line.
  let untargetedTriggerCount = 0;
  const attribution = new Map<string, CoverageAttribution>();
  for (const m of mutants) {
    const context = `mutant ${m.mutantId} (${m.file})`;
    // Member-level first: precise, and correct for every ordinary procedure.
    let testKeys = index.byMember.get(
      memberKeyOf(m.objectType, m.codeunitId, m.procedureName, context),
    );
    // FALLBACK 1 — object-level, for ANY trigger mutant, whatever object kind it lives in.
    //
    // NO trigger has a member-level entry to match: SymbolReference.json does not record triggers
    // at all, so AppMethodIndex can never name one — not for a table's `OnValidate`, not for a
    // codeunit's `trigger OnRun()`, not for a page's `OnOpenPage`/`OnAction`. Fall back to "any
    // test that covered ANYTHING in this object". The widening is narrow and evidence-based, not
    // a guess: the key carries `objectType`, so it can only ever return tests that measurably
    // executed something in THIS object. An object nothing covers resolves to nothing here and
    // still falls through to `no-coverage`.
    //
    // Gating this on the object being a TABLE is the harmful direction, and was tried: a
    // codeunit's `trigger OnRun()` is the most ordinary shape in AL, its member-level key can
    // never hit, and this is its ONLY route to ever being executed — so the gate silently
    // reported every mutant in a COVERED codeunit's `OnRun` as `no-coverage` and dropped it from
    // the score. Over-running costs time; under-running hides bugs.
    const isTrigger = m.triggerName !== undefined;
    // Recorded BEFORE fallback 1 can overwrite `testKeys`: after it runs, an exact hit and an
    // object-level hit are indistinguishable by inspecting `testKeys` alone.
    const how: CoverageAttribution =
      testKeys !== undefined && testKeys.size > 0 ? "exact" : "object";
    if ((testKeys === undefined || testKeys.size === 0) && isTrigger) {
      testKeys = index.byObject.get(objectKeyOf(m.objectType, m.codeunitId, context));
    }
    // UNNAMED-MEMBER fallback — ordinary procedure mutants the manifest marks `local`. A
    // member-level miss for a local-procedure mutant is structural, not evidence of
    // non-execution: local procedures never appear in SymbolReference.json (verified
    // 2026-07-18), so `byMember` can never hit for one — the same shape as a trigger, one
    // visibility level up. When coverage saw SOME unnameable member execute in this object
    // (`byObjectUnnamed`), that observation may BE the mutant's own procedure, so run those
    // tests at object grain (attribution "object" — the survivor caveat above applies in
    // full). Measured on the sandbox fixture: `ApplyAudit` calls the local `LogAudit`;
    // without this branch its three mutants report `no-coverage` while genuinely executing —
    // a false "your tests don't reach this" where the honest finding is "your tests don't
    // ASSERT on this". The `procedureScope === "local"` gate is the whole point: a PUBLIC
    // procedure whose member key misses DID NOT EXECUTE (a public execution always resolves
    // by name), and widening it to object level would manufacture a vacuous `survived` —
    // R63's measured failure on Document Output, where the pre-fix locals EXPANSION credited
    // every local of a codeunit to any test that executed one, and 77 mutants in procedures
    // their "covering" tests could not reach were scored `survived`.
    if (
      (testKeys === undefined || testKeys.size === 0) &&
      !isTrigger &&
      m.procedureScope === "local"
    ) {
      testKeys = index.byObjectUnnamed.get(objectKeyOf(m.objectType, m.codeunitId, context));
    }
    // FALLBACK 2 — every green test. TABLE triggers only; that gate is the measured part.
    //
    // A live-gate run found real table trigger mutants coverage cannot place at ANY precision —
    // object-level came back empty too. We genuinely don't know which tests reach that trigger,
    // and the honest response to "I don't know" is to run every green test, not to silently
    // report no-coverage: skipping would hide a live mutation site, which is the exact failure
    // this layer exists to prevent.
    //
    // This branch is now MUCH rarer than it was, and deliberately so. BC does report coverage for
    // table-trigger code (measured on Cronus282, 2026-07-26) — `buildCoverageMap` used to discard
    // the observation because it could not NAME the member, which starved `byObject` and pushed
    // table triggers onto whatever wrong answer fallback 1 could scrape together. Object-level
    // entries (`CoverageEntry` with no `procedure`) feed `byObject` now, so fallback 1 answers
    // precisely and this all-green net catches only the genuinely unseen.
    //
    // Unlike fallback 1 this one is UNMEASURED for every other object kind. "Coverage sees
    // nothing in this object at all, yet the trigger is still reachable from the test suite" was
    // established for table triggers (live gate 2026-07-25, fixtures/README.md §Tier-2 Phase 0).
    // Extending it would flip a mutant in a wholly-uncovered codeunit/page from `no-coverage`
    // (excluded from the score, honestly "we don't know") to `survived` (scored) on a guess.
    const isTableTrigger = isTrigger && normalizeObjectType(m.objectType, context) === "table";
    if ((testKeys === undefined || testKeys.size === 0) && isTableTrigger) {
      covered.set(m.mutantId, [...allTests]);
      attribution.set(m.mutantId, "all-green");
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
    // A non-trigger mutant never reaches fallback 1, so reaching here with no exact hit is
    // impossible for one; `how` is already "exact" in that case.
    attribution.set(m.mutantId, how);
  }
  if (untargetedTriggerCount > 0) {
    console.warn(
      `[lethal] ${untargetedTriggerCount} table trigger mutant(s) could not be coverage-matched (no green test reported executing anything in that table, and no trigger is nameable at member level) — running each against all ${allTests.length} green test(s).`,
    );
  }
  return { covered, uncovered, untargetedTriggerCount, attribution };
}
