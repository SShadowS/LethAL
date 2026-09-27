import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { type Role, roleOf, testCodeunitApps } from "./r216-classify-gained";

/**
 * R216's role decision, which decided the census (STOP (b), 0 deployable product sites). Each case
 * is one app laid out on disk the way the classifier finds it. Case (e) is the review finding
 * (R-216-001 r1): a "Library Assert" dependency that Microsoft does not publish is NOT a test
 * library, so an app declaring it is a product app.
 */

const HELPER = `codeunit 50004 "Helper"
{
    procedure Check()
    begin
        asserterror Error('x');
    end;
}
`;
const TEST_CU = `codeunit 50099 "T"
{
    Subtype = Test;
}
`;

beforeAll(async () => {
  await initParser();
});

/** Lays out `files` under a fresh corpus dir, then returns each file's top-level object's role. */
function roles(files: Record<string, string>): Map<string, Role> {
  const dir = mkdtempSync(join(tmpdir(), "lethal-r216-"));
  const roots = new Map<string, ALSyntaxNode>();
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text, "utf8");
    if (rel.endsWith(".al")) roots.set(rel, wrapRoot(parseAL(text)));
  }
  const testApps = testCodeunitApps(dir, roots);
  const out = new Map<string, Role>();
  for (const [rel, root] of roots) {
    const obj = root.namedChildren[0];
    if (obj === undefined) throw new Error(`${rel} parsed to no object`);
    out.set(rel, roleOf(dir, rel, obj, testApps));
  }
  return out;
}

const app = (deps: unknown[]): string => JSON.stringify({ dependencies: deps });

describe("r216-classify-gained role", () => {
  test("(a) an app with no dependencies and no test codeunit is product", () => {
    expect(
      roles({ "app.json": app([]), "Helper.Codeunit.al": HELPER }).get("Helper.Codeunit.al"),
    ).toBe("product");
  });

  test("(b) a Microsoft Library Assert dependency makes the app a test app", () => {
    const r = roles({
      "app.json": app([{ name: "Library Assert", publisher: "Microsoft" }]),
      "Helper.Codeunit.al": HELPER,
    });
    expect(r.get("Helper.Codeunit.al")).toBe("test");
  });

  test("(c) a Subtype = Test codeunit makes every object in its app test, helpers included", () => {
    const r = roles({
      "app.json": app([]),
      "Helper.Codeunit.al": HELPER,
      "T.Codeunit.al": TEST_CU,
    });
    expect(r.get("Helper.Codeunit.al")).toBe("test");
    expect(r.get("T.Codeunit.al")).toBe("test");
  });

  test("(d) no app.json and not a test codeunit is unknown, never product", () => {
    expect(roles({ "Helper.Codeunit.al": HELPER }).get("Helper.Codeunit.al")).toBe("unknown");
  });

  test("(e) Library Assert from a publisher other than Microsoft is product", () => {
    const r = roles({
      "app.json": app([{ name: "Library Assert", publisher: "Contoso" }]),
      "Helper.Codeunit.al": HELPER,
    });
    expect(r.get("Helper.Codeunit.al")).toBe("product");
  });

  test("(f) the name match is case-sensitive: Microsoft 'library assert' is product", () => {
    const r = roles({
      "app.json": app([{ name: "library assert", publisher: "Microsoft" }]),
      "Helper.Codeunit.al": HELPER,
    });
    expect(r.get("Helper.Codeunit.al")).toBe("product");
  });
});
