import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { UpgradeClashRefusedError } from "../src/app-version";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  PackageUnread,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { InstalledDependent } from "../src/harness";
import { ObjectClashError } from "../src/object-clash";
import { runSession } from "../src/orchestrator";
import { ResultsStore } from "../src/store";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { TEST_APP, servedIsInstalled, testAppJson } from "./helpers/proven-test-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

/**
 * R843: a target that declares an object an INSTALLED dependent declares is refused by name before
 * anything is published. Every test drives the real `runSession` with a stateful fake backend; the
 * proof that nothing was published is `deploys` (a call counter), never timing.
 */

const TARGET_ID = "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a91";
const APP_JSON = JSON.stringify({
  id: TARGET_ID,
  name: "R843 Target",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79299 }],
});

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;

const TESTS_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;
}
`;

const NS = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';

/** The tests app as the server holds it: a manifest, and a SymbolReference.json with the test
 *  codeunit (so the compiled membership equals the source suite) plus whatever else is declared. */
function residentTestsApp(extra: Record<string, unknown[]> = {}, version = "1.0.0.0"): Uint8Array {
  const own = {
    Id: 79100,
    Name: "Sandbox Tests",
    Properties: [{ Name: "Subtype", Value: "Test" }],
    Methods: [{ Id: 1, Name: "OverBudgetDetected", Attributes: [{ Name: "Test" }] }],
  };
  // The top level a real alc build carries: the app it belongs to, and its version.
  const symbols: Record<string, unknown> = { AppId: TEST_APP.id, Version: version, ...extra };
  symbols.Codeunits = [own, ...(extra.Codeunits ?? [])];
  return new Uint8Array(
    buildFakeAppWithEntries({
      "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package ${NS}><App Id="${TEST_APP.id}" Name="${TEST_APP.name}" Publisher="${TEST_APP.publisher}" Version="1.0.0.0" /></Package>`,
      "SymbolReference.json": JSON.stringify(symbols),
    }),
  );
}

function otherApp(extra: Record<string, unknown[]>): Uint8Array {
  return new Uint8Array(
    buildFakeAppWithEntries({
      "SymbolReference.json": JSON.stringify({
        AppId: "9f3c2b1a-0000-4000-8000-000000000001",
        Version: "2.3.4.5",
        ...extra,
      }),
    }),
  );
}

const TESTS_DEP: InstalledDependent = {
  id: TEST_APP.id,
  name: TEST_APP.name,
  publisher: TEST_APP.publisher,
  version: "1.0.0.0",
};
const OTHER_DEP: InstalledDependent = {
  id: "9f3c2b1a-0000-4000-8000-000000000001",
  name: "Other App",
  publisher: "Elsewhere",
  version: "2.3.4.5",
};

type PackageRead = Uint8Array | PackageUnread;

class ClashBackend implements ExecutionBackend {
  deploys = 0;
  dependentReads = 0;
  fetched: string[] = [];
  private activations: Array<string | null> = [];
  installedDependents?: (appId: string) => Promise<readonly InstalledDependent[]>;
  /** R847: set by a test through `Setup.configure`; absent on a backend that is not bcdev. */
  installedVersions?: (appId: string) => Promise<readonly string[]>;
  objectOwners?: NonNullable<ExecutionBackend["objectOwners"]>;
  fieldOwners?: NonNullable<ExecutionBackend["fieldOwners"]>;
  readonly fetchPublishedAppPackage = async (app: {
    publisher: string;
    name: string;
  }): Promise<PackageRead> => {
    this.fetched.push(app.name);
    return this.packages.get(app.name) ?? { unread: "not installed" };
  };
  readonly microsoftMode = () => servedIsInstalled(() => residentTestsApp());
  /** Only a v3 session asks for it (R586). */
  readonly runnerBuild = async () => ({
    version: "al-runner 3.0.0 (r843 fake)",
    binarySha256: "0".repeat(64),
  });

