import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { dryRunDependencyPackageDirs } from "../src/cli";

// R656: `--dry-run` lists dependency reports from the folders the REAL run of that backend reads.
// al-runner-v3 used to fall into bcdev's package cache.

const config = {
  bcdev: { packageCachePath: "bc-cache" },
  alRunner: { packagesDir: "v2-pkgs" },
  alRunnerV3: { packagesDir: "v3-pkgs" },
};

describe("R656: dryRunDependencyPackageDirs per backend kind", () => {
  test("bcdev reads bcdev's package cache", () => {
    expect(dryRunDependencyPackageDirs("bcdev", config, "proj")).toEqual([resolve("bc-cache")]);
  });

  test("bcdev with no packageCachePath reads <project>/.alpackages", () => {
    expect(dryRunDependencyPackageDirs("bcdev", {}, "proj")).toEqual([
      resolve(join("proj", ".alpackages")),
    ]);
  });

  test("al-runner (v2) reads alRunner.packagesDir", () => {
    expect(dryRunDependencyPackageDirs("al-runner", config, "proj")).toEqual(["v2-pkgs"]);
  });

  test("al-runner (v2) with no packagesDir reads none", () => {
    expect(dryRunDependencyPackageDirs("al-runner", {}, "proj")).toEqual([]);
  });

  test("al-runner-v3 reads alRunnerV3.packagesDir, as the v3 backend's dependencyPackageDirs does", () => {
    expect(dryRunDependencyPackageDirs("al-runner-v3", config, "proj")).toEqual(["v3-pkgs"]);
  });

  test("al-runner-v3 with no packagesDir reads none, never bcdev's cache", () => {
    expect(dryRunDependencyPackageDirs("al-runner-v3", { bcdev: config.bcdev }, "proj")).toEqual(
      [],
    );
    expect(dryRunDependencyPackageDirs("al-runner-v3", undefined, "proj")).toEqual([]);
  });
});
