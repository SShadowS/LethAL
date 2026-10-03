import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultAlRunnerCacheDir, defaultAlRunnerSecondaryCacheDir } from "../src/al-runner-cache";
import { homeDir } from "../src/home";

/**
 * R264: every default that resolves under the home directory (al-runner's two caches, the
 * quarantine dir, the env-tool state dir, the VS Code extensions dir) must resolve under a fake
 * home in a unit test. `scripts/test-preload.ts`, loaded by the root `bunfig.toml`, does the
 * redirect. The check is EXACT equality with the fake home the preload recorded, never "not under
 * the real home": on Windows `tmpdir()` is itself inside the real profile, so a correct fake home
 * IS a descendant of the real one. This test also fails when `bun test` is started outside the
 * repo root, where the preload does not load: run it from the root.
 */
test("unit tests run with the real home directory hidden (R264)", () => {
  const real = process.env.LETHAL_TEST_REAL_HOME;
  const fake = process.env.LETHAL_TEST_FAKE_HOME;
  expect(real, "the test preload did not run: start bun test from the repo root").toBeDefined();
  expect(fake, "the test preload did not run: start bun test from the repo root").toBeDefined();
  if (real === undefined || fake === undefined) return;
  const same = (p: string) => resolve(p).toLowerCase();
  expect(same(fake)).not.toBe(same(real));
  // R409: product code reads the home through `homeDir()`, on every platform.
  expect(same(homeDir())).toBe(same(fake));
  // `os.homedir()` follows the in-process redirect on Windows only: on Linux Bun keeps the HOME the
  // process started with (measured, Bun 1.4.2), which no preload can change. Linux is covered by
  // the `homeDir()` line above plus the no-direct-homedir guard below.
  if (process.platform === "win32") expect(same(homedir())).toBe(same(fake));
  expect(same(process.env.USERPROFILE ?? "")).toBe(same(fake));
  expect(same(process.env.HOME ?? "")).toBe(same(fake));
  expect(same(defaultAlRunnerCacheDir())).toBe(
    same(join(fake, ".local", "share", "al-runner", "artifacts")),
  );
  expect(same(defaultAlRunnerSecondaryCacheDir())).toBe(same(join(fake, ".cache", "al-runner")));
  // The two real roots, named, so the failure message says which one a regression reaches.
  expect(same(defaultAlRunnerCacheDir())).not.toBe(
    same(join(real, ".local", "share", "al-runner", "artifacts")),
  );
  expect(same(defaultAlRunnerSecondaryCacheDir())).not.toBe(
    same(join(real, ".cache", "al-runner")),
  );
});

test("R409: no product source calls os.homedir() directly; home.ts is the one reader", () => {
  const packagesDir = join(import.meta.dir, "..", "..");
  const callers: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = join(packagesDir, pkg, "src");
    let files: string[];
    try {
      files = readdirSync(srcDir, { recursive: true }).map(String);
    } catch {
      continue; // a package with no src/
    }
    for (const f of files) {
      if (!f.endsWith(".ts")) continue;
      if (/\bhomedir\s*\(/.test(readFileSync(join(srcDir, f), "utf8"))) {
        callers.push(`${pkg}/src/${f.split("\\").join("/")}`);
      }
    }
  }
  // Exactly the one reader. Seeing home.ts here also proves the walk is not vacuous.
  expect(callers).toEqual(["runner/src/home.ts"]);
});
