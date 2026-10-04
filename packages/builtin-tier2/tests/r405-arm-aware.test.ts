import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R405 part (a) (plan `docs/superpowers/plans/2026-10-04-R-405a-arm-aware-symbol-table.md`, r2):
 * the symbol table, the two trigger readers and the receiver's shadowing guard read the members
 * inside a member-level `#if` (a `preproc_conditional` in an object body) by ARM.
 *
 * - The symbol table and the triggers see an active member, never an inactive one, and never one
 *   inside a `#if` whose file is undecided (the first arm in the text would win). An undecided
 *   DIRECT member stays, as before.
 * - The receiver keeps counting every procedure-like (`allProcedureLikes`, so R327's swallowed and
 *   R331's `#if`-object declarations still shadow) and drops only an INACTIVE one.
 * - With no arm map (a context built without one), every reader answers exactly as before: direct
 *   members only, never both arms.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  type ArmEvaluation,
  type SemanticContext,
  buildSemanticContext,
  claimsRecordMethod,
  claimsSystemCall,
  evaluateArms,
  findAll,
  initParser,
  objectScopeKey,
  resolveReceiverTable,
} from "@lethal/engine";
import { resolveForcedTrigger } from "../src/forced-trigger-raise";
import { insertSkipCanRaise, onInsertTrigger } from "../src/insert-key-assignment";
import { parseClean } from "./parse-clean";

beforeAll(async () => {
  await initParser();
});

/** `null` symbols: a context built WITHOUT an arm map. */
function load(
  files: Readonly<Record<string, string>>,
  symbols: readonly string[] | null,
): { ctx: SemanticContext; root: (path: string) => ALSyntaxNode } {
  const parsed = Object.entries(files).map(([path, text]) => ({
    path,
    text,
    root: parseClean(text),
  }));
  const arms =
    symbols === null
      ? undefined
      : new Map<ALSyntaxNode, ArmEvaluation>(
          parsed.map((p) => [p.root, evaluateArms(p.root, p.text, symbols)]),
        );
  const ctx = buildSemanticContext(
    parsed.map(({ path, root }) => ({ path, root })),
    arms,
  );
  return {
    ctx,
    root(path) {
      const found = parsed.find((p) => p.path === path);
      if (found === undefined) throw new Error(`no file ${path}`);
      return found.root;
    },
  };
}

/** The one call whose text is `text` in `root`. */
function callOf(root: ALSyntaxNode, text: string): ALSyntaxNode {
  const calls = findAll(root, ALNodeKind.procedure_call).filter((c) => c.text === text);
  const [only] = calls;
  if (only === undefined || calls.length !== 1) throw new Error(`expected one call ${text}`);
  return only;
}

// --- the symbol table: procedures ----------------------------------------------------------------

const SYM = `codeunit 50400 "S Ops"
{
#if X
    procedure OnlyX(): Integer
    begin
        exit(1);
    end;
#endif

#if X
    procedure Both(): Integer
    begin
        exit(1);
    end;
#else
    procedure Both(): Text
    begin
        exit('a');
    end;
#endif

#if X
#if Y
    procedure Nested(): Integer
    begin
        exit(2);
    end;
#endif
#endif

#if X
    procedure Twice(): Integer
    begin
        exit(3);
    end;
#endif

    procedure Twice(): Text
    begin
        exit('b');
    end;
}
`;

const SYM_UNDECIDED = `codeunit 50401 "U Ops"
{
#if and
    procedure Inside(): Integer
    begin
        exit(1);
    end;
#endif

    procedure Direct(): Integer
    begin
        exit(2);
    end;
}
`;

