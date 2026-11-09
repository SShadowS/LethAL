import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SelectorIdDependencyClashError } from "@lethal/schemata";
import { initFromCli, validateSelectorIdsForProject } from "../src/cli";
import { dependencyCodeunitsOf } from "../src/dependency-codeunits";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { scratchDirs } from "./helpers/scratch";

/**
 * R888: the app's own top free ids are 50199, 50198, 50197, and an invented dependency ("Invented
 * Base", Contoso) declares codeunit 50199. A second invented app ("Invented Deep") that Invented
 * Base depends on declares 50198: the transitive case.
 */
const scratch = scratchDirs();
const BASE_ID = "11111111-1111-1111-1111-111111111111";
const DEEP_ID = "22222222-2222-2222-2222-222222222222";

function fakePackage(opts: {
  id: string;
  name: string;
  version: string;
  codeunits: number[];
  dependsOn?: { id: string; name: string };
}): Buffer {
  const dep =
    opts.dependsOn === undefined
      ? ""
      : `<Dependencies><Dependency Id="${opts.dependsOn.id}" Name="${opts.dependsOn.name}" Publisher="Contoso" MinVersion="1.0.0.0" /></Dependencies>`;
  return buildFakeAppWithEntries({
    "NavxManifest.xml": `<Package><App Id="${opts.id}" Name="${opts.name}" Publisher="Contoso" Version="${opts.version}" />${dep}</Package>`,
    "SymbolReference.json": JSON.stringify({
      AppId: opts.id,
      Version: opts.version,
      Codeunits: opts.codeunits.map((Id) => ({ Id, Name: `Dep ${Id}` })),
    }),
  });
}

function project(withDependency: boolean): string {
  const dir = scratch("lethal-r888-");
  writeFileSync(
    join(dir, "app.json"),
    JSON.stringify({
      id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
      name: "Mine",
      idRanges: [{ from: 50000, to: 50199 }],
      dependencies: withDependency
        ? [{ id: BASE_ID, name: "Invented Base", publisher: "Contoso", version: "1.0.0.0" }]
        : [],
    }),
  );
  mkdirSync(join(dir, ".alpackages"));
  return dir;
}

function install(dir: string, file: string, pkg: Buffer): void {
  writeFileSync(join(dir, ".alpackages", file), pkg);
}

const IDS = { selectorId: 50199, controlId: 50198, tableId: 50197 };

describe("R888: dependency codeunits against the selector ids", () => {
  test("dependencyCodeunitsOf reads direct and transitive dependencies, with the app's identity", async () => {
    const dir = project(true);
    install(
      dir,
      "base.app",
      fakePackage({
        id: BASE_ID,
        name: "Invented Base",
        version: "3.1.0.0",
        codeunits: [50199],
        dependsOn: { id: DEEP_ID, name: "Invented Deep" },
      }),
    );
    install(
      dir,
      "deep.app",
      fakePackage({ id: DEEP_ID, name: "Invented Deep", version: "2.0.0.0", codeunits: [50198] }),
    );
    const manifest = JSON.parse(readFileSync(join(dir, "app.json"), "utf8"));
    const { codeunits, unread } = await dependencyCodeunitsOf(manifest, [join(dir, ".alpackages")]);
    expect(unread).toEqual([]);
    expect(codeunits.get(50199)?.app).toEqual({
      name: "Invented Base",
      publisher: "Contoso",
      version: "3.1.0.0",
    });
    expect(codeunits.get(50198)?.app.name).toBe("Invented Deep");
  });

  test("validateSelectorIdsForProject refuses 50199 naming the dependency", async () => {
    const dir = project(true);
    install(
      dir,
      "base.app",
      fakePackage({ id: BASE_ID, name: "Invented Base", version: "3.1.0.0", codeunits: [50199] }),
    );
    const err = await validateSelectorIdsForProject(dir, IDS, undefined, {
      packageDirs: [join(dir, ".alpackages")],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SelectorIdDependencyClashError);
    expect((err as Error).message).toMatch(
      /selectorId[\s\S]*50199[\s\S]*Invented Base[\s\S]*Contoso[\s\S]*3\.1\.0\.0/,
    );
  });

  test("a dependency that does not declare the ids changes nothing", async () => {
    const dir = project(true);
    install(
      dir,
      "base.app",
      fakePackage({ id: BASE_ID, name: "Invented Base", version: "3.1.0.0", codeunits: [50100] }),
    );
    const warnings: string[] = [];
    await validateSelectorIdsForProject(dir, IDS, undefined, {
      packageDirs: [join(dir, ".alpackages")],
      warn: (l) => warnings.push(l),
    });
    expect(warnings).toEqual([]);
  });

  test("lethal init picks around the dependency's 50199 (and a transitive 50198)", async () => {
    const dir = project(true);
    install(
      dir,
      "base.app",
      fakePackage({
        id: BASE_ID,
        name: "Invented Base",
        version: "3.1.0.0",
        codeunits: [50199],
        dependsOn: { id: DEEP_ID, name: "Invented Deep" },
      }),
    );
    install(
      dir,
      "deep.app",
      fakePackage({ id: DEEP_ID, name: "Invented Deep", version: "2.0.0.0", codeunits: [50198] }),
    );
    const out = join(dir, "init.json");
    expect(await initFromCli({ mode: "init", projectDir: dir, outPath: out })).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).selectorIds).toEqual({
      selectorId: 50197,
      controlId: 50196,
      tableId: 50195,
    });
  });

  test("an unreadable package warns by name, does not refuse, and does not claim a clash", async () => {
    const dir = project(true); // the package folder is empty: the dependency's package is missing
    const warnings: string[] = [];
    await validateSelectorIdsForProject(dir, IDS, undefined, {
      packageDirs: [join(dir, ".alpackages")],
      warn: (l) => warnings.push(l),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Invented Base");
    expect(warnings[0]).toContain("AL0264");
    expect(warnings[0]).toContain("NOT ruled out");
  });

  test("a garbled package is reported as unread, not as declaring nothing", async () => {
    const dir = project(true);
    install(dir, "base.app", buildFakeAppWithEntries({ "SymbolReference.json": "{ not json" }));
    const manifest = JSON.parse(readFileSync(join(dir, "app.json"), "utf8"));
    const { unread } = await dependencyCodeunitsOf(manifest, [join(dir, ".alpackages")]);
    expect(unread.length).toBeGreaterThan(0);
  });

  test("a project with no dependencies warns about nothing", async () => {
    const dir = project(false);
    const warnings: string[] = [];
    await validateSelectorIdsForProject(dir, IDS, undefined, { warn: (l) => warnings.push(l) });
    expect(warnings).toEqual([]);
  });
});
