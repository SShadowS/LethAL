#!/usr/bin/env bun
/**
 * Env-gated integration test against a live bc-dev-mcp + Business Central dev server, pointed at
 * the TABLE fixture (`fixtures/sandbox-data` + `fixtures/sandbox-data-tests`) rather than the
 * codeunit one. NOT a `bun:test` file — a standalone script invoked via `bun run itest:tables`
 * (root package.json), never picked up by `bun test`.
 *
 * Skips cleanly (exit 0) when LETHAL_ITEST_TABLES is unset.
 *
 * WHY THIS EXISTS AS A COMMITTED GATE. Tier-2 Phase 0's whole claim is that a mutation living
 * inside a table trigger is generated, attributed, instrumented, executed and killed on a real
 * server. Every OTHER result in this repo is frozen per-mutant and asserted
 * (`bcdev.baseline.json`, `al-runner.baseline.json`); the table result was recorded once, by
 * hand, into `fixtures/README.md`, with no committed gate — so a regression in trigger
 * attribution, in the (objectType, objectId) coverage key, or in table selector-var injection
 * would break the one behaviour Phase 0 exists to prove and nothing would fail. `assertVerdictTable`
 * below plus `assertMatchesBaseline` close that.
 *
 * Connection details are never committed: this script reads
 *   fixtures/sandbox-data/lethal.config.local.json         (LethAL bcdev section — gitignored)
 *   fixtures/sandbox-data/.vscode/launch.local.json        (OPTIONAL — gitignored)
 * Note the config is the sandbox-data one, NOT sandbox-app's: the two fixtures target DIFFERENT
 * containers (and different .alpackages), so cross-reading would publish this app to the wrong
 * server. See fixtures/README.md for the expected shape.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import type { ActivationConfig } from "../src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient } from "../src/lease";
import { generateMutationSet, runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { SessionReport } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import { assertMatchesBaseline } from "./baseline-guard";

if (!process.env.LETHAL_ITEST_TABLES) {
  console.log(
    "skipped (set LETHAL_ITEST_TABLES=1 and populate the gitignored " +
      "fixtures/sandbox-data/lethal.config.local.json to run against a live dev server)",
  );
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-data");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-data-tests");
const LAUNCH_LOCAL_PATH = join(PROJECT_DIR, ".vscode", "launch.local.json");
const CONFIG_LOCAL_PATH = join(PROJECT_DIR, "lethal.config.local.json");
// Committed per-mutant baseline — see baseline-guard.ts. Absent on the first run: the guard
// RECORDS it and says so. Never hand-write this file; it must come from a live run.
const BASELINE_PATH = join(HERE, "tables.baseline.json");

// Must live inside sandbox-data's declared idRanges (79300-79399, see its
// app.json) — real alc.exe enforces app.json idRanges (AL0297) for the injected objects too.
// The injected selector objects live at the TOP OF THIS FIXTURE'S OWN BLOCK (79300-79399).
//
// They used to sit at 79197-79199, which is `LethAL Sandbox App`'s block, kept legal only by a
// three-id island `{79197..79199}` grafted onto this app's `idRanges` — the signature of a fixture
// cloned from App whose selector triple was never renumbered. Both apps then declared codeunits
// 79197/79198/79199 with the SAME names (`Mutation Upgrade`/`Mutation Register`/`Mutation
// Selector`), and they coexisted only because they are published to DIFFERENT containers.
// Co-installing them fails to publish.
//
// NOT 79297-79299, which would swap one collision for another: `LethAL Sandbox Probes` declares
// 79200-79299.
const SELECTOR_IDS = { selectorId: 79399, controlId: 79398, tableId: 79397 };

/**
 * The 81-site fixture's expected aggregate result.
 *
 * 63 / 10 / 2 is the CORRECTED result. The run recorded before the object-level-coverage fix
 * reported 53 killed / 20 survived / 2 no-coverage, and 10 of those 20 survivors were FALSE. BC
 * DOES report coverage for table-trigger code, but `buildCoverageMap` (bcdev-backend.ts) dropped
 * any observation it could name neither via SymbolReference.json (which records no trigger) nor
 * via the local-procedure scan (empty for `Data Main`, whose procedures are all public), so the
 * OBJECT lost credit along with the member: `byObject["table:79300"]` held only the one test whose
 * methodId happened to resolve, `coverageFilter`'s FALLBACK 1 answered with that non-empty-but-
 * wrong set, its all-green-tests FALLBACK 2 never fired, and every table-trigger mutant ran
 * against a single irrelevant test. Each of the 10 was then driven individually through the fenced
 * path against its intended killer and KILLED. Note the shape of the old bug: a table with public
 * procedures scored WORSE than one with none (`Data No Trigger`'s empty `byObject` fell through to
 * the correct fallback and scored right).
 *
 * `mutationScore` is written as the division, not a rounded literal — `report.ts` computes
 * `killed / (killed + timeoutKilled + survived)` in full float precision and this must equal it
 * exactly.
 *
 * PER-MUTANT: the old `verdicts` map (7 entries, from the superseded 7-mutant fixture) is gone.
 * Asserting a 7-key map against 75 scored mutants cannot pass and proves nothing; the per-mutant
 * regression guard for THIS fixture is `assertMatchesBaseline` against the committed
 * `tables.baseline.json` (semantic-identity keyed, and self-recording when the file is absent).
 * The file IS committed; delete it to re-record after a deliberate fixture change, and review the
 * diff before committing — a re-record is the one operation that can silently bless a regression.
 * `assertTriggerKillAndSurvive` below independently pins the trigger claim.
 */
