import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_SYMBOL_FILE, buildPackageCacheCopy } from "../packages/runner/src/artifact.ts";
import { buildFakeAppWithEntries } from "../packages/runner/tests/helpers/fake-app.ts";
import {
  MARKER,
  SymbolCacheError,
  buildDirName,
  fillSymbolCache,
  lookupSymbolCache,
  verifyBuildDir,
} from "./bc-symbol-cache.ts";

const BUILD = "28.4.53241.56646";

function pkg(name: string, publisher = "Microsoft", version = BUILD, extra = ""): Buffer {
  return buildFakeAppWithEntries({
    "NavxManifest.xml": `<Package><App Id="id-${name}" Name="${name}" Publisher="${publisher}" Version="${version}" /></Package>`,
    "SymbolReference.json": `{"x":"${extra}"}`,
  });
}

const roots: string[] = [];
function newRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "bc-symbols-"));
  roots.push(r);
  return r;
}
/** A completed dir is 0555: open every dir up again so the temp roots can be removed. */
function openUp(dir: string): void {
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir)) {
    if (statSync(join(dir, e)).isDirectory()) openUp(join(dir, e));
  }
}
afterAll(() => {
  for (const r of roots) {
    if (!existsSync(r)) continue;
    openUp(r);
    rmSync(r, { recursive: true, force: true });
  }
});
const POSIX = process.platform !== "win32";

/** file, bytes, name, publisher, version */
type HandEntry = readonly [string, Buffer, string, string, string];

/** A build dir written by hand, with a marker whose hashes are all correct. */
function handDir(root: string, list: readonly HandEntry[], build = BUILD): string {
  const names = list.map((e) => e[2]);
  const dir = join(root, "bc3", buildDirName(build, names));
  mkdirSync(dir, { recursive: true });
  const sha = (b: Buffer) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
  const packages = list.map(([file, b, name, publisher, version]) => {
    writeFileSync(join(dir, file), b);
    return { file, id: `id-${name}`, name, publisher, version, sha256: sha(b) };
  });
  const writtenAt = "2026-10-22T00:00:00Z";
  const marker = { server: "bc3", build, writtenAt, fileCount: list.length, packages };
  writeFileSync(join(dir, MARKER), JSON.stringify(marker));
  return dir;
}

/** A server whose Microsoft packages are `pkgs`; counts every download. */
function server(pkgs: Record<string, Buffer>, gate?: Promise<void>) {
  const calls: string[] = [];
  return {
    calls,
    download: async (name: string) => {
      calls.push(name);
      if (gate !== undefined) await gate;
      return pkgs[name] ?? null;
    },
  };
}

const MS = { System: pkg("System"), "Base Application": pkg("Base Application") };
const NAMES = ["System", "Base Application"];
/** The build dir's name: the build plus the hash of the name set. */
const DIR = buildDirName(BUILD, NAMES);
const fill = (
  root: string,
  s = server(MS),
  names = NAMES,
  rename?: (from: string, to: string) => void,
) =>
  fillSymbolCache({
    root,
    server: "bc3",
    names,
    download: s.download,
    ...(rename !== undefined ? { rename } : {}),
  });

