import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import { renderInto, staleTargets } from "./operator-tables";

const REPO_ROOT = join(import.meta.dir, "..");
// R856: the counts are the DEFAULT set; an opt-in operator is added after, and said so.
// R868: opt-in operators are in both tiers; the counts per tier drop their own.
const optIn1 = tier1Operators.filter((o) => o.optIn === true).length;
const optIn2 = tier2Operators.filter((o) => o.optIn === true).length;
const optInCount = optIn1 + optIn2;
const plusOptIn = `, plus ${optInCount} opt-in (run only when --operator names it)`;
const defaultT1 = tier1Operators.length - optIn1;
const defaultT2 = tier2Operators.length - optIn2;
const expectedSummary = (): string => `${defaultT1 + defaultT2} operators, in two tiers${plusOptIn}`;
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

  // Issue #44: the counts in README prose are generated, so a stale count is drift like a stale row.
  it("the README's prose counts are the registry's counts", () => {
    const total = defaultT1 + defaultT2;
    const readme = read("README.md");
    expect(optInCount).toBe(3);
    expect(readme).toContain(
      `<!-- operators: summary -->${total} operators, in two tiers${plusOptIn}<!-- /operators: summary -->`,
    );
    expect(readme).toContain(
      `<!-- operators: limits -->${total} operators today, in two groups: ${defaultT1} generic ones (Tier 1) and ${defaultT2} AL-specific ones (Tier 2)${plusOptIn}<!-- /operators: limits -->`,
    );
  });

  it("regenerating a hand-edited prose count restores the committed file", () => {
    const readme = read("README.md");
    const stale = readme.replace(/(<!-- operators: summary -->)\d+/, "$115");
    expect(stale).not.toBe(readme);
    // The generator's own output for the stale text is the committed README again.
    expect(renderInto(stale, "summary", expectedSummary())).toBe(readme);
  });

  it("an inline marker adds no new lines", () => {
    expect(
      renderInto("a <!-- operators: summary -->x<!-- /operators: summary --> b", "summary", "N"),
    ).toBe("a <!-- operators: summary -->N<!-- /operators: summary --> b");
  });
});
