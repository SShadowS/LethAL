import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPLICATION_APP_ID,
  type AppDependency,
  type AppInputs,
  DependencyUnreadableError,
  type MicrosoftMode,
  type PackageReader,
  appInputsOfAppJson,
  appInputsOfManifest,
  dependencyFingerprint,
  readAppJsonInputs,
  targetOf,
} from "../src/digest-inputs";
import { CONTROL_APP_ID } from "../src/harness";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const DEP = "22222222-2222-2222-2222-222222222222";
const SUB = "33333333-3333-3333-3333-333333333333";
const MS = "44444444-4444-4444-4444-444444444444";
const MS2 = "55555555-5555-5555-5555-555555555555";
const SYSTEM_ID = "8874ed3a-0643-4247-9ced-7a7002f7135d";
const TEST_RUNNER = "23de40a6-dfe8-4f80-80db-d70f83ce8caf";
const CONTROL_VERSION = "1.0.0.20";

const manifest = (id: string, name: string, publisher: string, deps = "", version = "1.0.0.0") =>
  `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${id}" Name="${name}" Publisher="${publisher}" Version="${version}" /><Dependencies>${deps}</Dependencies></Package>`;
const depTag = (id: string, name: string, publisher: string) =>
  `<Dependency Id="${id}" Name="${name}" Publisher="${publisher}" MinVersion="1.0.0.0" />`;
/** A package of app `id`, whose bytes differ by `build` at an unchanged version. */
const pkg = (
  id: string,
  name: string,
  publisher: string,
  build: string,
  deps = "",
  version = "1.0.0.0",
) =>
  new Uint8Array(
    buildFakeAppWithEntries({
      "NavxManifest.xml": manifest(id, name, publisher, deps, version),
      "src/X.al": `// build ${build}`,
    }),
  );

const root = (publisher: string, id = DEP) =>
  appInputsOfAppJson({ dependencies: [{ id, name: "Dep", publisher, version: "1.0.0.0" }] });

const DECLARED: MicrosoftMode = { kind: "declared" };

interface BytesOpts {
  system?: Uint8Array | null | undefined;
  control?: Uint8Array | null | undefined;
  controlVersion?: string;
  installed?: (id: string) => Promise<readonly string[]>;
}
const controlWith = (deps: string, version = CONTROL_VERSION, id = CONTROL_APP_ID) =>
  pkg(id, "LethAL Control", "LethAL", "c", deps, version);
/** A bytes mode whose server holds `System` (build "s"), a control app with no dependency, and
 *  every Microsoft app installed at 1.0.0.0. `asked` records each installed-check id. */
function bytes(o: BytesOpts = {}): MicrosoftMode & { kind: "bytes"; asked: string[] } {
  const asked: string[] = [];
  const system = "system" in o ? o.system : pkg(SYSTEM_ID, "System", "Microsoft", "s");
  const control = "control" in o ? o.control : controlWith("");
  return {
    kind: "bytes",
    asked,
    readSystem: async () => system,
    readControl: async () => control,
    controlVersion: async () => o.controlVersion ?? CONTROL_VERSION,
    installed: async (id) => {
      asked.push(id);
      return o.installed !== undefined ? o.installed(id) : ["1.0.0.0"];
    },
  };
}

