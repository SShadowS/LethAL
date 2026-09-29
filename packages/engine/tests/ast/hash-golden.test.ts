import { beforeAll, describe, expect, it } from "bun:test";
import { astSubtreeHash } from "../../src/ast/hash";
import { initParser, parseAL } from "../../src/ast/parser";
import { initWasmParser, parseALWasm, wrapWasmRoot } from "../../src/ast/parser-wasm";
import {
  type ALSyntaxNode,
  FLAG_FIELD_TARGET,
  FLAG_MISSING,
  FLAG_NAMED,
  type FlatTree,
  findAll,
  visit,
  withText,
  wrapFlatRoot,
  wrapRoot,
} from "../../src/ast/syntax-node";

/**
 * RUST-03 S4.2d, AMENDMENT 8 Guard 1. These are the first pinned `astSubtreeHash` values: never
 * re-capture one of the hex literals below.
 *
 * Each case pins the same hash across three wrappers of the same tree, so a case name starting
 * "flat" is a native `FlatNode` (`wrapFlatRoot`, `wrapRoot`), "generic mirror" is `mirror(...)` (a
 * test-side forwarding wrapper that forces the generic `ALSyntaxNode` path), and "generic wasm" is
 * the WASM parser's wrapper. A `withText` node is covered too.
 *
 * Golden literals cover every structural rule: `member`/`function` names, numbering (first use and
 * reuse), all four literal kinds, a named operator leaf, anonymous children, a non-leaf's own text,
 * empty text, CRLF, non-ASCII, lone surrogates, surrogate pairs inside long text literals, ERROR,
 * MISSING, and `withText` leaves.
 */
const PAIR = "😀";
const LONE = "\uD800";

// --- a hand-built flat tree, so every structural rule is exercised exactly ---------------------

interface Spec {
  readonly k: string;
  /** A leaf's text, or the text a non-leaf adds after its children (its "own" text). */
  readonly t?: string;
  readonly f?: string;
  readonly anon?: true;
  readonly missing?: true;
  readonly c?: readonly Spec[];
}

function buildFlat(root: Spec): ALSyntaxNode {
  const kindNames: string[] = [];
  const fieldNames: string[] = [""];
  const kind: number[] = [];
  const field: number[] = [];
  const flags: number[] = [];
  const childCount: number[] = [];
  const nextSibling: number[] = [];
  const startIndex: number[] = [];
  const endIndex: number[] = [];
  let source = "";
  const idOf = (list: string[], s: string): number => {
    const at = list.indexOf(s);
    if (at !== -1) return at;
    list.push(s);
    return list.length - 1;
  };
  const add = (s: Spec): number => {
    const i = kind.length;
    kind.push(idOf(kindNames, s.k));
    field.push(s.f === undefined ? 0 : idOf(fieldNames, s.f));
    flags.push(
      (s.anon === true ? 0 : FLAG_NAMED) |
        (s.missing === true ? FLAG_MISSING : 0) |
        (s.f === undefined ? 0 : FLAG_FIELD_TARGET),
    );
    childCount.push((s.c ?? []).length);
    nextSibling.push(-1);
    startIndex.push(source.length);
    endIndex.push(0);
    let prev = -1;
    for (const c of s.c ?? []) {
      const ci = add(c);
      if (prev !== -1) nextSibling[prev] = ci;
      prev = ci;
    }
    source += s.t ?? "";
    endIndex[i] = source.length;
    return i;
  };
  add(root);
  const flat: FlatTree = {
    kindNames,
    kind: Uint16Array.from(kind),
    fieldNames,
    field: Uint16Array.from(field),
    flags: Uint8Array.from(flags),
    childCount: Uint32Array.from(childCount),
    nextSibling: Int32Array.from(nextSibling),
    startIndex: Uint32Array.from(startIndex),
    endIndex: Uint32Array.from(endIndex),
    points: new Uint32Array(4 * kind.length),
  };
  return wrapFlatRoot({ source, flat });
}

const id = (t: string, f?: string): Spec =>
  f === undefined ? { k: "identifier", t } : { k: "identifier", t, f };

