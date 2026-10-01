import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoadmapFormatError, parseRowFile } from "./roadmap-index.ts";
import { setStatus, setStatusLine } from "./roadmap-set.ts";

const ROW = [
  "---",
  'id: "R7"',
  'title: "A title"',
  'section: "gaps"',
  'status: "open"',
  "order: 10",
  "---",
  "",
  'Body with status: "open" in prose, which must not change.',
  "",
].join("\n");

describe("setStatusLine", () => {
  test("rewrites only the frontmatter status line", () => {
    const out = setStatusLine(ROW, "done (abc1234)", "R007.md");
    expect(out).toBe(ROW.replace('status: "open"\n', 'status: "done (abc1234)"\n'));
    expect(out).toContain('Body with status: "open" in prose');
  });
  test("escapes quotes, backslashes and pipes so the index parser reads the exact text back", () => {
    const status = 'done (abc1234) · said "ok" | path C:\\x\\y, tab\there';
    const out = setStatusLine(ROW, status, "R007.md");
    expect(parseRowFile(out, "R007.md").status).toBe(status);
    expect(out).toContain(
      'status: "done (abc1234) · said \\"ok\\" | path C:\\\\x\\\\y, tab\\there"',
    );
  });
  test("refuses a 'pending' placeholder, an empty status, and a missing status line", () => {
    expect(() => setStatusLine(ROW, "done (pending)", "R007.md")).toThrow(/pending/);
    expect(() => setStatusLine(ROW, "  ", "R007.md")).toThrow(RoadmapFormatError);
    const noStatus = ROW.replace('status: "open"\n', "");
    expect(() => setStatusLine(noStatus, "done (abc)", "R007.md")).toThrow(/no 'status:' line/);
  });
});

describe("setStatus", () => {
  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "roadmap-set-"));
    mkdirSync(join(root, "docs/roadmap"), { recursive: true });
    writeFileSync(join(root, "docs/roadmap/_template.md"), "# Roadmap\n\n<!-- rows: gaps -->\n");
    writeFileSync(join(root, "docs/roadmap/R007.md"), ROW);
    return root;
  }
  test("writes the row and regenerates the index from it", () => {
    const root = repo();
    expect(setStatus(root, "R7", "done (abc1234)")).toBe("docs/roadmap/R007.md");
    expect(readFileSync(join(root, "ROADMAP.md"), "utf8")).toContain("· done (abc1234)");
  });
  test("refuses a row file that does not exist", () => {
    expect(() => setStatus(repo(), "R8", "done (abc)")).toThrow(/does not exist/);
  });
});