const EXPECTED = {
  // R30 moved this from 81 to 93. The fixture gained its first EXTENSION objects — a
  // `tableextension` over `Data Main` and a `page`/`pageextension` pair — so that extension
  // support, which had only ever run in unit tests, is instrumented, compiled, published and
  // EXECUTED by a gate. New sites have no frozen baseline entry by construction; every
  // PRE-EXISTING mutant must keep its verdict, which is what `assertMatchesBaseline` checks.
  // R78 moved this from 93 to 96. The fixture gained `codeunit 79308 "Data Value Source"` and
  // `page 79323 "Data Value Card"` — a deliberately minimal pair whose only route in is a
  // `TestPage` test, built to answer whether a mutant covered EXCLUSIVELY by a TestPage test can be
  // scored at all. The three new sites are `empty-block` on the page's OnAction, `empty-block` on
  // `GetValue`'s body, and `return-value` on its `exit(42)`; all three flip the value the test
  // asserts, so all three are killable by that one test and by nothing else.
  // R70 moved this from 96 to 99. The fixture gained the cross-kind NAME COLLISION every gate was
  // blind to: `table 79309 "Data Scope Probe"` and `page 79324 "Data Scope Probe"`, same name,
  // different kind — the ordinary "card page named after its table" convention. The table's
  // OnInsert filters through a receiver declared in the TRIGGER'S OWN var section, invisible to the
  // symbol table (R68), so Tier 2 must REFUSE it and Tier 1 claims the statement. Under the R70 bug
  // the same-named page's `Helper: Record "Data Main"` answered for the table and Tier 2 CLAIMED
  // the site, whose §3.2 precedence then DELETED the Tier-1 mutant — measured offline on this
  // fixture as raw specs 99 -> 100 with DEPLOYED unchanged at 90. So the regression shows up as an
  // OPERATOR NAME at a fixed file:line, which `assertMatchesBaseline` compares per mutant.
  // R68 moved this from 117 to 118: resolving a trigger's own `var` section made
  // `Data Scope Probe.OnInsert`'s receiver claimable, so Tier 2 gained a `remove-setrange` spec
  // there. DEPLOYED is unchanged at 106 — §3.2 precedence deletes the Tier-1 `void-method-call`
  // that used to hold that site, which is the dedup mechanism working, not a lost mutant.
  // R82 moved this from 118 to 148: `codeunit 79311 "Data Swap Ops"` and its six arms, which are
  // the live measurement of `lethal.swap-call-arguments` (spec
  // docs/superpowers/specs/2026-08-03-r82-swap-call-arguments-design.md, per-mutant predictions
  // pre-committed in its §5 BEFORE this run). All 30 new specs DEPLOY — the five swap mutants
  // coexist with `void-method-call` at their sites rather than displacing it, because dedup keys on
  // replacement TEXT and a swap's is never a deletion's empty string. That coexistence is R82's
  // "marginal == gross" claim, and it is now a measurement rather than an argument.
  // R72 moved this from 148 to 154. `Data Commit Ops.CommitThenRunValueForm` is the first fixture
  // site in any project that can produce BC's write-transaction refusal: the SAME procedure shape as
  // `CommitThenRun` with the `Codeunit.Run` return value consumed, which a 2x2x2 on Cronus281
  // measured as the only factor deciding the abort. Six raw specs, five deployed (Tier-1
  // `void-method-call` and Tier-2 `remove-commit` both claim the `Commit()` and §3.2 keeps Tier 2).
  // Per-mutant predictions pre-committed in
  // docs/superpowers/specs/2026-08-08-r72-value-form-arm-precommitment.md BEFORE this run.
  // R136 moved this from 154 to 207. Three operator changes and eleven new fixture arms (A through
  // K), none of which had a live site before: `lethal.swap-modify-flag` extended from `Modify` alone
  // to `Insert`/`Delete` (1.0.0 -> 1.1.0), the new `lethal.swap-find-direction`
  // (`FindFirst` <-> `FindLast`), and the new `lethal.validate-to-assign` (`Validate(F, V)` ->
  // `F := V`, refusing the single-argument form). All 51 per-mutant verdicts were pre-committed in
  // docs/superpowers/specs/2026-08-12-r136-trio-precommitment.md BEFORE this run.
  // R134 moved this from 207 to 243. One operator landed with no live site anywhere:
  // `lethal.flip-filter-literal` (Tier 2, 1.0.0) mutates INSIDE the filter STRING a `SetFilter`
  // hands to BC, through a four-rule ladder (flip `<>` to `=`, shift a `<`/`<=`/`>`/`>=` boundary,
  // reverse an open range, drop a placeholder-free alternative from a `|` list). The fixture's one
  // pre-existing `SetFilter` carries the bare placeholder `'%1'`, which every rule declines, so
  // nothing measured any rule of the four. `codeunit 79317 "Data Filter Ops"` adds seven arms (A,
  // B, C, D, E, G and H) plus seven tests. 36 new raw specs, 4 new displacements, 32 new deployed.
  // All 32 per-mutant verdicts were pre-committed in
  // docs/superpowers/specs/2026-08-12-r134-filter-precommitment.md BEFORE this run.
  // R141 moved this from 243 to 248. One arm, `Data Filter Ops.CountTaggedInBand`, whose `SetFilter`
  // literal carries an inner quote (the `<>''` not-blank idiom) and therefore hits the operator's
  // CHARACTER refusal — a different code path from arm H's ladder exhaustion, and until now proven
  // by one offline unit test and nothing else. Five new raw specs, one displacement, four deployed;
  // `flip-filter-literal` stays at SIX, which is the number the arm exists to hold down. All four
  // verdicts pre-committed in
  // docs/superpowers/specs/2026-08-14-r141-character-refusal-precommitment.md BEFORE this run.
  // R132 moved this from 248 to 252. `codeunit 79318 "Data Assert Ops"` is a TWIN PAIR: two
  // procedures of identical shape whose covering tests differ only in HOW they raise, one through
  // Microsoft's Library Assert and one through bare `Error(...)`. Four new mutants, no displacement
  // (neither site is a call), all four predicted killed — and the point is not the verdicts but what
  // the assertion screen does with them, which is why this fixture's `discrimination` moves from
  // `vacuous` to `partial` below. Pre-committed in
  // docs/superpowers/specs/2026-08-14-r132-assertion-arm-precommitment.md BEFORE this run.
  // R161 moved this from 252 to 256. Six operators' guard widened from `isStatementPosition` to
  // `isStatementSlot`, so a call that is the UN-BRACED BODY of a branch is claimed. All four new
  // sites are the same shape and it is the shape that matters: `if <bad condition> then Error(...)`,
  // the ordinary BC guard clause, at which this tool previously emitted NOTHING. Three are the
  // `Error` in a field `OnValidate` (`Data Main`'s `"No."` and `Category`, `Data No Trigger`'s
  // `"No."`) and the fourth is `DataMain.Delete(false)` inside `if DataMain.Get(MainNo) then` in
  // `Data Ops.InsertWithoutTrigger`. No displacement: all four are `void-method-call`, and the one
  // that shares a statement with an existing mutant (`Category`'s `remove-calcfields`) becomes its
  // SIBLING in one dispatch chain rather than replacing it. All four verdicts pre-committed in
  // docs/superpowers/specs/2026-08-19-r161-branch-slot-precommitment.md BEFORE this run.
  // R161 moved this from 252 to 256; R163 moves it to 257. One operator, `lethal.remove-not`
  // (Tier 1, 1.0.0), which strips a `not` from a bare call, identifier or member access —
  // `negate-conditional` reaches a negation only through a comparison, so this fixture's
  // `if not DataMain.Get(CommitRunNoLbl) then` was claimed by nothing. Exactly ONE site here, and
  // the census said so before the run; a second would be a finding. No displacement: nothing else
  // claims a `unary_expression`. Verdict pre-committed in
  // docs/superpowers/specs/2026-08-19-r163-remove-not-precommitment.md.
  // R159 moves this from 257 to 265. `lethal.swap-additive` (Tier 1, 1.0.0) flips `+` and `-`
  // where BOTH operands are provably numeric. Eight sites here, no displacement — nothing else
  // claims an `additive_expression`. Two of them are NESTED (the outer and inner additive of
  // `Data Ops.RunUserDefinedBuiltins`'s total), so they share a containment component and become
  // siblings in one dispatch chain while staying two mutants. All eight verdicts pre-committed in
  // docs/superpowers/specs/2026-08-19-r159-swap-additive-precommitment.md.
  // R165 moves this from 265 to 266. `swap-modify-flag` 1.2.0 also claims the ARGUMENT-LESS form
  // (`Rec.Modify()` means RunTrigger = false, so the mutant runs the trigger). Exactly ONE site
  // here, in `pageextension Data Main List Ext`'s `OnOpenPage`, and the fixture's own comment states
  // the mechanism: `Modify()` is deliberate there because running `OnModify` would add 1 to the very
  // field the test asserts. Verdict pre-committed in
  // docs/superpowers/specs/2026-08-19-r165-forced-trigger-precommitment.md.
  // R171 moves this from 266 to 279. Thirteen new mutants: `negate-guard` claims FOUR guards that
  // were already here (`Data Find Ops` twice, `Data Ops.InsertWithoutTrigger`, and the pageextension
  // `OnOpenPage`), and `codeunit 79319 "Data Set Ops"` adds NINE more. That arm exists for the
  // `remove-not` cession seam: the operator refused every parenthesized operand and ceded them to
  // `negate-conditional`, which claims comparisons and logical expressions and nothing else, so
  // `not (X in [...])` was ceded to an operator that does not want it. The fix adds ZERO sites on
  // every other fixture, which is why the arm had to be written rather than the fix landed alone.
  // All thirteen verdicts pre-committed in
  // docs/superpowers/specs/2026-08-20-r171-build-precommitment.md.
  // R171 moved this to 279; `flip-boolean-literal` (R159) adds 13 more. Every one is a `true` or
  // `false` LITERAL that no operator claimed before — the node-kind census had `boolean` at 3,620
  // corpus occurrences with nothing touching it. Verdicts pre-committed in
  // docs/superpowers/specs/2026-08-26-r159-flip-boolean-build-precommitment.md.
  // R159's `remove-assignment` adds 52 — the largest single wave this fixture has taken. It deletes
  // an assignment STATEMENT, the direct analogue of `void-method-call` on the other statement form
  // AL has, and `assignment_statement` was the largest kind the node-kind census left unclaimed
  // (6,850 corpus occurrences, zero exact-span overlap). All 52 verdicts were MEASURED in the spike
  // before this build and are restated, not re-predicted, in
  // docs/superpowers/specs/2026-08-26-r159-remove-assignment-build-precommitment.md.
  // R159's `toggle-blank-string` adds 10: seven of its own sites plus the three other mutants in
  // `codeunit 79320 "Data Blank Ops"`, the arm that makes R121's screen SEPARATE on this operator
  // instead of flagging everything. Pre-committed in
  // docs/superpowers/specs/2026-08-26-r159-toggle-blank-string-build-precommitment.md.
  // R159's `shift-integer` adds 11: three of its own sites in `Data Commit Ops`, plus all EIGHT
  // mutants of `codeunit 79325 "Data Shift Ops"`. That arm is a TWIN PAIR in R132's sense, and it
  // turned out to control four operators rather than one. Its shape yields `empty-block`,
  // `negate-conditional`, `shift-integer` and `return-value` per half, all eight killed, so the
  // VERDICTS are constant and the only variable across the pair is which side of R121's screen each
  // kill lands on. Pre-committed in
  // docs/superpowers/specs/2026-08-26-r159-shift-integer-build-precommitment.md.
  totalMutantSites: 365,
  // R36 moved this from 63/10 to 64/9, deliberately and in one direction only.
  //
  // `RequireCategoryAFails` used to assert merely that AN error occurred, so deleting
  // `DataMain.Get(MainNo)` (M0034) was invisible: with no `Get` the record is blank and
  // `TestField(Category, 'A')` still raises, just for a different reason. The mutant was correctly
  // reported survived — the fixture genuinely did not catch it — but this fixture exists so that a
  // BROKEN OPERATOR FAILS, and it was carrying the project's signature "test passes for the wrong
  // reason" inside itself. The test now asserts the error names the record it loaded, which a
  // blank record cannot do, so M0034 is killable and killed.
  // R30 moved this from 64/9/2 to 69/9/6, and the delta is entirely NEW sites — every pre-existing
  // mutant kept its verdict (checked per-mutant against the previous `tables.baseline.json`, not
  // inferred from the totals).
  //
  //   +5 killed  — `tableextension "Data Main Ext"`, all five of its deployed mutants, including
  //                `remove-testfield` on the IMPLICIT `Rec` (which claims only if `Rec` resolves to
  //                the EXTENDED table) and `remove-setrange` on a receiver declared INSIDE the
  //                extension (which claims only if extension members are indexed for scope). These
  //                are the first Tier-2 extension mutants any gate has EXECUTED.
  //   +4 no-cov  — `pageextension "Data Main List Ext"`. Its code is reachable only through a
  //                `TestPage`, and a TestPage HANGS the fenced session (measured 2026-07-31, R69),
  //                so the object is instrumented, compiled, published and installed live but never
  //                runs. Deliberately kept: no-coverage is the honest verdict for code no test
  //                reaches, and the pipeline proof is real even when the execution proof is not.
  // R70 moved this from 69 to 71. Both new killed mutants are in `table 79309 "Data Scope Probe"`'s
  // OnInsert — `empty-block` on the trigger body and `void-method-call` on the `SetRange` — and
  // `Data Tests.ScopeProbeCountsOnlyFilteredRelated` kills both by seeding out-of-filter decoys, so
  // deleting either widens the count the test asserts.
  // R73 moved this from 71 to 81, and R73's whole point is ONE of those: M0007, the first
  // `lethal.remove-commit` mutant any gate has ever KILLED. Until now the operator shipped proven
  // on its refusals and unproven on its claims — both pre-existing `Commit` sites are shadowed
  // negatives, correctly refused, so no gate had ever generated one.
  // R71 moved this from 81 to 84, and one of the three is the point: M0088, the fixture's only
  // `lethal.swap-rec-xrec` mutant, KILLED by `Data Tests.ScopeProbeTracksFieldChange`. The operator
  // ships with its claim proven live rather than only its refusals — the gap R73 had just closed
  // for `RemoveCommit`, not reopened one operator later.
  // R82 moved this from 84 to 109. 25 of the 30 new mutants are predicted killed; the three that
  // matter are the swap mutants at DataSwapOps:46 (arm A — the `var` writeback redirected, which is
  // also the live proof that a swapped call COMPILES with a `var` parameter), :69 (arm B —
  // EXPRESSION position, the shape 452 of the 893 real sites have) and :146 (arm E — killed by a
  // platform length overflow under a test that asserts NOTHING, this repo's sharpest false kill).
  // R72 moved this from 109 to 113. Four of `CommitThenRunValueForm`'s five deployed mutants are
  // predicted killed, and the one that matters is the `lethal.remove-commit` at its `Commit()`:
  // deleting it leaves a write open across a `Codeunit.Run` whose return value is consumed, BC
  // aborts the transaction, and the test dies without reaching any assertion. That mutant is the
  // first anywhere to be scored `killed` AND screened as a platform artifact — and the verdict
  // deliberately does not move, which `assertPlatformArtifactScreen` below pins alongside the count.
  // R136 moved this from 113 to 158, per the 45 killed predictions in
  // docs/superpowers/specs/2026-08-12-r136-trio-precommitment.md, then to 157 by that same
  // document's additive amendment (committed before the second live run): row 28, the
  // `void-method-call` deleting `KeyProbe.Init()`, was reclassified from `killed` to `survived` as
  // EQUIVALENT. `Data Key Probe` has exactly one field, so once the arm's fix gave `Init()` an
  // explicit blank key assignment to precede, `Init()` itself has nothing left to do on either
  // iteration — deleting a no-op is undetectable by any test. Three of the remaining 44 are
  // platform artifacts by construction — a duplicate primary key from a blank `Code[20]` key on a
  // second insert, reached three different ways — and none is tagged by the screen below, which is
  // the measured size of its blind spot (docs/roadmap/R138.md), not evidence that only one platform
  // artifact exists in this run.
  // R134 moved this from 157 to 183. 26 of the 32 new mutants are predicted killed, and FOUR of
  // those are `flip-filter-literal` itself: arm A's `'<>%1'` -> `'=%1'` (rule 1), arm C's `'<%1'` ->
  // `'<=%1'` with a row sitting exactly AT the threshold (rule 2), arm E's `'..%1'` -> `'%1..'`
  // (rule 3), and arm G's `'FLT-G-DECOY|%1'` -> `'%1'` (rule 4). A matching verdict on those four
  // does NOT prove the suite caught them: a mutated filter is DATA that BC re-parses at runtime, and
  // a platform rejection scores `killed` with nothing recording which happened (R86/R138). The
  // wave's real claim rests on the two SURVIVORS and on the arm C / arm D pair, which
  // `assertFilterLiteralEvidence` below pins directly.
  // R141 moved this from 183 to 187: all four of arm I's deployed mutants are predicted killed, and
  // each of the two interesting ones rests on a count MEASURED against Cronus283 before the arm was
  // written (scripts/r141-filter-probe/) — deleting the `SetFilter` counts the blank row too (3, not
  // 2), deleting the `SetRange` counts the out-of-band decoy too (3, not 2). Each kill must carry the
  // arm's own bare `Error(...)` text: a kill whose failure text is a BC filter-evaluation error would
  // mean the character refusal broke and BC was handed `=''`, which is the false kill this arm exists
  // to detect rather than to produce.
  // R132 moved this from 187 to 191: all four of the twin pair's mutants are predicted killed, two
  // by an `Assert.AreEqual` and two by a bare `Error(...)`. Identical verdicts are the CONTROL here
  // — with the verdicts equal, the only thing separating the four is the screen, which is what the
  // arm exists to measure.
  // R161 moved this from 191 to 194: three of the four new guard-clause deletions are killed, each
  // by an `asserterror` whose whole purpose is that guard. `BlankNoValidateFails`,
  // `CategoryGuardNeedsCalcFields` and `TooLongNoValidateFails` all stop seeing an error the moment
  // the `Error(...)` is deleted, which is the most direct kill in the fixture.
  // R163 moves this from 194 to 195. `Data Commit Target.OnRun` guards on
  // `if not DataMain.Get(CommitRunNoLbl) then exit;`. With the `not` gone the Get SUCCEEDS, the
  // trigger exits immediately and never sets `Flagged`, which both covering tests assert by name.
  // Assertion-earned, not a platform artifact: the mutated program completes and simply does less.
  // R159 moves this from 195 to 201. Six of the eight new arithmetic mutants are killed by an
  // assertion that names an exact number: two filter arms whose range inverts and counts nothing,
  // the two halves of `RunUserDefinedBuiltins`'s 372, `Data Validator.TestField`'s accumulator that
  // feeds it, and `Data Swap Ops.Accumulate`'s 15.
  // R171 moves this from 201 to 213. Twelve of its thirteen new mutants are killed: three of the
  // four `negate-guard` guards on existing code (the fourth is in the uncovered pageextension), and
  // all nine in the new arm, whose three tests each assert BOTH directions so nothing there can
  // survive on a one-sided assertion.
  // R159's `flip-boolean-literal` moves this from 213 to 219. Six of its thirteen are killed, all
  // by an assertion that names the field the flipped boolean writes.
  // R159's `remove-assignment` moves this from 219 to 252: 33 of its 52 killed.
  // R159's `toggle-blank-string` moves this from 252 to 259.
  // R159's `shift-integer` moves this from 259 to 267: all eight of the twin pair's mutants kill,
  // for the same reason in both halves (the mutated procedure returns 0 where 1 is expected),
  // which is exactly what makes the pair a control.
  killed: 267,
  // R73 moved this from 9 to 12, and TWO of the three additions are worth reading rather than
  // accepting:
  //
  //   M0012 `remove-commit` in `CommitThenRun` SURVIVED, and that CONTRADICTS R72's premise.
  //     R72 says deleting a `Commit()` before a `Codeunit.Run` makes the platform refuse the call.
  //     Measured on `sandbox-probes` it does — write, then `Codeunit.Run`, in a test method, aborts
  //     with "An error occurred and the transaction is stopped." Measured HERE, with the write and
  //     the `Codeunit.Run` inside an ordinary codeunit called from a test, it does NOT: the call
  //     goes through, the callee flags the row, and both assertions pass. So the artifact is
  //     shape-dependent and the probe's shape did not generalise. Filed on R72; the detector is NOT
  //     built, because there is still nothing real for it to fire on.
  //
  //   M0005 / M0010 `void-method-call` on `DataMain.Init()` survive because deleting `Init()` is
  //     harmless when every field is assigned immediately after. Honest survivors, left as they
  //     are: manufacturing an assertion that kills them would test the fixture, not the operator.
  // R82 moved this from 12 to 17, and FOUR of the five are the point rather than the cost.
  //
  //   DataSwapOps:92 `swap-call-arguments` (arm C) — EQUIVALENT. `or` cannot tell its operands
  //     apart, so no assertion can ever kill it. The covering test is strong (it kills the deletion
  //     at the same site), which is what proves this is equivalence and not missing coverage.
  //   DataSwapOps:116 `swap-call-arguments` (arm D) — UNDERTESTED, and deliberately readable APART
  //     from arm C: the mutant IS observable, the assertion just does not look. One says "your test
  //     is weak here", the other says "this mutant is unkillable", and a real-project report is
  //     full of both.
  //   DataSwapOps:145 / :150 `empty-block` and :146 `void-method-call` — the arm E controls. Its
  //     test asserts nothing, so deleting that call is genuinely unobservable. They are what proves
  //     arm E's KILL came from the swap's runtime overflow and not from anything the test does.
  // R72 moved this from 17 to 18. The addition is `void-method-call` on `CommitThenRunValueForm`'s
  // `DataMain.Init()`, which survives for the same reason the fixture's two other `Init()` deletions
  // do: every field is assigned immediately after, so the deletion is unobservable. Manufacturing an
  // assertion that killed it would test the fixture rather than the operator.
  // R136 moved this from 18 to 24, then to 25 by the same amendment noted above. The seven new
  // survivors are the discrimination evidence the wave exists for, plus one equivalence: arm F's
  // `swap-find-direction` (an existence-only assertion cannot see a direction reversal — the
  // fixture's one deliberate equivalent among the DISCRIMINATION arms), arm B's `swap-modify-flag`
  // (`Insert(false)` still lands a row, so a read-back assertion misses it), arm H's
  // `validate-to-assign` (the assignment leaves the field value correct, so a value-only assertion
  // misses the skipped trigger), and FOUR arm K mutants whose covering test asserts nothing at all:
  // `empty-block` on the procedure body, `empty-block` on the loop body, `void-method-call` deleting
  // the `Insert`, and (added by the amendment) `void-method-call` deleting `Init()` — the last of
  // these is EQUIVALENT rather than undertested, since there is nothing left for `Init()` to do.
  // R134 moved this from 25 to 31. Six of the 32 new mutants are predicted survived, and two of
  // them are the load-bearing predictions of the whole wave, because a survivor cannot be
  // manufactured by a platform error the way a kill can: arm B's `flip-filter-literal` (an
  // existence-only assertion cannot see WHICH group was counted) and arm D's (with a GAP at the
  // boundary the shifted comparator selects the identical row, so the mutant is genuinely
  // EQUIVALENT). The other four are collateral: `void-method-call` at arms B, G and H, and
  // `conditional-boundary` turning arm B's `Count() > 0` into the tautology `Count() >= 0`.
  // R141 leaves this at 31: arm I predicts no survivors. Its blank in-band row and its out-of-band
  // decoy exist precisely so neither collateral deletion can survive on data starvation, which is the
  // shape that made `remove-setrange` survivors uninformative before the fixture seeded decoys.
  // R132 leaves this at 31: both halves of the twin pair assert an exact non-zero value, so an
  // emptied body and a zeroed `exit` are both observable.
  // R161 moved this from 31 to 32, by ONE, and the one is a `covered-but-unreached` case worth
  // knowing: deleting `DataMain.Delete(false)` in `Data Ops.InsertWithoutTrigger` is unobservable
  // because the only covering test calls `DeleteMain('T-INS')` first, so `DataMain.Get(MainNo)`
  // answers `false` and the deleted statement never runs. Coverage is procedure-level, so the site
  // is COVERED and the verdict is `survived` rather than `no-coverage` — the distinction the
  // `reach` field exists to carry.
  // R159 moves this from 32 to 34, and the two are worth reading. `Data Main`'s `Touched` field is
  // incremented by two different `OnValidate` triggers and READ BY NOTHING in the suite — the string
  // does not appear in the test codeunit — so decrementing it instead is invisible. A genuine
  // unasserted behaviour in a fixture that exists to prove operators work, found by arithmetic
  // rather than planted.
  // R159 moves this from 34 to 41, and the seven are the point rather than a regression. Four are
  // behaviours this suite does not assert: `CommitBeforeCodeunitRunSucceeds` checks the row exists
  // and `Flagged` is set but never reads `Amount`, which three of them double through `OnInsert`;
  // and `DeleteRunTriggerLeavesTombstone` checks a RETURN VALUE, not the tombstone's own field.
  //
  // They also answer R159's own point 2, the strongest argument against building this operator:
  // `empty-block` KILLS those procedures while the fine-grained flip SURVIVES. Coarse and fine
  // disagree at the same sites, which is discrimination evidence no aggregate can fake. A survivor
  // count that stayed at 34 would mean the operator added nothing.
  // R159's `remove-assignment` moves this from 41 to 57. Sixteen survivors is the highest any one
  // operator has added here, and it is the expected shape rather than a regression: an assignment
  // whose target is never read again is an equivalent mutant, and nothing in a source-derived layer
  // can see that without dataflow. The operator's doc comment says so before the number arrives.
  // R159's `toggle-blank-string` moves this from 57 to 60: the three `Category := 'A'` arms, whose
  // covering tests assert the row exists and that `Flagged` is set and never read its other fields.
  // R159's `shift-integer` moves this from 60 to 63: the same three `Data Commit Ops` arms every
  // value-mutating operator survives, whose tests assert the row exists and that `Flagged` is set
  // and never read `Amount`.
  survived: 63,
  // R78 moved this from 6 to 9. The three new sites all belong to the TestPage-only pair
  // (`Data Value Source` / `Data Value Card`), and all three land `no-coverage` because the one
  // test that reaches them is refused on the fenced path. That is the measured statement of the
  // gap R69 exists for: the mutants are excluded from the score rather than scored against a test
  // that never ran. If the routed path is ever wired, THESE THREE are what must flip to scored.
  // R70 moved this from 9 to 10: `page 79324 "Data Scope Probe"`'s OnOpenPage `empty-block`. Nothing
  // opens that page — deliberately, R76 measured that a page over a trigger-carrying table can HANG
  // a fenced session — so no-coverage is the honest verdict for it.
  // R82 leaves this at 10 — every one of its 30 new mutants sits in a codeunit the test bodies call
  // directly, so procedure-level attribution should reach all of them. If any arrives `no-coverage`
  // that is an ATTRIBUTION finding, named as one in the spec's §5, and must not be absorbed by
  // adjusting the fixture until it is understood.
  // R72 leaves this at 10 — the new arm sits in a codeunit the new test calls directly, so
  // procedure-level attribution must reach all five of its mutants. Any arriving `no-coverage` is an
  // ATTRIBUTION finding and must not be absorbed by editing this number.
  // R136 leaves this at 10, unchanged — none of the wave's 51 new mutants was predicted
  // no-coverage. Arm I (a table PROCEDURE, not a trigger) was the leading attribution risk: a
  // PUBLIC procedure mutant that misses member-level coverage gets no fallback and is reported
  // no-coverage directly, unlike a trigger mutant's two fallbacks. If it had missed, all four of
  // arm I's mutants would have moved together and the aggregate would read 154/24/14.
  // R134 leaves this at 10, unchanged: all 32 of its new mutants sit inside procedures of
  // `codeunit 79317 "Data Filter Ops"`, each called directly by exactly one new test, so
  // member-level attribution must reach every one of them. Any arriving `no-coverage` is an
  // ATTRIBUTION finding and must not be absorbed by editing this number.
  // R141 leaves this at 10, unchanged, for the same reason: arm I's four mutants sit in a procedure
  // of `codeunit 79317 "Data Filter Ops"` called directly by one new test.
  // R132 leaves this at 10 for the same reason: both new procedures are called directly by their
  // own new test.
  // R165 moves this from 10 to 11, and the new one is NOT killed for a reason worth knowing: the
  // test that would catch it, `PageExtCountsMatchingRelated`, no longer exists. It was removed after
  // being measured twice against Cronus283 to wedge the fenced session — `in-flight-unknown` at
  // baseline, the whole run quarantined. That is why this pageextension's four other mutants are
  // already `no-coverage`; the fifth joins them.
  // R171 moves this from 11 to 12. The new one is `negate-guard` on the same pageextension
  // `OnOpenPage` whose other five mutants are already `no-coverage`, for the reason above: the test
  // that would cover it was removed after wedging the fenced session twice.
  // R159's `remove-assignment` moves this from 12 to 15: three of its sites sit in procedures no
  // test calls.
  noCoverage: 15,
  // 183 / 214 does not reduce (183 is 3 x 61, 214 is 2 x 107). It is about 0.8551, DOWN from
  // 0.8626: a wave that adds six deliberate survivors is SUPPOSED to move the score down, and a
  // score that rose instead would mean the survivors did not arrive.
  // R141 moves it to 187 / 218, about 0.8578, back UP: an arm of four predicted kills and no
  // survivors should raise it. The direction is the readable part, not the digits.
  // R132 moves it to 191 / 222, about 0.8604, up again for the same reason.
  // R161 moves it to 194 / 226, about 0.8584, DOWN slightly. That direction is right and worth
  // stating: three of the four new mutants are killed and one survives, so a wave that is 75% kills
  // still lowers a score sitting at 86%. A score that only ever rises is a score nobody is testing
  // against new ground.
  // R171 moves it to 213 / 247, about 0.8623, UP from 0.8553. An arm of nine predicted kills and
  // no survivors should raise it; a score that fell would mean the arm did not land.
  // R159 moves it to 219 / 260, about 0.8423, DOWN from 0.8623. That direction is the readable
  // part: a wave adding seven deliberate survivors and six kills must lower the score.
  // R159 moves it to 252 / 309, about 0.8155, DOWN from 0.8423 — the right direction for a wave
  // adding 16 survivors against 33 kills.
  // R159 moves it to 259 / 319, about 0.8119 — three survivors against seven kills.
  // R159's `shift-integer` moves it to 267 / 330, about 0.8091, DOWN from 0.8119: an arm of eight
  // kills raises it and three survivors elsewhere lower it, and the survivors win. Worth reading as
  // the direction rather than the digits.
  mutationScore: 267 / (267 + 63),
  /**
   * R72, extended by R138: the screen must fire, and on exactly these mutants under exactly these
   * mechanisms.
   *
   * It was 1 until R138, when `lethal.swap-modify-flag`'s `Insert` mutants gained the second
   * mechanism, and 3 until R143 gave that mechanism a detector. The fixture holds three
   * `Insert(true)` sites — arms A, B and K in `Data Flag Ops` — of which arms A and K are killed
   * and arm B survives, and a survivor at such a site is not screened.
   *
   * R143 TOOK THIS FROM 3 TO 2, and the mutant that left is the point of the change. Arms A and B
   * insert into `Data Trigger Probe`, whose `OnInsert` sets a Boolean and never touches the primary
   * key, so the duplicate-key mechanism is provably unavailable there and arm A's kill is
   * assertion-earned. Arm K inserts into `Data Key Probe`, whose `OnInsert` DOES assign the key.
   * So 1 + 1 = 2, pre-committed in
   * docs/superpowers/specs/2026-08-14-r143-insert-narrowing-precommitment.md before the run.
   *
   * A count alone would be satisfied by the wrong two mutants, so `byMechanism` is pinned by NAME
   * and by MEMBERSHIP below. The write-transaction group in particular must stay at exactly one: a
   * second member there would mean the detector had started claiming the STATEMENT form of
   * `Codeunit.Run`, the shape measured to survive and the false prediction R72 spent a probe
   * correcting.
   */
  platformArtifactKills: 2,
  /**
   * R121: this fixture is the measured VACUOUS case for the assertion screen, and pinning it here is
   * the point rather than an incidental extra.
   *
   * R132 MOVED THIS FROM `vacuous` TO `partial`, deliberately, and the `vacuous` case moved to
   * `itest:bcdev` rather than being given up.
   *
   * Until R132, all 52 tests here raised via bare `Error(...)`, so the rule — "the failure text does
   * not begin with `Assert.`" — flagged EVERY kill and separated nothing, and this gate pinned that.
   * The trouble with pinning only that is that `partial`, the one branch where a reader is told
   * something actionable, then ran in NO live gate at all: it was proven by unit tests and by
   * re-scoring one committed third-party corpus (Continia Document Output, which calls Library
   * Assert ~1,886 times and where the rule scored 100% recall and 26.1% precision).
   *
   * `codeunit 79318 "Data Assert Ops"` and its two tests are a twin pair built to make this fixture
   * produce BOTH kinds of failure text: identical target shape, identical verdicts, one covered by
   * `Library Assert.AreEqual` and one by bare `Error(...)`. So the rule now has something to
   * separate here, and `itest:bcdev` (whose suite is still bare `Error(...)` only) pins the vacuous
   * case. Both states are asserted live, by two gates.
   *
   * A gate that only asserted a COUNT would pass identically whether the report distinguished those
   * two situations or printed the same number for both, which is exactly the failure R121 exists to
   * avoid — so the assertions below pin the two POPULATIONS and the per-mutant membership, not a
   * number.
   */
  assertionScreenDiscrimination: "partial",
  /**
   * `coverageFilter`'s FALLBACK 2 ("coverage places this table trigger nowhere, run every green
   * test") must fire for NOBODY here. This is the assertion `0a463fd` actually earns: before it,
   * member-less coverage observations were discarded, `byObject["table:79300"]` held one
   * accidental test, and trigger mutants ran against a wrong-but-non-empty set. The verdicts
   * alone cannot tell the two regimes apart on this fixture — nearly every test touches
   * `Data Main`, so precise attribution and "run everything" kill the same mutants — which is
   * exactly why the tally has to be asserted rather than admired in a stderr line.
   *
   * A future rise here is not automatically a bug (an honestly unplaceable trigger SHOULD run
   * everything), but it IS a change in what this gate proves, and must be explained before the
   * number is edited.
   */
  untargetedTriggerCount: 0,
  /**
   * R144: the declarative surface LethAL REFUSES to mutate, which R135 ruled out permanently and
   * which the report now has to say out loud.
   *
   * One site, in one file, and both halves are deliberate. `page 79320 "Data Main List"` carries
   * `Enabled = Rec."Modify Count" > 0` — a page PROPERTY whose value is a boolean expression, which
   * tree-sitter yields as the same comparison shape a statement would, so
   * `lethal.conditional-boundary` claims it and `isMutableSite` then drops it. It was added for
   * this gate, and `totalMutantSites` above is UNCHANGED at 252 because of it: a declarative site
   * produces no mutant, which is the entire point.
   *
   * Pinning a real 1 rather than the measured 0 the fixture had before is what makes this
   * assertion mean anything. A gate asserting `siteCount === 0` would pass identically on a build
   * where the count never reached the report at all — the exact "checked, and there was nothing"
   * misreading R144 was filed to prevent.
   *
   * The shapes that DO NOT produce a drop were measured the same day (grammar 4.0.x): `SubPageLink`,
   * `SourceTableView`, `TableRelation ... where(...)`, `DataItemTableFilter` and `RunPageLink` no
   * longer parse as comparison expressions, so no operator claims them and nothing is dropped. A
   * rise above 1 here therefore means the grammar or an operator's targeting changed, not that the
   * fixture grew.
   */
  declarativeSites: {
    siteCount: 1,
    fileCount: 1,
    file: "src/DataMainList.Page.al",
    kinds: "page_declaration",
  },
};

