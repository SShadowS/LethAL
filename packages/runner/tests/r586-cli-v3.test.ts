// R586 T16 and T17 (plan r2 §9): the al-runner-v3 CLI surface, its config section and its
// refusals by name, each with the direction that must NOT fire.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBcVersionMatchesPackages,
  refuseV3Platform,
  validateAlRunnerV3Config,
} from "../src/al-runner-v3-config";
import { parseCliConfig } from "../src/cli";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const ok = { packagesDir: "/deps", bcVersion: "28.0.46665.47126" };

describe("T16: refused by name for v3, and not for v2", () => {
  const base = ["--project", "P", "--tests", "T", "--backend", "al-runner-v3"];
  // M9: the CLI refuses v3 on every platform but Linux, so on another OS (the Windows CI job) these
  // tests ASSERT that refusal instead of the Linux behaviour; neither direction is skipped.
  const LINUX = process.platform === "linux";
  const PLATFORM_REFUSED = /al-runner-v3-(windows|platform)-unsupported/;
  test("--backend al-runner-v3 parses on Linux, and is refused by name elsewhere", () => {
    if (!LINUX) {
      expect(() => parseCliConfig(["run", ...base])).toThrow(PLATFORM_REFUSED);
      return;
    }
    const c = parseCliConfig(["run", ...base]);
    expect(c.mode === "run" && c.backendKind).toBe("al-runner-v3");
  });
  // R654 S3: the "not for v2" direction went with the .NET al-runner; the direction that must not
  // fire is now v3 at one worker.
  test("--workers > 1 is refused for v3, and --workers 1 is not", () => {
    expect(() => parseCliConfig(["run", ...base, "--workers", "2"])).toThrow(
      LINUX ? /al-runner-v3-workers-refused/ : PLATFORM_REFUSED,
    );
    if (LINUX) expect(() => parseCliConfig(["run", ...base, "--workers", "1"])).not.toThrow();
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
  test("serverMode and selectorMode in the v3 section are refused by name", () => {
    expect(() => validateAlRunnerV3Config({ ...ok, serverMode: true })).toThrow(
      /al-runner-v3-config-refused/,
    );
    expect(() => validateAlRunnerV3Config({ ...ok, selectorMode: "resource" })).toThrow(
      /al-runner-v3-resource-selector-refused/,
    );
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
  test("M8: no System Application found (nothing checked) is refused by name, never a pass", async () => {
    dir = await mkdtemp(join(tmpdir(), "lethal-r586-bc-"));
    await writeFile(
      join(dir, "Microsoft_Base Application.app"),
      app("Base Application", "1.2.3.4"),
    );
    await writeFile(join(dir, "Unreadable.app"), "not a package");
    await expect(assertBcVersionMatchesPackages(dir, "28.0.46665.47126")).rejects.toThrow(
      /al-runner-v3-system-application-not-found/,
    );
  });
});

describe("M9: every platform but Linux is refused by name (only Linux was measured)", () => {
  test("darwin, win32 and freebsd are refused; linux is not", () => {
    expect(() => refuseV3Platform("darwin")).toThrow(/al-runner-v3-platform-unsupported: darwin/);
    expect(() => refuseV3Platform("win32")).toThrow(/al-runner-v3-windows-unsupported/);
    expect(() => refuseV3Platform("freebsd")).toThrow(/al-runner-v3-platform-unsupported/);
    expect(() => refuseV3Platform("linux")).not.toThrow();
  });
});
