import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind, findAll, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { buildComponents } from "../src/components";
import { assignMutantIds } from "../src/ids";
import {
  type IdentityEntry,
  assignIdentityOrdinals,
  identitySiteKey,
  numberIdentityOrdinals,
} from "../src/project";

/**
 * R475: every identity and ordering path orders strings by UTF-16 code unit, never by the host's
 * default collation. Under `localeCompare` ("en") `a` sorts before `B` and `aop` before `Zop`; by
 * code unit `B` (0x42) and `Z` (0x5A) sort before `a` (0x61). So each expectation below is RED on
 * a comparator that still calls `localeCompare`, and `underBothCollations` also re-runs each case
 * with `localeCompare` negated (a host with the opposite collation) and requires the same answer.
 */
function underBothCollations<T>(f: () => T): T {
  const plain = f();
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function (
    this: string,
    that: string,
    locales?: string | string[],
    options?: Intl.CollatorOptions,
  ): number {
    return -original.call(this, that, locales, options);
  };
  try {
    expect(f()).toEqual(plain);
  } finally {
    String.prototype.localeCompare = original;
  }
  return plain;
}

const entry = (file: string, operatorName: string, tuple: string): IdentityEntry => ({
  file,
  startIndex: 10,
  endIndex: 20,
  operatorName,
  tuple,
});

describe("R475: identity order is code-unit order, whatever the host collation", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("numberIdentityOrdinals numbers cross-file twins in code-unit FILE order", () => {
    const entries = [entry("src/a.al", "op", "t"), entry("src/B.al", "op", "t")];
    const ordinals = underBothCollations(() => {
      const m = numberIdentityOrdinals(entries);
      return ["src/B.al", "src/a.al"].map((f) => m.get(identitySiteKey(f, 10, 20, "op")));
    });
    expect(ordinals).toEqual([0, 1]);
  });

  it("numberIdentityOrdinals visits one site's operators in code-unit order (the Map's order)", () => {
    // Different tuples, so no ordinal can move; the operator tie-break decides only iteration order.
    const entries = [entry("f.al", "aop", "t1"), entry("f.al", "Zop", "t2")];
    const keys = underBothCollations(() => [...numberIdentityOrdinals(entries).keys()]);
    expect(keys).toEqual([
      identitySiteKey("f.al", 10, 20, "Zop"),
      identitySiteKey("f.al", 10, 20, "aop"),
    ]);
  });

  const manifestEntry = (mutantId: string, file: string) =>
    ({
      mutantId,
      file,
      startIndex: 10,
      endIndex: 20,
      startLine: 1,
      operatorName: "op",
      operatorVersion: "1.0.0",
      astHash: "same",
      objectType: "codeunit",
      codeunitId: 1,
      codeunitName: "A",
      procedureName: "P",
      originalText: "true",
      mutatedText: "false",
    }) as Parameters<typeof assignIdentityOrdinals>[0][number];

  it("assignIdentityOrdinals numbers cross-file twins in code-unit file order", () => {
    const out = underBothCollations(() =>
      assignIdentityOrdinals([
        manifestEntry("M0001", "src/a.al"),
        manifestEntry("M0002", "src/B.al"),
      ]).map((m) => `${m.file}=${m.identityOrdinal}`),
    );
    expect(out).toEqual(["src/a.al=1", "src/B.al=0"]);
  });

  it("assignIdentityOrdinals breaks a same-site tie by mutant id in code-unit order", () => {
    const out = underBothCollations(() =>
      assignIdentityOrdinals([manifestEntry("Ma", "f.al"), manifestEntry("MB", "f.al")]).map(
        (m) => `${m.mutantId}=${m.identityOrdinal}`,
      ),
    );
    expect(out).toEqual(["Ma=1", "MB=0"]);
  });

  const spec = (before: unknown, operatorName: string): MutationSpec =>
    ({
      operatorName,
      operatorVersion: "1.0.0",
      astNodeId: "n",
      before,
      after: { text: "y" },
      parentContext: "statement-position",
    }) as never;

  it("assignMutantIds codes same-start operators in code-unit order", () => {
    const before = { startIndex: 10, endIndex: 11, text: "x" };
    const codes = underBothCollations(() =>
      [...assignMutantIds(new Map([["f.al", [spec(before, "aop"), spec(before, "Zop")]]])).values()]
        .flat()
        .map((s) => `${s.mutantId}=${s.spec.operatorName}`),
    );
    expect(codes).toEqual(["M0001=Zop", "M0002=aop"]);
  });

  it("buildComponents orders same-span members by operator in code-unit order", () => {
    const root = wrapRoot(
      parseAL(`codeunit 79000 "T"
{
    procedure P(): Integer
    begin
        exit(1);
    end;
}
`),
    );
    const exit: ALSyntaxNode | undefined = findAll(root, ALNodeKind.exit_statement)[0];
    if (exit === undefined) throw new Error("fixture drift");
    const members = underBothCollations(() =>
      buildComponents([
        { mutantId: "M0001", spec: spec(exit, "aop") },
        { mutantId: "M0002", spec: spec(exit, "Zop") },
      ]).flatMap((c) => c.members.map((m) => m.mutantId)),
    );
    expect(members).toEqual(["M0002", "M0001"]);
  });
});
