import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  FileRefusedError,
  findAll,
  findFirst,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { compileSchemataForFile } from "../src/compile";
import { emitFile } from "../src/compile-emit";
import { planFile } from "../src/compile-plan";

/**
 * R-307 O5 (plan amendment 2026-10-03). `planFile` is the PLAN half of `compileSchemataForFile`:
 * every decision and every throw. `emitFile` is the EMIT half: text from the frozen plan only.
 */

function spec(before: ALSyntaxNode, after: unknown, operatorName: string): MutationSpec {
  return {
    operatorName,
    operatorVersion: "1.0.0",
    astNodeId: `${before.startIndex}-${before.endIndex}`,
    before,
    after: after as never,
    parentContext: "statement-position",
  };
}

function refusalOf(fn: () => unknown): FileRefusedError {
  try {
    fn();
  } catch (err) {
    if (err instanceof FileRefusedError) return err;
    throw err;
  }
  throw new Error("expected a FileRefusedError, got none");
}

describe("R-307 O5: plan-only twins of the compile refusals", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("twin of compile.test.ts's xmlport case: planFile refuses with the same fields", () => {
    const source = `xmlport 50100 "My Port"
{
    schema
    {
        textelement(Root)
        {
            tableelement(Cust; Customer)
            {
                trigger OnAfterGetRecord()
                begin
                    DoThing();
                end;
            }
        }
    }
}`;
    const root = wrapRoot(parseAL(source));
    const call = findFirst(root, ALNodeKind.procedure_call);
    if (call === null) throw new Error("no call in fixture");
    const s = spec(call, { ...call, text: "" }, "lethal.void-method-call");
    const thrown = refusalOf(() => planFile(source, root, [s], undefined, "MyPort.XmlPort.al"));
    expect(thrown.message).toContain("MyPort.XmlPort.al");
    expect(thrown.message).toContain("AL0118");
    expect(thrown.file).toBe("MyPort.XmlPort.al");
    expect(thrown.shape).toBe("unsupported-kind");
    expect(thrown.site).toBe("compile.unsupported-kind");
    expect(thrown.objects).toEqual([{ type: "xmlport", id: 50100, name: "My Port" }]);
    expect(thrown.lines).toEqual([11, 11]);
  });

  it("twin of compile.test.ts's latch-owner case: planFile refuses with the same fields", () => {
    const text = "L := 1";
    const before: ALSyntaxNode = {
      kind: ALNodeKind.assignment_statement,
      rawKind: "assignment_statement",
      text,
      startIndex: 0,
      endIndex: text.length,
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: text.length },
      parent: null,
      children: [],
      namedChildren: [],
      fieldName: null,
      isMissing: false,
      hasError: false,
      childForFieldName: () => null,
    };
    const s = spec(before, { ...before, text: "L := 2" }, "lethal.op");
    const thrown = refusalOf(() => planFile(text, before, [s], undefined, "src/Detached.al"));
    expect(thrown.message).toContain("a reach marker sits outside any procedure or trigger body");
    expect(thrown.file).toBe("src/Detached.al");
    expect(thrown.shape).toBe("latch-owner");
    expect(thrown.site).toBe("compile.latch-owner");
    expect(thrown.objects).toBeUndefined();
    expect(thrown.lines).toEqual([1, 1]);
  });
});

/**
 * Wraps node-like values in a `Proxy` that counts EVERY property read (`get`, `has`, `ownKeys`,
 * `getOwnPropertyDescriptor`), string and symbol keys alike. A node-like value it returns (a
 * parent, each child, a method's result) is wrapped too, memoised by target so a node keeps one
 * proxy identity: the plan keys `Map`s by node identity, so a fresh proxy per read would change
 * behaviour, not only count it.
 */
function countingNodes(): { wrap: <T>(v: T) => T; reads: () => number } {
  let reads = 0;
  const memo = new WeakMap<object, object>();
  const wrap = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(wrap);
    if (typeof v !== "object" || v === null || !("startIndex" in v)) return v;
    const known = memo.get(v);
    if (known !== undefined) return known;
    const proxy = new Proxy(v, {
      get(t, key) {
        reads++;
        const r: unknown = Reflect.get(t, key, t);
        if (typeof r === "function")
          return (...a: unknown[]) => wrap(Reflect.apply(r as (...x: unknown[]) => unknown, t, a));
        return wrap(r);
      },
      has(t, key) {
        reads++;
        return Reflect.has(t, key);
      },
      ownKeys(t) {
        reads++;
        return Reflect.ownKeys(t);
      },
      getOwnPropertyDescriptor(t, key) {
        reads++;
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
    });
    memo.set(v, proxy);
    return proxy;
  };
  return { wrap: <T>(v: T) => wrap(v) as T, reads: () => reads };
}

describe("R-307 O5 (I5): EMIT reads no node", () => {
  beforeAll(async () => {
    await initParser();
  });

  const SRC = [
    'codeunit 79391 "Frozen"',
    "{",
    "    procedure P(C: Boolean)",
    "    var",
    "        X: Integer;",
    "    begin",
    "        X := 1;",
    "        if C then",
    "            X := 2;",
    "    end;",
    "}",
    "",
  ].join("\n");

  /** A custom-tier operator's specs: a statement replacement, a nested literal, a slot statement. */
  function specsOf(root: ALSyntaxNode, wrap: <T>(v: T) => T): MutationSpec[] {
    const [first, second] = findAll(root, ALNodeKind.assignment_statement);
    const literal = first === undefined ? undefined : findFirst(first, ALNodeKind.integer_literal);
    if (first === undefined || second === undefined || literal === undefined || literal === null)
      throw new Error("fixture drift");
    return [
      spec(wrap(first), wrap({ ...first, text: "X := 7" }), "custom.replace"),
      spec(wrap(literal), wrap({ ...literal, text: "9" }), "custom.literal"),
      spec(wrap(second), wrap({ ...second, text: "" }), "custom.delete"),
    ];
  }

  it("after planFile returns, emitFile adds zero reads on any operator-supplied node", () => {
    const counter = countingNodes();
    const root = wrapRoot(parseAL(SRC));
    const specs = specsOf(root, counter.wrap);
    const plan = planFile(SRC, root, specs, undefined, "Frozen.Codeunit.al");
    const afterPlan = counter.reads();
    // PLAN did read the nodes, so a zero below is not a counter that never counts.
    expect(afterPlan).toBeGreaterThan(0);
    const out = emitFile(plan);
    expect(counter.reads()).toBe(afterPlan);
    // And the text is the composition's, from unwrapped specs.
    const plainRoot = wrapRoot(parseAL(SRC));
    const plain = specsOf(plainRoot, (v) => v);
    expect(out).toBe(
      compileSchemataForFile(SRC, plainRoot, plain, undefined, "Frozen.Codeunit.al"),
    );
    expect(out).toContain("MutationSelector.Active('M0001')");
    expect(out).toContain("MutationSelector.Active('M0003')");
  });
});