describe("R405 a: buildSymbolTable reads a member-level #if by arm", () => {
  const owner = objectScopeKey("codeunit", "S Ops");
  const unique = (symbols: readonly string[] | null, name: string) =>
    load({ "S.al": SYM }, symbols).ctx.symbols.uniqueProcedure(owner, name);

  it("a procedure in an active arm resolves", () => {
    expect(unique(["X"], "OnlyX")?.returnType).toBe("Integer");
  });

  it("a procedure in an inactive arm is absent, and does not hide a direct one of its name", () => {
    expect(unique([], "OnlyX")).toBeNull();
    expect(unique([], "Twice")?.returnType).toBe("Text");
    // Both declarations are compiled under X: two of one name, so neither is unique.
    expect(unique(["X"], "Twice")).toBeNull();
  });

  it("#if X P #else P #endif resolves to the active arm's P", () => {
    expect(unique(["X"], "Both")?.returnType).toBe("Integer");
    expect(unique([], "Both")?.returnType).toBe("Text");
  });

  it("nested #if: a procedure resolves only when every enclosing arm is active", () => {
    expect(unique(["X", "Y"], "Nested")?.returnType).toBe("Integer");
    expect(unique(["X"], "Nested")).toBeNull();
    expect(unique(["Y"], "Nested")).toBeNull();
  });

  it("undecided file: a procedure inside #if is refused, a direct one resolves (as before)", () => {
    const { ctx } = load({ "U.al": SYM_UNDECIDED }, ["X"]);
    const key = objectScopeKey("codeunit", "U Ops");
    expect(ctx.symbols.uniqueProcedure(key, "Inside")).toBeNull();
    expect(ctx.symbols.resolveProcedure(key, "Inside")).toBeNull();
    expect(ctx.symbols.uniqueProcedure(key, "Direct")?.returnType).toBe("Integer");
  });
});

// --- the symbol table: globals -------------------------------------------------------------------

const GLOBALS = (arms: string): string => `codeunit 50402 "G Ops"
{
${arms}
    procedure Run()
    begin
        R.Modify();
    end;
}
`;
const ONE_ARM = '#if X\n    var\n        R: Record "D Tab";\n#endif\n';
const TWO_ARMS =
  '#if X\n    var\n        R: Record "D Tab";\n#else\n    var\n        R: Integer;\n#endif\n';
const UNDECIDED_ARM = '#if and\n    var\n        R: Record "D Tab";\n#endif\n';

describe("R405 a: a var section inside a member-level #if gives globals by arm", () => {
  const owner = objectScopeKey("codeunit", "G Ops");
  const probe = (arms: string, symbols: readonly string[] | null) => {
    const { ctx, root } = load({ "G.al": GLOBALS(arms) }, symbols);
    const call = callOf(root("G.al"), "R.Modify()");
    return {
      globals: ctx.symbols.globalsOf(owner).map((v) => `${v.name}: ${v.typeText}`),
      table: resolveReceiverTable(call, ctx),
      claimed: claimsRecordMethod(call, ctx, "Modify"),
    };
  };

  it("an active arm makes R a global, so R.Modify() resolves", () => {
    expect(probe(ONE_ARM, ["X"])).toEqual({
      globals: ['R: Record "D Tab"'],
      table: "D Tab",
      claimed: true,
    });
  });

  it("an inactive arm leaves R unresolved", () => {
    expect(probe(ONE_ARM, [])).toEqual({ globals: [], table: null, claimed: false });
  });

  it("two arms with different types resolve to the active arm's", () => {
    expect(probe(TWO_ARMS, ["X"]).table).toBe("D Tab");
    expect(probe(TWO_ARMS, []).globals).toEqual(["R: Integer"]);
    expect(probe(TWO_ARMS, []).claimed).toBe(false);
  });

  it("an undecided #if leaves R unresolved", () => {
    expect(probe(UNDECIDED_ARM, ["X"])).toEqual({ globals: [], table: null, claimed: false });
  });
});

// --- the trigger readers -------------------------------------------------------------------------

const KEYED = (triggers: string): string => `table 50403 "I Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
${triggers}}
`;
const ON_INSERT = `    trigger OnInsert()
    begin
        "Code" := 'A';
    end;
`;
const ON_MODIFY = `    trigger OnModify()
    begin
        Error('m');
    end;
`;
const INS_OPS = `codeunit 50404 "I Ops"
{
    procedure Ins()
    var
        T: Record "I Tab";
    begin
        T.Insert(true);
    end;

    procedure Modi()
    var
        T: Record "I Tab";
    begin
        T.Modify();
    end;
}
`;

