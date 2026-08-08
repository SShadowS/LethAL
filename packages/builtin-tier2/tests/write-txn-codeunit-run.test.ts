import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R72 — the site tag that says a `lethal.remove-commit` kill would be BC's refusal rather than an
 * assertion.
 *
 * Every case below is stated in terms of the MEASUREMENT that decides it
 * (`scripts/r72-probe/`, `docs/measurements/README.md` §R72): with a write transaction open, a
 * `Codeunit.Run` whose return value is CONSUMED aborts the whole transaction, in both call frames,
 * with and without a prior `Commit()`; the bare statement form does not, in any cell. The tag is
 * therefore about ONE thing — is the return value consumed — and these tests exist to keep it
 * about that one thing rather than about the shapes that happened to be in the fixture.
 *
 * The tag never moves a verdict. That property is not testable here (this layer has no verdicts);
 * `report.test.ts` pins it on the report instead.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  findAll,
  initParser,
} from "@lethal/engine";
import { removeCommit } from "../src/remove-commit";
import { contextFor, parseClean } from "./parse-clean";

function specsFor(sourceAL: string) {
  const root = parseClean(sourceAL);
  const ctx: SemanticContext = contextFor(root);
  const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
  return calls
    .filter((n) => removeCommit.targets(n, ctx))
    .flatMap((n) => removeCommit.generate(n, ctx));
}

function mechanismsFor(sourceAL: string): Array<string | undefined> {
  return specsFor(sourceAL).map((s) => s.platformKillMechanism);
}

describe("remove-commit — platformKillMechanism (R72)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("tags the assignment form, which is the shape the 2x2x2 measured as aborting", () => {
    const src = `codeunit 50200 "C" { procedure P() var Ran: Boolean; begin Commit(); Ran := Codeunit.Run(Codeunit::"T"); end; }`;
    expect(mechanismsFor(src)).toEqual(["write-txn-codeunit-run"]);
  });

  it("tags the guard form, measured separately (probe arms B1/B2) rather than inferred", () => {
    const src = `codeunit 50201 "C" { procedure P() begin Commit(); if not Codeunit.Run(Codeunit::"T") then Error('x'); end; }`;
    expect(mechanismsFor(src)).toEqual(["write-txn-codeunit-run"]);
  });

  it("does NOT tag the bare statement form — measured to survive in every cell", () => {
    // This is `Data Commit Ops.CommitThenRun`, the shape that SURVIVED on the live tables gate and
    // proved R72's original prediction wrong. A tag here would re-assert that falsified prediction.
    const src = `codeunit 50202 "C" { procedure P() begin Commit(); Codeunit.Run(Codeunit::"T"); end; }`;
    expect(mechanismsFor(src)).toEqual([undefined]);
  });

  it("does NOT tag a consumed Codeunit.Run that comes BEFORE the Commit", () => {
    // Deleting the `Commit()` cannot change what the earlier call saw, so tagging here would be a
    // pure false positive — and the ordering guard is the only thing standing between this test and
    // one that passes because the tag fires on the whole procedure body.
    const src = `codeunit 50203 "C" { procedure P() var Ran: Boolean; begin Ran := Codeunit.Run(Codeunit::"T"); Commit(); end; }`;
    expect(mechanismsFor(src)).toEqual([undefined]);
  });

  it("tags a consumed Codeunit.Run nested in a later branch, deliberately over-flagging", () => {
    // Approximation 1 in `detectWriteTxnCodeunitRun`'s doc comment, asserted rather than described:
    // there is no control-flow analysis, so a branch the covering test never takes still counts.
    // A missed warning silently credits a platform refusal to the suite, which is the flattering
    // direction (R86); this is the other one.
    const src = `codeunit 50204 "C" { procedure P(Flag: Boolean) var Ran: Boolean; begin Commit(); if Flag then begin Ran := Codeunit.Run(Codeunit::"T"); end; end; }`;
    expect(mechanismsFor(src)).toEqual(["write-txn-codeunit-run"]);
  });

  it("does not leak the tag across procedures", () => {
    // The consumed call lives in a DIFFERENT procedure from the Commit. Deleting this Commit cannot
    // open a transaction across that call, and a whole-file scan would say it does.
    const src = `codeunit 50205 "C" { procedure P() begin Commit(); end; procedure Q() var Ran: Boolean; begin Ran := Codeunit.Run(Codeunit::"T"); end; }`;
    expect(mechanismsFor(src)).toEqual([undefined]);
  });

  it("tags from inside a trigger body too, not only a procedure", () => {
    const src = `codeunit 50206 "C" { trigger OnRun() var Ran: Boolean; begin Commit(); Ran := Codeunit.Run(Codeunit::"T"); end; }`;
    expect(mechanismsFor(src)).toEqual(["write-txn-codeunit-run"]);
  });

  it("is case-insensitive, because AL is", () => {
    // `CODEUNIT.RUN` is the same site as `Codeunit.Run`. A case-sensitive match would silently miss
    // it — the exact shape the tables fixture keeps a CASE-VARIANT test for (spec §4.1).
    const src = `codeunit 50207 "C" { procedure P() var Ran: Boolean; begin Commit(); Ran := CODEUNIT.RUN(Codeunit::"T"); end; }`;
    expect(mechanismsFor(src)).toEqual(["write-txn-codeunit-run"]);
  });

  it("does not tag a same-named call on some other receiver", () => {
    // `Mgt.Run(...)` is an ordinary procedure call, not the AL system `Codeunit.Run`, and nothing
    // measured says the platform refuses it.
    const src = `codeunit 50208 "C" { procedure P() var Ran: Boolean; Mgt: Codeunit "Other"; begin Commit(); Ran := Mgt.Run(); end; }`;
    expect(mechanismsFor(src)).toEqual([undefined]);
  });

  it("tags each Commit independently — the earlier one only, when the call sits between them", () => {
    const src = `codeunit 50209 "C" { procedure P() var Ran: Boolean; begin Commit(); Ran := Codeunit.Run(Codeunit::"T"); Commit(); end; }`;
    expect(mechanismsFor(src)).toEqual(["write-txn-codeunit-run", undefined]);
  });
});
