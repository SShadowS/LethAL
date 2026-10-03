import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// Every `secret_files` destination in .kraken/project.yaml must be ignored by THIS repo's
// .gitignore alone. The owner's global ignore file hides gaps on the host and is absent in the
// container, where a `git add -A` would then commit the secret.
const tos = [
  ...readFileSync(join(ROOT, ".kraken", "project.yaml"), "utf8").matchAll(/\bto:\s*(\S+?)\s*\}/g),
].map((m) => m[1] ?? "");

test("project.yaml names secret files to check", () => {
  expect(tos.length).toBeGreaterThan(5);
});

for (const to of tos) {
  test(`secret file ${to} is ignored by the repo's .gitignore alone`, () => {
    const r = Bun.spawnSync(
      [
        "git",
        "-c",
        `core.excludesFile=${join(tmpdir(), "kraken-no-such-excludes")}`,
        "check-ignore",
        "--no-index",
        "-q",
        to,
      ],
      { cwd: ROOT },
    );
    expect(r.exitCode).toBe(0);
  });
}