interface LaunchLocalConfig {
  readonly configurations: ReadonlyArray<{
    readonly environmentType?: "OnPrem" | "Sandbox" | "Production";
    readonly environmentName?: string;
  }>;
}

async function readJson<T>(path: string, what: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}. See fixtures/README.md for the expected local-file setup.`,
    );
  }
  return JSON.parse(text) as T;
}

/**
 * `launch.local.json` only supplies `environmentType`/`environmentName`, both optional on the
 * backend. sandbox-data has no `.vscode/` of its own, so a missing file is normal here and must
 * not be an error — but a PRESENT-and-unreadable/corrupt one still is (never swallow that: it
 * would silently target the wrong environment).
 */
async function readOptionalLaunchConfig(): Promise<LaunchLocalConfig["configurations"][number]> {
  let text: string;
  try {
    text = await readFile(LAUNCH_LOCAL_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed = JSON.parse(text) as LaunchLocalConfig;
  return parsed.configurations[0] ?? {};
}

interface RunOnceResult {
  readonly report: SessionReport;
  readonly odataCfg: ActivationConfig;
}

async function runOnce(scratchRoot: string): Promise<RunOnceResult> {
  const launchCfg = await readOptionalLaunchConfig();
  const configFile = await readJson<LethalConfigFile>(
    CONFIG_LOCAL_PATH,
    "lethal.config.local.json",
  );
  const bcdev = validateBcDevConfig(configFile.bcdev);

  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error(
      "could not locate alc.exe/altool.exe under the AL Language VS Code extension install",
    );
  }

  const outputDir = join(scratchRoot, "publish");
  await mkdir(outputDir, { recursive: true });
  const compiler = new ArtifactCompiler(
    {
      alcPath: toolPaths.alcPath,
      packageCachePath: bcdev.packageCachePath,
      outputDir,
    },
    defaultArtifactIo,
  );
  const deployer = new ContainerDeployer(
    {
      altoolPath: toolPaths.altoolPath,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      username: bcdev.username,
      password: bcdev.password,
      ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
    },
    defaultDeployerIo,
  );
  const odataCfg = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const verifier = new DeploymentVerifier(odataCfg);
  const harnessVerifier = new HarnessVerifier(odataCfg);
  const backend = new BcDevMcpBackend(
    {
      mcpCommand: bcdev.mcpCommand,
      project: PROJECT_DIR,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      company: bcdev.company,
      packageCachePath: bcdev.packageCachePath,
      controlSymbolPath: bcdev.controlSymbolPath,
      ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
      ...(launchCfg.environmentType !== undefined
        ? { environmentType: launchCfg.environmentType }
        : {}),
      ...(launchCfg.environmentName !== undefined
        ? { environmentName: launchCfg.environmentName }
        : {}),
      ...(bcdev.env !== undefined ? { env: bcdev.env } : {}),
      // R76's own recorded caveat, fixed 2026-08-08: this script hand-builds the backend config
      // and used to drop `coverageMode`, so the gate could not exercise the very setting R76 was
      // CLOSED by (`procedure`, which routes baseline through the hub and makes a real `TestPage`
      // test survivable). The measurement that closed R76 had to be taken through the direct CLI
      // instead, which means the gate froze a mode the fix does not apply to.
      //
      // Forwarding an absent field is a no-op — `BcDevConfig.coverageMode` falls back to
      // `DEFAULT_COVERAGE_MODE` ("fenced") — so the frozen 109/17/10 is unaffected while the
      // config file has no `coverageMode`. Verified by running the gate with this line in and the
      // config untouched. What it buys is that setting the field in the config file now actually
      // reaches the backend.
      ...(bcdev.coverageMode !== undefined ? { coverageMode: bcdev.coverageMode } : {}),
    },
    undefined,
    { compiler, deployer, verifier, harnessVerifier },
    (targetAppId, artifactId) => new RunMutantTransport(odataCfg, targetAppId, artifactId),
  );

  const store = new ResultsStore(join(PROJECT_DIR, "lethal.sqlite"));
  try {
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir: join(scratchRoot, "instrumented"),
      selectorIds: SELECTOR_IDS,
      // Layer 5C-B1 (design §6): take the machine-global lease before deploying, fence the
      // publish, heartbeat it, carry the tuple into every RunMutant, release at the end —
      // identical to bcdev.itest.ts, since this drives the same fenced server path.
      lease: {
        client: new LeaseClient(odataCfg),
        serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
      },
      resourceServer: bcdev.server,
      resourceServerInstance: bcdev.serverInstance,
      // A SCRATCH quarantine dir, deliberately NOT defaultQuarantineDir() — one transient
      // failure landing in the real ~/.lethal store poisons every later gate run until an
      // operator deletes it by hand (observed live). Same reasoning as bcdev.itest.ts.
      quarantineDir: join(scratchRoot, "quarantine"),
    });
    return { report, odataCfg };
  } finally {
    store.close();
    // Without this the spawned bc-dev MCP child keeps the event loop alive and this script never
    // exits, even on a fully successful run.
    await backend.close();
  }
}

function assertVerdictTable(report: SessionReport): void {
  // Always dump the per-mutant table BEFORE asserting. A bare "survived count mismatch 1 !== 2"
  // says nothing about which mutant moved, and this gate takes minutes to re-run against a live
  // container — so the first run has to carry its own diagnosis.
  console.log(
    `  verdicts: killed=${report.counts.killed} survived=${report.counts.survived} noCoverage=${report.counts.noCoverage} baselineGreen=${report.baselineGreen} score=${report.mutationScore} untargetedTriggers=${report.untargetedTriggerCount} declarativeSites=${report.declarativeSites.siteCount}`,
  );
  for (const m of report.mutants) {
    const cause = m.cause !== undefined ? ` cause=${m.cause}` : "";
    const note = m.failureNote !== undefined ? ` note=${m.failureNote}` : "";
    console.log(
      `    ${m.mutantCode} ${m.verdict}${cause} ${m.file}:${m.line} ${m.operatorName}${note}`,
    );
  }
  if (report.quarantined !== undefined) {
    console.log(`  quarantined: ${JSON.stringify(report.quarantined)}`);
  }

  // R78 turned this from a blanket `baselineGreen === true` into an EXACT statement of the one
  // expected failure. Flipping it to `false` would have been the lazy update and would have gutted
  // the guard: any newly-broken fixture test would then pass unnoticed. The fixture now contains
  // exactly one test that CANNOT run on the fenced path — `PageActionComputesNonZero` opens a
  // TestPage, which this session type refuses — so the honest assertion is "exactly that one fails,
  // by name, for that reason", which still catches every other regression.
  assert.equal(
    report.unsupportedTests.length,
    1,
    `expected exactly 1 baseline failure (the TestPage test), got ${report.unsupportedTests.length}: ${report.unsupportedTests.join(", ")}`,
  );
  assert.equal(
    report.unsupportedTests[0],
    "Data Tests.PageActionComputesNonZero",
    "the only permitted baseline failure is the TestPage test",
  );
  assert.ok(
    report.validity.caveats.includes("tests-testpage-unsupported"),
    "the TestPage refusal must be NAMED in the report, not left as an unexplained baseline failure",
  );
  assert.equal(report.counts.killed, EXPECTED.killed, "killed count mismatch");
  assert.equal(report.counts.survived, EXPECTED.survived, "survived count mismatch");
  assert.equal(report.counts.noCoverage, EXPECTED.noCoverage, "no-coverage count mismatch");
  assert.equal(report.counts.errors, 0, "no mutant may error on the healthy path");
  assert.equal(report.counts.unstable, 0, "no mutant may be unstable on the healthy path");
  assert.equal(report.mutationScore, EXPECTED.mutationScore, "mutation score mismatch");
  assert.equal(
    report.untargetedTriggerCount,
    EXPECTED.untargetedTriggerCount,
    "table trigger mutants took coverageFilter's all-green-tests FALLBACK 2 — object-level " +
      "coverage should place every trigger in this fixture (FALLBACK 1). A non-zero here with " +
      "unchanged verdicts is the signature of the pre-0a463fd bug returning: `byObject` starved, " +
      "attribution silently coarsened, every count identical",
  );
  // R72: the screen, asserted at the same prominence as the counts above and in the same place, so
  // a run that silently stopped naming the platform artifact fails rather than passing quietly.
  //
  // Three separate claims, because they can break independently:
  //   1. the screen fires, on exactly one mutant, under the measured mechanism name;
  //   2. that mutant is the `lethal.remove-commit` in `CommitThenRunValueForm` — not some other
  //      kill that happened to acquire the tag;
  //   3. its verdict is still `killed` and it is still inside `mutationScore`. This is the one that
  //      guards R72's own discipline: a diagnosis must never move a verdict, and the cheapest way
  //      to break that is to start excluding screened kills from the denominator.
  const screen = report.platformArtifactKills;
  assert.ok(
    screen !== undefined,
    "the report must NAME the write-transaction artifact — the fixture holds a `remove-commit` " +
      "site at a value-form `Codeunit.Run`, which BC is measured to refuse, and a run that scores " +
      "that kill without saying why credits a platform refusal to the suite (R72)",
  );
  assert.equal(screen.killedCount, EXPECTED.platformArtifactKills, "screened-kill count mismatch");
  assert.deepEqual(
    screen.byMechanism.map((g) => g.mechanism),
    ["run-trigger-skipped-insert", "write-txn-codeunit-run"],
    "both mechanisms must be present and named — R138 added the second, and the report sorts them",
  );
  const groupOf = (mechanism: string) => {
    const g = screen.byMechanism.find((x) => x.mechanism === mechanism);
    assert.ok(g !== undefined, `no ${mechanism} group in the screen`);
    return g;
  };
  const mutantOf = (code: string) => {
    const m = report.mutants.find((x) => x.mutantCode === code);
    assert.ok(m !== undefined, `screened mutant ${code} is not in the report's own mutant list`);
    return m;
  };
  // Mechanism 1, R72 — unchanged by R138, and asserted as such rather than assumed.
  const writeTxn = groupOf("write-txn-codeunit-run");
  assert.equal(writeTxn.mutants.length, 1, "the write-transaction mechanism screens exactly one");
  const [screenedCode] = writeTxn.mutants;
  const screened = mutantOf(screenedCode ?? "");
  assert.equal(screened.operatorName, "lethal.remove-commit", "screened mutant's operator");
  assert.equal(
    screened.procedureName,
    "CommitThenRunValueForm",
    "the screened mutant must be the VALUE-FORM arm — `CommitThenRun` uses the statement form, " +
      "which is measured NOT to abort, and tagging it would re-assert the prediction the r72 probe " +
      "falsified",
  );
  assert.equal(
    screened.verdict,
    "killed",
    "a diagnosis must NEVER move a verdict (R72/R121) — this mutant stays `killed`",
  );
  // Mechanism 2, R138. Pinned BY MUTANT, because a count of two is satisfied by the wrong two: the
  // fixture has three `Insert(true)` sites and the interesting fact is exactly WHICH of them the
  // screen holds — arms A and K (both killed), never arm B (which survives, and a survivor at such
  // a site is just a survivor), and never the `Delete` or either `Modify` site, which the R138
  // ruling says get no mechanism at all.
  const insertGroup = groupOf("run-trigger-skipped-insert");
  const insertScreened = insertGroup.mutants.map(mutantOf);
  assert.equal(insertScreened.length, 1, "the Insert mechanism screens exactly one kill");
  for (const m of insertScreened) {
    assert.equal(
      m.operatorName,
      "lethal.swap-modify-flag",
      "only `swap-modify-flag` declares the Insert mechanism",
    );
    assert.ok(
      /\.?insert\s*\(\s*true/i.test(m.originalText ?? ""),
      `screened mutant ${m.mutantCode} is not at an Insert(true) site: ${m.originalText}`,
    );
    assert.equal(
      m.verdict,
      "killed",
      "a diagnosis must NEVER move a verdict (R72/R121) — these stay `killed`",
    );
  }
  assert.deepEqual(
    insertScreened.map((m) => m.procedureName).sort(),
    ["InsertTwiceWithKeyTrigger"],
    "the ONE screened Insert kill is arm K, and R143 is why the list is one name rather than two. " +
      "Arm K is the genuine platform artifact: `Data Key Probe`'s OnInsert assigns the primary " +
      "key, its covering test asserts nothing, and the kill is a duplicate key. Arm A " +
      "(`InsertWithTrigger`) LEFT this group when the detector landed — `Data Trigger Probe`'s " +
      "OnInsert sets a Boolean and never touches the key, so the mechanism is provably " +
      "unavailable there and its kill is assertion-earned. Arm A reappearing here means the " +
      "detector stopped resolving the receiver's table; arm K disappearing means it started " +
      "refusing a table it can resolve, which is the direction that credits a platform refusal to " +
      "the suite",
  );
  // The two mechanisms must not share one explanation: the reader would be told a duplicate-key
  // artifact was measured on Cronus281 as a write-transaction abort.
  assert.ok(
    insertGroup.explanation.includes("duplicate primary key"),
    "the Insert mechanism must explain ITS own mechanism",
  );
  assert.ok(
    writeTxn.explanation.includes("return value is consumed"),
    "the write-transaction mechanism must keep its own measured explanation",
  );
  assert.ok(
    report.validity.caveats.includes("platform-artifact-kills"),
    "the screen must also appear as a caveat, or `lethal explain` projects nothing for it",
  );

  // R121 — the assertion screen, pinned as the VACUOUS case. See EXPECTED's comment for why that
  // is the interesting assertion on this fixture.
  const assertionScreen = report.assertionScreen;
  assert.ok(assertionScreen !== undefined, "a run with 183 kills must carry an assertion screen");
  assert.ok(
    assertionScreen.killsWithText > 0,
    "every kill on this path records its failure text (R86) — a zero here means the text stopped " +
      "being recorded, and the screen would then be reporting `no-text` about a suite it never read",
  );
  assert.equal(
    assertionScreen.discrimination,
    EXPECTED.assertionScreenDiscrimination,
    "R132: this fixture now raises BOTH ways — 52 tests through bare `Error(...)` and one through " +
      "Microsoft's Library Assert — so the screen must report that it separated something. A " +
      "`vacuous` here means the Library Assert arm stopped killing anything, or its failure text " +
      "stopped reaching `killingTestFailure`, and the branch this gate exists to exercise is dark " +
      "again",
  );
  // R132: both populations must be non-empty, asserted directly so the discrimination label and the
  // numbers behind it cannot disagree — and so a future change that empties either side fails here
  // rather than quietly reverting this gate to the vacuous case it used to pin.
  assert.ok(
    assertionScreen.flagged > 0,
    `partial requires flagged kills; got flagged=${assertionScreen.flagged}`,
  );
  assert.ok(
    assertionScreen.killsWithText - assertionScreen.flagged > 0,
    `partial requires UNflagged kills — the Library Assert arm — got killsWithText=${assertionScreen.killsWithText} flagged=${assertionScreen.flagged}`,
  );
  assertAssertionScreenTwinPair(report, assertionScreen.flaggedMutants);
  assertBlankStringScreenSeparates(report, assertionScreen.flaggedMutants);
  assertShiftScreenTwinPair(report, assertionScreen.flaggedMutants);
  assert.equal(
    assertionScreen.runnerRefusals,
    0,
    "al-runner's `out-of-scope:` marker cannot appear on the bcdev path",
  );
  // R144: the declarative refusal, pinned at the same prominence as the counts — R135's ruling is
  // "refuse the class permanently AND say so in the report", and a ruling the report never states
  // is a decision the product never communicates. Asserted per FILE, not as a bare total: a total
  // alone would be satisfied by a drop somewhere else in the fixture.
  assert.equal(
    report.declarativeSites.siteCount,
    EXPECTED.declarativeSites.siteCount,
    "declarative-site count mismatch — the fixture holds exactly one page property LethAL refuses " +
      "to mutate (`Data Main List`'s `Enabled`). A 0 means the count stopped reaching the report; " +
      "a rise means an operator started claiming declarative shapes it did not claim before",
  );
  assert.equal(
    report.declarativeSites.fileCount,
    EXPECTED.declarativeSites.fileCount,
    "declarative-site file count mismatch",
  );
  const declarative = report.declarativeSites.files[0];
  assert.ok(
    declarative !== undefined,
    "the declarative-site list must name its file, not just count it",
  );
  assert.equal(
    declarative.file.replaceAll("\\", "/"),
    EXPECTED.declarativeSites.file,
    "the declarative site must be the one the fixture put there, not some other file's",
  );
  assert.equal(
    declarative.kinds,
    EXPECTED.declarativeSites.kinds,
    "declarative-site kind mismatch",
  );
  assert.equal(
    declarative.sites,
    EXPECTED.declarativeSites.siteCount,
    "per-file declarative count mismatch",
  );
  assert.ok(
    report.validity.caveats.includes("declarative-sites-dropped"),
    "a run that declined a declarative site must CARRY the caveat — the count without the caveat " +
      "leaves a reader to discover the refusal by reading a number they were never pointed at",
  );
  // Per-mutant verdicts are asserted by `assertMatchesBaseline` (tables.baseline.json), not here
  // — see EXPECTED's doc comment for why the old inline 7-entry map was removed rather than
  // extended by hand.
}

