// PR-128 (R1110): `lethal doctor` warns when a package in the project's dependency closure needs SQL
// Server Full-Text Search and that app is not installed (at the cached version) on the server.
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildDoctorDeps } from "../src/cli";
import { runDoctor } from "../src/doctor";
import { textSearchApp, textSearchFields, textSearchNote } from "../src/text-search-fields";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const DIRECT_ID = "11111111-1111-1111-1111-111111111111";
const NEEDY_ID = "22222222-2222-2222-2222-222222222222";

interface PkgOpts {
  readonly version?: string;
  readonly deps?: readonly { id: string; version: string }[];
  readonly noSymbols?: boolean;
}
const manifest = (id: string, name: string, version: string, o: PkgOpts) =>
  `<Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${id}" Name="${name}" Publisher="MP" Version="${version}"/><Dependencies>${(
    o.deps ?? []
  )
    .map((d) => `<Dependency Id="${d.id}" Name="x" Publisher="MP" MinVersion="${d.version}"/>`)
    .join("")}</Dependencies></Package>`;
const field = (name: string, props: object[] = []) => ({ Id: 1, Name: name, Properties: props });
const textOn = { Name: "OptimizeForTextSearch", Value: "1" };
const pkg = (id: string, name: string, symbols: unknown, o: PkgOpts = {}) =>
  buildFakeAppWithEntries({
    "NavxManifest.xml": manifest(id, name, o.version ?? "1.0.0.0", o),
    ...(o.noSymbols ? {} : { "SymbolReference.json": JSON.stringify(symbols) }),
  });
const needySymbols = {
  Tables: [{ Id: 5, Name: "KYC Company", Fields: [field("Name", [textOn]), field("City")] }],
};
const needy = pkg(NEEDY_ID, "Onboarding", needySymbols);
const plainPkg = (id: string, name: string, o: PkgOpts = {}) =>
  pkg(id, name, { Tables: [{ Id: 5, Name: "T", Fields: [field("Name")] }] }, o);

describe("textSearchFields", () => {
  test("finds the property, at any namespace depth, and finds nothing without it", () => {
    expect(textSearchFields(needy)).toEqual([{ table: "KYC Company", field: "Name" }]);
    const nested = pkg(NEEDY_ID, "N", {
      Namespaces: [
        { Namespaces: [{ Tables: [{ Name: "Deep", Fields: [field("F", [textOn])] }] }] },
      ],
    });
    expect(textSearchFields(nested)).toEqual([{ table: "Deep", field: "F" }]);
    expect(textSearchFields(plainPkg(DIRECT_ID, "P"))).toEqual([]);
    expect(textSearchApp(plainPkg(DIRECT_ID, "P"))).toBeUndefined();
  });

  test("a TableExtensions field counts", () => {
    const ext = pkg(NEEDY_ID, "E", {
      TableExtensions: [{ Name: "Cust Ext", Fields: [field("Memo", [textOn])] }],
    });
    expect(textSearchFields(ext)).toEqual([{ table: "Cust Ext", field: "Memo" }]);
  });

  test("the off values are not a declaration", () => {
    for (const Value of ["0", "false", "False"]) {
      const off = pkg(NEEDY_ID, "O", {
        Tables: [{ Name: "T", Fields: [field("F", [{ Name: "OptimizeForTextSearch", Value }])] }],
      });
      expect(textSearchFields(off)).toEqual([]);
    }
  });

  test("the note names the app, table, field and Full-Text Search", () => {
    const app = textSearchApp(needy);
    if (app === undefined) throw new Error("expected an app");
    const note = textSearchNote(app);
    expect(note).toContain("MP Onboarding");
    expect(note).toContain("KYC Company.Name");
    expect(note).toContain("Full-Text Search");
  });

  test("the note lists at most 5 fields and counts the rest", () => {
    const many = pkg(NEEDY_ID, "Many", {
      Tables: [
        { Name: "T", Fields: Array.from({ length: 8 }, (_, i) => field(`F${i}`, [textOn])) },
      ],
    });
    const app = textSearchApp(many);
    if (app === undefined) throw new Error("expected an app");
    const note = textSearchNote(app);
    expect(note).toContain("T.F4");
    expect(note).not.toContain("T.F5");
    expect(note).toContain("and 3 more");
  });
});