/** Names, numbering, literals, leaves, anonymous children and a non-leaf's own text, in one tree. */
const STRUCTURE: Spec = {
  k: "root",
  t: " ROOT OWN TEXT, IGNORED",
  c: [
    id("A"),
    { k: "member_expression", c: [id("A"), id("Delete", "member")] },
    { k: "call_expression", c: [id("Foo", "function"), id("B"), id("A")] },
    // `member`/`function` identifiers are NOT numbered: `C` must still get #2 after them.
    id("Delete", "member"),
    id("C", "argument"),
    id("a"),
    // An identifier is handled before any child inspection: its children are never visited.
    { k: "identifier", t: "B", c: [{ k: "integer", t: "99" }] },
    { k: "integer", t: "12" },
    { k: "decimal", t: "3.50" },
    { k: "string_literal", t: "'x'" },
    { k: "boolean", t: "TRUE" },
    // A literal emits its own text even when it has named children.
    { k: "integer", t: "7", c: [{ k: "decimal", t: "8.0" }] },
    { k: "comparison_operator", t: ">=" },
    { k: "basic_type", t: "Integer" },
    // Anonymous children, one of them with a named descendant, are skipped whole.
    { k: "+", t: "+", anon: true },
    { k: "anon_group", anon: true, c: [id("Z"), { k: "integer", t: "5" }] },
    { k: "binary", t: " own", c: [id("A"), { k: "-", t: "-", anon: true }, id("D")] },
  ],
};

/** Exact text cases, each in a leaf. */
const TEXTS: Spec = {
  k: "texts",
  c: [
    { k: "empty", t: "" },
    { k: "crlf", t: "a\r\nb\r\n" },
    { k: "non_ascii", t: "Grüße ✓ 日本" },
    { k: "lone_high", t: `x${LONE}y` },
    { k: "lone_low", t: "\uDC00" },
    { k: "pair", t: `p${PAIR}q` },
    { k: "string_literal", t: `'${LONE}${PAIR}'` },
  ],
};

/** ERROR and MISSING nodes follow the ordinary rules; `isMissing`/`hasError` are not hashed. */
const ERRORS: Spec = {
  k: "statement_block",
  c: [
    { k: "ERROR", c: [{ k: "assignment_operator", t: ":=" }, id("A")] },
    { k: "ERROR", t: "@@" },
    { k: "end_keyword", t: "", missing: true },
    { k: ")", t: "", anon: true, missing: true },
  ],
};

/** A surrogate pair inside a long text literal, at three paddings: `(r (p <pad>) (q <PAIR>))`. */
const pairInLongText = (pad: 0 | 1 | 2): Spec => ({
  k: "r",
  c: [
    { k: "p", t: "a".repeat(4082 + pad) },
    { k: "q", t: PAIR },
  ],
});

/** A single very long text literal, with two surrogate pairs inside it. */
const HUGE: Spec = {
  k: "r",
  c: [
    { k: "p", t: `${"b".repeat(4088)}${PAIR}${"c".repeat(4092)}${PAIR}${"d".repeat(700)}` },
    id("A"),
  ],
};

// --- real parses -------------------------------------------------------------------------------

const REAL = [
  'codeunit 50100 "Golden"',
  "{",
  '    procedure P(Rec: Record "T"; A: Integer; B: Integer): Boolean',
  "    var",
  "        X: Decimal;",
  "        Msg: Text;",
  "    begin",
  "        Rec.Delete(false);",
  "        Foo(A, B, A);",
  "        X := A + 12 * 3.5;",
  `        Msg := 'Grüße ✓' + '${PAIR}';`,
  "        /* block\r\ncomment */",
  `        Msg := '${LONE}x';`,
  "        exit((A + B) >= 3);",
  "    end;",
  "}",
].join("\r\n");
const ERROR_SRC = 'codeunit 1 "B" { procedure P() begin X := (A + ; end; }';
const MISSING_SRC = 'codeunit 1 "B" { procedure P() begin if A then end; }';
/** `(additive_expression (string_literal '<pad>') (string_literal '<PAIR>'))`: a long text literal. */
const PAD_SRC = `codeunit 50101 "Pad" { procedure P() var Msg: Text; begin Msg := '${"a".repeat(4036)}' + '${PAIR}'; end; }`;

