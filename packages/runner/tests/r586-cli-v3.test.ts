// R586 T16 and T17 (plan r2 §9): the al-runner-v3 CLI surface, its config section and its
// refusals by name, each with the direction that must NOT fire (v2 keeps its server and resource legs).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBcVersionMatchesPackages,
  refuseV3Platform,
  validateAlRunnerV3Config,
} from "../src/al-runner-v3-config";
import { parseCliConfig, validateAlRunnerConfig } from "../src/cli";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const ok = { packagesDir: "/deps", bcVersion: "28.0.46665.47126" };

describe("T16: refused by name for v3, and not for v2", () => {
  const base = ["--project", "P", "--tests", "T", "--backend", "al-runner-v3"];
  test("--backend al-runner-v3 parses", () => {
    const c = parseCliConfig(["run", ...base]);
    expect(c.mode === "run" && c.backendKind).toBe("al-runner-v3");
  });
  test("--workers > 1 is refused for v3, not for v2", () => {
    expect(() => parseCliConfig(["run", ...base, "--workers", "2"])).toThrow(
      /al-runner-v3-workers-refused/,
    );
    expect(() =>
      parseCliConfig([
        "run",
        "--project",
        "P",
        "--tests",
        "T",
        "--backend",
        "al-runner",
        "--workers",
        "2",
      ]),
    ).not.toThrow();
  });
  test("--keep-env is refused for v3 (no environment)", () => {
    expect(() => parseCliConfig(["run", ...base, "--keep-env"])).toThrow(
      /al-runner-v3 has no environment/,
    );
  });
  test("Windows is refused by name; Linux is not", () => {
    expect(() => refuseV3Platform("win32")).toThrow(/al-runner-v3-windows-unsupported/);
    expect(() => refuseV3Platform("linux")).not.toThrow();
  });
  test("serverMode and selectorMode in the v3 section are refused by name; v2's section still takes them", () => {
    expect(() => validateAlRunnerV3Config({ ...ok, serverMode: true })).toThrow(
      /al-runner-v3-config-refused/,
    );
    expect(() => validateAlRunnerV3Config({ ...ok, selectorMode: "resource" })).toThrow(
      /al-runner-v3-resource-selector-refused/,
    );
    expect(
      validateAlRunnerConfig({ alRunnerPath: "/a", serverMode: true, selectorMode: "resource" })
        .serverMode,
    ).toBe(true);
  });
  test("an unknown key is refused; the defaults are the pinned path and coverage al-runner", () => {
    expect(() => validateAlRunnerV3Config({ ...ok, servermode: true })).toThrow(/unknown key/);
    expect(validateAlRunnerV3Config(ok)).toMatchObject({
      path: "/work/tools/al-runner-v3/current/al-runner",
      coverage: "al-runner",
    });
  });
});

describe("T17: bcVersion is required and must equal the package folder's System Application", () => {
  let dir = "";
  afterEach(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
  });
  const app = (name: string, version: string) =>
    buildFakeAppWithEntries({
      "NavxManifest.xml": `<?xml version="1.0"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="1" Name="${name}" Publisher="Microsoft" Version="${version}" /></Package>`,
    });
  test("missing or malformed bcVersion is refused", () => {
    expect(() => validateAlRunnerV3Config({ packagesDir: "/d" })).toThrow(/bcVersion" is required/);
    expect(() => validateAlRunnerV3Config({ packagesDir: "/d", bcVersion: "28.0" })).toThrow(
      /four-number/,
    );
  });
  test("a mismatch is refused; equal versions pass", async () => {
    dir = await mkdtemp(join(tmpdir(), "lethal-r586-bc-"));
    await writeFile(
      join(dir, "Microsoft_System Application.app"),
      app("System Application", "28.0.46665.47126"),
    );
    await writeFile(
      join(dir, "Microsoft_Base Application.app"),
      app("Base Application", "1.2.3.4"),
    );
    await expect(assertBcVersionMatchesPackages(dir, "28.0.46665.47126")).resolves.toBeUndefined();
    await expect(assertBcVersionMatchesPackages(dir, "28.4.53241.53758")).rejects.toThrow(
      /al-runner-v3-bc-version-mismatch/,
    );
  });
});
