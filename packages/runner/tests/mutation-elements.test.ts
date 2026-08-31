import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describe as describeMutant,
  lossesFor,
  positionOf,
  toMutationElements,
} from "../src/mutation-elements";
import type { MutantOutcome, SessionReport } from "../src/report";

/**
 * R178. The projection into `mutation-testing-report-schema` is the surface a CI system renders, so
 * two things have to hold and neither is visible from reading the output: it must VALIDATE against
 * the schema the ecosystem actually publishes, and the qualifications LethAL earned must survive.
 *
 * The schema is validated against the real `mutation-testing-report-schema` package rather than a
 * transcription of it, for the reason `schemas.test.ts` gives about its own: a copy is a second
 * account of the same contract, free to drift.
 */
const SCHEMA = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../../node_modules/mutation-testing-report-schema/dist/src/mutation-testing-report-schema.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

type Node = Record<string, unknown>;
function deref(node: Node): Node {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  return ref
    .split("/")
    .slice(1)
    .reduce<Node>((o, k) => (o[k] ?? {}) as Node, SCHEMA as Node);
}
/** Minimal structural validation: required, enum, nested objects and arrays. Enough to catch the
 *  mistakes a hand-built projection actually makes. */
function violations(node: Node, value: unknown, path = "$"): string[] {
  const s = deref(node);
  const out: string[] = [];
  const en = s.enum;
  if (Array.isArray(en) && !en.includes(value))
    out.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (s.type === "object" || s.properties !== undefined || s.required !== undefined) {
    if (typeof value !== "object" || value === null) return [`${path}: expected object`];
    for (const r of (s.required as string[] | undefined) ?? []) {
      if (!(r in (value as object))) out.push(`${path}.${r}: REQUIRED but absent`);
    }
    const props = (s.properties ?? {}) as Record<string, Node>;
    const extra = s.additionalProperties;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const ps =
        props[k] ?? (typeof extra === "object" && extra !== null ? (extra as Node) : undefined);
      if (ps !== undefined) out.push(...violations(ps, v, `${path}.${k}`));
    }
  }
  if (s.type === "array" && Array.isArray(value)) {
    const items = s.items as Node | undefined;
    if (items !== undefined) {
      value.forEach((v, i) => out.push(...violations(items, v, `${path}[${i}]`)));
    }
  }
  return out;
}

const SOURCE = [
  "codeunit 50000 X",
  "{",
  "    procedure P()",
  "    begin",
  "    end;",
  "}",
  "",
].join("\n");

function mutant(over: Partial<MutantOutcome> = {}): MutantOutcome {
  return {
    mutantCode: "M0001",
    file: "src/X.Codeunit.al",
    line: 3,
    startIndex: SOURCE.indexOf("procedure"),
    endIndex: SOURCE.indexOf("procedure") + 9,
    operatorName: "lethal.empty-block",
    verdict: "survived",
    ...over,
  } as MutantOutcome;
}
function report(mutants: MutantOutcome[], over: Partial<SessionReport> = {}): SessionReport {
  return { mutants, ...over } as unknown as SessionReport;
}
const OPTS = {
  projectDir: "P",
  thresholds: { high: 80, low: 60 },
  readSource: async () => SOURCE,
};

