import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";
import { r572InvariantStep, r572RequireNonZeroStep, r572Seam } from "../src/loop-hazard";

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

function project(files: Files) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    root: wrapRoot(parseAL(src)),
  }));
  const ctx = buildSemanticContext(parsed);
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

  // 12. a cycle A(var T) -> B(T) -> A, read in both orders
  const cyc = (pFirst: boolean): Files => {
    const lp = `        S := 'abc';
        V := C.P(S);
        while V <> '' do
            V := C.P(S);`;
    const lq = `        S := 'abc';
        V := C.Q(S);
        while V <> '' do
            V := C.Q(S);`;
    return {
      [C]: `codeunit 57202 "R572 Cyc"
{
    procedure P(var S: Text): Text
    var
        Tag: Text;
        V: Text;
    begin
        Tag := 'T12P';
        V := Q(S);
        S := CopyStr(S, 2);
        exit(V);
    end;

    procedure Q(T: Text): Text
    var
        Tag: Text;
        V: Text;
    begin
        Tag := 'T12Q';
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
  it("12. a cycle P(var S) -> Q(T) -> P: both refused, whichever loop is read first", () => {
    for (const first of [true, false]) {
      const at = project(cyc(first));
      expect(at(C, "T12P")).toBe(true);
      expect(at(C, "T12Q")).toBe(true);
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
  it("23b. control: a by-value parameter step with the non-zero rule off is skipped", () => {
    const files: Files = {
      "Buf.Table.al": BUF,
      [C]: FEED,
      [L]: `codeunit 57201 "R572 Loop"
{
    procedure Run(Step: Integer)
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
    expect(withSeam(r572RequireNonZeroStep, false, () => project(files)(C, "FEED"))).toBe(false);
    // with the rule on (the default until the Next(0) probe), a parameter is not proven non-zero
    expect(project(files)(C, "FEED")).toBe(true);
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

  it("21. field-argument writes: `Evaluate(Buf.Val, ..)` and `H.Inc(Buf.Val)` (var): refused", () => {
    const at = project({
      "Buf.Table.al": BUF,
      "H.Codeunit.al": `codeunit 57203 "R572 H"
{
    procedure Inc(var V: Text)
    begin
        V := V + 'x';
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
}`,
      [L]: loop(
        `        It: Codeunit "R572 Fld";`,
        `        while It.GetNext() <> 'xxx' do begin
            It.Load('a');
            It.Bump();
        end;`,
      ),
    });
    expect(at(C, "T21A")).toBe(true);
    expect(at(C, "T21B")).toBe(true);
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