  constructor(
    private readonly kind: BackendCapabilities["kind"],
    dependents: readonly InstalledDependent[] | "absent" | "throws",
    private readonly packages: ReadonlyMap<string, PackageRead>,
    /** R845: when set, the apps that depend on each app id (lower case), asked for by id. */
    byParent?: Readonly<Record<string, readonly InstalledDependent[] | Error>>,
  ) {
    if (dependents !== "absent") {
      this.installedDependents = async (appId: string) => {
        this.dependentReads++;
        this.readIds.push(appId.toLowerCase());
        if (dependents === "throws") throw new Error("control app unreachable");
        if (byParent !== undefined) {
          const got = byParent[appId.toLowerCase()] ?? [];
          if (got instanceof Error) throw got;
          return got;
        }
        return dependents;
      };
    }
  }
  /** R845: every app id `installedDependents` was asked about, in order. */
  readIds: string[] = [];

  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      kind: this.kind,
      authoritative: this.kind === "bcdev",
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "r843" };
  }
  /** R845: when set, every deploy throws this message after counting itself. */
  deployError: string | undefined;
  async deploy(): Promise<null> {
    this.deploys++;
    if (this.deployError !== undefined) throw new Error(this.deployError);
    return null;
  }
  async compileCheck(): Promise<void> {}
  async compilePlainCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
            },
          }
        : {}),
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}
const ids = { selectorId: 79290, controlId: 79291, tableId: 79292 };

interface Setup {
  readonly kind?: BackendCapabilities["kind"];
  readonly dependents?: readonly InstalledDependent[] | "absent" | "throws";
  readonly packages?: ReadonlyMap<string, PackageRead>;
  /** Extra target files, by name. */
  readonly targetFiles?: Record<string, string>;
  readonly testsAl?: string;
  readonly selectorIds?: typeof ids;
  readonly preprocessorSymbols?: readonly string[];
  /** R845: dependents of each app id (lower case); the key of the target is `TARGET_ID`. */
  readonly byParent?: Readonly<Record<string, readonly InstalledDependent[] | Error>>;
  /** R845: the target's app.json text, to give it `dependencies`. */
  readonly appJson?: string;
  /** R845: the publish fails with this text (a U3 refusal). */
  readonly deployError?: string;
  /** R847: gives the backend its keyed reads of the server. */
  readonly configure?: (b: ClashBackend) => void;
}

async function drive(s: Setup) {
  const root = scratch("lethal-r843-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  for (const [name, text] of Object.entries(s.targetFiles ?? {})) {
    await Bun.write(join(projectDir, name), text);
  }
  await Bun.write(join(projectDir, "app.json"), s.appJson ?? APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), s.testsAl ?? TESTS_AL);
  await Bun.write(join(testDir, "app.json"), testAppJson());
  const backend = new ClashBackend(
    s.kind ?? "bcdev",
    s.dependents ?? [TESTS_DEP],
    s.packages ?? new Map([[TEST_APP.name, residentTestsApp()]]),
    s.byParent,
  );
  backend.deployError = s.deployError;
  s.configure?.(backend);
  const warnings: Array<{ code: string; message: string }> = [];
  const store = new ResultsStore(":memory:");
  const outcome = await runSession({
    backend,
    store,
    projectDir,
    testDir,
    instrumentedDir: join(root, "instr"),
    selectorIds: s.selectorIds ?? ids,
    ...(s.preprocessorSymbols !== undefined ? { preprocessorSymbols: s.preprocessorSymbols } : {}),
    emit: [
      (e: { type: string; code?: string; message?: string }) => {
        if (e.type === "warning") warnings.push({ code: e.code ?? "", message: e.message ?? "" });
      },
    ],
  } as never).then(
    (report) => ({ report }),
    (error: unknown) => ({ error }),
  );
  store.close();
  return { backend, warnings, ...outcome };
}

function refused(r: Awaited<ReturnType<typeof drive>>): ObjectClashError {
  expect("error" in r).toBe(true);
  const e = "error" in r ? r.error : undefined;
  expect(e).toBeInstanceOf(ObjectClashError);
  return e as ObjectClashError;
}

