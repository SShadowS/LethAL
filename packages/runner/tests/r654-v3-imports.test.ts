// R654 S1 (plan docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md, S1 and r1 M1): the
// v3 backend, and the two modules it keeps after v2 is retired (`al-runner-server.ts`,
// `al-runner-coverage.ts`), plus the two modules S1 created for what they share
// (`al-runner-rows.ts`, `resource-selector.ts`), import nothing from a module S3 deletes.
// The WHOLE file text is read, so a multi-line import (`} from "./al-runner-backend";`) and a
// dynamic `import("./al-runner-backend")` are caught too.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

/** The modules S3 deletes. */
const V2_ONLY = [
  "backend",
  "transport",
  "canary",
  "contract",
  "frame-probe",
  "predefined-probe",
  "cache",
] as const;

const V2_IMPORT = new RegExp(
  String.raw`(?:from\s+|import\s*\(\s*|import\s+)["']\.\/al-runner-(?:${V2_ONLY.join("|")})(?:\.js|\.ts)?["']`,
  "g",
);

/** Every v2-only import in `text`, as the matched source. */
function v2Imports(text: string): string[] {
  return [...text.matchAll(V2_IMPORT)].map((m) => m[0]);
}

/** The files the guard covers: every `al-runner-v3-*.ts`, and the four kept or shared modules. */
function guardedFiles(): string[] {
  const v3 = readdirSync(SRC).filter((f) => /^al-runner-v3-.*\.ts$/.test(f));
  return [
    ...v3,
    "al-runner-server.ts",
    "al-runner-coverage.ts",
    "al-runner-rows.ts",
    "resource-selector.ts",
  ];
}

describe("R654 S1: v3 and the kept modules import nothing S3 deletes", () => {
  test("no guarded file imports a v2-only module", () => {
    const found = guardedFiles().flatMap((f) =>
      v2Imports(readFileSync(join(SRC, f), "utf8")).map((m) => `${f}: ${m}`),
    );
    expect(found).toEqual([]);
  });

  test("the guard covers the v3 files and the four kept or shared modules", () => {
    const files = guardedFiles();
    expect(files.filter((f) => f.startsWith("al-runner-v3-")).length).toBeGreaterThanOrEqual(7);
    for (const f of [
      "al-runner-server.ts",
      "al-runner-coverage.ts",
      "al-runner-rows.ts",
      "resource-selector.ts",
    ]) {
      expect(files).toContain(f);
    }
  });

  test("direction: single-line, multi-line, type-only, dynamic and side-effect imports are all caught", () => {
    const text = [
      'import { x } from "./al-runner-backend";',
      "import {",
      "  y,",
      '} from "./al-runner-transport";',
      'import type { Z } from "./al-runner-canary.js";',
      'const m = await import("./al-runner-contract");',
      "export { w } from './al-runner-cache';",
      'import "./al-runner-backend";',
    ].join("\n");
    expect(v2Imports(text)).toHaveLength(6);
  });

  test("direction: the kept modules and similar names are not caught", () => {
    const text = [
      'import { a } from "./al-runner-server";',
      'import { b } from "./al-runner-coverage";',
      'import { c } from "./al-runner-v3-backend";',
      'import { d } from "./al-runner-rows";',
      'import { e } from "./al-runner-backend-extra";',
      '// see "./al-runner-backend" in a comment, not an import',
    ].join("\n");
    expect(v2Imports(text)).toEqual([]);
  });
});
