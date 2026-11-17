// PR-128 (R1110): `lethal doctor` warns when a package in the cache needs SQL Server Full-Text Search
// and that app is not installed on the server.
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

const manifest = (id: string, name: string, version: string) =>
  `<Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${id}" Name="${name}" Publisher="MP" Version="${version}"/></Package>`;
const field = (name: string, props: object[] = []) => ({ Id: 1, Name: name, Properties: props });
const textOn = { Name: "OptimizeForTextSearch", Value: "1" };
const pkg = (id: string, name: string, symbols: unknown) =>
  buildFakeAppWithEntries({
    "NavxManifest.xml": manifest(id, name, "1.0.0.0"),
    "SymbolReference.json": JSON.stringify(symbols),
  });
const needy = pkg(NEEDY_ID, "Onboarding", {
  Tables: [{ Id: 5, Name: "KYC Company", Fields: [field("Name", [textOn]), field("City")] }],
});
const plainPkg = (id: string, name: string) =>
  pkg(id, name, { Tables: [{ Id: 5, Name: "T", Fields: [field("Name")] }] });

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

  test("the note names the app, table, field and Full-Text Search", () => {
    const app = textSearchApp(needy);
    if (app === undefined) throw new Error("expected an app");
    const note = textSearchNote(app);
    expect(note).toContain("MP Onboarding");
    expect(note).toContain("KYC Company.Name");
    expect(note).toContain("Full-Text Search");
  });
});

describe("text-search-dependencies check", () => {
  async function run(
    cache: Record<string, Buffer>,
    installed: readonly string[],
    over: { noProject?: boolean } = {},
  ) {
    const project = scratch("lethal-ts-proj-");
    const cacheDir = scratch("lethal-ts-cache-");
    // The target depends on DIRECT_ID only: the needy package is NOT a direct dependency.
    await writeFile(
      join(project, "app.json"),
      JSON.stringify({
        dependencies: [{ id: DIRECT_ID, name: "D", publisher: "MP", version: "1.0.0.0" }],
      }),
    );
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
        alToolPaths: async () => ({ alcPath: "alc", altoolPath: "altool" }),
        installedVersions: async () => installed,
      },
    );
    const textSearchDependencies = deps.textSearchDependencies;
    if (textSearchDependencies === undefined) throw new Error("no textSearchDependencies probe");
    const report = await runDoctor({}, { textSearchDependencies });
    const c = report.checks.find((x) => x.name === "text-search-dependencies");
    if (c === undefined) throw new Error("no check");
    return c;
  }

  test("scans non-direct packages too: a needy app beside the direct dependency is found", async () => {
    const c = await run({ "a-direct.app": plainPkg(DIRECT_ID, "D"), "z-needy.app": needy }, []);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Onboarding");
  });

  test("a found app that is installed passes and is named", async () => {
    const c = await run({ "n.app": needy }, ["1.0.0.0"]);
    expect(c.ok).toBe(true);
    expect(c.skipped).toBeUndefined();
    expect(c.detail).toContain("Onboarding");
  });

  test("a found app that is not installed fails, naming app, table, field and Full-Text Search", async () => {
    const c = await run({ "n.app": needy }, []);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Onboarding");
    expect(c.detail).toContain("KYC Company.Name");
    expect(c.detail).toContain("Full-Text Search");
  });

  test("no package declares the property: ok, and nothing is read on the server", async () => {
    const c = await run({ "p.app": plainPkg(DIRECT_ID, "D") }, []);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("no package");
  });

  test("without --project the check is skipped, by name", async () => {
    const c = await run({ "n.app": needy }, [], { noProject: true });
    expect(c.skipped).toBe(true);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("--project");
  });

  test("an unreadable file is named", async () => {
    const c = await run({ "n.app": needy, "broken.app": Buffer.from("not a package") }, []);
    expect(c.detail).toContain("broken.app");
  });
});
