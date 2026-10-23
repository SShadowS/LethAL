import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { smokeLine } from "./native-parse-smoke.ts";

/**
 * R662: release.yml's two count checks on `fixtures/sandbox-data` read committed files. These run
 * the same counts on every CI push, so a fixture change fails ordinary CI here instead of the next
 * release trial (the 22 Oct trial failed on a value nobody updated after R-463 added fixtures).
 */
const REPO = join(import.meta.dir, "..");
const lines = (f: string) =>
  readFileSync(join(import.meta.dir, f), "utf8")
    .split("\n")
    .filter((l) => l !== "");

test("native-parse-expect.txt is the native parse count of fixtures/sandbox-data/src", async () => {
  expect(lines("native-parse-expect.txt")).toEqual([
    await smokeLine(join(REPO, "fixtures", "sandbox-data", "src")),
  ]);
});

test("release-dry-run-expect.txt holds the dry run's two count lines for fixtures/sandbox-data", () => {
  const r = Bun.spawnSync(
    ["bun", "packages/runner/src/cli.ts", "run", "--project", "fixtures/sandbox-data", "--dry-run"],
    { cwd: REPO, stdout: "pipe", stderr: "pipe" },
  );
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString().replaceAll("\r", "").split("\n");
  const want = lines("release-dry-run-expect.txt");
  expect(want).toHaveLength(2);
  for (const w of want) expect(out).toContain(w);
});