describe("R405 a: OnInsert inside a member-level #if", () => {
  const skip = (triggers: string, symbols: readonly string[] | null): boolean => {
    const { ctx, root } = load({ "T.al": KEYED(triggers), "O.al": INS_OPS }, symbols);
    return insertSkipCanRaise(callOf(root("O.al"), "T.Insert(true)"), ctx);
  };

  it("control: a direct OnInsert that assigns the key keeps the tag", () => {
    expect(skip(ON_INSERT, ["X"])).toBe(true);
  });

  it("an active arm drives insertSkipCanRaise exactly as a direct OnInsert does", () => {
    expect(skip(`#if X\n${ON_INSERT}#endif\n`, ["X"])).toBe(true);
  });

  it("an inactive arm acts as if the trigger were absent", () => {
    expect(skip(`#if X\n${ON_INSERT}#endif\n`, [])).toBe(false);
    expect(skip("", [])).toBe(false);
  });

  it("onInsertTrigger finds the active arm's trigger, not the inactive one's", () => {
    const text = KEYED(`#if X\n${ON_INSERT}#endif\n`);
    for (const [symbols, found] of [
      [["X"], true],
      [[], false],
    ] as const) {
      const { ctx, root } = load({ "T.al": text }, symbols);
      const table = findAll(root("T.al"), ALNodeKind.table)[0];
      if (table === undefined) throw new Error("no table");
      expect(onInsertTrigger(table, () => true, ctx.armOf) !== null).toBe(found);
    }
  });
});

describe("R405 a: findTableTrigger (forward swap-modify-flag) inside a member-level #if", () => {
  const forced = (triggers: string, symbols: readonly string[] | null): string | null => {
    const { ctx, root } = load({ "T.al": KEYED(triggers), "O.al": INS_OPS }, symbols);
    const trigger = resolveForcedTrigger(callOf(root("O.al"), "T.Modify()"), ctx, "Modify");
    return trigger === null ? null : (trigger.childForFieldName("name")?.text ?? "?");
  };

  it("an active arm's OnModify is found; an inactive arm's is not", () => {
    expect(forced(`#if X\n${ON_MODIFY}#endif\n`, ["X"])).toBe("OnModify");
    expect(forced(`#if X\n${ON_MODIFY}#endif\n`, [])).toBeNull();
  });

  it("undecided file: a trigger inside #if is NOT found, a direct one IS (as before)", () => {
    expect(forced(`#if and\n${ON_MODIFY}#endif\n`, ["X"])).toBeNull();
    expect(forced(`${ON_MODIFY}#if and\n${ON_INSERT}#endif\n`, ["X"])).toBe("OnModify");
  });
});

// --- the receiver's shadowing guard ---------------------------------------------------------------

const COMMIT_OPS = (decl: string): string => `codeunit 50405 "C Ops"
{
${decl}
    procedure Run()
    begin
        Commit();
    end;
}
`;
const COMMIT_PROC = "    procedure Commit()\n    begin\n    end;\n";
const MOD_TABLE = (decl: string): string => `table 50406 "M Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
    }
${decl}}
`;
const MOD_PROC = "    procedure Modify()\n    begin\n    end;\n";
const MOD_OPS = `codeunit 50407 "M Ops"
{
    procedure Run()
    var
        M: Record "M Tab";
    begin
        M.Modify();
    end;
}
`;