describe("R843: refused before the target is published", () => {
  test("a resident tests app declares the target's codeunit id, its source is clean", async () => {
    // The installed tests app was built against an OLDER target that held no such codeunit; the
    // source in the tests dir declares only 79100. Source against source would miss this.
    const r = await drive({
      packages: new Map([
        [TEST_APP.name, residentTestsApp({ Codeunits: [{ Id: 79000, Name: "Old Helper" }] })],
      ]),
    });
    const e = refused(r);
    expect(r.backend.deploys).toBe(0);
    expect(e.findings).toHaveLength(1);
    const [f] = e.findings;
    expect(f?.kind).toBe("Codeunit");
    expect(f?.id).toBe(79000);
    expect(f?.app.name).toBe("Sandbox Tests");
    expect(f?.read).toBe("installed-package");
    expect(f?.target.name).toBe("Sandbox Logic");
    expect(f?.other.name).toBe("Old Helper");
    expect(e.message).toContain("defined in multiple apps");
    expect(e.message).toContain("Sandbox Tests 1.0.0.0");
  });

  test("a dependent other than the tests app is compared too", async () => {
    const r = await drive({
      dependents: [TESTS_DEP, OTHER_DEP],
      packages: new Map([
        [TEST_APP.name, residentTestsApp()],
        ["Other App", otherApp({ Codeunits: [{ Id: 79000, Name: "Theirs" }] })],
      ]),
    });
    const e = refused(r);
    expect(r.backend.deploys).toBe(0);
    expect(e.findings.map((f) => f.app.name)).toEqual(["Other App"]);
    expect(e.findings[0]?.app.version).toBe("2.3.4.5");
  });

  test("tableId is a CODEUNIT: a test codeunit with that id refuses, a test TABLE with that id passes", async () => {
    const withCodeunit = await drive({
      selectorIds: { ...ids, tableId: 79555 },
      packages: new Map([
        [TEST_APP.name, residentTestsApp({ Codeunits: [{ Id: 79555, Name: "Clash" }] })],
      ]),
    });
    const e = refused(withCodeunit);
    expect(withCodeunit.backend.deploys).toBe(0);
    expect(e.findings[0]?.target.name).toBe("Mutation Upgrade");
    expect(e.findings[0]?.target.where).toContain("tableId");

    const withTable = await drive({
      selectorIds: { ...ids, tableId: 79555 },
      packages: new Map([
        [TEST_APP.name, residentTestsApp({ Tables: [{ Id: 79555, Name: "T" }] })],
      ]),
    });
    expect("report" in withTable).toBe(true);
    expect(withTable.backend.deploys).toBeGreaterThan(0);
  });

  test("selectorId and controlId are checked too", async () => {
    for (const key of ["selectorId", "controlId"] as const) {
      const r = await drive({
        selectorIds: { ...ids, [key]: 79556 },
        packages: new Map([
          [TEST_APP.name, residentTestsApp({ Codeunits: [{ Id: 79556, Name: "Clash" }] })],
        ]),
      });
      refused(r);
      expect(r.backend.deploys).toBe(0);
    }
  });

  test("Enum and PermissionSet kinds refuse", async () => {
    const enumRun = await drive({
      targetFiles: { "E.Enum.al": 'enum 79300 "Sandbox Enum"\n{\n    value(0; A) { }\n}\n' },
      packages: new Map([
        [TEST_APP.name, residentTestsApp({ EnumTypes: [{ Id: 79300, Name: "E" }] })],
      ]),
    });
    expect(refused(enumRun).findings[0]?.kind).toBe("Enum");
    expect(enumRun.backend.deploys).toBe(0);

    const psRun = await drive({
      targetFiles: {
        "PS.PermissionSet.al": 'permissionset 79301 "Sandbox PS"\n{\n    Assignable = true;\n}\n',
      },
      packages: new Map([
        [TEST_APP.name, residentTestsApp({ PermissionSets: [{ Id: 79301, Name: "P" }] })],
      ]),
    });
    expect(refused(psRun).findings[0]?.kind).toBe("PermissionSet");
    expect(psRun.backend.deploys).toBe(0);
  });

  test("a split-header object is counted, not dropped", async () => {
    const r = await drive({
      preprocessorSymbols: ["SPLITX"],
      targetFiles: {
        "Split.Codeunit.al":
          '#if SPLITX\ncodeunit 79302 "Split A"\n#else\ncodeunit 79303 "Split B"\n#endif\n{\n}\n',
      },
      packages: new Map([
        [TEST_APP.name, residentTestsApp({ Codeunits: [{ Id: 79302, Name: "Theirs" }] })],
      ]),
    });
    expect(refused(r).findings[0]?.id).toBe(79302);
    expect(r.backend.deploys).toBe(0);
  });

  test("an unreadable package falls back to the tests app's SOURCE and names the symbols", async () => {
    const r = await drive({
      packages: new Map<string, PackageRead>([[TEST_APP.name, { unread: "HTTP 404" }]]),
      testsAl: `${TESTS_AL}\ncodeunit 79000 "Source Clash"\n{\n}\n`,
      preprocessorSymbols: ["FROMCONFIG"],
    });
    const e = refused(r);
    expect(r.backend.deploys).toBe(0);
    expect(e.findings[0]?.read).toBe("source-fallback");
    expect(e.findings[0]?.symbols).toEqual(["FROMCONFIG"]);
    expect(e.message).toContain("SOURCE under symbols [FROMCONFIG]");
  });
});

