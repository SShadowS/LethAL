// R1208: the rule that finds the unit tests reading the gated-builds file, on this checkout and on planted modules.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GATED_BUILDS_JSON,
  READER_MODULES,
  gatedBuildsReaderTests,
  gatedBuildsReaders,
  scanRel,
  topLevelDecls,
} from "./gated-builds-readers";

const REPO = dirname(import.meta.dir);

describe("R1208: the reader tests of this checkout", () => {
  test("the readers include every function that reads the rows, directly or through another reader", () => {
    const names = gatedBuildsReaders(REPO);
    for (const n of [
      "gatedBuilds",
      "findGatedBuild",
      "newestGatedRelease",
      "findV3Pin",
      "v3InstallHint",
      "checkGated",
    ])
      expect(names).toContain(n);
  });

  test("the reader tests hold the three R1208 names, and the update script's own test", () => {
    const files = gatedBuildsReaderTests(REPO);
    for (const f of [
      "packages/runner/tests/pr256-stop-groups.test.ts",
      "packages/runner/tests/pr402-login-replay.test.ts",
      "packages/runner/tests/r814-gated-builds.test.ts",
      "scripts/al-runner-v3-update.test.ts",
    ])
      expect(files).toContain(f);
  });

  test("no module outside the reader modules imports the file, so the rule's boundary holds", () => {
    const importers = scanRel(REPO, [
      "packages/*/src/**/*.ts",
      "packages/*/itest/**/*.ts",
      "scripts/**/*.ts",
    ])
      .filter((f) => !f.endsWith(".test.ts"))
      .filter((f) =>
        new RegExp(`from "[^"]*${GATED_BUILDS_JSON.replace(/\./g, "\\.")}"`).test(
          readFileSync(join(REPO, f), "utf8"),
        ),
      );
    expect(importers.every((f) => (READER_MODULES as readonly string[]).includes(f))).toBe(true);
    expect(importers.length).toBeGreaterThan(0);
  });
});

describe("R1208: the rule on planted modules", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
  });
  async function tree(pins: string, pin: string, tests: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), "lethal-r1208-"));
    roots.push(root);
    const files: Record<string, string> = {
      [READER_MODULES[0]]: pins,
      [READER_MODULES[1]]: pin,
      ...tests,
    };
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, f)), { recursive: true });
      await writeFile(join(root, f), text);
    }
    return root;
  }
  const PINS = `import RAW from "./${GATED_BUILDS_JSON}";
export function rows(): unknown[] {
  return RAW as unknown[];
}
export function unrelated(): number {
  return 1;
}
`;

  test("a NEW reader, two hops from the file, is found with no list edited, and so is its test", async () => {
    const r = await tree(
      `${PINS}export function hopOne(): number {\n  return rows().length;\n}\n`,
      `import { hopOne } from "./al-runner-v3-pins";\nexport const hopTwo = () =>\n  hopOne() + 1;\n`,
      {
        "packages/runner/tests/new-reader.test.ts": "hopTwo();\n",
        "packages/runner/tests/other.test.ts": "unrelated();\n",
        "scripts/x.test.ts": "rowsAndMore();\n",
      },
    );
    expect(gatedBuildsReaders(r)).toEqual(["RAW", "hopOne", "hopTwo", "rows"]);
    expect(gatedBuildsReaderTests(r)).toEqual(["packages/runner/tests/new-reader.test.ts"]);
  });

  test("an empty answer throws, never passing every row", async () => {
    const r = await tree(PINS, "export const x = 1;\n", {
      "packages/runner/tests/other.test.ts": "unrelated();\n",
    });
    expect(() => gatedBuildsReaderTests(r)).toThrow("no test file names a reader");
    const none = await tree("export const x = 1;\n", "export const y = 2;\n", {});
    expect(() => gatedBuildsReaders(none)).toThrow("reads al-runner-v3-gated-builds.json");
  });

  test("paths come back with / on every OS", async () => {
    const r = await tree(PINS, "export const x = 1;\n", {
      "packages/runner/tests/deep/a.test.ts": "rows();\n",
    });
    expect(scanRel(r, ["packages/*/tests/**/*.test.ts"])).toEqual([
      "packages/runner/tests/deep/a.test.ts",
    ]);
  });

  test("a declaration ends at the next column-0 line, so a later function is not swallowed", () => {
    const d = topLevelDecls(
      "export function a() {\n  return 1;\n}\n// note\nexport function b() {\n  return rows();\n}\n",
    );
    expect(d.map((x) => x.name)).toEqual(["a", "b"]);
    expect(d[0]?.body).not.toContain("rows");
  });
});
