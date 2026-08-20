import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INDEX_FILE,
  RoadmapFormatError,
  type RoadmapRow,
  buildIndex,
  indexLine,
  isOpen,
  parseRowFile,
  renderIndex,
  rowFileName,
  shortStatus,
} from "./roadmap-index.ts";

const REPO_ROOT = join(import.meta.dir, "..");

function file(fields: Record<string, string>, body: string): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

const WELL_FORMED = file(
  {
    id: '"R42"',
    title: '"Instrumentation multiplies ONE existing diagnostic"',
    status: '"done (measured; no code change)"',
    section: '"backends-and-tooling"',
    order: "120",
  },
  '**Body prose.** With a literal | pipe, a `code | span`, and a "quote".',
);

function row(overrides: Partial<RoadmapRow> = {}): RoadmapRow {
  return {
    id: "R1",
    numericId: 1,
    title: "A title",
    status: "open",
    section: "next-up",
    order: 10,
    body: "Body.",
    ...overrides,
  };
}

const FIELDS = {
  id: '"R1"',
  title: '"t"',
  status: '"open"',
  section: '"next-up"',
  order: "10",
} as const;

describe("parseRowFile", () => {
  test("reads every field, and a body containing the pipe that broke the old table", () => {
    const parsed = parseRowFile(WELL_FORMED, "R042.md");
    expect(parsed.id).toBe("R42");
    expect(parsed.numericId).toBe(42);
    expect(parsed.status).toBe("done (measured; no code change)");
    expect(parsed.section).toBe("backends-and-tooling");
    expect(parsed.order).toBe(120);
    // The whole point of the split: a pipe in the prose is prose, not a field boundary.
    expect(parsed.body).toBe(
      '**Body prose.** With a literal | pipe, a `code | span`, and a "quote".',
    );
  });

  test("keeps a multi-paragraph body whole, including its blank lines", () => {
    const parsed = parseRowFile(
      file({ ...FIELDS }, "First.\n\n## Superseded status\n\nSecond."),
      "x",
    );
    expect(parsed.body).toBe("First.\n\n## Superseded status\n\nSecond.");
  });

  test.each([
    ["no frontmatter fence", "just prose\n"],
    ["unclosed frontmatter", '---\nid: "R1"\n'],
    ["a body that is empty", file({ ...FIELDS }, "")],
  ])("refuses %s", (_name, text) => {
    expect(() => parseRowFile(text, "R001.md")).toThrow(RoadmapFormatError);
  });

  test("refuses a missing field, naming it", () => {
    const { status: _dropped, ...rest } = FIELDS;
    expect(() => parseRowFile(file(rest, "Body."), "R001.md")).toThrow(/missing 'status'/);
  });

  test("refuses an unknown field rather than silently ignoring it", () => {
    expect(() => parseRowFile(file({ ...FIELDS, owner: '"me"' }, "Body."), "R001.md")).toThrow(
      /unknown frontmatter key 'owner'/,
    );
  });

  test("refuses a value that is not a JSON scalar — a bare YAML string would parse ambiguously", () => {
    expect(() => parseRowFile(file({ ...FIELDS, title: "bare: text" }, "B."), "R001.md")).toThrow(
      /not a JSON-encoded scalar/,
    );
  });

  test("refuses a non-integer order and an id that is not R<n>", () => {
    expect(() => parseRowFile(file({ ...FIELDS, order: "1.5" }, "B."), "x")).toThrow(/integer/);
    expect(() => parseRowFile(file({ ...FIELDS, id: '"42"' }, "B."), "x")).toThrow(/is not R<n>/);
  });
});

describe("isOpen", () => {
  /**
   * Every one of these prefixes appears in a real row today. The count this drives was measured
   * WRONG once — a shell filter matching statuses that start with `done`/`closed` reported 20 open
   * when the answer was 8, because several statuses open with `**done`.
   */
  test("closed only when the status OPENS with done or closed, emphasis stripped", () => {
    for (const closed of [
      "done (a343b5f) — measured",
      "**done (`b95426b`)** — the header carries both",
      "closed 2026-08-09 — the ruling, which has no commit to name",
      "DONE (this commit)",
    ]) {
      expect(isOpen(closed)).toBe(false);
    }
  });

  test("borderline statuses are OPEN, deliberately", () => {
    // Reading any of these as closed is how a real gap disappears from the durable record.
    for (const open of [
      "open — filed 2026-08-20",
      "PARTIALLY fixed 2026-08-19 — names now hash distinctly; the headline case still collides",
      "additive half DONE (this commit) — the other census candidates remain undecided",
      "SPIKED 2026-08-20 and recommended for build — committed UNREGISTERED",
      "recurring — RE-CHECKED 2026-08-19",
      "blocked (upstream #1657)",
      "in progress",
    ]) {
      expect(isOpen(open)).toBe(true);
    }
  });

  test("the generated index states the count, and it matches isOpen over the rows", () => {
    const rows: RoadmapRow[] = [
      row({ id: "R1", status: "done (abc)" }),
      row({ id: "R2", status: "**done (def)**" }),
      row({ id: "R3", status: "PARTIALLY fixed" }),
      row({ id: "R4", status: "open" }),
    ];
    const out = renderIndex(
      `<!-- open-count -->
<!-- rows: next-up -->
`,
      rows,
    );
    expect(out).toContain("2 of 4 items are OPEN");
  });
});