describe("R845: fields, enum values and transitive dependents, refused before any publish", () => {
  const TARGET_BARE = TARGET_ID.replaceAll("-", "");
  const TABLE_AL =
    'table 79310 "Sandbox Table"\n{\n    fields\n    {\n        field(1; Code; Code[10]) { }\n        field(5; Qty; Integer) { }\n    }\n}\n';
  const ENUM_AL =
    'enum 79311 "Sandbox Enum"\n{\n    Extensible = true;\n    value(0; Zero) { }\n    value(7; Seven) { }\n}\n';
  const testsExtending = (extra: Record<string, unknown[]>) =>
    new Map([[TEST_APP.name, residentTestsApp(extra)]]);

  test("U1: the tests app's extension holds a field id the target's table now has", async () => {
    const r = await drive({
      targetFiles: { "T.Table.al": TABLE_AL },
      packages: testsExtending({
        TableExtensions: [
          {
            Id: 79100,
            Name: "Tests Ext",
            TargetObject: `#${TARGET_BARE}#Sandbox Table`,
            Fields: [{ Id: 5, Name: "TestsField" }],
          },
        ],
      }),
    });
    const e = refused(r);
    expect(r.backend.deploys).toBe(0);
    expect(e.findings).toEqual([]);
    expect(e.memberFindings).toHaveLength(1);
    expect(e.memberFindings[0]).toMatchObject({
      rule: "field-id",
      ownerName: "Sandbox Table",
      app: { name: "Sandbox Tests" },
      read: "installed-package",
    });
  });

  test("L4: the tests app's enum extension holds a value name the target's enum now has", async () => {
    const r = await drive({
      targetFiles: { "E.Enum.al": ENUM_AL },
      packages: testsExtending({
        EnumExtensionTypes: [
          {
            Id: 79101,
            Name: "Tests Enum Ext",
            TargetObject: `#${TARGET_BARE}#Sandbox Enum`,
            Values: [{ Ordinal: 99, Name: "Seven" }],
          },
        ],
      }),
    });
    const e = refused(r);
    expect(r.backend.deploys).toBe(0);
    expect(e.memberFindings.map((f) => [f.rule, f.container])).toEqual([
      ["enum-value-name", "Enum"],
    ]);
  });

  test("U4: an app that depends on the tests app clashes: refused, and the walk asked for the tests app's dependents", async () => {
    const r = await drive({
      dependents: [TESTS_DEP],
      byParent: { [TARGET_ID]: [TESTS_DEP], [TEST_APP.id.toLowerCase()]: [OTHER_DEP] },
      packages: new Map([
        [TEST_APP.name, residentTestsApp()],
        ["Other App", otherApp({ Codeunits: [{ Id: 79000, Name: "Theirs" }] })],
      ]),
    });
    const e = refused(r);
    expect(r.backend.deploys).toBe(0);
    expect(e.findings.map((f) => f.app.name)).toEqual(["Other App"]);
    expect(r.backend.readIds).toEqual([
      TARGET_ID,
      TEST_APP.id.toLowerCase(),
      OTHER_DEP.id.toLowerCase(),
    ]);
    // R727's warning names the transitive dependent too.
    const w = r.warnings.find((x) => x.code === "installed-dependents");
    expect(w?.message).toContain("Other App");
    expect(w?.message).toContain("[transitive]");
  });

  test("L3e: a third app's table counts only if the target's app.json depends on that app", async () => {
    const third = "5e51037273b74af1841e42184d5d7479";
    const thirdId = "5e510372-73b7-4af1-841e-42184d5d7479";
    const targetFiles = {
      "X.Table.al":
        'tableextension 79320 "Sandbox TE" extends "Third Table"\n{\n    fields\n    {\n        field(5; Mine; Integer) { }\n    }\n}\n',
    };
    const packages = testsExtending({
      TableExtensions: [
        {
          Id: 79102,
          Name: "Tests Ext",
          TargetObject: `#${third}#Third Table`,
          Fields: [{ Id: 5, Name: "TestsField" }],
        },
      ],
    });
    const withDep = await drive({
      targetFiles,
      packages,
      appJson: JSON.stringify({ ...JSON.parse(APP_JSON), dependencies: [{ id: thirdId }] }),
    });
    const e = refused(withDep);
    expect(withDep.backend.deploys).toBe(0);
    expect(e.memberFindings.map((f) => f.rule)).toEqual(["field-id"]);
    // Not a dependency: it may be another app's table of that name. Warns, and the run publishes.
    const without = await drive({ targetFiles, packages });
    expect("report" in without).toBe(true);
    expect(without.backend.deploys).toBeGreaterThan(0);
    expect(without.warnings.some((x) => x.message.includes("may be another app's table"))).toBe(
      true,
    );
  });

  test("U3: a publish refused over an app the check could not see names the dependents LethAL listed", async () => {
    const r = await drive({
      dependents: [TESTS_DEP],
      byParent: { [TARGET_ID]: [TESTS_DEP], [TEST_APP.id.toLowerCase()]: [OTHER_DEP] },
      packages: new Map([
        [TEST_APP.name, residentTestsApp()],
        ["Other App", otherApp({})],
      ]),
      deployError:
        "The field ID '5' can only appear once in the table 'Customer'. The field is declared in multiple apps",
    });
    expect("error" in r).toBe(true);
    const e = "error" in r ? r.error : undefined;
    expect(e).toBeInstanceOf(UpgradeClashRefusedError);
    expect((e as Error).message).toContain(
      "which BC removed: Sandbox Tests 1.0.0.0; Other App 2.3.4.5",
    );
    expect(r.backend.deploys).toBe(1);
  });

  test("a failed read of one level warns by name (object-clash-unchecked) and the run goes on", async () => {
    const r = await drive({
      dependents: [TESTS_DEP],
      byParent: { [TARGET_ID]: [TESTS_DEP], [TEST_APP.id.toLowerCase()]: new Error("HTTP 500") },
    });
    expect("report" in r).toBe(true);
    expect(r.backend.deploys).toBeGreaterThan(0);
    const w = r.warnings.filter((x) => x.code === "object-clash-unchecked");
    expect(w).toHaveLength(1);
    expect(w[0]?.message).toContain("could not read which installed apps depend on Sandbox Tests");
    expect(w[0]?.message).toContain("HTTP 500");
  });

  test("no transitive dependents: the walk asks for each app once, then the run publishes", async () => {
    const r = await drive({
      dependents: [TESTS_DEP],
      packages: new Map([[TEST_APP.name, residentTestsApp()]]),
      byParent: { [TARGET_ID]: [TESTS_DEP] },
    });
    expect("report" in r).toBe(true);
    expect(r.backend.deploys).toBeGreaterThan(0);
    // Reads: the target, then the tests app (no dependents of its own).
    expect(r.backend.readIds).toEqual([TARGET_ID, TEST_APP.id.toLowerCase()]);
  });
});

