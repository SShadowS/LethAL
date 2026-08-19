import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { renderInto, staleTargets } from "./operator-tables";

const REPO_ROOT = join(import.meta.dir, "..");
const read = (f: string): string => readFileSync(join(REPO_ROOT, f), "utf8");

describe("operator tables", () => {
  /**
   * The reason this file exists. `design.md` §4's tables were hand-written and drifted for months:
   * they listed `RemoveSetLoadFields` and `EmptyTrigger`, neither built, and omitted four shipped
   * operators. A second copy of the registry rots unless something fails when it does.
   */
  it("design.md and README.md agree with the operator registry", () => {
    expect(staleTargets()).toEqual([]);
  });

  it("lists every registered operator, by name, in the rendered files", () => {
    const design = read("design.md");
    const readme = read("README.md");
    for (const op of [...tier1Operators, ...tier2Operators]) {
      expect(design).toContain(`\`${op.name}\``);
      expect(readme).toContain(`\`${op.name}\``);
    }
  });

  it("names NO operator that is not registered", () => {
    // The exact drift that motivated this. Both were in the hand-written table and neither is built.
    const registered = new Set([...tier1Operators, ...tier2Operators].map((o) => o.name));
    expect(registered.has("lethal.remove-setloadfields")).toBe(false);
    expect(registered.has("lethal.empty-trigger")).toBe(false);
    for (const file of ["design.md", "README.md"] as const) {
      const between = /<!-- operators: tier[12] -->([\s\S]*?)<!-- \/operators: tier[12] -->/g;
      const text = read(file);
      let match = between.exec(text);
      let checked = 0;
      while (match !== null) {
        const body = match[1] ?? "";
        for (const name of body.matchAll(/`(lethal\.[a-z-]+)`/g)) {
          expect(registered.has(name[1] ?? "")).toBe(true);
          checked += 1;
        }
        match = between.exec(text);
      }
      // Refuse to pass on an empty sweep: a broken regex would otherwise "verify" nothing.
      expect(checked).toBe(tier1Operators.length + tier2Operators.length);
    }
  });

  it("renderInto refuses a missing marker pair rather than appending", () => {
    expect(() => renderInto("no markers here", "tier1", "x")).toThrow(/missing/);
  });

  it("renderInto replaces only what sits between the markers", () => {
    const src = "before\n<!-- operators: tier1 -->\nOLD\n<!-- /operators: tier1 -->\nafter";
    const out = renderInto(src, "tier1", "NEW");
    expect(out).toBe("before\n<!-- operators: tier1 -->\nNEW\n<!-- /operators: tier1 -->\nafter");
    expect(out).not.toContain("OLD");
  });
});