type Parse = (src: string) => ALSyntaxNode;
const native: Parse = (src) => wrapRoot(parseAL(src));
const wasm: Parse = (src) => wrapWasmRoot(parseALWasm(src));

function first(root: ALSyntaxNode, rawKind: string): ALSyntaxNode {
  let hit: ALSyntaxNode | null = null;
  visit(root, (n) => {
    if (hit === null && n.rawKind === rawKind) hit = n;
  });
  if (hit === null) throw new Error(`no ${rawKind}`);
  return hit;
}

function stringLiteral(root: ALSyntaxNode, text: string): ALSyntaxNode {
  const hit = findAll(root, "string_literal" as ALSyntaxNode["kind"]).find((n) => n.text === text);
  if (hit === undefined) throw new Error(`no string literal ${text}`);
  return hit;
}

/**
 * A forwarding wrapper: `mirror(node)` implements `ALSyntaxNode` by reading every member through
 * `node`, and wraps each child it hands out, so a hash over it never sees a native `FlatNode` and
 * always takes the generic path. Like the product wrappers, it builds fresh children on every read.
 */
class Mirror implements ALSyntaxNode {
  constructor(
    private readonly inner: ALSyntaxNode,
    readonly parent: ALSyntaxNode | null,
  ) {}
  get kind() {
    return this.inner.kind;
  }
  get rawKind() {
    return this.inner.rawKind;
  }
  get text() {
    return this.inner.text;
  }
  get startIndex() {
    return this.inner.startIndex;
  }
  get endIndex() {
    return this.inner.endIndex;
  }
  get startPosition() {
    return this.inner.startPosition;
  }
  get endPosition() {
    return this.inner.endPosition;
  }
  get children(): readonly ALSyntaxNode[] {
    return this.inner.children.map((c) => new Mirror(c, this));
  }
  get namedChildren(): readonly ALSyntaxNode[] {
    return this.inner.namedChildren.map((c) => new Mirror(c, this));
  }
  get fieldName() {
    return this.inner.fieldName;
  }
  get isMissing() {
    return this.inner.isMissing;
  }
  get hasError() {
    return this.inner.hasError;
  }
  childForFieldName(name: string): ALSyntaxNode | null {
    const c = this.inner.childForFieldName(name);
    return c === null ? null : new Mirror(c, this);
  }
}

function mirror(node: ALSyntaxNode): ALSyntaxNode {
  return new Mirror(node, node.parent);
}

// --- the cases ---------------------------------------------------------------------------------

type Case = readonly [name: string, make: () => ALSyntaxNode];

const synthetic = (name: string, spec: Spec): Case[] => [
  [`flat ${name}`, () => buildFlat(spec)],
  [`generic ${name}`, () => mirror(buildFlat(spec))],
];

const real = (name: string, pick: (parse: Parse) => ALSyntaxNode): Case[] => [
  [`flat ${name}`, () => pick(native)],
  [`generic mirror ${name}`, () => mirror(pick(native))],
  [`generic wasm ${name}`, () => pick(wasm)],
];

const CASES: readonly Case[] = [
  ...synthetic("structure", STRUCTURE),
  ...synthetic("texts", TEXTS),
  ...synthetic("errors", ERRORS),
  ...synthetic("surrogate pair inside a long text literal (pad 4082)", pairInLongText(0)),
  ...synthetic("surrogate pair inside a long text literal (pad 4083)", pairInLongText(1)),
  ...synthetic("surrogate pair inside a long text literal (pad 4084)", pairInLongText(2)),
  ...synthetic("a very long text literal", HUGE),
  ...real("procedure", (p) => first(p(REAL), "procedure")),
  ...real("whole file", (p) => p(REAL)),
  ...real("member call", (p) => first(p(REAL), "call_expression")),
  ...real("comparison", (p) => first(p(REAL), "comparison_expression")),
  ...real("block comment with CRLF", (p) => first(p(REAL), "multiline_comment")),
  ...real("lone surrogate literal", (p) => stringLiteral(p(REAL), `'${LONE}x'`)),
  ...real("ERROR", (p) => p(ERROR_SRC)),
  ...real("MISSING", (p) => p(MISSING_SRC)),
  ...real("parsed long text literal with a surrogate pair", (p) =>
    first(p(PAD_SRC), "additive_expression"),
  ),
  // A `withText` leaf: its replacement text is hashed, not `before`'s. `before` is a native
  // FlatNode, so these start on the generic path.
  [
    "withText string literal",
    () => withText(stringLiteral(native(REAL), "'Grüße ✓'"), `'Ersatz ✓ ${PAIR} ${LONE}'`),
  ],
  ["withText integer", () => withText(first(native(REAL), "integer"), "13")],
  [
    "withText identifier",
    () => withText(first(first(native(REAL), "member_expression"), "identifier"), "Other"),
  ],
  ["withText operator leaf", () => withText(first(native(REAL), "comparison_operator"), ">")],
];