describe("R-371: digest-inputs", () => {
  test("a manifest and the app.json it was built from give equal build inputs", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${DEP}" Name="T" Publisher="P" Version="1.0.0.0" Runtime="16.0" Target="Cloud" Application="27.0.0.0" Platform="27.0.0.0" /><Features><Feature>NOIMPLICITWITH</Feature><Feature>TRANSLATIONFILE</Feature></Features><PreprocessorSymbols><PreprocessorSymbol>CLEAN</PreprocessorSymbol></PreprocessorSymbols></Package>`;
    const json = {
      runtime: "16.0",
      application: "27.0.0.0",
      platform: "27.0.0.0",
      features: ["TranslationFile", "NoImplicitWith"],
      preprocessorSymbols: ["CLEAN"],
    };
    expect(appInputsOfManifest(xml).buildInputs).toBe(appInputsOfAppJson(json).buildInputs);
    // And it is not equal by being empty: another symbol set differs.
    expect(appInputsOfManifest(xml).buildInputs).not.toBe(
      appInputsOfAppJson({ ...json, preprocessorSymbols: [] }).buildInputs,
    );
  });

  test("a non-Microsoft dependency rebuilt at an UNCHANGED version changes the fingerprint", async () => {
    const at = (build: string) =>
      dependencyFingerprint(root("Other"), async () => [pkg(DEP, "Dep", "Other", build)], bytes());
    expect(await at("one")).not.toBe(await at("two"));
    expect(await at("one")).toBe(await at("one"));
  });

  test("a transitive non-Microsoft dependency is read too", async () => {
    const at = (build: string) =>
      dependencyFingerprint(
        root("Other"),
        async (d: AppDependency) =>
          d.id === DEP
            ? [pkg(DEP, "Dep", "Other", "same", depTag(SUB, "Sub", "Other"))]
            : [pkg(SUB, "Sub", "Other", build)],
        bytes(),
      );
    expect(await at("one")).not.toBe(await at("two"));
  });

  // Review r1 #4: a test project's app.json that cannot be read is never read as empty inputs.
  test("a missing or unparseable test-project app.json throws, never empty inputs", async () => {
    const missing = scratch("lethal-appjson-missing-");
    await expect(readAppJsonInputs(missing)).rejects.toBeInstanceOf(DependencyUnreadableError);
    const broken = scratch("lethal-appjson-broken-");
    writeFileSync(join(broken, "app.json"), '{"name": "T", ');
    await expect(readAppJsonInputs(broken)).rejects.toBeInstanceOf(DependencyUnreadableError);
    const ok = scratch("lethal-appjson-ok-");
    writeFileSync(join(ok, "app.json"), '{"runtime": "16.0"}');
    expect((await readAppJsonInputs(ok)).buildInputs).toBe(
      appInputsOfAppJson({ runtime: "16.0" }).buildInputs,
    );
  });

  test("R205: targetOf reads app.json from the snapshot, and a snapshot without one never reads the disk", async () => {
    const dir = scratch("lethal-targetof-");
    writeFileSync(join(dir, "app.json"), `{"id": "${DEP}"}`);
    const pinned = new Map([["app.json", Buffer.from(`{"id": "${SUB}"}`)]]);
    expect((await targetOf(dir, pinned)).id).toBe(SUB);
    await expect(targetOf(dir, new Map())).rejects.toBeInstanceOf(DependencyUnreadableError);
  });

  test("an unreadable non-Microsoft dependency throws, never a partial fingerprint", async () => {
    await expect(
      dependencyFingerprint(root("Other"), async () => null, bytes()),
    ).rejects.toBeInstanceOf(DependencyUnreadableError);
  });
});

/** Expects `DependencyUnreadableError` whose message names `app`. */
async function refusesNaming(p: Promise<unknown>, app: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DependencyUnreadableError);
  expect((caught as Error).message).toContain(app);
}