describe("R405 a: a procedure declared only in an inactive arm does not shadow a built-in", () => {
  const commit = (decl: string, symbols: readonly string[] | null): boolean => {
    const { ctx, root } = load({ "C.al": COMMIT_OPS(decl) }, symbols);
    return claimsSystemCall(callOf(root("C.al"), "Commit()"), ctx, "Commit");
  };
  const modify = (decl: string, symbols: readonly string[] | null): boolean => {
    const { ctx, root } = load({ "T.al": MOD_TABLE(decl), "O.al": MOD_OPS }, symbols);
    return claimsRecordMethod(callOf(root("O.al"), "M.Modify()"), ctx, "Modify");
  };

  it("Commit() is claimed when its project namesake is in an inactive arm, refused in an active one", () => {
    expect(commit(`#if X\n${COMMIT_PROC}#endif\n`, [])).toBe(true);
    expect(commit(`#if X\n${COMMIT_PROC}#endif\n`, ["X"])).toBe(false);
  });

  it("R.Modify() is claimed when the table's Modify is in an inactive arm, refused in an active one", () => {
    expect(modify(`#if X\n${MOD_PROC}#endif\n`, [])).toBe(true);
    expect(modify(`#if X\n${MOD_PROC}#endif\n`, ["X"])).toBe(false);
  });

  it("undecided: the namesake inside #if still shadows (refused)", () => {
    expect(commit(`#if and\n${COMMIT_PROC}#endif\n`, ["X"])).toBe(false);
    expect(modify(`#if and\n${MOD_PROC}#endif\n`, ["X"])).toBe(false);
  });

  // R327: a split member after the global var section is swallowed into it; it still shadows.
  const SWALLOWED =
    "    var\n        G: Integer;\n\n#if X\n    procedure Commit()\n#else\n    procedure Commit()\n#endif\n    begin\n    end;\n";
  const SPLIT =
    "#if X\n    procedure Commit()\n#else\n    procedure Commit()\n#endif\n    begin\n    end;\n";

  it("a var-swallowed split member (R327) still shadows, in both builds", () => {
    for (const symbols of [[], ["X"]]) expect(commit(SWALLOWED, symbols)).toBe(false);
  });

  it("a direct split member still shadows, in both builds", () => {
    for (const symbols of [[], ["X"]]) expect(commit(SPLIT, symbols)).toBe(false);
  });

  it("a table wrapped whole in #if (R331) still shadows, in both builds", () => {
    const t = MOD_TABLE(MOD_PROC);
    for (const symbols of [[], ["X"]]) {
      const { ctx, root } = load(
        { "T.al": `#if X\n${t}#else\n${t}#endif\n`, "O.al": MOD_OPS },
        symbols,
      );
      expect(claimsRecordMethod(callOf(root("O.al"), "M.Modify()"), ctx, "Modify")).toBe(false);
    }
  });
});

// --- no arm map: exactly as before ---------------------------------------------------------------

describe("R405 a: a context built WITHOUT an arm map reads direct members only, as before", () => {
  it("symbol table: a procedure inside #if is refused, never resolved from either arm", () => {
    const { ctx } = load({ "S.al": SYM }, null);
    const owner = objectScopeKey("codeunit", "S Ops");
    expect(ctx.symbols.uniqueProcedure(owner, "OnlyX")).toBeNull();
    expect(ctx.symbols.uniqueProcedure(owner, "Both")).toBeNull();
    expect(ctx.symbols.uniqueProcedure(owner, "Nested")).toBeNull();
    expect(ctx.symbols.uniqueProcedure(owner, "Twice")).toBeNull();
    expect(ctx.symbols.resolveProcedure(owner, "OnlyX")).toBeNull();
  });

  it("globals: a var section inside #if gives no global", () => {
    const { ctx } = load({ "G.al": GLOBALS(TWO_ARMS) }, null);
    expect(ctx.symbols.globalsOf(objectScopeKey("codeunit", "G Ops"))).toEqual([]);
  });

  it("triggers: a trigger inside #if is not found", () => {
    const { ctx, root } = load(
      { "T.al": KEYED(`#if X\n${ON_MODIFY}#endif\n#if X\n${ON_INSERT}#endif\n`), "O.al": INS_OPS },
      null,
    );
    expect(resolveForcedTrigger(callOf(root("O.al"), "T.Modify()"), ctx, "Modify")).toBeNull();
    const table = findAll(root("T.al"), ALNodeKind.table)[0];
    if (table === undefined) throw new Error("no table");
    expect(onInsertTrigger(table, () => true, ctx.armOf)).toBeNull();
  });

  it("receiver: a namesake inside #if shadows, whatever its arm", () => {
    const { ctx, root } = load({ "C.al": COMMIT_OPS(`#if X\n${COMMIT_PROC}#endif\n`) }, null);
    expect(claimsSystemCall(callOf(root("C.al"), "Commit()"), ctx, "Commit")).toBe(false);
  });
});
