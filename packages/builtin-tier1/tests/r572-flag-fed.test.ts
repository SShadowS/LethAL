import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  evaluateArms,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";
import {
  type R572Gaps,
  r572Census,
  r572InvariantStep,
  r572RequireNonZeroStep,
  r572Seam,
} from "../src/loop-hazard";

/**
 * R572 (coord task R-572, plan r4): a loop whose exit is fed by another object's STATEFUL procedure
 * (a flag, a `var` argument, or a call in the exit) refuses that procedure's chain and the writers
 * of its value path. Option D and narrowing (a) skip a loop whose own step forces the exit;
 * narrowing (b) refuses only writers of the value path. Each site is a unique text-literal marker
 * inside a procedure. Every test was red-checked alone; the red checks are recorded in
 * `/coord/handoff/R-572/build.md`.
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";

type Files = Record<string, string>;

/** The project, built as production builds it: with an arm map, no preprocessor symbols. */
function project(files: Files) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    src,
    root: wrapRoot(parseAL(src)),
  }));
  const arms = new Map(parsed.map((p) => [p.root, evaluateArms(p.root, p.src, [])]));
  const ctx = buildSemanticContext(parsed, arms);
  /** Is the marker literal `'<tag>'` in `path` refused? */
  return (path: string, tag: string): boolean => {
    const f = parsed.find((p) => p.path === path);
    if (f === undefined) throw new Error(`no file ${path}`);
    let hit: ALSyntaxNode | undefined;
    visit(f.root, (n: ALSyntaxNode) => {
      if (hit === undefined && n.text === `'${tag}'`) hit = n;
    });
    if (hit === undefined) throw new Error(`'${tag}' not found in ${path}`);
    return openItemHangRefuses(hit, ctx, VMC);
  };
}

/** Run `f` with a seam set, then restore it (a fresh project per call, so nothing is cached). */
function withSeam<T>(seam: { on: boolean }, on: boolean, f: () => T): T {
  const was = seam.on;
  seam.on = on;
  try {
    return f();
  } finally {
    seam.on = was;
  }
}

const BUF = `table 57200 "R572 Buf"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
        field(2; Val; Text[50]) { }
        field(3; Step; Integer) { }
    }
    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
    }
}`;

const L = "Loop.Codeunit.al";
const C = "Callee.Codeunit.al";

/** A loop codeunit around `body` (its own `var` section in `vars`). */
const loop = (vars: string, body: string, extra = ""): string => `codeunit 57201 "R572 Loop"
{
    procedure Run()
    var
        R: Record "R572 Buf";
${vars}
    begin
${body}
    end;
${extra}
}`;

describe("R572 rule P: the stateful chain is refused", () => {
  // 1. NextDimEntryNo: a global buffer stepper feeding a flag
  const files1: Files = {
    "Buf.Table.al": BUF,
    [C]: `codeunit 57202 "R572 Dims"
{
    var
        TempBuf: Record "R572 Buf" temporary;

    procedure NextNo(): Integer
    var
        Tag: Text;
    begin
        Tag := 'T1';
        if TempBuf.Next() = 0 then
            exit(0);
        exit(TempBuf."Entry No.");
    end;
}`,
    [L]: loop(
      `        D: Codeunit "R572 Dims";
        No: Integer;`,
      `        No := D.NextNo();
        while No <> 0 do
            No := D.NextNo();`,
    ),
  };
  it("1. a global-buffer stepper fed into a flag: refused, and not without R572", () => {
    expect(project(files1)(C, "T1")).toBe(true);
    expect(withSeam(r572Seam, false, () => project(files1)(C, "T1"))).toBe(false);
  });

  // 3. CutAtSeperator: a `var` text consumer
  it("3. a `var` text consumer (CutAtSeperator): refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Str"
{
    procedure CutAt(var S: Text; Sep: Text): Text
    var
        Tag: Text;
        P: Integer;
        Tok: Text;
    begin
        Tag := 'T3';
        P := StrPos(S, Sep);
        if P = 0 then begin
            Tok := S;
            S := '';
            exit(Tok);
        end;
        Tok := CopyStr(S, 1, P - 1);
        S := CopyStr(S, P + 1);
        exit(Tok);
    end;
}`,
      [L]: `codeunit 57201 "R572 Loop"
{
    procedure Run(List: Text)
    var
        Str: Codeunit "R572 Str";
        Tok: Text;
    begin
        Tok := Str.CutAt(List, ',');
        while Tok <> '' do
            Tok := Str.CutAt(List, ',');
    end;
}`,
    });
    expect(at(C, "T3")).toBe(true);
  });

  // 4. GetNextBottom: a var-out flag
  it("4. a var-out flag (GetNextBottom): refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Cap"
{
    procedure GetNext(var B: Integer)
    var
        Tag: Text;
    begin
        Tag := 'T4';
        B := B + 10;
    end;
}`,
      [L]: `codeunit 57201 "R572 Loop"
{
    procedure Run()
    var
        Cap: Codeunit "R572 Cap";
        Bottom: Integer;
    begin
        repeat
            Cap.GetNext(Bottom);
        until Bottom >= 100;
    end;
}`,
    });
    expect(at(C, "T4")).toBe(true);
  });

  // 5. a local real-table queue
  it("5. a local real-table queue (FindFirst, Delete): refused", () => {
    const at = project({
      "Buf.Table.al": BUF,
      [C]: `codeunit 57202 "R572 Queue"
{
    procedure Pop(): Integer
    var
        Q: Record "R572 Buf";
        Tag: Text;
        N: Integer;
    begin
        Tag := 'T5';
        if not Q.FindFirst() then
            exit(0);
        N := Q."Entry No.";
        Q.Delete();
        exit(N);
    end;
}`,
      [L]: loop(
        `        Qu: Codeunit "R572 Queue";
        N: Integer;`,
        `        N := Qu.Pop();
        while N <> 0 do
            N := Qu.Pop();`,
      ),
    });
    expect(at(C, "T5")).toBe(true);
  });

  // 6. UNKNOWN through an interface dispatch
  it("6. UNKNOWN through an interface dispatch: refused", () => {
    const at = project({
      "Src.Interface.al": `interface "R572 Src"
{
    procedure Get(): Integer;
}`,
      [C]: `codeunit 57202 "R572 Wrap"
{
    procedure Next(S: Interface "R572 Src"): Integer
    var
        Tag: Text;
        V: Integer;
    begin
        Tag := 'T6';
        V := S.Get();
        exit(V);
    end;
}`,
      [L]: `codeunit 57201 "R572 Loop"
{
    procedure Run(S: Interface "R572 Src")
    var
        W: Codeunit "R572 Wrap";
        V: Integer;
    begin
        V := W.Next(S);
        while V <> 0 do
            V := W.Next(S);
    end;
}`,
    });
    expect(at(C, "T6")).toBe(true);
  });

  // 7. state one call deep
  it("7. a one-call-deep global getter: refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Deep"
{
    var
        Cnt: Integer;

    procedure Peek(): Integer
    var
        Tag: Text;
        V: Integer;
    begin
        Tag := 'T7';
        V := Inner();
        exit(V);
    end;

    local procedure Inner(): Integer
    begin
        exit(Cnt);
    end;
}`,
      [L]: loop(
        `        D: Codeunit "R572 Deep";
        V: Integer;`,
        `        V := D.Peek();
        while V > 0 do
            V := D.Peek();`,
      ),
    });
    expect(at(C, "T7")).toBe(true);
  });

  // 12. a cycle P(var S) -> Q(T) -> P. X reaches it as X -> P -> Q, Y as Y -> Z -> Q, so both
  // loops read Q at the same hop depth: a result cached while P was in progress (Q "stateless",
  // the cycle cut) would answer Y's question wrongly. Read in both orders.
  const cyc = (pFirst: boolean): Files => {
    const lp = `        S := 'abc';
        V := C.X(S);
        while V <> '' do
            V := C.X(S);`;
    const lq = `        S := 'abc';
        V := C.Y(S);
        while V <> '' do
            V := C.Y(S);`;
    return {
      [C]: `codeunit 57202 "R572 Cyc"
{
    procedure X(T: Text): Text
    var
        Tag: Text;
        V: Text;
    begin
        Tag := 'T12X';
        V := P(T);
        exit(V);
    end;

    procedure Y(T: Text): Text
    var
        Tag: Text;
        V: Text;
    begin
        Tag := 'T12Y';
        V := Z(T);
        exit(V);
    end;

    local procedure Z(T: Text): Text
    var
        V: Text;
    begin
        V := Q(T);
        exit(V);
    end;

    local procedure P(var S: Text): Text
    var
        V: Text;
    begin
        V := Q(S);
        S := CopyStr(S, 2);
        exit(V);
    end;

    local procedure Q(T: Text): Text
    var
        V: Text;
    begin
        if T = '' then
            exit('');
        V := P(T);
        exit(V);
    end;
}`,
      [L]: `codeunit 57201 "R572 Loop"
{
    procedure RunA()
    var
        C: Codeunit "R572 Cyc";
        S: Text;
        V: Text;
    begin
${pFirst ? lp : lq}
    end;

    procedure RunB()
    var
        C: Codeunit "R572 Cyc";
        S: Text;
        V: Text;
    begin
${pFirst ? lq : lp}
    end;
}`,
    };
  };
  it("12. a cycle P(var S) -> Q(T) -> P: X and Y both refused, whichever loop is read first", () => {
    for (const first of [true, false]) {
      const at = project(cyc(first));
      expect(at(C, "T12X")).toBe(true);
      expect(at(C, "T12Y")).toBe(true);
    }
  });

  // 20. the stated limit: a stateless self-feed
  it("20. a stateless self-feed (NextSendingDate): emitted, the stated limit", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Date"
{
    procedure NextDate(D: Date): Date
    var
        Tag: Text;
    begin
        Tag := 'T20';
        exit(CalcDate('<1D>', D));
    end;
}`,
      [L]: `codeunit 57201 "R572 Loop"
{
    procedure Run(EndD: Date)
    var
        Dt: Codeunit "R572 Date";
        D: Date;
    begin
        D := Dt.NextDate(Today());
        while D < EndD do
            D := Dt.NextDate(D);
    end;
}`,
    });
    expect(at(C, "T20")).toBe(false);
  });
});

