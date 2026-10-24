import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyReason } from "./r386-fallback-census";

const root = join(import.meta.dir, "..");

describe("R-386 fallback census", () => {
  test("one fixture app: exit 0, shapes add up to onFallback, unclassified is a key", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "r386-")), "out.json");
    const p = Bun.spawn(
      [
        "bun",
        join(root, "scripts/r386-fallback-census.ts"),
        join(root, "fixtures/sandbox-tests"),
        out,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await p.exited).toBe(0);
    const j = JSON.parse(await Bun.file(out).text()) as {
      onFallback: number;
      tests: number;
      shapes: Record<string, { tests: number }>;
      unclassified: Record<string, number>;
    };
    expect(j.tests).toBeGreaterThan(0);
    expect("unclassified" in j).toBe(true);
    const sum =
      Object.values(j.shapes).reduce((a, s) => a + s.tests, 0) +
      Object.values(j.unclassified).reduce((a, n) => a + n, 0);
    expect(sum).toBe(j.onFallback);
  });

  test("templates map to the R386 shapes", () => {
    const id = (s: string) => classifyReason(s)?.id;
    expect(id("T.X is handed this, a test-app object, by P.Q")).toBe("this-handed-external");
    expect(id("T.X is handed R (Record Foo), a test-app object, by P.Q")).toBe(
      "record-handed-external",
    );
    expect(id("T.X is handed R (Page Foo), a test-app object, by P.Q")).toBe(
      "page-var-handed-external",
    );
    expect(id("T.X is handed R (array [3] of Record Foo), a test-app object, by P.Q")).toBe(
      "array-element",
    );
    expect(id("W: V is a parameter of P, which can be called from outside the test app")).toBe(
      "variant-param-external-caller",
    );
    expect(id("W: Q.R passes Report::Foo")).toBe("variant-param-unreached-caller");
    expect(id("something new")).toBeUndefined();
  });
});