/**
 * Every mutant of every artifact this run actually deployed, keyed by mutant id.
 *
 * `MutantOutcome` (report.ts) carries neither `triggerName` nor `objectType`, so the report alone
 * cannot say whether a verdict landed on a TRIGGER site — the one claim Phase 0 exists to prove.
 * The manifest can: `prepareArtifactDir` writes one `mutant-manifest.json` per artifact into
 * `<instrumentedDir>/run-<runId>-batch-<n>/`, from the same `triggerNameOf`/`objectHeaderOf`
 * attribution the coverage key uses.
 *
 * `run-…-batch-<n>-bisect` dirs are excluded by the `\d+$` anchor: those hold NARROWED subsets
 * written while searching for a compile-failure culprit, not the deployed set.
 */
async function readDeployedManifests(
  instrumentedDir: string,
): Promise<Map<string, MutantManifestEntry>> {
  const byId = new Map<string, MutantManifestEntry>();
  const entries = await readdir(instrumentedDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || !/^run-.+-batch-\d+$/.test(e.name)) continue;
    const raw = await readFile(join(instrumentedDir, e.name, "mutant-manifest.json"), "utf8");
    for (const m of (JSON.parse(raw) as MutantManifest).mutants) byId.set(m.mutantId, m);
  }
  if (byId.size === 0) {
    const why =
      "cannot verify trigger attribution, and passing without verifying it is exactly the " +
      "failure this gate exists to catch";
    throw new Error(`no deployed mutant-manifest.json found under ${instrumentedDir} — ${why}`);
  }
  return byId;
}