/** A feed codeunit whose `More()` is stateful and never gets the loop's record. */
const FEED = `codeunit 57202 "R572 Feed"
{
    var
        Left: Integer;

    procedure More(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'FEED';
        Left -= 1;
        exit(Left > 0);
    end;
}`;

/** A project whose loop reads `cond` with `More` fed by the stateful `Feed.More()`. */
const dLoop = (head: string, vars = "", pre = "", extra = ""): Files => ({
  "Buf.Table.al": BUF,
  [C]: FEED,
  [L]: loop(
    `        F: Codeunit "R572 Feed";
        More: Boolean;
${vars}`,
    `${pre}        if R.FindSet() then
${head}`,
    extra,
  ),
});

describe("R572 option D: the loop's own step forces the exit", () => {
  it("8. `while More or (R.Next() <> 0)`: not forced, so refused", () => {
    const files = dLoop(`            while More or (R.Next() <> 0) do
                More := F.More();`);
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("9b. `until not ((R.Next() = 0) or More)`: the `not` flips the polarity, so refused", () => {
    const files = dLoop(`            repeat
                More := F.More();
            until not ((R.Next() = 0) or More);`);
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("9c. `until not ((R.Next() <> 0) and More)`: forced after the flip, so skipped", () => {
    const files = dLoop(`            repeat
                More := F.More();
            until not ((R.Next() <> 0) and More);`);
    expect(project(files)(C, "FEED")).toBe(false);
  });
  it("9d. `while More and (R.Next() = 0)`: the wrong comparison for a while, so refused", () => {
    const files = dLoop(`            while More and (R.Next() = 0) do
                More := F.More();`);
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("9. `until (not More) and (R.Next() = 0)`: not forced, so refused", () => {
    const files = dLoop(`            repeat
                More := F.More();
            until (not More) and (R.Next() = 0);`);
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("10. `while More and (R.Next() <> 0)`, stateful callee without the cursor: skipped", () => {
    const files = dLoop(`            while More and (R.Next() <> 0) do
                More := F.More();`);
    expect(project(files)(C, "FEED")).toBe(false);
  });
  it("11. a stateful callee that gets the cursor but never moves it: not refused", () => {
    const at = project({
      "Buf.Table.al": BUF,
      [C]: `codeunit 57202 "R572 Peek"
{
    var
        Seen: Integer;

    procedure Check(var B: Record "R572 Buf"): Boolean
    var
        Tag: Text;
    begin
        Tag := 'T11';
        Seen += 1;
        exit(B.Val <> '');
    end;
}`,
      [L]: loop(
        `        P: Codeunit "R572 Peek";
        Ok: Boolean;`,
        `        if R.FindSet() then begin
            Ok := P.Check(R);
            while Ok and (R.Next() <> 0) do
                Ok := P.Check(R);
        end;`,
      ),
    });
    expect(at(C, "T11")).toBe(false);
  });
  it("11b. the same callee re-finding the cursor (`B.FindFirst()`): refused", () => {
    const at = project({
      "Buf.Table.al": BUF,
      [C]: `codeunit 57202 "R572 Peek"
{
    var
        Seen: Integer;

    procedure Check(var B: Record "R572 Buf"): Boolean
    var
        Tag: Text;
    begin
        Tag := 'T11B';
        Seen += 1;
        B.FindFirst();
        exit(B.Val <> '');
    end;
}`,
      [L]: loop(
        `        P: Codeunit "R572 Peek";
        Ok: Boolean;`,
        `        if R.FindSet() then begin
            Ok := P.Check(R);
            while Ok and (R.Next() <> 0) do
                Ok := P.Check(R);
        end;`,
      ),
    });
    expect(at(C, "T11B")).toBe(true);
  });
});

describe("R572 narrowing (a): a forced step with an invariant argument", () => {
  /** `until (R.Next(Step) = 0) or not More`, with `Step := 1` before the loop and `inBody` in it. */
  const stepLoop = (inBody: string, extraVars = "", extra = ""): Files =>
    dLoop(
      `            repeat
                More := F.More();
${inBody}
            until (R.Next(Step) = 0) or not More;`,
      `        Step: Integer;
${extraVars}`,
      `        Step := 1;
`,
      extra,
    );

  it("13. Step assigned in the body: refused", () => {
    expect(project(stepLoop("                Step := 2;"))(C, "FEED")).toBe(true);
  });
  it("14. Step invariant (assigned 1 before the loop only): skipped", () => {
    expect(project(stepLoop(""))(C, "FEED")).toBe(false);
  });
  /** Step also counted (`I += Step`), so the probed `Next(0)` fact does not cover it. */
  const counted = (pre: string): Files =>
    dLoop(
      `            repeat
                More := F.More();
                I += Step;
            until (R.Next(Step) = 0) or not More;`,
      `        Step: Integer;
        N: Integer;
        I: Integer;`,
      pre,
    );
  it("14b. the non-zero rule (Step also a counter step): assigned from a variable: refused", () => {
    const files = counted("        Step := N;\n");
    expect(project(files)(C, "FEED")).toBe(true);
    expect(withSeam(r572RequireNonZeroStep, false, () => project(files)(C, "FEED"))).toBe(false);
  });
  it("14c. the non-zero rule (Step also a counter step): `Step := 1` only under an `if`: refused", () => {
    const files = counted("        if N > 0 then\n            Step := 1;\n");
    expect(project(files)(C, "FEED")).toBe(true);
    expect(withSeam(r572RequireNonZeroStep, false, () => project(files)(C, "FEED"))).toBe(false);
  });
  it("14d. control: the counter loop with `Step := 1` before it on every path: skipped", () => {
    expect(project(counted("        Step := 1;\n"))(C, "FEED")).toBe(false);
  });
  it("30. ruling 1: Step only a `Next` step, assigned from a variable (a mutant may zero it): ADMITTED", () => {
    const files = dLoop(
      `            repeat
                More := F.More();
            until (R.Next(Step) = 0) or not More;`,
      `        Step: Integer;
        N: Integer;`,
      "        Step := N;\n",
    );
    expect(project(files)(C, "FEED")).toBe(false);
  });
  it("30b. ruling 1: the same Step also a counter step (`I += Step`): REFUSED", () => {
    expect(project(counted("        Step := N;\n"))(C, "FEED")).toBe(true);
  });
  /** `until (Adv(R, Step) = 0) or not More`, Step from a variable, the helper's body given. */
  const viaHelper = (helperBody: string): Files =>
    dLoop(
      `            repeat
                More := F.More();
            until (Adv(R, Step) = 0) or not More;`,
      `        Step: Integer;
        N: Integer;`,
      "        Step := N;\n",
      `
    var
        Moved: Integer;

    local procedure Adv(var B: Record "R572 Buf"; S: Integer): Integer
    begin
${helperBody}
    end;`,
    );
  it("30e. ruling 1: Step also handed to a codeunit's own `Next(Step)` (not a cursor): REFUSED", () => {
    const files: Files = {
      ...dLoop(
        `            repeat
                More := F.More();
                Q.Next(Step);
            until (R.Next(Step) = 0) or not More;`,
        `        Step: Integer;
        N: Integer;
        Q: Codeunit "R572 Q";`,
        "        Step := N;\n",
      ),
      "Q.Codeunit.al": `codeunit 57203 "R572 Q"
{
    procedure Next(S: Integer)
    begin
        Message('%1', S);
    end;
}`,
    };
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("30c. ruling 1: a helper whose parameter is only a `Next` step: ADMITTED", () => {
    expect(project(viaHelper("        exit(B.Next(S));"))(C, "FEED")).toBe(false);
  });
  it("30d. ruling 1: a custom Advance that also counts with the step: REFUSED", () => {
    const files = viaHelper("        Moved += S;\n        exit(B.Next(S));");
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("15. Step passed to a `var` parameter in the body: refused", () => {
    const files = stepLoop(
      "                Bump(Step);",
      "",
      `
    local procedure Bump(var S: Integer)
    begin
        S += 1;
    end;`,
    );
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("15b. Step passed to a BY-VALUE parameter in the body: still skipped", () => {
    const files = stepLoop(
      "                Show(Step);",
      "",
      `
    local procedure Show(S: Integer)
    begin
        Message('%1', S);
    end;`,
    );
    expect(project(files)(C, "FEED")).toBe(false);
  });
  it("15c. Step passed to a built-in in the body (`Evaluate(Step, ..)`): refused", () => {
    expect(project(stepLoop("                Evaluate(Step, '2');"))(C, "FEED")).toBe(true);
  });
  it("16. the step through a same-object helper, `until (Stepped(R) = 0) or not More`: skipped", () => {
    const files = dLoop(
      `            repeat
                More := F.More();
            until (Stepped(R) = 0) or not More;`,
      "",
      "",
      `
    local procedure Stepped(var B: Record "R572 Buf"): Integer
    begin
        exit(B.Next());
    end;`,
    );
    expect(project(files)(C, "FEED")).toBe(false);
  });
  it("16b. a Boolean helper, `until AtEnd(R) or not More` (`exit(B.Next() = 0)`): skipped", () => {
    const files = dLoop(
      `            repeat
                More := F.More();
            until AtEnd(R) or not More;`,
      "",
      "",
      `
    local procedure AtEnd(var B: Record "R572 Buf"): Boolean
    begin
        exit(B.Next() = 0);
    end;`,
    );
    expect(project(files)(C, "FEED")).toBe(false);
  });
  it("16c. a Boolean helper with the wrong polarity (`exit(B.Next() <> 0)`): refused", () => {
    const files = dLoop(
      `            repeat
                More := F.More();
            until AtEnd(R) or not More;`,
      "",
      "",
      `
    local procedure AtEnd(var B: Record "R572 Buf"): Boolean
    begin
        exit(B.Next() <> 0);
    end;`,
    );
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("22. a record field as the step, `R.Next(R.Step) = 0`: refused", () => {
    const files = dLoop(`            repeat
                More := F.More();
            until (R.Next(R.Step) = 0) or not More;`);
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("23. a global as the step: refused (also with the non-zero rule off)", () => {
    const files: Files = {
      "Buf.Table.al": BUF,
      [C]: FEED,
      [L]: `codeunit 57201 "R572 Loop"
{
    var
        Step: Integer;

    procedure Run()
    var
        R: Record "R572 Buf";
        F: Codeunit "R572 Feed";
        More: Boolean;
    begin
        Step := 1;
        if R.FindSet() then
            repeat
                More := F.More();
            until (R.Next(Step) = 0) or not More;
    end;
}`,
    };
    expect(project(files)(C, "FEED")).toBe(true);
    expect(withSeam(r572RequireNonZeroStep, false, () => project(files)(C, "FEED"))).toBe(true);
  });
  it("23c. a `var` parameter as the step, with the non-zero rule off: refused", () => {
    const files: Files = {
      "Buf.Table.al": BUF,
      [C]: FEED,
      [L]: `codeunit 57201 "R572 Loop"
{
    procedure Run(var Step: Integer)
    var
        R: Record "R572 Buf";
        F: Codeunit "R572 Feed";
        More: Boolean;
    begin
        if R.FindSet() then
            repeat
                More := F.More();
            until (R.Next(Step) = 0) or not More;
    end;
}`,
    };
    expect(withSeam(r572RequireNonZeroStep, false, () => project(files)(C, "FEED"))).toBe(true);
  });
  /** A by-value parameter Step; `pre` before the loop, `inBody` in it. */
  const paramLoop = (pre: string, inBody: string): Files => ({
    "Buf.Table.al": BUF,
    [C]: FEED,
    [L]: `codeunit 57201 "R572 Loop"
{
    procedure Run(Step: Integer)
    var
        R: Record "R572 Buf";
        F: Codeunit "R572 Feed";
        More: Boolean;
        I: Integer;
    begin
${pre}        if R.FindSet() then
            repeat
                More := F.More();
${inBody}
            until (R.Next(Step) = 0) or not More;
    end;
}`,
  });
  it("23d. the non-zero rule takes a LOCAL only: a counted parameter set to 1 is refused", () => {
    const files = paramLoop("        Step := 1;\n", "                I += Step;");
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("23b. a by-value parameter step: skipped when only a `Next` step, refused when counted", () => {
    const files = paramLoop("", "");
    expect(withSeam(r572RequireNonZeroStep, false, () => project(files)(C, "FEED"))).toBe(false);
    // ruling 1: the probed `Next(0)` fact covers a step that is only a `Next` step
    expect(project(files)(C, "FEED")).toBe(false);
    // ... and not one that is also counted: then the parameter is not proven non-zero
    expect(project(paramLoop("", "                I += Step;"))(C, "FEED")).toBe(true);
  });
  it("24. Step assigned inside an inactive `#if` arm in the body: refused", () => {
    const files = stepLoop(`#if NEVERDEFINED
                Step := 0;
#endif`);
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("25. a helper with a second exit, `if Cond then exit(1); exit(B.Next())`: refused", () => {
    const files = dLoop(
      `            repeat
                More := F.More();
            until (Stepped(R) = 0) or not More;`,
      "",
      "",
      `
    local procedure Stepped(var B: Record "R572 Buf"): Integer
    begin
        if B.Val = '' then
            exit(1);
        exit(B.Next());
    end;`,
    );
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("25b. a Boolean helper that can fall off its end (no final `exit`): refused", () => {
    const files = dLoop(
      `            repeat
                More := F.More();
            until AtEnd(R) or not More;`,
      "",
      "",
      `
    local procedure AtEnd(var B: Record "R572 Buf"): Boolean
    begin
        if B.Val <> '' then
            exit(B.Next() = 0);
    end;`,
    );
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("26b. a helper that steps a BY-VALUE copy of the cursor: refused", () => {
    const files = dLoop(
      `            repeat
                More := F.More();
            until (Stepped(R) = 0) or not More;`,
      "",
      "",
      `
    local procedure Stepped(B: Record "R572 Buf"): Integer
    begin
        exit(B.Next());
    end;`,
    );
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("26. a helper that re-finds, `B.FindFirst(); exit(B.Next())`: refused", () => {
    const files = dLoop(
      `            repeat
                More := F.More();
            until (Stepped(R) = 0) or not More;`,
      "",
      "",
      `
    local procedure Stepped(var B: Record "R572 Buf"): Integer
    begin
        B.FindFirst();
        exit(B.Next());
    end;`,
    );
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("28. a flag only the step writes, with a `continue` before the write: refused", () => {
    const base = (skip: string): Files =>
      dLoop(
        `            repeat
                More := F.More();
${skip}
                EndLoop := R.Next() = 0;
            until EndLoop or not More;`,
        `        EndLoop: Boolean;
        Skip: Boolean;`,
      );
    expect(
      project(base("                if Skip then\n                    continue;"))(C, "FEED"),
    ).toBe(true);
    // control: the same flag without the `continue` is forced, so skipped
    expect(project(base(""))(C, "FEED")).toBe(false);
  });
  /** `until EndLoop or not More`, where the body is `body`. */
  const flagLoop = (body: string): Files =>
    dLoop(
      `            repeat
                More := F.More();
${body}
            until EndLoop or not More;`,
      `        EndLoop: Boolean;
        Skip: Boolean;`,
    );
  it("28b. the flag written only under an `if`: refused", () => {
    const files = flagLoop(`                if not Skip then
                    EndLoop := R.Next() = 0;`);
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("28c. the flag also handed to a call (`Clear(EndLoop)`): refused", () => {
    const files = flagLoop(`                EndLoop := R.Next() = 0;
                Clear(EndLoop);`);
    expect(project(files)(C, "FEED")).toBe(true);
  });
  it("28e. a flag fed from itself (`EndLoop := not EndLoop`): refused, and no endless recursion", () => {
    const files = flagLoop("                EndLoop := not EndLoop;");
    expect(project(files)(C, "FEED")).toBe(true);
    // ended by the visited set (the cause), not by the depth backstop
    expect(gapsOf(files).backstopCutOffs).toBe(0);
  });
  it("28f. a flag that also keeps itself (`EndLoop := (R.Next() = 0) or EndLoop`): skipped", () => {
    const files = flagLoop("                EndLoop := (R.Next() = 0) or EndLoop;");
    expect(project(files)(C, "FEED")).toBe(false);
  });
  it("28g. a ring of two flags (`EndLoop := Other; Other := EndLoop`): refused, no recursion", () => {
    const files = dLoop(
      `            repeat
                More := F.More();
                EndLoop := Other;
                Other := EndLoop;
            until EndLoop or not More;`,
      `        EndLoop: Boolean;
        Other: Boolean;`,
    );
    expect(project(files)(C, "FEED")).toBe(true);
    expect(gapsOf(files).backstopCutOffs).toBe(0);
  });
  it("28h. a flag chain 10,000 deep: the depth backstop refuses it, without overflow", () => {
    const N = 10_000;
    const vars = Array.from({ length: N }, (_, i) => `        A${i}: Boolean;`).join("\n");
    const chain = Array.from({ length: N }, (_, i) =>
      i === N - 1
        ? `                A${i} := R.Next() = 0;`
        : `                A${i} := A${i + 1};`,
    ).join("\n");
    const files = dLoop(
      `            repeat
                More := F.More();
${chain}
            until A0 or not More;`,
      vars,
    );
    expect(project(files)(C, "FEED")).toBe(true);
    expect(gapsOf(files).backstopCutOffs).toBeGreaterThan(0);
  });
  it("28i. control: a two-deep flag chain to the step stays forced (skipped)", () => {
    const files = dLoop(
      `            repeat
                More := F.More();
                A0 := A1;
                A1 := R.Next() = 0;
            until A0 or not More;`,
      `        A0: Boolean;
        A1: Boolean;`,
    );
    expect(project(files)(C, "FEED")).toBe(false);
  });
  it("28d. the flag written twice in the body: refused", () => {
    const files = flagLoop(`                EndLoop := R.Next() = 0;
                EndLoop := false;`);
    expect(project(files)(C, "FEED")).toBe(true);
  });
});

describe("R572 narrowing (b): writers of the value path", () => {
  it("2. a writer called from the loop body only (PowerBI's tracker): refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Tracker"
{
    var
        Status: Integer;

    procedure GetStatus(): Integer
    begin
        exit(Status);
    end;

    procedure Advance()
    var
        Tag: Text;
    begin
        Tag := 'T2';
        Status := Status + 1;
    end;
}`,
      [L]: loop(
        `        T: Codeunit "R572 Tracker";
        S: Integer;`,
        `        S := T.GetStatus();
        while S < 3 do begin
            T.Advance();
            S := T.GetStatus();
        end;`,
      ),
    });
    expect(at(C, "T2")).toBe(true);
  });

  it("17. a writer of a global NOT on the value path: not refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Iter"
{
    var
        Status: Integer;
        LastRead: Integer;

    procedure GetStatus(): Integer
    begin
        LastRead := Status;
        exit(Status);
    end;

    procedure Touch()
    var
        Tag: Text;
    begin
        Tag := 'T17';
        LastRead := 0;
    end;

    procedure Advance()
    var
        Tag: Text;
    begin
        Tag := 'T17ADV';
        Status += 1;
    end;
}`,
      [L]: loop(
        `        It: Codeunit "R572 Iter";
        S: Integer;`,
        `        S := It.GetStatus();
        while S < 3 do begin
            It.Touch();
            It.Advance();
            S := It.GetStatus();
        end;`,
      ),
    });
    expect(at(C, "T17")).toBe(false);
    // control: the writer of the path global stays refused
    expect(at(C, "T17ADV")).toBe(true);
  });

  it("17b. an undecidable value path (an uncertain call, R567): every global counts", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Iter"
{
    var
        Status: Integer;
        LastRead: Integer;

    procedure GetStatus(): Integer
    begin
        LastRead := Status;
        exit(Pick(Status,
#pragma warning disable AA0001
            0));
    end;

    local procedure Pick(A: Integer; B: Integer): Integer
    begin
        exit(A + B);
    end;

    procedure Touch()
    var
        Tag: Text;
    begin
        Tag := 'T17B';
        LastRead := 0;
    end;
}`,
      [L]: loop(
        `        It: Codeunit "R572 Iter";
        S: Integer;`,
        `        S := It.GetStatus();
        while S < 3 do begin
            It.Touch();
            S := It.GetStatus();
        end;`,
      ),
    });
    expect(at(C, "T17B")).toBe(true);
  });

  it("18. GetNext/Advance/Refill: Advance (body-called, writes Pos) is refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Split"
{
    var
        Buffer: Text;
        Pos: Integer;
        Data: List of [Text];

    procedure GetNext(): Text
    begin
        exit(Buffer);
    end;

    procedure Advance()
    var
        Tag: Text;
    begin
        Tag := 'T18ADV';
        Pos += 1;
    end;

    procedure Refill()
    var
        Tag: Text;
    begin
        Tag := 'T18REF';
        Buffer := '';
        if Pos <= Data.Count() then
            Buffer := Data.Get(Pos);
    end;
}`,
      [L]: loop(
        `        It: Codeunit "R572 Split";`,
        `        while It.GetNext() <> '' do begin
            It.Advance();
            It.Refill();
        end;`,
      ),
    });
    expect(at(C, "T18REF")).toBe(true);
    expect(at(C, "T18ADV")).toBe(true);
  });

  /** GetNext reads `Total` through a chain of `n` same-object getters; Touch writes `Other`, which
   *  is NOT on the value path. */
  const getterChain = (n: number): Files => {
    const getters = Array.from({ length: n }, (_, i) =>
      i === n - 1
        ? `    local procedure G${i}(): Integer\n    begin\n        exit(Total);\n    end;`
        : `    local procedure G${i}(): Integer\n    var\n        V: Integer;\n    begin\n        V := G${i + 1}();\n        exit(V);\n    end;`,
    ).join("\n\n");
    return {
      [C]: `codeunit 57202 "R572 Deep"
{
    var
        Total: Integer;
        Other: Integer;

    procedure GetNext(): Integer
    var
        V: Integer;
    begin
        V := G0();
        exit(V);
    end;

    procedure Add()
    begin
        Total -= 1;
    end;

    procedure Touch()
    var
        Tag: Text;
    begin
        Tag := 'T18C';
        Other := 0;
    end;

${getters}
}`,
      [L]: loop(
        `        It: Codeunit "R572 Deep";
        V: Integer;`,
        `        V := It.GetNext();
        while V > 0 do begin
            It.Add();
            It.Touch();
            V := It.GetNext();
        end;`,
      ),
    };
  };
  it("18c. a value-path slice through 10,000 getters: the backstop counts every global (refuses)", () => {
    const files = getterChain(10_000);
    expect(project(files)(C, "T18C")).toBe(true);
    expect(gapsOf(files).backstopCutOffs).toBeGreaterThan(0);
  }, 120_000); // 10,000 procedures take a few seconds to resolve
  it("18d. control: the same through 3 getters: `Other`'s writer is not refused", () => {
    expect(project(getterChain(3))(C, "T18C")).toBe(false);
  });
  it("18b. the result read through a SECOND same-object procedure: its global's writer is refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Two"
{
    var
        Total: Integer;

    procedure GetNext(): Integer
    var
        V: Integer;
    begin
        V := Compute();
        exit(V);
    end;

    local procedure Compute(): Integer
    begin
        exit(Total);
    end;

    procedure Add()
    var
        Tag: Text;
    begin
        Tag := 'T18B';
        Total -= 1;
    end;
}`,
      [L]: loop(
        `        It: Codeunit "R572 Two";
        V: Integer;`,
        `        V := It.GetNext();
        while V > 0 do begin
            It.Add();
            V := It.GetNext();
        end;`,
      ),
    });
    expect(at(C, "T18B")).toBe(true);
  });

  it("19. a var-out result: the writer of the global copied into it is refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 VarOut"
{
    var
        Cur: Integer;

    procedure Next(var Val: Integer)
    begin
        Val := Cur;
    end;

    procedure Move()
    var
        Tag: Text;
    begin
        Tag := 'T19';
        Cur -= 1;
    end;
}`,
      [L]: loop(
        `        It: Codeunit "R572 VarOut";
        V: Integer;`,
        `        repeat
            It.Move();
            It.Next(V);
        until V = 0;`,
      ),
    });
    expect(at(C, "T19")).toBe(true);
  });

  /** Item Jnl.-Post Line's shape, abstracted: the loop hands its exit flag by `var` to an event
   *  wrapper in another object (stateful: it raises an integration event), whose OTHER `var`
   *  parameter is named like a record global of that object (`JnlLine`); the body also calls
   *  `Post`, which writes that global. `genuine`: the wrapper reads the global itself. */
  const shadow = (genuine: boolean): Files => ({
    "Buf.Table.al": BUF,
    [C]: `codeunit 57202 "R572 Post"
{
    var
        JnlLine: Record "R572 Buf";

    procedure RunOnStep(${genuine ? "" : `var JnlLine: Record "R572 Buf"; `}var Handled: Boolean)
    begin
        ${genuine ? "Handled := JnlLine.Val <> '';" : "OnStep(JnlLine, Handled);"}
    end;

    procedure Post()
    var
        Tag: Text;
    begin
        Tag := 'T35';
        JnlLine.Modify();
    end;

    [IntegrationEvent(false, false)]
    local procedure OnStep(var Line: Record "R572 Buf"; var Handled: Boolean)
    begin
    end;
}`,
    [L]: loop(
      `        P: Codeunit "R572 Post";
        Line: Record "R572 Buf";
        Handled: Boolean;`,
      `        repeat
            P.RunOnStep(${genuine ? "" : "Line, "}Handled);
            P.Post();
        until Handled;`,
    ),
  });
  it("35. a wrapper's `var` parameter that SHADOWS a record global: the global's writer is not refused", () => {
    expect(project(shadow(false))(C, "T35")).toBe(false);
  });
  it("35b. the same global read for real by the wrapper: its writer is refused", () => {
    expect(project(shadow(true))(C, "T35")).toBe(true);
  });

  /** The Shpfy paging shape, abstracted: `Execute` (stateful: it names `IsTest`) builds its request
   *  from `Shop` through `url`; the loop reads the next cursor from the response and calls
   *  `SetShop`, which writes `Shop`. `deep`: `Shop` is read two calls below `Execute`. */
  const paging = (deep: boolean): Files => ({
    "Buf.Table.al": BUF,
    [C]: `codeunit 57202 "R572 Comm"
{
    var
        Shop: Record "R572 Buf";
        IsTest: Boolean;

    procedure Execute(Q: Text): Text
    var
        R: Text;
    begin
        if IsTest then
            exit('');
        R := Send(${deep ? "BuildUrl(Q)" : "UrlOf(Q)"});
        exit(R);
    end;

    local procedure BuildUrl(Q: Text): Text
    var
        U: Text;
    begin
        U := UrlOf(Q);
        exit(U);
    end;

    local procedure UrlOf(Q: Text): Text
    begin
        exit(Shop.Val + Q);
    end;

    local procedure Send(U: Text): Text
    begin
        exit(U);
    end;

    procedure SetShop(S: Record "R572 Buf")
    var
        Tag: Text;
    begin
        Tag := 'T36';
        Shop := S;
    end;
}`,
    [L]: loop(
      `        Cm: Codeunit "R572 Comm";
        Resp: Text;
        Cursor: Text;`,
      `        repeat
            Cm.SetShop(R);
            Resp := Cm.Execute(Cursor);
            Cursor := CopyStr(Resp, 2);
        until Resp = '';`,
    ),
  });
  // KNOWN OVER-REFUSAL, pinned (R628): a by-name slice cannot tell "a deep global only addresses the
  // request" (Shopify's shop) from "a deep global feeds the exit" (37b). The deep carry is kept so
  // 37b stays refused; this pin goes the other way the day R628 is fixed without losing 37b.
  it("36. the Shpfy paging shape (the shop read two calls below the chain): SetShop IS refused (R628)", () => {
    expect(project(paging(true))(C, "T36")).toBe(true);
  });
  it("36b. the shop read ONE call below the chain: SetShop refused", () => {
    expect(project(paging(false))(C, "T36")).toBe(true);
  });

  /** The safety probe: the exit reads `Pos` (the chain names it); the body calls `Step`, which calls
   *  `Inner`, which calls `Bump`, which writes `Pos` (the writer two calls below the body call). */
  it("37. the exit's state written by a callee two calls below the body call: refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Deep2"
{
    var
        Pos: Integer;

    procedure HasMore(): Boolean
    begin
        exit(Pos < 3);
    end;

    procedure Step()
    begin
        Inner();
    end;

    local procedure Inner()
    begin
        Bump();
    end;

    local procedure Bump()
    var
        Tag: Text;
    begin
        Tag := 'T37';
        Pos += 1;
    end;
}`,
      [L]: loop(
        `        It: Codeunit "R572 Deep2";`,
        `        while It.HasMore() do
            It.Step();`,
      ),
    });
    expect(at(C, "T37")).toBe(true);
  });

  /** The READ side two calls deep: the chain computes its result through `Check`, which reads it
   *  through `Peek`, which reads `Pos`; `Bump` (body-called) writes `Pos`. */
  it("37b. the exit's state READ two calls below the chain, written from the body: refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Read2"
{
    var
        Pos: Integer;

    procedure HasMore(): Boolean
    var
        V: Boolean;
    begin
        V := Check();
        exit(V);
    end;

    local procedure Check(): Boolean
    var
        W: Boolean;
    begin
        W := Peek();
        exit(W);
    end;

    local procedure Peek(): Boolean
    begin
        exit(Pos < 3);
    end;

    procedure Bump()
    var
        Tag: Text;
    begin
        Tag := 'T37B';
        Pos += 1;
    end;
}`,
      [L]: loop(
        `        It: Codeunit "R572 Read2";`,
        `        while It.HasMore() do
            It.Bump();`,
      ),
    });
    expect(at(C, "T37B")).toBe(true);
  });
  it("19b. a named return value: the writer of the global copied into it is refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Named"
{
    var
        Cur: Integer;

    procedure GetNext() Result: Integer
    begin
        Result := Cur;
    end;

    procedure Move()
    var
        Tag: Text;
    begin
        Tag := 'T19B';
        Cur -= 1;
    end;
}`,
      [L]: loop(
        `        It: Codeunit "R572 Named";
        V: Integer;`,
        `        V := It.GetNext();
        while V <> 0 do begin
            It.Move();
            V := It.GetNext();
        end;`,
      ),
    });
    expect(at(C, "T19B")).toBe(true);
  });

  /** GetNext returns a field of the global record `Buf`; the body calls four procedures that hand
   *  that field to calls, or call a method on `Buf`. */
  const FLD: Files = {
    "Buf.Table.al": BUF,
    "H.Codeunit.al": `codeunit 57203 "R572 H"
{
    procedure Inc(var V: Text)
    begin
        V := V + 'x';
    end;

    procedure Show(V: Text)
    begin
        Message(V);
    end;

    procedure ShowRec(B: Record "R572 Buf")
    begin
        Message(B.Val);
    end;
}`,
    [C]: `codeunit 57202 "R572 Fld"
{
    var
        Buf: Record "R572 Buf" temporary;
        H: Codeunit "R572 H";

    procedure GetNext(): Text
    begin
        exit(Buf.Val);
    end;

    procedure Load(Src: Text)
    var
        Tag: Text;
    begin
        Tag := 'T21A';
        Evaluate(Buf.Val, Src);
    end;

    procedure Bump()
    var
        Tag: Text;
    begin
        Tag := 'T21B';
        H.Inc(Buf.Val);
    end;

    procedure Show()
    var
        Tag: Text;
        L: Codeunit "R572 H";
    begin
        Tag := 'T21C';
        L.Show(Buf.Val);
    end;

    procedure Revalidate()
    var
        Tag: Text;
    begin
        Tag := 'T21D';
        Buf.Validate(Step, 1);
    end;

    procedure PassRec()
    var
        Tag: Text;
        L: Codeunit "R572 H";
    begin
        Tag := 'T21E';
        L.ShowRec(Buf);
    end;

    procedure Peek(): Integer
    var
        Tag: Text;
        N: Integer;
    begin
        Tag := 'T21F';
        N := Buf.Count();
        exit(N);
    end;
}`,
    [L]: loop(
      `        It: Codeunit "R572 Fld";
        N: Integer;`,
      `        while It.GetNext() <> 'xxx' do begin
            It.Load('a');
            It.Bump();
            It.Show();
            It.Revalidate();
            It.PassRec();
            N := It.Peek();
        end;`,
    ),
  };

  it("21. field-argument writes: `Evaluate(Buf.Val, ..)` (a built-in): refused", () => {
    expect(project(FLD)(C, "T21A")).toBe(true);
  });

  it("21 (cont.). ... and `H.Inc(Buf.Val)` (var): refused", () => {
    expect(project(FLD)(C, "T21B")).toBe(true);
  });

  it("21b. the same field passed to a BY-VALUE parameter (`H.Show(Buf.Val)`): not a writer", () => {
    expect(project(FLD)(C, "T21C")).toBe(false);
  });

  it("21c. a non-read-only method on the path record (`Buf.Validate(..)`): refused", () => {
    expect(project(FLD)(C, "T21D")).toBe(true);
  });

  it("21d. the path record passed BY VALUE (a temporary copy shares its rows): refused", () => {
    expect(project(FLD)(C, "T21E")).toBe(true);
  });

  it("21e. a read-only method on the path record (`Buf.Count()`): not a writer", () => {
    expect(project(FLD)(C, "T21F")).toBe(false);
  });

  it("27. a guard-global writer (a branch condition on the result path): refused", () => {
    const at = project({
      [C]: `codeunit 57202 "R572 Guard"
{
    var
        UseAlt: Boolean;
        Alt: Integer;
        Main: Integer;

    procedure GetQty(): Integer
    begin
        if UseAlt then
            exit(Alt);
        exit(Main);
    end;

    procedure Flip()
    var
        Tag: Text;
    begin
        Tag := 'T27';
        UseAlt := not UseAlt;
    end;
}`,
      [L]: loop(
        `        It: Codeunit "R572 Guard";
        Q: Integer;`,
        `        Q := It.GetQty();
        while Q > 0 do begin
            It.Flip();
            Q := It.GetQty();
        end;`,
      ),
    });
    expect(at(C, "T27")).toBe(true);
  });
});

/** Is the site whose text is exactly `text` in `path` refused for operator `op`? */
function siteRefused(files: Files, path: string, text: string, op: string): boolean {
  const parsed = Object.entries(files).map(([p, src]) => ({
    path: p,
    src,
    root: wrapRoot(parseAL(src)),
  }));
  const arms = new Map(parsed.map((p) => [p.root, evaluateArms(p.root, p.src, [])]));
  const ctx = buildSemanticContext(parsed, arms);
  const f = parsed.find((p) => p.path === path);
  if (f === undefined) throw new Error(`no file ${path}`);
  let hit: ALSyntaxNode | undefined;
  visit(f.root, (n: ALSyntaxNode) => {
    if (hit === undefined && n.text === text) hit = n;
  });
  if (hit === undefined) throw new Error(`${text} not found in ${path}`);
  return openItemHangRefuses(hit, ctx, op);
}

describe("R572 ruling 2: a guard that dominates a writer call in the loop body", () => {
  const ITER = `codeunit 57202 "R572 GIter"
{
    var
        Buffer: Text;
        Pos: Integer;
        Enabled: Boolean;

    procedure GetNext(): Text
    begin
        exit(Buffer);
    end;

    procedure Advance()
    begin
        Pos += 1;
        Buffer := Format(Pos);
    end;

    procedure ShouldAdvance(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'T29G';
        exit(Enabled or (Pos < 10));
    end;

    procedure Probe(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'T29P';
        exit(Enabled);
    end;
}`;
  const guarded: Files = {
    [C]: ITER,
    [L]: loop(
      `        It: Codeunit "R572 GIter";
        Ok: Boolean;`,
      `        while It.GetNext() <> 'x' do begin
            Ok := It.Probe();
            if It.ShouldAdvance() then
                It.Advance();
        end;`,
    ),
  };
  it("29. the guard's callee (`It.ShouldAdvance()`) is refused", () => {
    expect(project(guarded)(C, "T29G")).toBe(true);
  });
  it("29b. the guard site itself in the loop body is refused", () => {
    expect(siteRefused(guarded, L, "It.ShouldAdvance()", "lethal.negate-conditional")).toBe(true);
  });
  it("29c. control: a body call that guards no writer (`Ok := It.Probe()`) is not refused", () => {
    expect(project(guarded)(C, "T29P")).toBe(false);
  });
  it("29d. control: the same callee with the writer call NOT under it is not refused", () => {
    const unguarded: Files = {
      [C]: ITER,
      [L]: loop(
        `        It: Codeunit "R572 GIter";
        Ok: Boolean;`,
        `        while It.GetNext() <> 'x' do begin
            Ok := It.ShouldAdvance();
            It.Advance();
        end;`,
      ),
    };
    expect(project(unguarded)(C, "T29G")).toBe(false);
    expect(siteRefused(unguarded, L, "It.ShouldAdvance()", "lethal.negate-conditional")).toBe(
      false,
    );
  });
});

describe("R572 ruling 2, review r1 H1: guards that are not a direct ancestor of the writer call", () => {
  /** `while T.GetStatus() < 3 do <body>`; `T.Advance` is the writer. */
  const TRACKER = `codeunit 57202 "R572 HTracker"
{
    var
        Status: Integer;

    procedure GetStatus(): Integer
    begin
        exit(Status);
    end;

    procedure ShouldAdvance(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'H1SHOULD';
        exit(true);
    end;

    procedure Skip(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'H1SKIP';
        exit(false);
    end;

    procedure Advance()
    var
        Tag: Text;
    begin
        Tag := 'H1ADV';
        Status := Status + 1;
    end;
}`;
  const files = (body: string, extra = ""): Files => ({
    [C]: TRACKER,
    [L]: `codeunit 57201 "R572 HLoop"
{
    var
        T: Codeunit "R572 HTracker";

    procedure Run()
    var
        Adv: Boolean;
    begin
        while T.GetStatus() < 3 do begin
${body}
        end;
    end;
${extra}
}`,
  });
  it("31. (P1) a `continue` guard before the writer call: its callee is refused", () => {
    const f = files(`            if T.Skip() then
                continue;
            T.Advance();`);
    expect(project(f)(C, "H1SKIP")).toBe(true);
  });
  it("31b. control: the same `continue` guard AFTER the writer call: not refused", () => {
    const f = files(`            T.Advance();
            if T.Skip() then
                continue;`);
    expect(project(f)(C, "H1SKIP")).toBe(false);
  });
  it("32. (P2) a flag-fed guard (`Adv := T.ShouldAdvance(); if Adv then`): refused", () => {
    const f = files(`            Adv := T.ShouldAdvance();
            if Adv then
                T.Advance();`);
    expect(project(f)(C, "H1SHOULD")).toBe(true);
  });
  it("32b. control: the same flag set but guarding nothing: not refused", () => {
    const f = files(`            Adv := T.ShouldAdvance();
            T.Advance();`);
    expect(project(f)(C, "H1SHOULD")).toBe(false);
  });
  it("33. (P3) the guard through a same-object helper (`exit(T.ShouldAdvance())`): refused", () => {
    const f = files(
      `            if LocalShould() then
                T.Advance();`,
      `
    local procedure LocalShould(): Boolean
    begin
        exit(T.ShouldAdvance());
    end;`,
    );
    expect(project(f)(C, "H1SHOULD")).toBe(true);
  });
  it("33b. control: the same helper called, guarding nothing: not refused", () => {
    const f = files(
      `            Adv := LocalShould();
            T.Advance();`,
      `
    local procedure LocalShould(): Boolean
    begin
        exit(T.ShouldAdvance());
    end;`,
    );
    expect(project(f)(C, "H1SHOULD")).toBe(false);
  });
  it("34. (P5) a guard around a same-object wrapper of the writer (`DoAdvance()`): refused", () => {
    const f = files(
      `            if T.ShouldAdvance() then
                DoAdvance();`,
      `
    local procedure DoAdvance()
    begin
        T.Advance();
    end;`,
    );
    expect(project(f)(C, "H1SHOULD")).toBe(true);
  });
  it("34b. control: a guard around a same-object procedure that writes nothing: not refused", () => {
    const f = files(
      `            if T.ShouldAdvance() then
                DoNothing();
            T.Advance();`,
      `
    local procedure DoNothing()
    begin
        Message('x');
    end;`,
    );
    expect(project(f)(C, "H1SHOULD")).toBe(false);
  });
});

/** R604's census counters over a project (`r572Census(..).gaps`). */
function gapsOf(files: Files): R572Gaps {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    src,
    root: wrapRoot(parseAL(src)),
  }));
  const arms = new Map(parsed.map((p) => [p.root, evaluateArms(p.root, p.src, [])]));
  return r572Census(buildSemanticContext(parsed, arms)).gaps;
}

describe("R604 census: one counter per gap master already has (not refusals)", () => {
  const ZERO: R572Gaps = {
    h2SplitQueue: 0,
    m1TouchViaWrapper: 0,
    m2ReachCutOff: 0,
    m3CopyShared: 0,
    m3RecRefByValue: 0,
    s3AliasViaVarCallee: 0,
    s4WithGlobal: 0,
    backstopCutOffs: 0,
  };
  const RESET = `codeunit 57202 "R572 Reset"
{
    var
        Count: Integer;

    procedure Maybe(var B: Record "R572 Buf"): Boolean
    begin
        Count += 1;
        if Count = 1 then
            B.FindFirst();
        exit(Count > 0);
    end;

    procedure MaybeRef(RR: RecordRef): Boolean
    begin
        Count += 1;
        if Count = 1 then
            RR.FindFirst();
        exit(Count > 0);
    end;
}`;
  it("H2: a split real-table queue (pure HasNext, Advance deletes the same table)", () => {
    const g = gapsOf({
      "Buf.Table.al": BUF,
      [C]: `codeunit 57202 "R572 Q"
{
    procedure HasNext(): Boolean
    var
        Q: Record "R572 Buf";
    begin
        exit(not Q.IsEmpty());
    end;

    procedure Advance()
    var
        Q: Record "R572 Buf";
    begin
        if Q.FindFirst() then
            Q.Delete();
    end;
}`,
      [L]: `codeunit 57201 "R572 Loop"
{
    procedure Run()
    var
        X: Codeunit "R572 Q";
    begin
        while X.HasNext() do
            X.Advance();
    end;
}`,
    });
    expect(g).toEqual({ ...ZERO, h2SplitQueue: 1 });
  });
  it("M1: a touching callee reached through a same-object wrapper under option D", () => {
    const g = gapsOf({
      "Buf.Table.al": BUF,
      [C]: RESET,
      [L]: `codeunit 57201 "R572 Loop"
{
    var
        X: Codeunit "R572 Reset";

    procedure Run()
    var
        R: Record "R572 Buf";
        More: Boolean;
    begin
        if R.FindSet() then
            repeat
                More := Wrap(R);
            until (R.Next() = 0) or not More;
    end;

    local procedure Wrap(var B: Record "R572 Buf"): Boolean
    var
        Ok: Boolean;
    begin
        Ok := X.Maybe(B);
        exit(Ok);
    end;
}`,
    });
    expect(g.m1TouchViaWrapper).toBeGreaterThan(0);
  });
  it("M2: a writer reach cut off at the hop cap", () => {
    const deep = (n: number): string =>
      Array.from({ length: n }, (_, i) =>
        i === n - 1
          ? `    local procedure A${i + 1}() begin T.Advance(); end;`
          : `    local procedure A${i + 1}() begin A${i + 2}(); end;`,
      ).join("\n");
    const files = (n: number): Files => ({
      [C]: `codeunit 57202 "R572 Tracker"
{
    var
        Status: Integer;

    procedure GetStatus(): Integer
    begin
        exit(Status);
    end;

    procedure Advance()
    begin
        Status += 1;
    end;
}`,
      [L]: `codeunit 57201 "R572 Loop"
{
    var
        T: Codeunit "R572 Tracker";

    procedure Run()
    begin
        while T.GetStatus() < 3 do
            A1();
    end;
${deep(n)}
}`,
    });
    expect(gapsOf(files(5)).m2ReachCutOff).toBeGreaterThan(0);
    expect(gapsOf(files(2)).m2ReachCutOff).toBe(0);
  });
  it("M3: `Copy(X, true)` in a refused chain's object", () => {
    const g = gapsOf({
      "Buf.Table.al": BUF,
      [C]: `codeunit 57202 "R572 TQ"
{
    var
        TempQ: Record "R572 Buf" temporary;
        TempW: Record "R572 Buf" temporary;

    procedure Init()
    begin
        TempW.Copy(TempQ, true);
    end;

    procedure HasNext(): Boolean
    begin
        exit(not TempQ.IsEmpty());
    end;

    procedure Advance()
    begin
        if TempW.FindFirst() then
            TempW.Delete();
    end;
}`,
      [L]: `codeunit 57201 "R572 Loop"
{
    procedure Run()
    var
        X: Codeunit "R572 TQ";
    begin
        X.Init();
        while X.HasNext() do
            X.Advance();
    end;
}`,
    });
    expect(g.m3CopyShared).toBe(1);
  });
  it("M3: a forced RecordRef cursor handed by value", () => {
    const g = gapsOf({
      "Buf.Table.al": BUF,
      [C]: RESET,
      [L]: `codeunit 57201 "R572 Loop"
{
    var
        X: Codeunit "R572 Reset";

    procedure Run()
    var
        RR: RecordRef;
        More: Boolean;
    begin
        RR.Open(Database::"R572 Buf");
        if RR.FindSet() then
            repeat
                More := X.MaybeRef(RR);
            until (RR.Next() = 0) or not More;
    end;
}`,
    });
    expect(g.m3RecRefByValue).toBeGreaterThan(0);
  });
  /** GetNext reads the global record `G` through `body`; `Bump` (body-called) writes `G`. */
  const alias = (body: string, extra = ""): Files => ({
    "Buf.Table.al": BUF,
    [C]: `codeunit 57202 "R572 Alias"
{
    var
        G: Record "R572 Buf";

    procedure GetNext(): Boolean
    var
        L: Record "R572 Buf";
    begin
${body}
    end;

    procedure Bump()
    begin
        G.Val := 'x';
        G.Modify();
    end;
${extra}
}`,
    [L]: loop(
      `        It: Codeunit "R572 Alias";`,
      `        while It.GetNext() do
            It.Bump();`,
    ),
  });
  it("S3: a global aliased into a local by a same-object `var` callee", () => {
    const g = gapsOf(
      alias(
        `        CopyInto(L);
        exit(L.Val = '');`,
        `
    local procedure CopyInto(var R: Record "R572 Buf")
    begin
        R := G;
    end;`,
      ),
    );
    expect(g.s3AliasViaVarCallee).toBe(1);
  });
  it("S4: `with G do exit(Val = '')` in a chain procedure", () => {
    const g = gapsOf(
      alias(`        with G do
            exit(Val = '');`),
    );
    expect(g.s4WithGlobal).toBe(1);
  });
  it("control: test 2's tracker has none of the five", () => {
    const g = gapsOf({
      [C]: `codeunit 57202 "R572 Tracker"
{
    var
        Status: Integer;

    procedure GetStatus(): Integer
    begin
        exit(Status);
    end;

    procedure Advance()
    begin
        Status := Status + 1;
    end;
}`,
      [L]: loop(
        `        T: Codeunit "R572 Tracker";
        S: Integer;`,
        `        S := T.GetStatus();
        while S < 3 do begin
            T.Advance();
            S := T.GetStatus();
        end;`,
      ),
    });
    expect(g).toEqual(ZERO);
  });
});

describe("R572 seams", () => {
  it("narrowing (a) is behind its own seam: with it off, test 14's loop is refused", () => {
    const files = dLoop(
      `            repeat
                More := F.More();
            until (R.Next(Step) = 0) or not More;`,
      "        Step: Integer;",
      "        Step := 1;\n",
    );
    expect(withSeam(r572InvariantStep, false, () => project(files)(C, "FEED"))).toBe(true);
  });
});
