import { beforeAll, expect, it } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import { initParser } from "../../src/ast/parser";
import { hashDifferential } from "./hash-differential";

beforeAll(async () => {
  await initParser();
});

// RUST-03 S4.2d, AMENDMENT 8 Guard 2: every `.al` under `fixtures/` (every fixture project and its
// test app), old against new, on every node through every path, with zero differences.
it(
  "astSubtreeHash equals the pre-S4.2d reference on every node of every fixture .al",
  () => {
    const root = join(import.meta.dir, "..", "..", "..", "..", "fixtures");
    const files = [...new Glob("**/*.al").scanSync(root)].sort().map((f) => join(root, f));
    const r = hashDifferential(files);
    expect(r.files).toBeGreaterThanOrEqual(68);
    expect(r.named).toBeGreaterThan(10_000);
    expect(r.differences).toEqual([]);
  },
  { timeout: 120_000 },
);