describe("fillSymbolCache: temp dir, marker, atomic rename", () => {
  test("a fill writes a verifying marker and seals the dir under <server>/<build>-<hash8>", async () => {
    const root = newRoot();
    const s = server(MS);
    const r = await fill(root, s);
    expect(DIR).toMatch(/^28\.4\.53241\.56646-[0-9a-f]{8}$/);
    expect(r).toMatchObject({ dir: join(root, "bc3", DIR), build: BUILD, outcome: "filled" });
    expect(s.calls).toEqual(NAMES);
    const v = verifyBuildDir(r.dir, "bc3", NAMES);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.marker.fileCount).toBe(2);
    expect(v.marker.packages.map((p) => [p.name, p.publisher, p.version, p.id])).toEqual([
      ["System", "Microsoft", BUILD, "id-System"],
      ["Base Application", "Microsoft", BUILD, "id-Base Application"],
    ]);
    // Windows has no POSIX mode bits; the shared cache lives in the Linux container.
    if (POSIX) {
      expect(statSync(r.dir).mode & 0o777).toBe(0o555);
      expect(statSync(join(r.dir, "Microsoft_System.app")).mode & 0o777).toBe(0o444);
    }
    // no temp dir is left beside the build dir
    expect(readdirSync(join(root, "bc3"))).toEqual([DIR]);
  });

  test.skipIf(!POSIX)(
    "a crash right after the rename still leaves a SEALED dir (sealed before the move)",
    async () => {
      const root = newRoot();
      const crash = (from: string, to: string) => {
        renameSync(from, to);
        throw new Error("crashed after the rename");
      };
      // The crash reads as a lost race: the loser verifies the dir that is now in place.
      const r = await fill(root, server(MS), NAMES, crash);
      expect(r.outcome).toBe("lost-race");
      expect(statSync(join(root, "bc3", DIR)).mode & 0o777).toBe(0o555);
      expect(readdirSync(join(root, "bc3"))).toEqual([DIR]);
    },
  );

  test("a NEW Microsoft dependency on the same build gets a new dir, and the old one stays", async () => {
    const root = newRoot();
    const old = await fill(root, server(MS), ["System"]);
    const r = await fill(root, server(MS), NAMES);
    expect(r.outcome).toBe("filled");
    expect(r.dir).not.toBe(old.dir);
    expect(readdirSync(join(root, "bc3")).sort()).toEqual(
      [buildDirName(BUILD, ["System"]), DIR].sort(),
    );
    expect(verifyBuildDir(old.dir, "bc3", ["System"]).ok).toBe(true);
    expect(lookupSymbolCache(root, "bc3", NAMES).chosen?.dir).toBe(r.dir);
  });

  test("a dir that already verifies is used: one download (System, for the build), dir untouched", async () => {
    const root = newRoot();
    const first = await fill(root);
    const before = statSync(join(first.dir, MARKER));
    const marker = readFileSync(join(first.dir, MARKER), "utf8");
    const s = server(MS);
    const again = await fill(root, s);
    expect(again.outcome).toBe("existing");
    expect(s.calls).toEqual(["System"]);
    const after = statSync(join(first.dir, MARKER));
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    expect(readFileSync(join(first.dir, MARKER), "utf8")).toBe(marker);
    expect(readdirSync(join(root, "bc3"))).toEqual([DIR]);
  });

  test("a partial dir (no marker) is never used and never touched", async () => {
    const root = newRoot();
    const partial = join(root, "bc3", DIR);
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, "Microsoft_System.app"), MS.System);
    await expect(fill(root)).rejects.toThrow(/no cache-complete\.json.*never modified or deleted/);
    expect(readdirSync(partial)).toEqual(["Microsoft_System.app"]);
    const found = lookupSymbolCache(root, "bc3", NAMES);
    expect(found.chosen).toBeUndefined();
    expect(found.unverified[0]).toContain("no cache-complete.json");
  });

  test("a dir whose file no longer matches its marker does not verify", async () => {
    const root = newRoot();
    const r = await fill(root);
    chmodSync(r.dir, 0o755);
    chmodSync(join(r.dir, "Microsoft_System.app"), 0o644);
    writeFileSync(join(r.dir, "Microsoft_System.app"), pkg("System", "Microsoft", BUILD, "edit"));
    const v = verifyBuildDir(r.dir, "bc3", NAMES);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("sha256 differs");
    expect(lookupSymbolCache(root, "bc3", NAMES).chosen).toBeUndefined();
  });

  test("two fills racing leave exactly one valid dir, and the loser verifies the winner", async () => {
    const root = newRoot();
    let open: () => void = () => {};
    const gate = new Promise<void>((res) => {
      open = res;
    });
    const a = fill(root, server(MS, gate));
    const b = fill(root, server(MS, gate));
    open();
    const results = await Promise.all([a, b]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["filled", "lost-race"]);
    expect(readdirSync(join(root, "bc3"))).toEqual([DIR]);
    expect(verifyBuildDir(join(root, "bc3", DIR), "bc3", NAMES).ok).toBe(true);
  });

  test("a new BC build gets a new dir and the old one is left alone", async () => {
    const root = newRoot();
    const old = await fill(root);
    const next = "28.5.1.1";
    const r = await fill(
      root,
      server({
        System: pkg("System", "Microsoft", next),
        "Base Application": pkg("Base Application", "Microsoft", next),
      }),
    );
    expect(r.dir).toBe(join(root, "bc3", buildDirName(next, NAMES)));
    expect(readdirSync(join(root, "bc3")).sort()).toEqual([DIR, buildDirName(next, NAMES)]);
    expect(verifyBuildDir(old.dir, "bc3", NAMES).ok).toBe(true);
  });
});