describe("R843: passes, and warns where it cannot know", () => {
  test("a clean source fallback passes and says the installed package was not read", async () => {
    const r = await drive({
      packages: new Map<string, PackageRead>([[TEST_APP.name, { unread: "HTTP 404" }]]),
    });
    expect("report" in r).toBe(true);
    expect(r.backend.deploys).toBeGreaterThan(0);
    const w = r.warnings.filter((x) => x.code === "object-clash-unchecked");
    expect(w).toHaveLength(1);
    expect(w[0]?.message).toContain("Sandbox Tests 1.0.0.0");
    expect(w[0]?.message).toContain("was not read (HTTP 404)");
  });

  test("a package of another version is not trusted: source stands in and the run says so", async () => {
    const r = await drive({
      packages: new Map([
        [
          TEST_APP.name,
          // Trusted, its codeunit 79000 would clash with the target's and refuse the run.
          residentTestsApp({ Codeunits: [{ Id: 79000, Name: "Old Helper" }] }, "0.0.0.1"),
        ],
      ]),
    });
    expect("report" in r).toBe(true);
    expect(r.backend.deploys).toBeGreaterThan(0);
    const w = r.warnings.filter((x) => x.code === "object-clash-unchecked");
    expect(w.map((x) => x.message).join("\n")).toContain(
      "version 0.0.0.1, not the installed 1.0.0.0",
    );
  });

  test("a clash in SOURCE with a clean installed app passes: nothing is harmed", async () => {
    const r = await drive({
      testsAl: `${TESTS_AL}\ncodeunit 79000 "Source Clash"\n{\n}\n`,
    });
    expect("report" in r).toBe(true);
    expect(r.backend.deploys).toBeGreaterThan(0);
  });

  test("the same id in another kind passes", async () => {
    const r = await drive({
      packages: new Map([[TEST_APP.name, residentTestsApp({ Pages: [{ Id: 79000, Name: "P" }] })]]),
    });
    expect("report" in r).toBe(true);
    expect(r.backend.deploys).toBeGreaterThan(0);
  });

  test("an interface is not compared", async () => {
    const r = await drive({
      packages: new Map([
        [TEST_APP.name, residentTestsApp({ Interfaces: [{ Id: 79000, Name: "I" }] })],
      ]),
    });
    expect("report" in r).toBe(true);
    expect(r.backend.deploys).toBeGreaterThan(0);
  });

  test("no dependent installed (a first publish) passes", async () => {
    const r = await drive({ dependents: [] });
    expect("report" in r).toBe(true);
    expect(r.backend.deploys).toBeGreaterThan(0);
  });

  test("an unreadable package of another dependent warns by name and passes", async () => {
    const r = await drive({
      dependents: [TESTS_DEP, OTHER_DEP],
      packages: new Map<string, PackageRead>([
        [TEST_APP.name, residentTestsApp()],
        ["Other App", { unread: "HTTP 500" }],
      ]),
    });
    expect("report" in r).toBe(true);
    const w = r.warnings.filter((x) => x.code === "object-clash-unchecked");
    expect(w).toHaveLength(1);
    expect(w[0]?.message).toContain("Other App 2.3.4.5");
    expect(w[0]?.message).toContain("HTTP 500");
    expect(r.backend.deploys).toBeGreaterThan(0);
  });

  test("an undecided #if arm in the target warns by file and never refuses", async () => {
    const r = await drive({
      targetFiles: {
        "Undecided.Codeunit.al": `codeunit 79304 "Undecided"
{
    procedure P()
    var
        T: Text;
    begin
        T.ToLower()
#if SOMETHING
        .ToUpper()
#endif
        ;
    end;
}
`,
      },
    });
    expect("report" in r).toBe(true);
    const w = r.warnings.filter((x) => x.code === "object-clash-unchecked");
    expect(w.some((x) => x.message.includes("Undecided.Codeunit.al"))).toBe(true);
    expect(r.backend.deploys).toBeGreaterThan(0);
  });

  test("a failed dependents read compares nothing", async () => {
    const r = await drive({ dependents: "throws" });
    expect("report" in r).toBe(true);
    expect(r.backend.fetched).toEqual(expect.not.arrayContaining(["Other App"]));
    expect(r.warnings.some((x) => x.code === "installed-dependents")).toBe(true);
  });
});