const GOLDEN: Readonly<Record<string, string>> = {
  "flat structure": "3176e69576652636ade3f9a1b79f4aafc912c0653b275a95990249eb7f587091",
  "generic structure": "3176e69576652636ade3f9a1b79f4aafc912c0653b275a95990249eb7f587091",
  "flat texts": "3fdb1b5e6f07a005378b560d24d571fdc154ea14ae638a83905783dea5097784",
  "generic texts": "3fdb1b5e6f07a005378b560d24d571fdc154ea14ae638a83905783dea5097784",
  "flat errors": "b458a338d922b7c81c051959e0371fc688765be8cb35bb59824d137c834e5f41",
  "generic errors": "b458a338d922b7c81c051959e0371fc688765be8cb35bb59824d137c834e5f41",
  "flat surrogate pair inside a long text literal (pad 4082)":
    "567e68cdf7505adbca1393725ea817076720a0cd76efbf668c3360be5757b508",
  "generic surrogate pair inside a long text literal (pad 4082)":
    "567e68cdf7505adbca1393725ea817076720a0cd76efbf668c3360be5757b508",
  "flat surrogate pair inside a long text literal (pad 4083)":
    "9345c0349e1a31e9c514fcaa749c252b41eeddc18527d9dcf38053e058cfc74b",
  "generic surrogate pair inside a long text literal (pad 4083)":
    "9345c0349e1a31e9c514fcaa749c252b41eeddc18527d9dcf38053e058cfc74b",
  "flat surrogate pair inside a long text literal (pad 4084)":
    "26af2f7889a9811da8bf7a49fb1095731798856b2c8efab7a223ac40252417c7",
  "generic surrogate pair inside a long text literal (pad 4084)":
    "26af2f7889a9811da8bf7a49fb1095731798856b2c8efab7a223ac40252417c7",
  "flat a very long text literal":
    "596314ae173ca515fdefa52bfb6d3bca1d1949608802916e2d88764879892d25",
  "generic a very long text literal":
    "596314ae173ca515fdefa52bfb6d3bca1d1949608802916e2d88764879892d25",
  "flat procedure": "7a346a914582eba0b1ef826c7f427c2929cc62e4b4bc8ade5c74f22a7fd04b55",
  "generic mirror procedure": "7a346a914582eba0b1ef826c7f427c2929cc62e4b4bc8ade5c74f22a7fd04b55",
  "generic wasm procedure": "7a346a914582eba0b1ef826c7f427c2929cc62e4b4bc8ade5c74f22a7fd04b55",
  "flat whole file": "35d537feac343e155634d775a995f39ca2cf34b80181fbbb3c912a0342fd7276",
  "generic mirror whole file": "35d537feac343e155634d775a995f39ca2cf34b80181fbbb3c912a0342fd7276",
  "generic wasm whole file": "35d537feac343e155634d775a995f39ca2cf34b80181fbbb3c912a0342fd7276",
  "flat member call": "e79b7cbcd0836aeb23ea6a1051bf79daee0d79b5e5a35768aca05574965a751d",
  "generic mirror member call": "e79b7cbcd0836aeb23ea6a1051bf79daee0d79b5e5a35768aca05574965a751d",
  "generic wasm member call": "e79b7cbcd0836aeb23ea6a1051bf79daee0d79b5e5a35768aca05574965a751d",
  "flat comparison": "4424b7fa402bf8972c24f378282f0647fa72490ed687aab5a40b0f9b0517f678",
  "generic mirror comparison": "4424b7fa402bf8972c24f378282f0647fa72490ed687aab5a40b0f9b0517f678",
  "generic wasm comparison": "4424b7fa402bf8972c24f378282f0647fa72490ed687aab5a40b0f9b0517f678",
  "flat block comment with CRLF":
    "e8e88ecfa9a03c6988b454816f388f8d3261a458bd5be26fede9a37084bda7e3",
  "generic mirror block comment with CRLF":
    "e8e88ecfa9a03c6988b454816f388f8d3261a458bd5be26fede9a37084bda7e3",
  "generic wasm block comment with CRLF":
    "e8e88ecfa9a03c6988b454816f388f8d3261a458bd5be26fede9a37084bda7e3",
  "flat lone surrogate literal": "772a4d1539c6fd4f292d7fa00385a9c2429c70929393e419579bc4865e47d7fd",
  "generic mirror lone surrogate literal":
    "772a4d1539c6fd4f292d7fa00385a9c2429c70929393e419579bc4865e47d7fd",
  "generic wasm lone surrogate literal":
    "772a4d1539c6fd4f292d7fa00385a9c2429c70929393e419579bc4865e47d7fd",
  "flat ERROR": "d1f9bd2de56688c7dde33bfde9b5eeb50ce1f7d0680ef7dd49c6ff239d731474",
  "generic mirror ERROR": "d1f9bd2de56688c7dde33bfde9b5eeb50ce1f7d0680ef7dd49c6ff239d731474",
  "generic wasm ERROR": "d1f9bd2de56688c7dde33bfde9b5eeb50ce1f7d0680ef7dd49c6ff239d731474",
  "flat MISSING": "72dd10f1f80a7c728da5ff18c3146d8b16180244025c9e91124f8abd1c584158",
  "generic mirror MISSING": "72dd10f1f80a7c728da5ff18c3146d8b16180244025c9e91124f8abd1c584158",
  "generic wasm MISSING": "72dd10f1f80a7c728da5ff18c3146d8b16180244025c9e91124f8abd1c584158",
  "flat parsed long text literal with a surrogate pair":
    "0f6aacd3afe17bd6d1a0f728e1ae1c20c1190fa357882664de9efc7842218de6",
  "generic mirror parsed long text literal with a surrogate pair":
    "0f6aacd3afe17bd6d1a0f728e1ae1c20c1190fa357882664de9efc7842218de6",
  "generic wasm parsed long text literal with a surrogate pair":
    "0f6aacd3afe17bd6d1a0f728e1ae1c20c1190fa357882664de9efc7842218de6",
  "withText string literal": "e934a39a25eec513c0f31fea712c84739d1483bf44038bd59dad6197aead6663",
  "withText integer": "c9522609e03156334fcdc8ac14a801f2246bb8d0f1dda263ad644b3fe411971f",
  "withText identifier": "68eef1763bb45ee8e7516190d3e31bfb031e144e8ca640198681ce5da363f62f",
  "withText operator leaf": "19d23b56b860b29962bc171a06f44dabbcb624c134ed8a9ca757d470068ac2ee",
};

describe("astSubtreeHash golden values (AMENDMENT 8 Guard 1)", () => {
  beforeAll(async () => {
    await initParser();
    await initWasmParser();
  });

  it("covers a named MISSING node and an ERROR node on both parsers", () => {
    for (const parse of [native, wasm]) {
      expect(first(parse(MISSING_SRC), "end_keyword").isMissing).toBe(true);
      expect(parse(ERROR_SRC).hasError).toBe(true);
    }
  });

  it("pins exactly one literal per case", () => {
    expect(new Set(CASES.map(([name]) => name)).size).toBe(CASES.length);
    expect(Object.keys(GOLDEN).sort()).toEqual(CASES.map(([name]) => name).sort());
  });

  it("hashes a withText leaf's replacement text", () => {
    const before = stringLiteral(native(REAL), "'Grüße ✓'");
    expect(astSubtreeHash(withText(before, "'other'"))).not.toBe(astSubtreeHash(before));
  });

  for (const [name, make] of CASES) {
    it(name, () => {
      const node = make();
      const want = GOLDEN[name];
      expect(astSubtreeHash(node)).toBe(want as string);
    });
  }
});
