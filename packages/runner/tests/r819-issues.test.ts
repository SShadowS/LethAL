// R-819: GitHub #46 (a flag the report names, which did not exist) and #47 (BC 29's Ready-to-Run
// wrappers, read as a missing System Application). The wrappers here are synthetic.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBcVersionMatchesPackages } from "../src/al-runner-v3-config";
import { parseCliConfig } from "../src/cli";
import {
  type MicrosoftMode,
  dependencyFingerprint,
  packageFolderReader,
} from "../src/digest-inputs";
import { BASELINE_TIMEOUT_DEFAULT } from "../src/orchestrator";
import { symbolPackageIdentity, unwrapSymbolPackage } from "../src/published-test-app";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const SYSTEM_APP = "63ca2fa4-4f03-4f2b-a480-172fef340d3f";
const R2R = "readytorunappmanifest.json";
const manifest = (id: string, name: string, version: string) =>
  `<Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${id}" Name="${name}" Publisher="Microsoft" Version="${version}"/></Package>`;
const plain = (id: string, name: string, version: string) =>
  buildFakeAppWithEntries({ "NavxManifest.xml": manifest(id, name, version) });
/** The shape #47 describes: no NavxManifest.xml on top, one inner .app, and the json naming it. */
const wrapper = (id: string, name: string, version: string, embeddedId = id) =>
  buildFakeAppWithEntries({
    [R2R]: JSON.stringify({ EmbeddedAppId: embeddedId }),
    [`${id}_${version}.app`]: plain(id, name, version),
    "marker.txt": "WRAPPER",
  });

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const folder = async (files: Record<string, Buffer>) => {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r819-"));
  dirs.push(dir);
  for (const [n, b] of Object.entries(files)) await writeFile(join(dir, n), b);
  return dir;
};

describe("#47: a Ready-to-Run wrapper's identity", () => {
  test("a wrapper reads as its embedded app; a plain package reads as itself", () => {
    const w = wrapper(SYSTEM_APP, "System Application", "29.0.54011.57368");
    expect(symbolPackageIdentity(w)).toMatchObject({
      id: SYSTEM_APP,
      name: "System Application",
      publisher: "Microsoft",
      version: "29.0.54011.57368",
    });
    const p = plain(SYSTEM_APP, "System Application", "29.0.54011.57368");
    expect(symbolPackageIdentity(p).version).toBe("29.0.54011.57368");
    expect(unwrapSymbolPackage(p)).toBe(p);
  });

  test("a wrapper that disagrees with itself throws, never a guess", () => {
    const other = "11111111-1111-1111-1111-111111111111";
    expect(() =>
      symbolPackageIdentity(wrapper(SYSTEM_APP, "System Application", "29.0.0.0", other)),
    ).toThrow("does not match EmbeddedAppId");
  });

  test("the version check reads the wrapper: equal passes, and a mismatch is still refused", async () => {
    const d = await folder({
      "Microsoft_System Application.app": wrapper(
        SYSTEM_APP,
        "System Application",
        "29.0.54011.57368",
      ),
    });
    await expect(assertBcVersionMatchesPackages(d, "29.0.54011.57368")).resolves.toBeUndefined();
    await expect(assertBcVersionMatchesPackages(d, "29.0.1.2")).rejects.toThrow(
      "al-runner-v3-bc-version-mismatch",
    );
  });

  test("a broken wrapper is not read as a System Application: refused by name, and it says so", async () => {
    const d = await folder({
      "Microsoft_System Application.app": wrapper(
        SYSTEM_APP,
        "System Application",
        "29.0.0.0",
        "11111111-1111-1111-1111-111111111111",
      ),
    });
    const err = await assertBcVersionMatchesPackages(d, "29.0.0.0").catch((e: unknown) => e);
    expect(String(err)).toContain("al-runner-v3-system-application-not-found");
    expect(String(err)).toContain("Ready-to-Run");
  });

  test("no System Application at all reads as before", async () => {
    const d = await folder({ "Other.app": plain(SYSTEM_APP, "Base Application", "29.0.0.0") });
    const err = await assertBcVersionMatchesPackages(d, "29.0.0.0").catch((e: unknown) => e);
    expect(String(err)).toContain("al-runner-v3-system-application-not-found");
    expect(String(err)).not.toContain("Ready-to-Run");
  });

  test("the package folder finds a dependency held as a wrapper, and hashes the file's own bytes", async () => {
    const w = wrapper(SYSTEM_APP, "System Application", "29.0.0.0");
    const d = await folder({ "Microsoft_System Application.app": w });
    const read = packageFolderReader([d]);
    const dep = {
      id: SYSTEM_APP,
      name: "System Application",
      publisher: "Microsoft",
      version: "29.0.0.0",
    };
    const got = await read(dep);
    expect(Array.isArray(got)).toBe(true);
    expect(Buffer.from((got as Uint8Array[])[0] ?? []).equals(w)).toBe(true);
    const mode: MicrosoftMode = { kind: "folder" };
    const root = { dependencies: [dep], preprocessorSymbols: [] } as never;
    const a = await dependencyFingerprint(root, read, mode);
    const other = await folder({
      "Microsoft_System Application.app": wrapper(SYSTEM_APP, "System Application", "29.0.0.1"),
    });
    const b = await dependencyFingerprint(root, packageFolderReader([other]), mode);
    expect(a).not.toBe(b);
  });
});

describe("#46: the flag the report names", () => {
  const RUN = ["run", "--project", "p", "--tests", "t", "--backend", "bcdev"] as const;
  const parsed = (...more: string[]) => {
    const cfg = parseCliConfig([...RUN, ...more]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    return cfg;
  };

  test("--baseline-timeout-ms parses; absent leaves no key, and the default stands", () => {
    expect(parsed("--baseline-timeout-ms", "300000").baselineTimeoutMs).toBe(300_000);
    expect("baselineTimeoutMs" in parsed()).toBe(false);
    expect(BASELINE_TIMEOUT_DEFAULT).toBe(120_000);
  });

  test("a bad value is refused by name", () => {
    for (const v of ["1.5", "0", "abc"])
      expect(() => parsed("--baseline-timeout-ms", v)).toThrow(/positive integer/);
  });

  test("--dry-run refuses it: a dry run runs no baseline", () => {
    expect(() => parsed("--dry-run", "--baseline-timeout-ms", "300000")).toThrow(/--dry-run/);
  });

  test("every flag a report tells a user to raise really parses", async () => {
    const src = await readFile(join(import.meta.dir, "../src/report.ts"), "utf8");
    const raised = new Set(
      [...src.matchAll(/[Rr]aise `--([a-z-]+)`(?: or `--([a-z-]+)`)?/g)].flatMap((m) =>
        [m[1], m[2]].filter((f) => f !== undefined),
      ),
    );
    expect([...raised].sort()).toEqual([
      "baseline-timeout-ms",
      "mutant-timeout-ms",
      "request-ceiling-ms",
    ]);
    for (const flag of raised) expect(() => parsed(`--${flag}`, "300000")).not.toThrow();
  });
});