describe("rowFileName", () => {
  test("zero-pads to three digits so a directory listing sorts", () => {
    expect([rowFileName(1), rowFileName(69), rowFileName(118)]).toEqual([
      "R001.md",
      "R069.md",
      "R118.md",
    ]);
  });
});

describe("shortStatus", () => {
  test("passes a short status through whole, `**` stripped", () => {
    expect(shortStatus("**done (`d2b3236`)**")).toBe("done (`d2b3236`)");
  });

  test("keeps a status that fits, rather than cutting it at its first em dash", () => {
    // The regression this exists for: cutting at ` — ` turned this into `done (2026-07-26`.
    const s = "done (2026-07-26 — 3 killed / 10 survived / 3 no-coverage, matching the gate)";
    expect(shortStatus(s)).toBe(s);
  });

  test("truncates a long status on a word boundary", () => {
    const short = shortStatus(`done — ${"word ".repeat(80)}`);
    expect(short.length).toBeLessThanOrEqual(111);
    expect(short.endsWith("…")).toBe(true);
    expect(short.startsWith("done — word")).toBe(true);
  });

  test("never emits an orphaned code-span backtick", () => {
    const short = shortStatus(`done ${"x".repeat(100)} \`some/long/path/that/is/cut.ts\``);
    expect((short.match(/`/g) ?? []).length % 2).toBe(0);
  });

  test("never emits an unclosed parenthesis", () => {
    const short = shortStatus(`done ${"x".repeat(100)} (a parenthetical that gets cut off)`);
    expect(short).not.toContain("(");
  });
});

describe("indexLine", () => {
  test("bolds the id and nothing else — interpretation.test.ts scans for exactly that", () => {
    const line = indexLine(row({ id: "R69", numericId: 69, title: "**Loud** title" }));
    expect([...line.matchAll(/\*\*(R\d+)\*\*/g)].map(([, id]) => id)).toEqual(["R69"]);
    expect(line).not.toContain("**Loud**");
    expect(line).toContain("[R069.md](docs/roadmap/R069.md)");
  });
});

describe("renderIndex", () => {
  const TEMPLATE = "# T\n\n## A\n\n<!-- rows: a -->\n\n## B\n\n<!-- rows: b -->\n";

  test("orders rows within a section by `order`, not by id", () => {
    const out = renderIndex(TEMPLATE, [
      row({ id: "R2", numericId: 2, section: "a", order: 20 }),
      row({ id: "R9", numericId: 9, section: "a", order: 10 }),
      row({ id: "R5", numericId: 5, section: "b", order: 10 }),
    ]);
    expect([...out.matchAll(/\*\*(R\d+)\*\*/g)].map(([, id]) => id)).toEqual(["R9", "R2", "R5"]);
  });

  test("refuses a row whose section has no marker — silently dropping it is the failure mode", () => {
    expect(() => renderIndex(TEMPLATE, [row({ section: "typo" })])).toThrow(
      /section 'typo' is declared by a row file but has no/,
    );
  });

  test("refuses two rows with the same id", () => {
    expect(() =>
      renderIndex(TEMPLATE, [row({ section: "a" }), row({ section: "a", order: 20 })]),
    ).toThrow(/duplicate row id 'R1'/);
  });

  test("refuses a template that invents an id no row file backs", () => {
    expect(() => renderIndex(`**R404**\n${TEMPLATE}`, [row({ section: "a" })])).toThrow(
      /exposes R404 as \*\*R<n>\*\* with no row file behind it/,
    );
  });

  test("refuses two markers for one section", () => {
    expect(() =>
      renderIndex("<!-- rows: a -->\n<!-- rows: a -->\n", [row({ section: "a" })]),
    ).toThrow(/has two row markers/);
  });
});

describe("the real store", () => {
  test("ROADMAP.md is GENERATED — regenerate it with `bun scripts/roadmap-index.ts`", () => {
    // Also the coupling that keeps `packages/runner/tests/interpretation.test.ts` honest: a row
    // file added without regenerating leaves its id invisible to that test's `**R<n>**` scan.
    expect(readFileSync(join(REPO_ROOT, INDEX_FILE), "utf8")).toBe(buildIndex(REPO_ROOT));
  });
});