describe("only Microsoft packages enter the shared cache (orchestrator ruling)", () => {
  for (const [what, offered] of [
    ["LethAL Control", pkg("LethAL Control", "LethAL", "1.0.0.23")],
    ["a fixture app", pkg("LethAL Sandbox App", "LethAL", "1.0.0.2")],
    ["a Continia app", pkg("Continia Core", "Continia Software", "28.5.0.336883")],
  ] as const) {
    test(`${what} offered for the shared dir is refused, and no build dir is made`, async () => {
      const root = newRoot();
      await expect(
        fill(root, server({ System: MS.System, "Base Application": offered })),
      ).rejects.toThrow(/only Microsoft packages enter the shared cache/);
      expect(readdirSync(join(root, "bc3"))).toEqual([]);
    });
  }

  test("a package that is not Microsoft's by its MANIFEST is refused, whatever it is called", async () => {
    const root = newRoot();
    await expect(
      fill(root, server({ System: pkg("System", "LethAL") }), ["System"]),
    ).rejects.toThrow(SymbolCacheError);
  });

  test("a build dir holding a lethal-control.app (as bc1's did in R-553) fails verification", async () => {
    const root = newRoot();
    const r = await fill(root);
    chmodSync(r.dir, 0o755);
    writeFileSync(join(r.dir, "lethal-control.app"), pkg("LethAL Control", "LethAL", "1.0.0.23"));
    const v = verifyBuildDir(r.dir, "bc3", NAMES);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("lethal-control.app");
  });

  test("a marker that lists a non-Microsoft package (hashes all correct) fails verification", () => {
    const fx = pkg("LethAL Sandbox App", "LethAL", "1.0.0.2");
    const dir = handDir(newRoot(), [
      ["Microsoft_System.app", MS.System, "System", "Microsoft", BUILD],
      ["fixture.app", fx, "LethAL Sandbox App", "LethAL", "1.0.0.2"],
    ]);
    const v = verifyBuildDir(dir, "bc3");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("fixture.app is published by LethAL");
  });

  test("THE STALE CASE: same build, LethAL Control bumped: the reader gets the current control", async () => {
    const root = newRoot();
    const r = await fill(root);
    const work = newRoot();
    const controlV24 = join(work, "control-1.0.0.24.app");
    writeFileSync(controlV24, pkg("LethAL Control", "LethAL", "1.0.0.24"));
    // R552's private copy is what every instrumented compile reads.
    const copy = await buildPackageCacheCopy(r.dir, controlV24, work);
    const msFiles = ["Microsoft_Base Application.app", "Microsoft_System.app"];
    expect(readdirSync(copy).sort()).toEqual([CONTROL_SYMBOL_FILE, ...msFiles].sort());
    expect(readFileSync(join(copy, CONTROL_SYMBOL_FILE))).toEqual(readFileSync(controlV24));
    // and the shared dir is still exactly what it was
    expect(verifyBuildDir(r.dir, "bc3", NAMES).ok).toBe(true);
    expect(readdirSync(r.dir).sort()).toEqual([MARKER, ...msFiles].sort());
  });
});

describe("verifyBuildDir: the build, regular files, never a throw", () => {
  test("a System whose manifest version is not the marker's build fails verification", () => {
    const old = "28.0.1.1";
    const dir = handDir(newRoot(), [
      ["Microsoft_System.app", pkg("System", "Microsoft", old), "System", "Microsoft", old],
    ]);
    const v = verifyBuildDir(dir, "bc3");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain(`System is 28.0.1.1, the marker's build is ${BUILD}`);
  });

  const SYS: HandEntry = ["Microsoft_System.app", MS.System, "System", "Microsoft", BUILD];

  test.skipIf(!POSIX)("a symlink in place of a package fails verification, unfollowed", () => {
    const root = newRoot();
    const dir = handDir(root, [SYS]);
    const elsewhere = join(root, "real-system.app");
    writeFileSync(elsewhere, MS.System);
    rmSync(join(dir, "Microsoft_System.app"));
    symlinkSync(elsewhere, join(dir, "Microsoft_System.app"));
    const v = verifyBuildDir(dir, "bc3");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("Microsoft_System.app is not a regular file");
  });

  test("a directory in place of a package fails verification", () => {
    const root = newRoot();
    const dir = handDir(root, [SYS]);
    rmSync(join(dir, "Microsoft_System.app"));
    mkdirSync(join(dir, "Microsoft_System.app"));
    const v = verifyBuildDir(dir, "bc3");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("Microsoft_System.app is not a regular file");
  });

  // POSIX: as a non-root user a 000 file cannot be read, so the read itself throws EACCES.
  test.skipIf(!POSIX || process.getuid?.() === 0)(
    "an unreadable package is a reason, never a throw, and lookup lists it as unverified",
    () => {
      const root = newRoot();
      const dir = handDir(root, [SYS]);
      chmodSync(join(dir, "Microsoft_System.app"), 0o000);
      try {
        expect(() => verifyBuildDir(dir, "bc3")).not.toThrow();
        const v = verifyBuildDir(dir, "bc3");
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.reason).toContain("EACCES");
        const found = lookupSymbolCache(root, "bc3", ["System"]);
        expect(found.chosen).toBeUndefined();
        expect(found.unverified).toHaveLength(1);
      } finally {
        chmodSync(join(dir, "Microsoft_System.app"), 0o644);
      }
    },
  );
});

describe("lookupSymbolCache (no server call)", () => {
  test("empty root: nothing chosen; filled: the verified dir with its marker", async () => {
    const root = newRoot();
    expect(lookupSymbolCache(root, "bc3", NAMES)).toEqual({ verified: [], unverified: [] });
    const r = await fill(root);
    const found = lookupSymbolCache(root, "bc3", NAMES);
    expect(found.chosen?.dir).toBe(r.dir);
    expect(found.chosen?.marker.build).toBe(BUILD);
    // another server's cache is not this one's
    expect(lookupSymbolCache(root, "bc1", NAMES).chosen).toBeUndefined();
  });

  test("a complete dir that lacks a now-required package is not chosen", async () => {
    const root = newRoot();
    await fill(root, server(MS), ["System"]);
    const found = lookupSymbolCache(root, "bc3", NAMES);
    expect(found.chosen).toBeUndefined();
    expect(found.unverified[0]).toContain("lacks Base Application");
  });
});