describe("R-385: Microsoft dependencies by the bytes the server holds", () => {
  const msRead =
    (build: string, version = "1.0.0.0"): PackageReader =>
    async (d) =>
      d.id === MS ? [pkg(MS, "Lib", "Microsoft", build, "", version)] : null;

  test("upgrade seen: a Microsoft dependency moving 28.0.1.0 -> 28.0.2.0 (declared 28.0.0.0 fixed) changes it", async () => {
    const declared = appInputsOfAppJson({
      dependencies: [{ id: MS, name: "Lib", publisher: "Microsoft", version: "28.0.0.0" }],
    });
    const at = (v: string) =>
      dependencyFingerprint(declared, msRead("same", v), bytes({ installed: async () => [v] }));
    expect(await at("28.0.1.0")).not.toBe(await at("28.0.2.0"));
  });

  test("a same-version rebuild of a Microsoft dependency changes it", async () => {
    const m = bytes();
    const a = await dependencyFingerprint(root("Microsoft", MS), msRead("one"), m);
    const b = await dependencyFingerprint(root("Microsoft", MS), msRead("two"), m);
    expect(a).not.toBe(b);
    expect(m.asked).toEqual([MS, MS]);
  });

  test("a Microsoft app reached only through another is read and changes it", async () => {
    const at = (build: string) =>
      dependencyFingerprint(
        root("Other"),
        async (d) =>
          d.id === DEP
            ? [pkg(DEP, "Dep", "Other", "same", depTag(MS, "Lib", "Microsoft"))]
            : d.id === MS
              ? [pkg(MS, "Lib", "Microsoft", build)]
              : null,
        bytes(),
      );
    expect(await at("one")).not.toBe(await at("two"));
  });

  test("System's bytes are hashed: a platform rebuild changes it, even with no Microsoft dependency", async () => {
    const at = (build: string) =>
      dependencyFingerprint(
        root("Other"),
        async () => [pkg(DEP, "Dep", "Other", "same")],
        bytes({ system: pkg(SYSTEM_ID, "System", "Microsoft", build) }),
      );
    expect(await at("one")).not.toBe(await at("two"));
  });

  test("Test Runner, reached only through the served control app, is hashed and checked", async () => {
    const tr = depTag(TEST_RUNNER, "Test Runner", "Microsoft");
    let m = bytes();
    const at = async (build: string) => {
      m = bytes({ control: controlWith(tr) });
      return dependencyFingerprint(
        appInputsOfAppJson({}),
        async (d) =>
          d.id === TEST_RUNNER ? [pkg(TEST_RUNNER, "Test Runner", "Microsoft", build)] : null,
        m,
      );
    };
    expect(await at("one")).not.toBe(await at("two"));
    expect(m.asked).toEqual([TEST_RUNNER]);
  });

  test("an `application` property walks Application by its GUID and checks it", async () => {
    const m = bytes();
    const read =
      (build: string): PackageReader =>
      async (d) =>
        d.id === APPLICATION_APP_ID
          ? [pkg(APPLICATION_APP_ID, "Application", "Microsoft", build)]
          : null;
    const app = appInputsOfAppJson({ application: "28.0.0.0" });
    const a = await dependencyFingerprint(app, read("one"), m);
    expect(m.asked).toEqual([APPLICATION_APP_ID]);
    expect(a).not.toBe(await dependencyFingerprint(app, read("two"), bytes()));
  });

  test("stability: the same packages with the dependencies in another order give the same fingerprint", async () => {
    const deps = [
      { id: MS, name: "Lib", publisher: "Microsoft", version: "1.0.0.0" },
      { id: MS2, name: "Lib2", publisher: "Microsoft", version: "1.0.0.0" },
      { id: DEP, name: "Dep", publisher: "Other", version: "1.0.0.0" },
    ];
    const read: PackageReader = async (d) => [pkg(d.id, d.name, d.publisher, "same")];
    const a = await dependencyFingerprint(
      appInputsOfAppJson({ dependencies: deps }),
      read,
      bytes(),
    );
    const b = await dependencyFingerprint(
      appInputsOfAppJson({ dependencies: [...deps].reverse() }),
      read,
      bytes(),
    );
    expect(a).toBe(b);
  });

  // Review r1 #1: the "nothing changed" direction on the Application and Test Runner paths. Every
  // read hands back FRESH buffers, so only equal content can make two fingerprints equal.
  test("stability: an `application` root (Application -> Base App) gives the same fingerprint twice", async () => {
    const read: PackageReader = async (d) =>
      d.id === APPLICATION_APP_ID
        ? [
            pkg(
              APPLICATION_APP_ID,
              "Application",
              "Microsoft",
              "same",
              depTag(MS, "Base", "Microsoft"),
            ),
          ]
        : d.id === MS
          ? [pkg(MS, "Base", "Microsoft", "same")]
          : null;
    const app = appInputsOfAppJson({ application: "28.0.0.0" });
    const a = await dependencyFingerprint(app, read, bytes());
    const b = await dependencyFingerprint(app, read, bytes());
    expect(a).toBe(b);
  });

  test("stability: a control app depending on Test Runner gives the same fingerprint twice", async () => {
    const tr = depTag(TEST_RUNNER, "Test Runner", "Microsoft");
    const read: PackageReader = async (d) =>
      d.id === TEST_RUNNER ? [pkg(TEST_RUNNER, "Test Runner", "Microsoft", "same")] : null;
    const at = () =>
      dependencyFingerprint(appInputsOfAppJson({}), read, bytes({ control: controlWith(tr) }));
    expect(await at()).toBe(await at());
  });

  test("Base Application reached through Application (a Microsoft app) is hashed: its bytes move it", async () => {
    const at = (build: string) =>
      dependencyFingerprint(
        appInputsOfAppJson({ application: "28.0.0.0" }),
        async (d) =>
          d.id === APPLICATION_APP_ID
            ? [
                pkg(
                  APPLICATION_APP_ID,
                  "Application",
                  "Microsoft",
                  "same",
                  depTag(MS, "Base", "Microsoft"),
                ),
              ]
            : d.id === MS
              ? [pkg(MS, "Base", "Microsoft", build)]
              : null,
        bytes(),
      );
    expect(await at("one")).not.toBe(await at("two"));
  });

  test("declared mode never equals bytes mode on the same inputs, and reads no Microsoft package", async () => {
    let reads = 0;
    const read: PackageReader = async (d) => {
      reads += 1;
      return d.id === MS ? [pkg(MS, "Lib", "Microsoft", "x")] : null;
    };
    const declared = await dependencyFingerprint(root("Microsoft", MS), read, DECLARED);
    expect(reads).toBe(0);
    expect(declared).not.toBe(await dependencyFingerprint(root("Microsoft", MS), read, bytes()));
  });

  describe("fail-closed: refuses by name", () => {
    const ms = appInputsOfAppJson({
      dependencies: [{ id: MS, name: "Lib", publisher: "Microsoft", version: "1.0.0.0" }],
    });
    const ok = msRead("x");
    const fp = (m: MicrosoftMode, read: PackageReader = ok, r: AppInputs = ms) =>
      dependencyFingerprint(r, read, m);

    test("a Microsoft package that reads null", async () => {
      await refusesNaming(
        fp(bytes(), async () => null),
        "Lib",
      );
    });
    test("System reads null or undefined or empty", async () => {
      await refusesNaming(fp(bytes({ system: null })), "System");
      await refusesNaming(fp(bytes({ system: undefined })), "System");
      await refusesNaming(fp(bytes({ system: new Uint8Array() })), "System");
    });
    test("System's manifest is not Microsoft/System", async () => {
      await refusesNaming(
        fp(bytes({ system: pkg(SYSTEM_ID, "Base", "Microsoft", "s") })),
        "System",
      );
      await refusesNaming(fp(bytes({ system: pkg(SYSTEM_ID, "System", "Other", "s") })), "System");
    });
    test("no installed row", async () => {
      await refusesNaming(fp(bytes({ installed: async () => [] })), "Lib");
    });
    test("two installed rows", async () => {
      await refusesNaming(fp(bytes({ installed: async () => ["1.0.0.0", "1.0.0.0"] })), "Lib");
    });
    test("the installed version differs from the hashed manifest's (both versions named)", async () => {
      await refusesNaming(fp(bytes({ installed: async () => ["1.0.0.1"] })), "1.0.0.1");
      await refusesNaming(fp(bytes({ installed: async () => ["1.0.0.1"] })), "Lib");
    });
    test("the installed check accepts exactly one row at the manifest's version", async () => {
      expect(await fp(bytes({ installed: async () => ["1.0.0.0"] }))).toMatch(/^[0-9a-f]{64}$/);
    });
    test("the per-id read throws", async () => {
      await refusesNaming(
        fp(
          bytes({
            installed: async () => {
              throw new Error("HTTP 500");
            },
          }),
        ),
        "Lib",
      );
    });
    test("Application served with another Id", async () => {
      await refusesNaming(
        fp(
          bytes(),
          async () => [pkg(MS, "Application", "Microsoft", "x")],
          appInputsOfAppJson({ application: "28.0.0.0" }),
        ),
        "Application",
      );
    });
    test("the control app reads null", async () => {
      await refusesNaming(fp(bytes({ control: null })), "LethAL Control");
    });
    test("the control app's Id is not CONTROL_APP_ID", async () => {
      await refusesNaming(
        fp(bytes({ control: controlWith("", CONTROL_VERSION, DEP) })),
        "LethAL Control",
      );
    });
    test("the served control app's Version differs from the running one (both named)", async () => {
      await refusesNaming(fp(bytes({ control: controlWith("", "1.0.0.19") })), "1.0.0.19");
      await refusesNaming(fp(bytes({ controlVersion: "1.0.0.21" })), "1.0.0.21");
    });
  });
});