/**
 * R847 Part 1: the installed target is on the server, an unrelated app X (NOT a dependent) declares
 * the codeunit id the target injects, and the keyed read names X. The refusal must come from X's own
 * package, before anything is published: `deploys` is the call counter.
 */
describe("R847: an installed app that is not a dependent, through runSession", () => {
  const X: InstalledDependent = {
    id: "9f3c2b1a-0000-4000-8000-0000000000aa",
    name: "Unrelated App",
    publisher: "Elsewhere",
    version: "3.0.0.0",
  };
  const targetPackage = new Uint8Array(
    buildFakeAppWithEntries({
      "SymbolReference.json": JSON.stringify({
        AppId: TARGET_ID,
        Version: "1.0.0.0",
        Codeunits: [{ Id: 79000, Name: "Sandbox Logic" }],
      }),
    }),
  );
  const unrelated = (extra: Record<string, unknown[]>): Uint8Array =>
    new Uint8Array(
      buildFakeAppWithEntries({
        "SymbolReference.json": JSON.stringify({ AppId: X.id, Version: X.version, ...extra }),
      }),
    );
  const serve = (calls: { objects: number; versions: number }) => (b: ClashBackend) => {
    b.installedVersions = async () => {
      calls.versions++;
      return ["1.0.0.0"];
    };
    b.objectOwners = async (items) => {
      calls.objects++;
      const rows = items.map((item) => {
        if (item.kind === "Codeunit" && item.id === 79000) {
          return {
            ...item,
            outcome: "owner" as const,
            app: { id: TARGET_ID, name: "R843 Target", publisher: "LethAL", version: "1.0.0.0" },
          };
        }
        if (item.kind === "Codeunit" && item.id === ids.controlId) {
          return { ...item, outcome: "owner" as const, app: X };
        }
        return { ...item, outcome: "none" as const };
      });
      return { read: rows.length, rows };
    };
    b.fieldOwners = async () => ({ read: 0, rows: [] });
  };

  test("a lead with a real clash refuses from the lead's package, with zero deploys", async () => {
    const calls = { objects: 0, versions: 0 };
    const r = await drive({
      configure: serve(calls),
      packages: new Map([
        [TEST_APP.name, residentTestsApp()],
        ["R843 Target", targetPackage],
        ["Unrelated App", unrelated({ Codeunits: [{ Id: ids.controlId, Name: "Theirs" }] })],
      ]),
    });
    const e = refused(r);
    expect(r.backend.deploys).toBe(0);
    expect(calls).toEqual({ objects: 1, versions: 1 });
    expect(e.findings.map((f) => [f.app.name, f.id, f.notDependent])).toEqual([
      ["Unrelated App", ids.controlId, true],
    ]);
    expect(r.backend.fetched).toContain("Unrelated App");
  });

  test("a lead with no real clash does not stop the run", async () => {
    const calls = { objects: 0, versions: 0 };
    const r = await drive({
      configure: serve(calls),
      packages: new Map([
        [TEST_APP.name, residentTestsApp()],
        ["R843 Target", targetPackage],
        ["Unrelated App", unrelated({ Codeunits: [{ Id: 1, Name: "Mine" }] })],
      ]),
    });
    expect("report" in r).toBe(true);
    expect(r.backend.deploys).toBeGreaterThan(0);
    expect(calls.objects).toBe(1);
  });

  test("a failed dependents read still reaches the lead (no early return)", async () => {
    const calls = { objects: 0, versions: 0 };
    const r = await drive({
      dependents: "throws",
      configure: serve(calls),
      packages: new Map([
        ["R843 Target", targetPackage],
        ["Unrelated App", unrelated({ Codeunits: [{ Id: ids.controlId, Name: "Theirs" }] })],
      ]),
    });
    refused(r);
    expect(r.backend.deploys).toBe(0);
  });

  test("a backend without the keyed reads asks nothing and is not refused", async () => {
    const r = await drive({
      packages: new Map([
        [TEST_APP.name, residentTestsApp()],
        ["Unrelated App", unrelated({ Codeunits: [{ Id: ids.controlId, Name: "Theirs" }] })],
      ]),
    });
    expect("report" in r).toBe(true);
    expect(r.backend.fetched).not.toContain("Unrelated App");
  });
});

describe("R843: only bcdev", () => {
  test("al-runner-v3 is not refused, even with a clashing installed app", async () => {
    const r = await drive({
      kind: "al-runner-v3",
      packages: new Map([
        [TEST_APP.name, residentTestsApp({ Codeunits: [{ Id: 79000, Name: "Old Helper" }] })],
      ]),
    });
    expect("report" in r).toBe(true);
    expect(r.backend.deploys).toBeGreaterThan(0);
    expect(r.warnings.filter((x) => x.code === "object-clash-unchecked")).toEqual([]);
  });

  test("a bcdev backend with no installedDependents is not asked", async () => {
    const r = await drive({
      dependents: "absent",
      packages: new Map([
        [TEST_APP.name, residentTestsApp({ Codeunits: [{ Id: 79000, Name: "Old Helper" }] })],
      ]),
    });
    expect("report" in r).toBe(true);
    expect(r.backend.dependentReads).toBe(0);
  });
});
