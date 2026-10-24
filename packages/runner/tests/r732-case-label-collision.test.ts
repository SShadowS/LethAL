import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { generateMutationSet } from "../src/orchestrator";

/**
 * R732: a mutated `case true of` label that equals a sibling label is AL0402 and fails the whole
 * batch. The shape, invented: `X = 0:` beside `X = 1:`. Measured with alc on 2026-10-24: the exact
 * duplicate, `A, A:`, a constant-folded value label and a comment-only difference are all AL0402.
 */
const SHAPE = `codeunit 50732 "R732 Shape"
{
    procedure Pick(X: Integer): Integer
    var
        R: Integer;
    begin
        case true of
            X = 0:
                R := 10;
            X = 1:
                R := 20;
        end;
        exit(R);
    end;
}
`;

async function generate(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r732-"));
  try {
    await Bun.write(join(dir, "app.json"), JSON.stringify({ name: "p" }));
    await Bun.write(join(dir, "src", "Shape.Codeunit.al"), source);
    const warnings: { code: string; message: string }[] = [];
    const set = await generateMutationSet(dir, {
      emit: (e) => {
        if (e.type === "warning") warnings.push({ code: e.code, message: e.message });
      },
    });
    const specs = set.files.flatMap((f) => f.specs);
    return { specs, warnings };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const labelShifts = (
  specs: readonly { operatorName: string; before: { text: string }; after: { text: string } }[],
) =>
  specs
    .filter((s) => s.operatorName === "lethal.shift-integer")
    .map((s) => `${s.before.text}->${s.after.text}`);

describe("R732: case label collisions are dropped, named, and not over-refused", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("`X = 0` -> `X = 1` is not generated; the sibling's own shift still is; one warning names the count", async () => {
    const { specs, warnings } = await generate(SHAPE);
    const shifts = labelShifts(specs);
    expect(shifts).not.toContain("0->1");
    // `1 -> 0` would equal `X = 0`; `1 -> 2` does not.
    expect(shifts).not.toContain("1->0");
    expect(shifts).toContain("1->2");
    const w = warnings.filter((x) => x.code === "case-label-collision");
    expect(w).toHaveLength(1);
    expect(w[0]?.message).toContain("Shape.Codeunit.al");
    expect(w[0]?.message).toContain("AL0402");
    // No mutant of this file carries a label equal to its sibling.
    for (const s of specs) expect(s.before.text).not.toBe("");
  });

  test("other operators: blank/non-blank text labels and `<` / `<=` labels do not collide either", async () => {
    const src = `codeunit 50733 "R732 Ops"
{
    procedure Pick(T: Text; X: Integer): Integer
    var
        R: Integer;
    begin
        case true of
            T = '':
                R := 1;
            T = 'x':
                R := 2;
        end;
        case true of
            X < 5:
                R := 3;
            X <= 5:
                R := 4;
        end;
        exit(R);
    end;
}
`;
    const { specs, warnings } = await generate(src);
    const pairs = specs.map(
      (s) => `${s.operatorName.replace("lethal.", "")}:${s.before.text}->${s.after.text}`,
    );
    // `'' -> 'x'` equals the `T = 'x'` label; `X < 5` -> `X <= 5` equals the next label.
    expect(pairs).not.toContain("toggle-blank-string:''->'x'");
    expect(pairs.filter((p) => p.startsWith("conditional-boundary:<"))).toEqual([]);
    expect(warnings.filter((x) => x.code === "case-label-collision")).toHaveLength(1);
    // The sibling `T = 'x'` still blanks (-> `T = ''`, which equals the first label), so it too is dropped.
    expect(pairs).not.toContain("toggle-blank-string:'x'->''");
  });

  test("labels that cannot collide produce no warning and keep both shifts", async () => {
    const { specs, warnings } = await generate(SHAPE.replace("X = 1:", "X = 7:"));
    const shifts = labelShifts(specs);
    expect(shifts).toContain("0->1");
    expect(shifts).toContain("7->8");
    expect(warnings.filter((x) => x.code === "case-label-collision")).toEqual([]);
  });
});
