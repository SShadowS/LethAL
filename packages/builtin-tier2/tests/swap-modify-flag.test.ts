import { beforeAll, describe, expect, it } from "bun:test";
/**
 * `SwapModifyFlag` — rewrite `<rec>.Modify(true)` -> `<rec>.Modify(false)`.
 *
 * Spec: docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md §4 table + §4 intro.
 * `claimsRecordMethod` itself is exhaustively tested in `receiver.test.ts`; this file exercises
 * the operator's own guards, and — the point of this operator — that it claims a site in an
 * `if`'s then-branch, NOT just statement position.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  buildSemanticContext,
  findAll,
  initParser,
  isStatementPosition,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { swapModifyFlag } from "../src/swap-modify-flag";

function specsFor(sourceAL: string) {
  const root = wrapRoot(parseAL(sourceAL));
  const ctx: SemanticContext = buildSemanticContext([{ path: "fixture.al", root }]);
  const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
  return calls
    .filter((n) => swapModifyFlag.targets(n, ctx))
    .flatMap((n) => swapModifyFlag.generate(n, ctx));
}

/** Same walk as `specsFor`, but with an extra `isStatementPosition` guard spliced in — used only
 * by the red-check test below to prove the then-branch case depends on NOT having that guard. */
function specsForWithStatementPositionGuard(sourceAL: string) {
  const root = wrapRoot(parseAL(sourceAL));
  const ctx: SemanticContext = buildSemanticContext([{ path: "fixture.al", root }]);
  const calls: ALSyntaxNode[] = findAll(root, ALNodeKind.procedure_call);
  return calls
    .filter((n) => isStatementPosition(n) && swapModifyFlag.targets(n, ctx))
    .flatMap((n) => swapModifyFlag.generate(n, ctx));
}

describe("swapModifyFlag", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("rewrites Modify(true) to Modify(false) in statement position", () => {
    const src = `codeunit 50140 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.Modify(true)"]);
    const [spec] = specs;
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.after.text).toBe("Cust.Modify(false)");
    expect(spec.operatorName).toBe("lethal.swap-modify-flag");
  });

  it("claims Modify(true) sitting as an if's then-branch — NOT statement position", () => {
    const src = `codeunit 50141 "C" { procedure P() var Cust: Record Customer; begin if Cust.FindSet() then Cust.Modify(true); end; }`;
    const calls: ALSyntaxNode[] = findAll(wrapRoot(parseAL(src)), ALNodeKind.procedure_call);
    const modifyCall = calls.find((n) => n.text.startsWith("Cust.Modify"));
    expect(modifyCall).toBeDefined();
    if (modifyCall === undefined) return;
    // The load-bearing structural fact this operator exists for: this call is
    // NOT in statement position (it's the un-braced then-branch of an if), yet
    // SwapModifyFlag must still claim it.
    expect(isStatementPosition(modifyCall)).toBe(false);

    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.Modify(true)"]);
    expect(specs[0]?.after.text).toBe("Cust.Modify(false)");
  });

  it("RED-CHECK: restricting to statement position drops the then-branch site", () => {
    const src = `codeunit 50142 "C" { procedure P() var Cust: Record Customer; begin if Cust.FindSet() then Cust.Modify(true); end; }`;
    // Un-restricted: claims the site.
    expect(specsFor(src).map((s) => s.before.text)).toEqual(["Cust.Modify(true)"]);
    // Restricted to statement position (the mistake this operator must NOT make):
    // the site is dropped entirely.
    expect(specsForWithStatementPositionGuard(src)).toEqual([]);
  });

  it("claims the implicit-receiver form inside a table trigger body", () => {
    const src = `table 50143 "T" { fields { field(1; "No."; Code[20]) { } } trigger OnInsert() begin Modify(true); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Modify(true)"]);
    expect(specs[0]?.after.text).toBe("Modify(false)");
  });

  it("REFUSES Modify(SomeBoolean) — literal true only, never a variable", () => {
    const src = `codeunit 50144 "C" { procedure P() var Cust: Record Customer; SomeBoolean: Boolean; begin Cust.Modify(SomeBoolean); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES Modify() — no argument, so no literal true to swap", () => {
    const src = `codeunit 50145 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES Modify(false) — already the mutated value", () => {
    const src = `codeunit 50146 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(false); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("REFUSES a receiver that resolves to a non-record (Validator.Modify)", () => {
    const src = `codeunit 50147 "C" { procedure P() var Validator: Codeunit "My Validator"; begin Validator.Modify(true); end; }`;
    expect(specsFor(src)).toEqual([]);
  });

  it("handles case variants: Modify(TRUE)", () => {
    const src = `codeunit 50148 "C" { procedure P() var Cust: Record Customer; begin Cust.Modify(TRUE); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.Modify(TRUE)"]);
    expect(specs[0]?.after.text).toBe("Cust.Modify(false)");
  });

  it("handles case variants: MODIFY(True)", () => {
    const src = `codeunit 50149 "C" { procedure P() var Cust: Record Customer; begin Cust.MODIFY(True); end; }`;
    const specs = specsFor(src);
    expect(specs.map((s) => s.before.text)).toEqual(["Cust.MODIFY(True)"]);
    expect(specs[0]?.after.text).toBe("Cust.MODIFY(false)");
  });
});