/**
 * The exit criterion, asserted rather than described: a kill AND a survive on TRIGGER sites
 * specifically. A kill alone can come from a runtime error unrelated to any assertion, and an
 * all-survive table proves nothing about activation. Both killed trigger mutants live in a
 * field-level `OnValidate`; the surviving M0003 is the object-level `OnInsert`.
 *
 * Trigger-ness comes from the deployed manifest, not from the mutant's file name: the file-name
 * check this replaced could not fail (the fixture holds only `DataMain`/`DataNoTrigger`), so it
 * asserted nothing at all.
 */
async function assertTriggerKillAndSurvive(
  report: SessionReport,
  byId: ReadonlyMap<string, MutantManifestEntry>,
): Promise<void> {
  const sited = report.mutants.map((m) => {
    const entry = byId.get(m.mutantCode);
    if (entry === undefined) {
      // Report and deployed artifact disagree about which mutants exist — never "close enough".
      throw new Error(
        `mutant ${m.mutantCode} appears in the report but in no deployed mutant-manifest.json`,
      );
    }
    return { code: m.mutantCode, verdict: m.verdict, entry };
  });
  const triggers = sited.filter((s) => s.entry.triggerName !== undefined);
  console.log(
    `  trigger-sited mutants: ${
      triggers
        .map((t) => `${t.code}=${t.verdict} (${t.entry.objectType} ${t.entry.triggerName})`)
        .join(", ") || "(none)"
    }`,
  );

  assert.ok(
    triggers.some((t) => t.verdict === "killed"),
    "no KILLED mutant sits at a trigger site (manifest `triggerName` set) — Phase 0's claim is " +
      "that a mutation inside a table trigger is generated, attributed, executed AND killed",
  );
  assert.ok(
    triggers.some((t) => t.verdict === "survived"),
    "no SURVIVED mutant sits at a trigger site — without one, an all-kill table could equally " +
      "be explained by the whole tier erroring out rather than by real activation",
  );
  // R30: the fixture now also holds a `pageextension` whose `OnOpenPage` is a trigger site, so
  // "every trigger here is a table trigger" is no longer true and asserting it would only pin the
  // fixture's file list. What this loop is FOR is narrower — a trigger mutant must be attributed to
  // the object that declares it, because a mis-keyed `(objectType, objectId)` sends it at the wrong
  // object's tests (R29's shape, and the reason `6e89948` keyed coverage on the pair rather than on
  // the bare id). So the check is now per-mutant: the manifest's objectType must equal the kind the
  // mutant's own SOURCE FILE declares.
  //
  // Read from the source HEADER, not from the file NAME. A name-suffix map (`.PageExt.al` ->
  // pageextension, everything else -> table) was written first and is wrong in a way that only
  // shows up later: a codeunit `OnRun` or a plain page trigger is a trigger site too, and the map
  // would call it `table` and fail a correct run. Reading the header keeps the check independent of
  // the manifest (which comes from the AL parse) while surviving any object kind the fixture grows.
  for (const t of triggers) {
    const source = await readFile(join(PROJECT_DIR, "src", basename(t.entry.file)), "utf8");
    const header = /^\s*(table|codeunit|page|report|tableextension|pageextension)\s+\d+/im.exec(
      source,
    );
    assert.ok(
      header !== null,
      `${t.code}: cannot read an object header out of ${t.entry.file}, so its attribution cannot be checked — and passing without checking is what this assertion exists to prevent`,
    );
    assert.equal(
      t.entry.objectType,
      header[1]?.toLowerCase(),
      `${t.code}: trigger site attributed to objectType ${t.entry.objectType}, but ${t.entry.file} declares a ${header[1]}`,
    );
  }
}