describe("R178: the projection validates against the published schema", () => {
  test("a report with every verdict conforms", async () => {
    const verdicts = [
      "killed",
      "survived",
      "no-coverage",
      "timeout-killed",
      "known-survivor",
      "error",
    ];
    const { report: out } = await toMutationElements(
      report(verdicts.map((v, i) => mutant({ mutantCode: `M000${i}`, verdict: v } as never))),
      OPTS,
    );
    expect(violations(SCHEMA as Node, out)).toEqual([]);
  });

  test("an UNMAPPED verdict throws rather than landing on Pending", async () => {
    // `Pending` reads as "not yet run", so defaulting to it would report a mutant nobody scored as
    // one still in flight. A new verdict must be mapped deliberately.
    await expect(
      toMutationElements(report([mutant({ verdict: "brand-new-verdict" } as never)]), OPTS),
    ).rejects.toThrow(/no schema status for LethAL verdict/);
  });

  test("a missing source file names --project rather than surfacing a bare ENOENT", async () => {
    await expect(
      toMutationElements(report([mutant()]), {
        ...OPTS,
        readSource: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow(/--project/);
  });
});

describe("R178: the qualifications survive the projection", () => {
  test("an R175 unplaceable mutant SAYS so, though the schema forces NoCoverage", async () => {
    // The whole point. `NoCoverage` reads as "your tests do not reach this code"; for these it is a
    // statement about LethAL. The schema has one status and no field for that, so it goes in
    // `description`, which the renderer shows.
    const { report: out } = await toMutationElements(
      report([mutant({ verdict: "no-coverage" })], { unplaceableMutants: ["M0001"] } as never),
      OPTS,
    );
    const m = (
      Object.values(out.files)[0] as { mutants: { status: string; description?: string }[] }
    ).mutants[0];
    expect(m?.status).toBe("NoCoverage");
    expect(m?.description).toMatch(/ATTRIBUTION COULD NOT PLACE THIS \(R175\)/);
  });

  test("an approximate covering set is declared, so it cannot read as an exact one", () => {
    const d = describeMutant(mutant({ coverageAttribution: "object" }), {
      unplaceable: new Set(),
      likelyEquivalent: new Set(),
    });
    expect(d).toMatch(/APPROXIMATE/);
  });

  test("a carried survivor says it was not executed in this run", () => {
    const d = describeMutant(mutant({ verdict: "known-survivor" }), {
      unplaceable: new Set(),
      likelyEquivalent: new Set(),
    });
    expect(d).toMatch(/PRIOR run/);
  });

  test("an ordinary mutant gets NO description, so the field means something", () => {
    expect(
      describeMutant(mutant({ verdict: "killed", coverageAttribution: "exact" }), {
        unplaceable: new Set(),
        likelyEquivalent: new Set(),
      }),
    ).toBeUndefined();
  });

  test("what CANNOT be carried is reported rather than dropped silently", () => {
    const losses = lossesFor(
      report([], {
        platformArtifactKills: { killedCount: 2, byMechanism: [] },
        assertionScreen: { discrimination: "partial" },
      } as never),
    );
    expect(losses.join(" ")).toMatch(/R138/);
    expect(losses.join(" ")).toMatch(/R121/);
    // Always at least the run-level one: the schema describes mutants, not the run.
    expect(lossesFor(report([])).length).toBeGreaterThan(0);
  });
});

describe("R178: positions", () => {
  test("offset 0 is line 1 column 1, and a newline advances the line", () => {
    expect(positionOf(SOURCE, 0)).toEqual({ line: 1, column: 1 });
    expect(positionOf(SOURCE, SOURCE.indexOf("{"))).toEqual({ line: 2, column: 1 });
  });

  test("an offset past the end does not run off, it clamps to the last line", () => {
    const p = positionOf(SOURCE, SOURCE.length + 500);
    expect(p.line).toBeLessThanOrEqual(SOURCE.split("\n").length);
  });
});

describe("R184: refusals are carried as Ignored rather than dropped silently", () => {
  const excluded = {
    totalFiles: 9,
    siteCount: 5,
    fileCount: 1,
    files: [
      {
        file: "src/Q.Query.al",
        kinds: "query_declaration",
        sites: 5,
        reason: "not-instrumentable",
      },
    ],
  };

  test("an excluded file becomes an Ignored entry, and still validates", async () => {
    // Before this the file rendered identically to one the tool found nothing in, which is the
    // silent projection this module's own doc comment forbids.
    const { report: out } = await toMutationElements(
      report([mutant()], { excludedSites: excluded } as Partial<SessionReport>),
      OPTS,
    );
    expect(violations(SCHEMA as Node, out)).toEqual([]);

    const files = out.files as Record<string, { mutants: Record<string, unknown>[] }>;
    const q = files["src/Q.Query.al"];
    expect(q).toBeDefined();
    expect(q?.mutants).toHaveLength(1);
    const entry = q?.mutants[0];
    expect(entry?.status).toBe("Ignored");
    // Grouped under the REASON, so every refusal of one kind is selectable as a set in the renderer.
    expect(entry?.mutatorName).toBe("not-instrumentable");
    expect(entry?.description).toContain("5 mutation site(s)");
    expect(entry?.description).toContain("not untested code");
  });

  test("a file with BOTH mutants and refusals keeps both, rather than one overwriting the other", async () => {
    // The merge is the part that can silently lose data: a declarative site and a real mutant can
    // live in the same file, and the refusal loop runs after the mutant loop has already built it.
    const both = {
      ...excluded,
      files: [
        { file: "src/X.Codeunit.al", kinds: "codeunit", sites: 2, reason: "declarative" as const },
      ],
    };
    const { report: out } = await toMutationElements(
      report([mutant()], { excludedSites: both } as Partial<SessionReport>),
      OPTS,
    );
    const files = out.files as Record<string, { mutants: Record<string, unknown>[] }>;
    const x = files["src/X.Codeunit.al"];
    expect(x?.mutants).toHaveLength(2);
    expect(x?.mutants.map((m) => m.status).sort()).toEqual(["Ignored", "Survived"]);
  });

  test("the lossy HALF is declared: one entry per file, not per site", () => {
    const losses = lossesFor(
      report([mutant()], { excludedSites: excluded } as Partial<SessionReport>),
    );
    expect(losses.some((l) => l.includes("5 refused site(s)") && l.includes("ONE"))).toBe(true);
  });

  test("a report with no refusals declares no such loss, so the line means something", () => {
    expect(lossesFor(report([mutant()])).some((l) => l.includes("refused site"))).toBe(false);
  });
});