describe("text-search-dependencies check", () => {
  interface Over {
    readonly noProject?: boolean;
    /** The target's app.json dependencies (ids, version 1.0.0.0). Default: the direct package only. */
    readonly rootIds?: readonly string[];
    /** The test app's dependencies; given = `--tests` is passed. */
    readonly testRootIds?: readonly string[];
    readonly installed?: (id: string) => Promise<readonly string[]>;
  }
  async function run(cache: Record<string, Buffer>, installed: readonly string[], over: Over = {}) {
    const project = scratch("lethal-ts-proj-");
    const cacheDir = scratch("lethal-ts-cache-");
    const asDeps = (ids: readonly string[]) =>
      ids.map((id) => ({ id, name: "D", publisher: "MP", version: "1.0.0.0" }));
    await writeFile(
      join(project, "app.json"),
      JSON.stringify({ dependencies: asDeps(over.rootIds ?? [DIRECT_ID]) }),
    );
    let testsDir: string | undefined;
    if (over.testRootIds !== undefined) {
      testsDir = scratch("lethal-ts-tests-");
      await writeFile(
        join(testsDir, "app.json"),
        JSON.stringify({ dependencies: asDeps(over.testRootIds) }),
      );
    }
    for (const [name, bytes] of Object.entries(cache)) {
      await mkdir(dirname(join(cacheDir, name)), { recursive: true });
      await writeFile(join(cacheDir, name), bytes);
    }
    const { deps } = await buildDoctorDeps(
      {
        bcdev: {
          mcpCommand: ["bun", "mcp"],
          company: "CRONUS",
          controlSymbolPath: "C:/lethal-control.app",
          server: "https://host",
          serverInstance: "BC",
          username: "u",
          password: "p",
          packageCachePath: cacheDir,
        },
      },
      {
        ...(over.noProject ? {} : { projectDir: project }),
        ...(testsDir !== undefined ? { testsDir } : {}),
        alToolPaths: async () => ({ alcPath: "alc", altoolPath: "altool" }),
        installedVersions: over.installed ?? (async () => installed),
      },
    );
    const textSearchDependencies = deps.textSearchDependencies;
    if (textSearchDependencies === undefined) throw new Error("no textSearchDependencies probe");
    const report = await runDoctor({}, { textSearchDependencies });
    const c = report.checks.find((x) => x.name === "text-search-dependencies");
    if (c === undefined) throw new Error("no check");
    return c;
  }
  const directThenNeedy = plainPkg(DIRECT_ID, "D", {
    deps: [{ id: NEEDY_ID, version: "1.0.0.0" }],
  });

  test("a transitive package (a dependency of a dependency) IS found", async () => {
    const c = await run({ "d.app": directThenNeedy, "n.app": needy }, []);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Onboarding");
  });

  test("a leftover package outside the closure does NOT fail", async () => {
    const c = await run({ "d.app": plainPkg(DIRECT_ID, "D"), "n.app": needy }, []);
    expect(c.ok).toBe(true);
    expect(c.detail).not.toContain("Onboarding");
  });

  test("a dependency the cache lacks is ignored here", async () => {
    const c = await run({ "d.app": directThenNeedy }, []);
    expect(c.ok).toBe(true);
  });

  test("the test app's dependencies are roots only when --tests is given, and the detail says which", async () => {
    const without = await run({ "n.app": needy }, [], { rootIds: [] });
    expect(without.ok).toBe(true);
    expect(without.detail).toContain("target only");
    const withTests = await run({ "n.app": needy }, [], { rootIds: [], testRootIds: [NEEDY_ID] });
    expect(withTests.ok).toBe(false);
    expect(withTests.detail).toContain("the target and the test app");
  });

  test("the highest cached version of an id is the one scanned", async () => {
    const old = pkg(NEEDY_ID, "Onboarding", { Tables: [] }, { version: "1.0.0.0" });
    const newer = pkg(NEEDY_ID, "Onboarding", needySymbols, { version: "2.0.0.0" });
    let reads = 0;
    const c = await run({ "a.app": old, "b.app": newer }, [], {
      rootIds: [NEEDY_ID],
      installed: async () => {
        reads++;
        return [];
      },
    });
    expect(c.ok).toBe(false);
    expect(reads).toBe(1);
  });

  test("an installed version at or above the cached one passes, and claims nothing about SQL", async () => {
    const c = await run({ "n.app": needy }, ["1.0.0.0"], { rootIds: [NEEDY_ID] });
    expect(c.ok).toBe(true);
    expect(c.skipped).toBeUndefined();
    expect(c.detail).toContain("Onboarding");
    expect(c.detail).toContain("their install succeeded");
    expect(c.detail).not.toContain("SQL supports");
  });

  test("an installed version OLDER than the cached one fails and says an upgrade needs Full-Text Search", async () => {
    const newer = pkg(NEEDY_ID, "Onboarding", needySymbols, { version: "2.0.0.0" });
    const c = await run({ "n.app": newer }, ["1.5.0.0"], { rootIds: [NEEDY_ID] });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("1.5.0.0");
    expect(c.detail).toContain("upgrade to 2.0.0.0");
    expect(c.detail).toContain("Full-Text Search");
    // A newer installed version than cached is fine.
    expect((await run({ "n.app": newer }, ["2.0.0.1"], { rootIds: [NEEDY_ID] })).ok).toBe(true);
  });

  test("a found app that is not installed fails, naming app, table, field and Full-Text Search", async () => {
    const c = await run({ "n.app": needy }, [], { rootIds: [NEEDY_ID] });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Onboarding");
    expect(c.detail).toContain("KYC Company.Name");
    expect(c.detail).toContain("Full-Text Search");
  });

  test("a failed installed-versions read FAILS the check, naming the app", async () => {
    const c = await run({ "n.app": needy }, [], {
      rootIds: [NEEDY_ID],
      installed: async () => {
        throw new Error("boom");
      },
    });
    expect(c.ok).toBe(false);
    expect(c.skipped).toBeUndefined();
    expect(c.detail).toContain("cannot read the installed versions of Onboarding");
  });

  test("no package declares the property: ok, and the server is never asked", async () => {
    let reads = 0;
    const c = await run({ "p.app": plainPkg(DIRECT_ID, "D") }, [], {
      installed: async () => {
        reads++;
        return [];
      },
    });
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("no package");
    expect(reads).toBe(0);
  });

  test("without --project the check is skipped, by name", async () => {
    const c = await run({ "n.app": needy }, [], { noProject: true, rootIds: [NEEDY_ID] });
    expect(c.skipped).toBe(true);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("--project");
  });

  test("an unreadable file is named, and a clean-looking result says it is not fully read", async () => {
    const c = await run(
      { "d.app": plainPkg(DIRECT_ID, "D"), "broken.app": Buffer.from("junk") },
      [],
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("no readable package");
    expect(c.detail).toContain("broken.app");
  });

  test("a closure package with no SymbolReference.json is listed as no symbols", async () => {
    const c = await run({ "d.app": plainPkg(DIRECT_ID, "D", { noSymbols: true }) }, []);
    expect(c.detail).toContain("No symbols");
    expect(c.detail).toContain("D 1.0.0.0");
  });

  test("a package in a cache subfolder counts", async () => {
    const c = await run({ "deep/er/n.app": needy }, [], { rootIds: [NEEDY_ID] });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Onboarding");
  });
});