/**
 * R136: `astSubtreeHash` alpha-renames identifiers, so `Insert` and `Delete` hash identically to
 * each other, as do `FindFirst` and `FindLast` — and the baseline's semantic-identity key
 * (astHash/codeunitName/operatorName/operatorMajor) carries no site text at all. So nothing frozen
 * in `tables.baseline.json` can distinguish a claimed `Delete` site from a claimed `Insert` one, or
 * a `FindLast` rewrite from a `FindFirst` one — both members of each pair collapse into the same
 * key. These four assertions read `report.mutants` directly, which DOES carry `originalText`/
 * `mutatedText`, to pin what the collapsed baseline key structurally cannot.
 */
function assertTrioTextEvidence(report: SessionReport): void {
  const killedMutantWith = (
    operatorName: string,
    field: "originalText" | "mutatedText",
    needle: string,
  ) =>
    report.mutants.some(
      (m) => m.operatorName === operatorName && m.verdict === "killed" && m[field].includes(needle),
    );

  assert.ok(
    killedMutantWith("lethal.swap-modify-flag", "originalText", "Insert(true)"),
    "expected a killed lethal.swap-modify-flag mutant whose originalText contains Insert(true) — " +
      "the Insert half of the 1.1.0 extension (arm A), which the collapsed baseline key cannot see " +
      "apart from the Delete half",
  );
  assert.ok(
    killedMutantWith("lethal.swap-modify-flag", "originalText", "Delete(true)"),
    "expected a killed lethal.swap-modify-flag mutant whose originalText contains Delete(true) — " +
      "the Delete half of the 1.1.0 extension (arm C), which the collapsed baseline key cannot see " +
      "apart from the Insert half",
  );
  assert.ok(
    killedMutantWith("lethal.swap-find-direction", "mutatedText", "FindLast"),
    "expected a killed lethal.swap-find-direction mutant whose mutatedText contains FindLast — the " +
      "FindFirst -> FindLast direction (arm D), which the collapsed baseline key cannot see apart " +
      "from the other direction",
  );
  assert.ok(
    killedMutantWith("lethal.swap-find-direction", "mutatedText", "FindFirst"),
    "expected a killed lethal.swap-find-direction mutant whose mutatedText contains FindFirst — the " +
      "FindLast -> FindFirst direction (arm E), which the collapsed baseline key cannot see apart " +
      "from the other direction",
  );
}

