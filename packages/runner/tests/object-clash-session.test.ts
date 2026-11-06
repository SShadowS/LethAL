import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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

const APP_JSON = JSON.stringify({
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a91",
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
function residentTestsApp(extra: Record<string, unknown[]> = {}): Uint8Array {
  const own = {
    Id: 79100,
    Name: "Sandbox Tests",
    Properties: [{ Name: "Subtype", Value: "Test" }],
    Methods: [{ Id: 1, Name: "OverBudgetDetected", Attributes: [{ Name: "Test" }] }],
  };
  const symbols: Record<string, unknown[]> = { ...extra };
  symbols.Codeunits = [own, ...(extra.Codeunits ?? [])];
  return new Uint8Array(
    buildFakeAppWithEntries({
      "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package ${NS}><App Id="${TEST_APP.id}" Name="${TEST_APP.name}" Publisher="${TEST_APP.publisher}" Version="1.0.0.0" /></Package>`,
      "SymbolReference.json": JSON.stringify(symbols),
    }),
  );
}

function otherApp(extra: Record<string, unknown[]>): Uint8Array {
  return new Uint8Array(buildFakeAppWithEntries({ "SymbolReference.json": JSON.stringify(extra) }));
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
  ) {
    if (dependents !== "absent") {
      this.installedDependents = async () => {
        this.dependentReads++;
        if (dependents === "throws") throw new Error("control app unreachable");
        return dependents;
      };
    }
  }

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
  async deploy(): Promise<null> {
    this.deploys++;
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
}

async function drive(s: Setup) {
  const root = scratch("lethal-r843-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  for (const [name, text] of Object.entries(s.targetFiles ?? {})) {
    await Bun.write(join(projectDir, name), text);
  }
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), s.testsAl ?? TESTS_AL);
  await Bun.write(join(testDir, "app.json"), testAppJson());
  const backend = new ClashBackend(
    s.kind ?? "bcdev",
    s.dependents ?? [TESTS_DEP],
    s.packages ?? new Map([[TEST_APP.name, residentTestsApp()]]),
  );
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

describe("R843: refused before anything is published", () => {
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

describe("R843: passes, and warns where it cannot know", () => {
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