/**
 * R132: the twin pair, pinned by MEMBERSHIP rather than by any count.
 *
 * `codeunit 79318 "Data Assert Ops"` holds two procedures of identical shape. `DoubledLevel` is
 * covered by a test that raises through Microsoft's `Library Assert`, `TripledLevel` by one that
 * raises through bare `Error(...)`. Every one of their four mutants is killed, so the VERDICTS are a
 * control: the only thing that differs is which side of the screen each kill lands on.
 *
 * Asserting `discrimination === "partial"` alone would pass if the screen split the fixture
 * somewhere else entirely — say if a BC platform error started killing an unrelated mutant with text
 * that happens to begin with `Assert.`. Naming the four mutants is what makes this an assertion
 * about the RULE.
 */
/**
 * R159: the assertion screen, measured ON `toggle-blank-string` rather than assumed.
 *
 * That operator declares no `PlatformKillMechanism`, and two of its kills here die on a DUPLICATE
 * PRIMARY KEY with nothing asserted — the shape R138 tagged for `swap-modify-flag`'s `Insert`. The
 * ruling is that changing a written VALUE is ordinary changed behaviour and R121's screen is what
 * tells a reader such a kill carried no assertion.
 *
 * Its spike could not test that ruling: every kill it produced was flagged, because this suite raises
 * through bare `Error(...)` and the rule has nothing to separate on. `Data Blank Ops.ClassifyCode`
 * exists so it does — killed through `Library Assert`, beside two duplicate-key kills.
 *
 * Pinned BY MUTANT, never by a count: a flagged total reads identically whether the screen separated
 * anything or not, which is the whole failure mode R132 built the twin pair to prevent.
 */
function assertBlankStringScreenSeparates(
  report: SessionReport,
  flaggedMutants: readonly string[],
): void {
  const flagged = new Set(flaggedMutants);
  const CASES = [
    // procedure, how its kill is produced, whether the screen must flag it
    ["ClassifyCode", "Assert.AreEqual (Library Assert)", false],
    ["InsertTwiceWithKeyTrigger", "a duplicate primary key, nothing asserted", true],
    ["OnInsert", "a duplicate primary key, nothing asserted", true],
  ] as const;

  for (const [procedureName, how, mustBeFlagged] of CASES) {
    const mutants = report.mutants.filter(
      (m) =>
        m.operatorName === "lethal.toggle-blank-string" &&
        (m.procedureName === procedureName || m.triggerName === procedureName),
    );
    assert.equal(
      mutants.length,
      1,
      `${procedureName}: expected exactly one toggle-blank-string mutant, got ${mutants.length}`,
    );
    const m = mutants[0];
    assert.ok(m !== undefined, `${procedureName}: mutant missing`);
    assert.equal(m.verdict, "killed", `${procedureName}: verdict`);
    assert.equal(
      flagged.has(m.mutantCode),
      mustBeFlagged,
      `${procedureName} is killed by ${how}, so the assertion screen must ${mustBeFlagged ? "" : "NOT "}` +
        `flag it. Both directions must hold or the screen separated nothing here. killingTestFailure: ` +
        `${JSON.stringify(m.killingTestFailure ?? null)}`,
    );
  }
}

/**
 * R159: the assertion screen, measured ON `shift-integer`, and on three other operators for free.
 *
 * `Data Shift Ops` is a TWIN PAIR in R132's sense: `BandedViaAssert` and `BandedViaError` are
 * identical in shape and differ only in how their covering test raises. The shape yields FOUR
 * mutants per half (`empty-block`, `negate-conditional`, `shift-integer`, `return-value`), and every
 * one of the eight kills for the same reason: the mutated procedure returns 0 where 1 is expected.
 *
 * That is what makes this a control rather than eight observations. The verdicts are constant across
 * the pair, so the ONLY variable is which side of the screen each kill lands on, and a difference
 * cannot be blamed on the mutants differing. A per-operator loop over both halves is the assertion;
 * a count of flagged kills would read identically if the screen had separated nothing.
 */
function assertShiftScreenTwinPair(report: SessionReport, flaggedMutants: readonly string[]): void {
  const flagged = new Set(flaggedMutants);
  const OPERATORS = [
    "lethal.empty-block",
    "lethal.negate-conditional",
    "lethal.shift-integer",
    "lethal.return-value",
  ] as const;
  const HALVES = [
    // procedure, how its covering test raises, whether the screen must flag its kills
    ["BandedViaAssert", "Library Assert", false],
    ["BandedViaError", "a bare Error(...)", true],
  ] as const;

  for (const [procedureName, how, mustBeFlagged] of HALVES) {
    for (const operatorName of OPERATORS) {
      const mutants = report.mutants.filter(
        (m) => m.operatorName === operatorName && m.procedureName === procedureName,
      );
      assert.equal(
        mutants.length,
        1,
        `${procedureName}/${operatorName}: expected exactly one mutant, got ${mutants.length}. The two halves must stay identical in shape or they are no longer a control.`,
      );
      const m = mutants[0];
      assert.ok(m !== undefined, `${procedureName}/${operatorName}: mutant missing`);
      assert.equal(
        m.verdict,
        "killed",
        `${procedureName}/${operatorName}: every mutant of this pair must be killed. A survivor here makes the screen evidence worthless, because a screen difference could then be a verdict difference.`,
      );
      assert.equal(
        flagged.has(m.mutantCode),
        mustBeFlagged,
        `${procedureName}/${operatorName} is killed through ${how}, so the screen must ${mustBeFlagged ? "" : "NOT "}flag it. Both directions must hold across all four operators, or the screen is reading something other than the assertion style. killingTestFailure: ${JSON.stringify(m.killingTestFailure ?? null)}`,
      );
    }
  }
}

function assertAssertionScreenTwinPair(
  report: SessionReport,
  flaggedMutants: readonly string[],
): void {
  const flagged = new Set(flaggedMutants);
  const TWINS = [
    // procedure, how its covering test raises, whether the screen must flag its kills
    ["DoubledLevel", "Library Assert", false],
    ["TripledLevel", "bare Error(...)", true],
  ] as const;

  for (const [procedureName, style, mustBeFlagged] of TWINS) {
    const mutants = report.mutants.filter((m) => m.procedureName === procedureName);
    assert.deepEqual(
      mutants.map((m) => m.operatorName).sort(),
      ["lethal.empty-block", "lethal.return-value"],
      `${procedureName}: expected exactly its two mutants, got ${mutants.map((m) => `${m.operatorName}=${m.verdict}`).join(", ")}`,
    );
    for (const m of mutants) {
      assert.equal(m.verdict, "killed", `${procedureName} (${m.operatorName}): verdict`);
      assert.equal(
        flagged.has(m.mutantCode),
        mustBeFlagged,
        `${procedureName} (${m.operatorName}) is killed by a test raising through ${style}, so the ` +
          `assertion screen must ${mustBeFlagged ? "" : "NOT "}flag it. killingTestFailure: ${JSON.stringify(m.killingTestFailure ?? null)}`,
      );
    }
  }
}

/**
 * R134: the six `lethal.flip-filter-literal` sites, pinned by TEXT and by the verdict of the
 * `void-method-call` sharing each span.
 *
 * Why this exists when `tables.baseline.json` already keys per mutant. Two reasons, and the second
 * is the load-bearing one.
 *
 *   1. The baseline is RE-RECORDED by the run that first measures a fixture growth, so it cannot
 *      catch anything on that run: it blesses whatever arrived. These assertions are what carried a
 *      prediction into the run rather than out of it, and they stay readable afterwards.
 *   2. The baseline's key (astHash/codeunitName/operatorName/operatorMajor) carries no site text and
 *      no PAIRING. The wave's whole claim is that this operator tells a strong test from a weak one,
 *      and the evidence for that is not a count: it is arm C and arm D, identical rule and identical
 *      mutation shape with OPPOSITE verdicts, plus two spans where the Tier-2 splice and the Tier-1
 *      deletion disagree in opposite directions (arm D flip survives while the deletion is killed;
 *      arm G flip is killed while the deletion survives). No aggregate can fake that pairing and no
 *      baseline row expresses it.
 *
 * The `void` column also carries the dedup coexistence claim (§2.7 of the design): this operator
 * sets `before` to the whole CALL, exactly as `void-method-call` does, but its `after.text` is a
 * splice and never the empty string, so the two identities differ by that one field and neither
 * displaces the other. If any arm below loses its `void-method-call`, dedup started treating a
 * splice and a deletion as the same identity, a wider regression than this wave.
 *
 * Arm H (`CountInRange`) is deliberately absent: a CLOSED range classifies fine but no rule in the
 * ladder targets it, so the site must refuse by ladder exhaustion. A seventh flip mutant means that
 * deferral broke; a fifth means an arm's shape stopped classifying.
 *
 * R141: arm I (`CountTaggedInBand`) is absent for a DIFFERENT reason, and keeping the two apart is
 * the point of asserting both. Its literal carries an inner quote (`'<>'''''`, the `<>''` not-blank
 * idiom), so `REFUSED_CHARACTERS` declines the string before anything is classified — the character
 * refusal, which no gate exercised until this arm. Arm H proves the ladder can exhaust; arm I proves
 * the parser can refuse. A flip mutant at arm I would mean BC was handed a filter the mini-parser
 * never validated, whose likely runtime rejection would score `killed` with no assertion earning it
 * (R86, R138) — a false kill dressed as a pass.
 */
function assertFilterLiteralEvidence(report: SessionReport): void {
  const FILTER_ARMS = [
    // arm, procedure, the literal before -> after, the flip's verdict, and the verdict of the
    // `void-method-call` deleting the SAME `SetFilter` call.
    ["A", "CountExcluding", "'<>%1'", "'=%1'", "killed", "killed"],
    ["B", "AnyExcluding", "'<>%1|FLT-NONE'", "'=%1|FLT-NONE'", "survived", "survived"],
    ["C", "CountBelowThreshold", "'<%1'", "'<=%1'", "killed", "killed"],
    ["D", "CountBelowThresholdSparse", "'<%1|999999999'", "'<=%1|999999999'", "survived", "killed"],
    ["E", "CountUpToBound", "'..%1'", "'%1..'", "killed", "killed"],
    ["G", "CountDecoyOrTarget", "'FLT-G-DECOY|%1'", "'%1'", "killed", "survived"],
  ] as const;

  const flips = report.mutants.filter((m) => m.operatorName === "lethal.flip-filter-literal");
  console.log(
    `  flip-filter-literal: ${flips.map((m) => `${m.procedureName}=${m.verdict}`).join(", ") || "(none)"}`,
  );
  assert.equal(
    flips.length,
    FILTER_ARMS.length,
    `expected exactly ${FILTER_ARMS.length} lethal.flip-filter-literal mutants (one per arm A, B, C, D, E and G), got ${flips.length} at ${flips.map((m) => m.procedureName).join(", ")}`,
  );
  assert.deepEqual(
    flips.filter((m) => m.procedureName === "CountInRange").map((m) => m.mutantCode),
    [],
    "arm H's CLOSED range must emit NO flip-filter-literal mutant: it classifies successfully and " +
      "then exhausts the ladder, which is the refusal negative this arm exists to be",
  );
  assert.deepEqual(
    flips.filter((m) => m.procedureName === "CountTaggedInBand").map((m) => m.mutantCode),
    [],
    "arm I's INNER QUOTE must emit NO flip-filter-literal mutant: `REFUSED_CHARACTERS` declines the " +
      "string before classification, a different refusal from arm H's ladder exhaustion (R141)",
  );

  // Arm I's own collateral mutants, and the failure text that earned each kill. Asserting the
  // verdicts alone would pass if BC had rejected a spliced filter instead of the test asserting
  // anything, which is the exact false kill this arm exists to detect.
  //
  // R159 made this FIVE. `lethal.swap-additive` claims the arm's `LowBound + 3`, and it belongs
  // here: mutated, the `SetRange` becomes `79200..79197`, an inverted range that matches nothing,
  // so the arm's own count assertion fires. The list is pinned by NAME rather than by length
  // precisely so a new operator arriving at a measured arm is a deliberate edit with a reason,
  // never a silent widening.
  const armI = report.mutants.filter((m) => m.procedureName === "CountTaggedInBand");
  assert.deepEqual(
    armI.map((m) => m.operatorName).sort(),
    [
      "lethal.empty-block",
      "lethal.remove-setrange",
      "lethal.return-value",
      "lethal.swap-additive",
      "lethal.void-method-call",
    ],
    `arm I (CountTaggedInBand): expected exactly its five collateral mutants, got ${armI.map((m) => `${m.operatorName}=${m.verdict}`).join(", ")}`,
  );
  for (const m of armI) {
    assert.equal(m.verdict, "killed", `arm I (${m.operatorName}): verdict`);
    assert.ok(
      (m.killingTestFailure ?? "").includes("non-blank rows in the band"),
      `arm I (${m.operatorName}): the kill must carry the arm's own assertion text, got ${JSON.stringify(m.killingTestFailure ?? null)}`,
    );
  }

  for (const [arm, procedureName, before, after, flipVerdict, voidVerdict] of FILTER_ARMS) {
    const inArm = report.mutants.filter((m) => m.procedureName === procedureName);
    const [flip, ...extraFlips] = inArm.filter(
      (m) => m.operatorName === "lethal.flip-filter-literal",
    );
    assert.ok(flip !== undefined, `arm ${arm} (${procedureName}): no flip-filter-literal mutant`);
    assert.deepEqual(
      extraFlips.map((m) => m.mutantCode),
      [],
      `arm ${arm} (${procedureName}): more than one flip-filter-literal mutant`,
    );
    assert.ok(
      flip.originalText.includes(before),
      `arm ${arm}: flip's originalText must carry the literal ${before}, got ${flip.originalText}`,
    );
    assert.ok(
      flip.mutatedText.includes(after),
      `arm ${arm}: flip's mutatedText must carry the literal ${after}, got ${flip.mutatedText}`,
    );
    assert.equal(flip.verdict, flipVerdict, `arm ${arm} (${procedureName}): flip verdict`);

    // The `void-method-call` sharing this span, matched on the SetFilter text so an arm's OTHER
    // statement-position deletions (the SetRange on arms C, D, E and H) cannot answer for it.
    const [voided, ...extraVoids] = inArm.filter(
      (m) => m.operatorName === "lethal.void-method-call" && m.originalText.includes("SetFilter"),
    );
    assert.ok(
      voided !== undefined,
      `arm ${arm} (${procedureName}): the SetFilter span carries a flip but NO void-method-call, so dedup has started treating a splice and a deletion as one identity`,
    );
    assert.deepEqual(
      extraVoids.map((m) => m.mutantCode),
      [],
      `arm ${arm} (${procedureName}): more than one void-method-call on a SetFilter`,
    );
    assert.equal(
      voided.verdict,
      voidVerdict,
      `arm ${arm} (${procedureName}): the SetFilter deletion's verdict. Arms D and G are the two spans where it disagrees with the flip, in opposite directions, and that disagreement is the evidence no aggregate count can produce`,
    );
  }
}

async function main(): Promise<void> {
  // PROJECT_DIR, not `<PROJECT_DIR>/src` — `runSession` generates from `cfg.projectDir`, so
  // scanning anything else would let this header describe a different file set than the run
  // below it actually executes.
  const { files } = await generateMutationSet(PROJECT_DIR);
  const total = files.reduce((n, f) => n + f.specs.length, 0);
  assert.equal(
    total,
    EXPECTED.totalMutantSites,
    `expected ${EXPECTED.totalMutantSites} mutant sites across the table fixture, generated ${total} — either the fixture changed or a tier-1 operator's targeting changed; update fixtures/README.md`,
  );

  // R9: runs the session TWICE and asserts verdict-identity, matching itest:bcdev/itest:alrunner
  // — a single run left cross-run nondeterminism here indistinguishable from a confusing
  // per-mutant baseline mismatch instead of an explicit determinism failure.
  const scratchA = await mkdtemp(join(tmpdir(), "lethal-itest-tables-a-"));
  const scratchB = await mkdtemp(join(tmpdir(), "lethal-itest-tables-b-"));
  try {
    const first = await runOnce(scratchA);
    assertVerdictTable(first.report);
    // The trigger claim itself, read off the manifests the run actually deployed (the scratch
    // dir is still on disk here — it is removed in the `finally` below).
    await assertTriggerKillAndSurvive(
      first.report,
      await readDeployedManifests(join(scratchA, "instrumented")),
    );
    // R136: the four durable text-based assertions the collapsed baseline key cannot express.
    assertTrioTextEvidence(first.report);
    // R134: the six flip-filter-literal arms, their texts, and the pairing with each span's
    // void-method-call: the wave's discrimination claim, which no baseline row can express.
    assertFilterLiteralEvidence(first.report);
    // Per-mutant regression guard against the committed baseline, keyed on semantic identity
    // (astHash/codeunitName/operatorName/operatorMajor) rather than mutant code — so it survives
    // renumbering that the EXPECTED.verdicts map above deliberately does not.
    await assertMatchesBaseline(first.report, BASELINE_PATH, "tables itest");

    const second = await runOnce(scratchB);
    assertVerdictTable(second.report);
    await assertTriggerKillAndSurvive(
      second.report,
      await readDeployedManifests(join(scratchB, "instrumented")),
    );
    assertTrioTextEvidence(second.report);
    assertFilterLiteralEvidence(second.report);

    const shape = (r: SessionReport) =>
      [...r.mutants]
        .map((m) => ({ mutantCode: m.mutantCode, verdict: m.verdict, killingTest: m.killingTest }))
        .sort((a, b) => a.mutantCode.localeCompare(b.mutantCode));
    assert.deepEqual(
      shape(first.report),
      shape(second.report),
      "two consecutive runs must be 100% verdict-identical (determinism exit criterion) — R9: " +
        "cross-run nondeterminism here must surface as an explicit determinism failure, not a " +
        "confusing per-mutant baseline mismatch",
    );
  } finally {
    await rm(scratchA, { recursive: true, force: true });
    await rm(scratchB, { recursive: true, force: true });
  }

  console.log("tables itest: PASS");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
