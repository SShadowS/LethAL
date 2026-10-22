import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../packages/runner/src/activation.ts";
import { listPackageEntries, readPackageEntry } from "../packages/runner/src/app-package.ts";
import { buildFakeAppWithEntries } from "../packages/runner/tests/helpers/fake-app.ts";
import {
  type AppItem,
  type AppManifest,
  type Conn,
  ContentUnknownError,
  type DecideInput,
  type ExtensionRow,
  type ServerOps,
  actAll,
  changedEntries,
  compilerVersion,
  contentDigest,
  decideAll,
  decideApp,
  decideControl,
  headerPackageId,
  isInstrumented,
  normaliseNavigation,
  realOps,
  refusals,
  residentPackage,
} from "./bc-app-content.ts";

// Five real alc 18.0.43.1464 builds (/coord/handoff/R-599/offline, digest-offline.log):
// names1 and names2 are one source compiled twice; nt-resident1 and nt-local are one test source
// compiled against two different target builds; nt-comment is nt-local plus one comment line.
const pkgOf = (n: string) => readFileSync(join(import.meta.dir, "testdata", `${n}.app`));
const NAMES1 = pkgOf("names1");
const NAMES2 = pkgOf("names2");
const NT_RESIDENT = pkgOf("nt-resident1");
const NT_LOCAL = pkgOf("nt-local");
const NT_COMMENT = pkgOf("nt-comment");

/** A stored-zip package; the reader checks no CRC. */
function fake(o: {
  name?: string;
  version?: string;
  compiler?: string;
  timestamp?: string | null;
  src?: string;
  instrumented?: boolean;
}): Buffer {
  const ts = o.timestamp === null ? "" : ` Timestamp="${o.timestamp ?? "2026-10-22T01:00:00Z"}"`;
  const manifest = `<Package><App Id="aaaa" Name="${o.name ?? "LethAL Sandbox Names"}" Publisher="LethAL" Version="${o.version ?? "1.0.0.0"}" /><Build${ts} CompilerVersion="${o.compiler ?? "18.0.43.1464"}" /></Package>`;
  return buildFakeAppWithEntries({
    "NavxManifest.xml": manifest,
    "src/Names.Codeunit.al": o.src ?? "codeunit 1 X {}",
    ...(o.instrumented === true ? { "src/MutationSelector.Codeunit.al": "codeunit 2 S {}" } : {}),
  });
}

function row(version: string, isInstalled = true, packageId = "p-1"): ExtensionRow {
  const [a, b, c, d] = version.split(".").map(Number);
  return {
    packageId,
    displayName: "x",
    isInstalled,
    versionMajor: a ?? 0,
    versionMinor: b ?? 0,
    versionBuild: c ?? 0,
    versionRevision: d ?? 0,
  };
}

const base = (over: Partial<DecideInput>): DecideInput => ({
  dir: "sandbox-names",
  local: fake({}),
  resident: fake({}),
  rows: [row("1.0.0.0")],
  role: "target",
  gateDeploys: true,
  installedDependent: null,
  mode: "setup",
  ...over,
});

describe("contentDigest (normalised: no header id, no build timestamp)", () => {
  test("two compiles of one source: raw sha256 differs, digest equal", () => {
    expect(NAMES1.equals(NAMES2)).toBe(false);
    expect(contentDigest(NAMES1)).toBe(contentDigest(NAMES2));
    expect(contentDigest(NAMES1)).toBe(
      "bbd7f8947571c37e18bf93314283e7d535e9f785cfb7f155e5425561fe4625ba",
    );
  });

  test("a test app compiled against two target builds: same digest (the measured 99f9d28a...)", () => {
    expect(contentDigest(NT_RESIDENT)).toBe(contentDigest(NT_LOCAL));
    expect(contentDigest(NT_LOCAL)).toBe(
      "99f9d28afe4d09f1293bed9270d13841f959ddb0ea99c1c560405ca533955a49",
    );
  });

  test("one comment line changes it (the AL source is in the package)", () => {
    expect(contentDigest(NT_COMMENT)).toBe(
      "a56ae76c2b180083383b5767075763d17bcd13ae24f28422e36dad15ba445453",
    );
  });

  test("refuses, never defaults: no timestamp, two timestamps, no manifest, no entries, a duplicate", () => {
    expect(() => contentDigest(fake({ timestamp: null }))).toThrow(/0 Build Timestamp/);
    const two = buildFakeAppWithEntries({
      "NavxManifest.xml":
        '<Package><Build Timestamp="a" /><Build Timestamp="b" /><App Version="1.0.0.0" /></Package>',
    });
    expect(() => contentDigest(two)).toThrow(/2 Build Timestamp/);
    expect(() => contentDigest(buildFakeAppWithEntries({ "a.al": "x" }))).toThrow(
      /no NavxManifest\.xml/,
    );
    expect(() => contentDigest(buildFakeAppWithEntries({}))).toThrow(/no entries/);
    const dup = buildFakeAppWithEntries([
      ["NavxManifest.xml", '<Package><Build Timestamp="a" /></Package>'],
      ["src/a.al", "one"],
      ["src/a.al", "two"],
    ]);
    expect(() => contentDigest(dup)).toThrow(/src\/a\.al twice/);
    for (const bad of [fake({ timestamp: null }), dup, buildFakeAppWithEntries({})]) {
      expect(() => contentDigest(bad)).toThrow(ContentUnknownError);
    }
  });
});

// Real alc builds (5 compiles each: /coord/handoff/R-599/nondeterminism-5x-all.log): two of probes
// (random ControlGUIDs), two of data (ActionDefinition order differs), two of wrapped (ActionChange
// order differs), and probes after a real AL navigation edit (ProbeList's UsageCategory Lists ->
// Administration, reverted in the fixture afterwards).
const PROBES1 = pkgOf("probes1");
const PROBES2 = pkgOf("probes2");
const DATA1 = pkgOf("data1");
const DATA2 = pkgOf("data2");
const WRAPPED1 = pkgOf("wrapped1");
const WRAPPED2 = pkgOf("wrapped2");
const PROBES_NAVEDIT = pkgOf("probes-navedit");

const nav = (p: Buffer) => readPackageEntry(p, "navigation.xml")?.toString("utf8") ?? "";

/** The same package rebuilt (stored zip), with `edit` applied to each entry's text. */
function rebuilt(p: Buffer, edit: (name: string, text: string) => string = (_n, t) => t): Buffer {
  return buildFakeAppWithEntries(
    listPackageEntries(p).map((n) => {
      const bytes = readPackageEntry(p, n) ?? Buffer.alloc(0);
      return [n, n.endsWith(".xml") ? edit(n, bytes.toString("utf8")) : bytes] as const;
    }),
  );
}
const inNav = (f: (t: string) => string) => (n: string, t: string) =>
  n === "navigation.xml" ? f(t) : t;
const navEdit = (p: Buffer, from: string | RegExp, to: string) =>
  rebuilt(
    p,
    inNav((t) => t.replace(from, to)),
  );

describe("navigation.xml: ControlGUID values and two element orders are not content (R599)", () => {
  test("two real builds of probes, of data and of wrapped each have one digest", () => {
    for (const [a, b] of [
      [PROBES1, PROBES2],
      [DATA1, DATA2],
      [WRAPPED1, WRAPPED2],
    ] as const) {
      expect(nav(a)).not.toBe(nav(b)); // the raw entry really differs
      expect(contentDigest(a)).toBe(contentDigest(b));
    }
  });

  test("a changed TargetID changes the digest (ActionChange and ActionDefinition)", () => {
    const base = contentDigest(rebuilt(WRAPPED1));
    const w = navEdit(WRAPPED1, 'TargetID="78910"', 'TargetID="78911"');
    expect(contentDigest(w)).not.toBe(base);
    const d = navEdit(DATA1, 'TargetID="79323"', 'TargetID="79324"');
    expect(contentDigest(d)).not.toBe(contentDigest(rebuilt(DATA1)));
  });

  test("an added or a removed action changes the digest; duplicates are kept", () => {
    const base = contentDigest(rebuilt(WRAPPED1));
    const change = /<ActionChange TargetID="78909" TargetType="Page" \/>/;
    const removed = navEdit(WRAPPED1, change, "");
    const doubled = rebuilt(
      WRAPPED1,
      inNav((t) =>
        t.replace(change, (m) => `${m}\n    <ActionChange TargetID="78909" TargetType="Page" />`),
      ),
    );
    expect(contentDigest(removed)).not.toBe(base);
    expect(contentDigest(doubled)).not.toBe(base);
    // the multiset is kept: all three elements survive the normalisation
    expect(normaliseNavigation(nav(doubled)).match(/<ActionChange /g)).toHaveLength(3);
    const def = /<Actions xsi:type="ActionDefinition"[^>]*Name="Data Value Card"[^>]*\/>/;
    const lessData = navEdit(DATA1, def, "");
    expect(contentDigest(lessData)).not.toBe(contentDigest(rebuilt(DATA1)));
  });

  test("reordering two ActionGroupDefinition groups (or any other element) still changes the digest", () => {
    const group = (caption: string, target: string) =>
      `<Actions xsi:type="ActionGroupDefinition" Caption="${caption}" ControlGUID="{x}">\n      <Actions xsi:type="ActionDefinition" TargetID="${target}" ControlGUID="{y}" />\n    </Actions>`;
    const doc = (a: string, b: string) =>
      `<NavigationDefinition>\n  <ActionContainers ActionContainerType="Departments">\n    ${a}\n    ${b}\n  </ActionContainers>\n</NavigationDefinition>`;
    const g1 = group("One", "1");
    const g2 = group("Two", "2");
    expect(normaliseNavigation(doc(g1, g2))).not.toBe(normaliseNavigation(doc(g2, g1)));
    const pkg = (t: string) =>
      buildFakeAppWithEntries({
        "NavxManifest.xml": '<Package><Build Timestamp="t" /></Package>',
        "navigation.xml": t,
      });
    expect(contentDigest(pkg(doc(g1, g2)))).not.toBe(contentDigest(pkg(doc(g2, g1))));
    // an action MOVED between groups (TargetIDs swapped across the two parents) still differs: a
    // run never crosses a parent's tags
    const swapped = doc(group("One", "2"), group("Two", "1"));
    expect(normaliseNavigation(doc(g1, g2))).not.toBe(normaliseNavigation(swapped));
    expect(contentDigest(pkg(doc(g1, g2)))).not.toBe(contentDigest(pkg(swapped)));
    // and two sibling elements of another kind are not reordered
    const other = (a: string, b: string) => `<X>\n  <Other A="${a}" />\n  <Other A="${b}" />\n</X>`;
    expect(normaliseNavigation(other("1", "2"))).not.toBe(normaliseNavigation(other("2", "1")));
  });

  test("ControlGUID and ActionChange order are NOT normalised outside navigation.xml", () => {
    const pkg = (t: string) =>
      buildFakeAppWithEntries({
        "NavxManifest.xml": '<Package><Build Timestamp="t" /></Package>',
        "src/Other.xml": t,
      });
    expect(contentDigest(pkg('<A ControlGUID="{1}" />'))).not.toBe(
      contentDigest(pkg('<A ControlGUID="{2}" />')),
    );
    const ac = (a: string, b: string) =>
      `<ActionChange TargetID="${a}" TargetType="Page" />\n<ActionChange TargetID="${b}" TargetType="Page" />`;
    expect(contentDigest(pkg(ac("1", "2")))).not.toBe(contentDigest(pkg(ac("2", "1"))));
  });

  test("a real AL navigation edit (UsageCategory) changes navigation.xml and the digest", () => {
    expect(contentDigest(PROBES_NAVEDIT)).not.toBe(contentDigest(PROBES1));
    expect(changedEntries(PROBES1, PROBES_NAVEDIT)).toContain("navigation.xml");
    expect(normaliseNavigation(nav(PROBES_NAVEDIT))).not.toBe(normaliseNavigation(nav(PROBES1)));
  });
});

describe("changedEntries, compilerVersion, isInstrumented, headerPackageId", () => {
  test("two builds that differ only in one src entry name exactly that entry (F2)", () => {
    expect(changedEntries(NT_LOCAL, NT_COMMENT)).toEqual(["src/src/NamesTests.Codeunit.al"]);
    expect(changedEntries(NAMES1, NAMES2)).toEqual([]);
  });

  test("a different compiler shows as NavxManifest.xml alone, with both versions readable", () => {
    const a = fake({ compiler: "18.0.43.1464" });
    const b = fake({ compiler: "17.0.1.1" });
    expect(changedEntries(a, b)).toEqual(["NavxManifest.xml"]);
    expect([compilerVersion(a), compilerVersion(b)]).toEqual(["18.0.43.1464", "17.0.1.1"]);
  });

  test("the instrumentation marker is src/ + CONTROL_SELECTOR_FILENAME, exactly", () => {
    expect(isInstrumented(fake({ instrumented: true }))).toBe(true);
    expect(isInstrumented(fake({}))).toBe(false);
    expect(isInstrumented(NAMES1)).toBe(false);
  });

  test("the header id reads in .NET GUID order (measure.md F4: Sandbox Names on bc3)", () => {
    const b = Buffer.alloc(40);
    Buffer.from("7356e53f35fc5245909f4454e08185cb", "hex").copy(b, 12);
    expect(headerPackageId(b)).toBe("3fe55673-fc35-4552-909f-4454e08185cb");
  });
});

describe("decideApp: the nine rows, in order", () => {
  test("row 1: nothing resident and no row: publish new", () => {
    const d = decideApp(base({ resident: null, rows: [] }));
    expect(d).toMatchObject({ action: "publish", how: "new" });
  });

  test("row 2 (I2): anything but exactly one installed row at the package's version is content-unknown", () => {
    const same = fake({});
    for (const [what, over] of [
      ["404 with a row", { resident: null, rows: [row("1.0.0.0")] }],
      ["a package with no row", { resident: same, rows: [] }],
      ["two rows", { resident: same, rows: [row("1.0.0.0"), row("1.0.0.0", true, "p-2")] }],
      // the published-but-not-installed case: same content would otherwise be a skip
      ["one row, not installed", { resident: same, local: same, rows: [row("1.0.0.0", false)] }],
      ["a row at another version", { resident: same, rows: [row("1.0.0.1")] }],
    ] as const) {
      const d = decideApp(base(over));
      expect(`${what}: ${d.action}`).toBe(`${what}: refuse`);
      if (d.action === "refuse") expect(d.why).toBe("content-unknown");
    }
  });

  test("row 3: a resident package that cannot be digested is content-unknown", () => {
    const d = decideApp(base({ resident: fake({ timestamp: null }) }));
    expect(d).toMatchObject({ action: "refuse", why: "content-unknown" });
  });

  test("row 4: same content is a skip, across two compiles (raw bytes differ)", () => {
    const d = decideApp(base({ local: NAMES2, resident: NAMES1 }));
    expect(d.action).toBe("skip");
  });

  test("row 5: a lower resident version is an upgrade", () => {
    const d = decideApp(
      base({ local: fake({ version: "1.0.0.5" }), resident: fake({}), rows: [row("1.0.0.0")] }),
    );
    expect(d).toMatchObject({ action: "publish", how: "upgrade" });
  });

  test("row 6: same version, other content, a target with an installed dependent: refused", () => {
    const d = decideApp(
      base({ local: fake({ src: "changed" }), installedDependent: "LethAL Sandbox Names Tests" }),
    );
    expect(d).toMatchObject({ action: "refuse", why: "same-version-target" });
    expect(d.line).toContain("LethAL Sandbox Names Tests is installed");
  });

  test("row 7: same version, other content (no installed dependent): published in place, naming entries and compilers", () => {
    const d = decideApp(
      base({ role: "dependent", local: NT_COMMENT, resident: NT_LOCAL, rows: [row("1.0.0.0")] }),
    );
    expect(d).toMatchObject({ action: "publish", how: "in place" });
    expect(d.line).toContain(
      "content changed in src/src/NamesTests.Codeunit.al (resident digest 99f9d28afe4d, compiler 18.0.43.1464; local a56ae76c2b18, compiler 18.0.43.1464)",
    );
    // and the same target with no installed dependent is published in place too
    expect(decideApp(base({ local: fake({ src: "changed" }) }))).toMatchObject({
      action: "publish",
      how: "in place",
    });
  });

  test("row 8: a gate-deployed, instrumented target above app.json is kept in setup", () => {
    const resident = fake({ version: "1.0.20747.42866", instrumented: true });
    const d = decideApp(base({ resident, rows: [row("1.0.20747.42866")] }));
    expect(d).toMatchObject({ action: "keep", residentVersion: "1.0.20747.42866" });
    expect(d.line).toContain("kept      minted target LethAL Sandbox Names 1.0.20747.42866");
  });

  test("row 9: above the build and anything else is refused, with the right remedy", () => {
    const up = { rows: [row("1.0.20747.42866")] };
    const inst = fake({ version: "1.0.20747.42866", instrumented: true });
    const plain = fake({ version: "1.0.20747.42866" });
    // not instrumented
    expect(decideApp(base({ ...up, resident: plain }))).toMatchObject({
      action: "refuse",
      why: "above-build",
    });
    // not marked gateDeploys (sandbox-probes)
    expect(
      decideApp(base({ ...up, resident: inst, gateDeploys: false, dir: "sandbox-probes" })),
    ).toMatchObject({ action: "refuse", why: "above-build" });
    // a test app never gets the keep rule, even instrumented and marked
    const dep = decideApp(base({ ...up, resident: inst, role: "dependent" }));
    expect(dep).toMatchObject({ action: "refuse", why: "above-build" });
    expect(dep.line).toContain("R605");
    // republish mode: a minted target names --mint
    const rep = decideApp(base({ ...up, resident: inst, mode: "republish" }));
    expect(rep).toMatchObject({ action: "refuse", why: "above-build" });
    expect(rep.line).toContain("resident 1.0.20747.42866 above 1.0.0.0");
    expect(rep.line).toContain("--mint sandbox-names");
  });

  test("every decision line prints the rows it saw", () => {
    const d = decideApp(base({ rows: [row("1.0.0.0", true, "1d69436c")] }));
    expect(d.line).toContain("rows: 1.0.0.0 installed=true packageId=1d69436c");
  });
});

describe("decideControl: the row check, then controlAction on raw sha256", () => {
  const pinned = fake({ name: "LethAL Control", version: "1.0.0.23" });

  test("the pinned bytes resident with one installed row: already-pinned", () => {
    expect(decideControl(pinned, pinned, [row("1.0.0.23")]).action).toBe("skip");
  });

  test("absent: publish; lower: publish", () => {
    expect(decideControl(pinned, null, []).action).toBe("publish");
    const lower = fake({ name: "LethAL Control", version: "1.0.0.22" });
    expect(decideControl(pinned, lower, [row("1.0.0.22")]).action).toBe("publish");
  });

  test("a higher, or a same-version other-bytes control is refused by name (setup used to skip it)", () => {
    const higher = fake({ name: "LethAL Control", version: "1.0.0.24" });
    expect(decideControl(pinned, higher, [row("1.0.0.24")]).line).toContain("above the pinned");
    const other = fake({ name: "LethAL Control", version: "1.0.0.23", src: "other" });
    expect(decideControl(pinned, other, [row("1.0.0.23")]).line).toContain("not the pinned build");
  });

  test("a resident control that is not installed is content-unknown, not already-pinned", () => {
    expect(decideControl(pinned, pinned, [row("1.0.0.23", false)])).toMatchObject({
      action: "refuse",
      why: "content-unknown",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// decideAll / actAll against a fake server

interface FakeApp {
  pkg: Buffer;
  rows: ExtensionRow[];
}

/** A server keyed by app name; counts publishes, and installs what is published. */
function fakeServer(apps: Record<string, FakeApp>, opts: { publishError?: string } = {}) {
  const published: string[] = [];
  const ids = new Map<string, string>();
  const ops: ServerOps = {
    resident: async (_p, name) => apps[name]?.pkg ?? null,
    rows: async (id) => {
      const name = ids.get(id);
      return name === undefined ? [] : (apps[name]?.rows ?? []);
    },
    publish: async (fileName, bytes) => {
      published.push(fileName);
      if (opts.publishError !== undefined) throw new Error(opts.publishError);
      const { readAppIdentity } = await import("../packages/runner/src/published-test-app.ts");
      const id = readAppIdentity(bytes);
      apps[id.name] = { pkg: bytes, rows: [row(id.version, true, "new")] };
    },
  };
  return { ops, published, ids };
}

function fakeNamed(name: string, id: string, version = "1.0.0.0", src = "x"): Buffer {
  return buildFakeAppWithEntries({
    "NavxManifest.xml": `<Package><App Id="${id}" Name="${name}" Publisher="LethAL" Version="${version}" /><Build Timestamp="t" CompilerVersion="18.0.43.1464" /></Package>`,
    "src/a.al": src,
  });
}

const item = (dir: string, local: Buffer, role: "target" | "dependent"): AppItem => ({
  dir,
  local,
  role,
  gateDeploys: false,
});

const T_ID = "t-id";
const D_ID = "d-id";
const FIXTURES = new Map<string, AppManifest>([
  ["target", { id: T_ID, name: "T", publisher: "LethAL", version: "1.0.0.0" }],
  [
    "tests",
    {
      id: D_ID,
      name: "D",
      publisher: "LethAL",
      version: "1.0.0.0",
      dependencies: [{ id: T_ID, name: "T", publisher: "LethAL" }],
    },
  ],
]);

describe("decideAll / actAll", () => {
  test("F4: republish of a same-version target with an installed dependent NOT in the list is refused; 0 publishes", async () => {
    const s = fakeServer({
      T: { pkg: fakeNamed("T", T_ID, "1.0.0.0", "old"), rows: [row("1.0.0.0")] },
      D: { pkg: fakeNamed("D", D_ID), rows: [row("1.0.0.0")] },
    });
    s.ids.set(T_ID, "T");
    s.ids.set(D_ID, "D");
    const items: AppItem[] = [item("target", fakeNamed("T", T_ID, "1.0.0.0", "new"), "target")];
    const lines: string[] = [];
    const decided = await decideAll(items, s.ops, "republish", FIXTURES, (l) => lines.push(l));
    const refused = refusals(decided).map((d) => d.decision.line);
    expect(refused.join("")).toContain("same-version-target");
    expect(lines.join("\n")).toContain("dependent D of T: rows: 1.0.0.0 installed=true");
    expect(s.published).toEqual([]);
  });

  test("actAll publishes, then reads back version, raw sha256, digest and one installed row", async () => {
    const id = "b9c876b5-8c82-4ed9-879d-90b799667dfe";
    const items: AppItem[] = [
      { dir: "sandbox-names-tests", local: NT_COMMENT, role: "dependent", gateDeploys: false },
    ];
    const real = fakeServer({
      "LethAL Sandbox Names Tests": { pkg: NT_LOCAL, rows: [row("1.0.0.0")] },
    });
    real.ids.set(id, "LethAL Sandbox Names Tests");
    const lines: string[] = [];
    const decided = await decideAll(items, real.ops, "republish", new Map(), (l) => lines.push(l));
    expect(decided[0]?.decision).toMatchObject({ action: "publish", how: "in place" });
    await actAll(decided, real.ops, (l) => lines.push(l));
    expect(real.published).toEqual(["LethAL_LethAL Sandbox Names Tests_1.0.0.0.app"]);
    expect(lines.join("\n")).toContain(
      "published in place LethAL Sandbox Names Tests 1.0.0.0: content changed in src/src/NamesTests.Codeunit.al",
    );
  });

  test("a read-back whose bytes differ stops the run and names the app", async () => {
    const id = "b9c876b5-8c82-4ed9-879d-90b799667dfe";
    const apps: Record<string, FakeApp> = {
      "LethAL Sandbox Names Tests": { pkg: NT_LOCAL, rows: [row("1.0.0.0")] },
    };
    const s = fakeServer(apps);
    s.ids.set(id, "LethAL Sandbox Names Tests");
    // the server "keeps" another build of the same content: only the header id differs, so the
    // digest is equal and the raw sha256 is not
    const other = Buffer.from(NT_COMMENT);
    other.fill(0xab, 12, 28);
    expect(contentDigest(other)).toBe(contentDigest(NT_COMMENT));
    s.ops.publish = async (f) => {
      s.published.push(f);
      apps["LethAL Sandbox Names Tests"] = { pkg: other, rows: [row("1.0.0.0")] };
    };
    const items: AppItem[] = [item("sandbox-names-tests", NT_COMMENT, "dependent")];
    const decided = await decideAll(items, s.ops, "republish", new Map(), () => {});
    await expect(actAll(decided, s.ops, () => {})).rejects.toThrow(
      /read-back of LethAL Sandbox Names Tests \(sandbox-names-tests\) does not match/,
    );
  });

  test("a read-back with the right bytes but no single installed row stops the run (I1)", async () => {
    const id = "b9c876b5-8c82-4ed9-879d-90b799667dfe";
    for (const [what, after] of [
      ["published, not installed", [row("1.0.0.0", false, "new")]],
      ["two rows", [row("1.0.0.0", true, "new"), row("1.0.0.0", true, "old")]],
      ["one installed row at another version", [row("0.9.0.0", true, "new")]],
    ] as const) {
      const apps: Record<string, FakeApp> = {
        "LethAL Sandbox Names Tests": { pkg: NT_LOCAL, rows: [row("1.0.0.0")] },
      };
      const s = fakeServer(apps);
      s.ids.set(id, "LethAL Sandbox Names Tests");
      s.ops.publish = async (f, bytes) => {
        s.published.push(f);
        apps["LethAL Sandbox Names Tests"] = { pkg: bytes, rows: [...after] };
      };
      const items: AppItem[] = [item("sandbox-names-tests", NT_COMMENT, "dependent")];
      const decided = await decideAll(items, s.ops, "republish", new Map(), () => {});
      await expect(
        actAll(decided, s.ops, () => {}),
        what,
      ).rejects.toThrow(/read-back of .* does not match/);
    }
  });

  test("F6.1: BC's 422 'newer version ... already installed' names R605 and --mint", async () => {
    const s = fakeServer(
      {},
      {
        publishError:
          "bc3: publishing x failed (HTTP 422): Cannot install the extension T by LethAL 1.0.0.0 because a newer version 1.0.20747.1 was already installed.",
      },
    );
    const items: AppItem[] = [item("target", fakeNamed("T", T_ID), "target")];
    const decided = await decideAll(items, s.ops, "setup", FIXTURES, () => {});
    await expect(actAll(decided, s.ops, () => {})).rejects.toThrow(
      "T: BC holds an installed-version record at 1.0.20747.1 (R605); publish a newer build: bc-republish.ts republish --mint target",
    );
  });

  test("F6.2: a dependent refused after its target was KEPT names the kept build and the remedy", async () => {
    const minted = buildFakeAppWithEntries({
      "NavxManifest.xml": `<Package><App Id="${T_ID}" Name="T" Publisher="LethAL" Version="1.0.20747.9" /><Build Timestamp="t" /></Package>`,
      "src/MutationSelector.Codeunit.al": "x",
    });
    const s = fakeServer({ T: { pkg: minted, rows: [row("1.0.20747.9")] } });
    s.ids.set(T_ID, "T");
    s.ops.publish = async (f) => {
      s.published.push(f);
      throw new Error("bc3: publishing D failed (HTTP 422): The procedure X is missing");
    };
    const items: AppItem[] = [
      { ...item("target", fakeNamed("T", T_ID), "target"), gateDeploys: true },
      { ...item("tests", fakeNamed("D", D_ID), "dependent"), targetDir: "target" },
    ];
    const decided = await decideAll(items, s.ops, "setup", FIXTURES, () => {});
    expect(decided.map((d) => d.decision.action)).toEqual(["keep", "publish"]);
    await expect(actAll(decided, s.ops, () => {})).rejects.toThrow(
      "the target T is a kept minted build 1.0.20747.9; run the target's gate, or bc-republish.ts republish --mint target, then re-run setup",
    );
  });

  test("actAll refuses to run at all when anything was refused", async () => {
    const s = fakeServer({ T: { pkg: fakeNamed("T", T_ID), rows: [] } });
    const items: AppItem[] = [item("target", fakeNamed("T", T_ID), "target")];
    const decided = await decideAll(items, s.ops, "setup", FIXTURES, () => {});
    expect(refusals(decided)).toHaveLength(1);
    await expect(actAll(decided, s.ops, () => {})).rejects.toThrow(/after a refusal/);
    expect(s.published).toEqual([]);
  });
});

/** A Conn whose every request is answered with `status` (never the network). */
function connAnswering(status: number, body: Uint8Array | string = "x"): Conn {
  return {
    server: "bc3",
    authorization: "Basic fake",
    fetch: (async () => new Response(body, { status })) as unknown as FetchFn,
  };
}

describe("residentPackage: the one strict dev/packages read (R624)", () => {
  test("2xx: the bytes", async () => {
    const pkg = fake({});
    expect(await residentPackage(connAnswering(200, pkg), "LethAL", "X")).toEqual(pkg);
  });

  test("404: null (the server holds none)", async () => {
    expect(await residentPackage(connAnswering(404), "LethAL", "X")).toBeNull();
  });

  test("401 and 403: the server-named login error", async () => {
    for (const s of [401, 403])
      await expect(residentPackage(connAnswering(s), "LethAL", "X")).rejects.toThrow(
        `bc3: the dev endpoint refused the login (HTTP ${s})`,
      );
  });

  test("any other failure throws, naming the server, the app and the status", async () => {
    for (const s of [500, 502, 503])
      await expect(residentPackage(connAnswering(s), "LethAL", "X Y")).rejects.toThrow(
        `bc3: LethAL "X Y": the dev endpoint answered HTTP ${s}`,
      );
  });

  test("realOps(...).resident gives the login error on a 401 (M3)", async () => {
    await expect(realOps(connAnswering(401)).resident("LethAL", "X")).rejects.toThrow(
      "bc3: the dev endpoint refused the login (HTTP 401)",
    );
  });

  // M1: a second reader (lenient or not) cannot come back unnoticed. The one-off probes outside
  // these files (`r372-package-source-probe`, `r624-absent-status.ts`) record a raw status on purpose.
  test("among the setup scripts, only bc-app-content.ts builds a dev/packages URL, once", () => {
    const files = [
      ...readdirSync(import.meta.dir)
        .filter((f) => /^bc-.*\.ts$/.test(f) && !f.endsWith(".test.ts"))
        .map((f) => join(import.meta.dir, f)),
      ...readdirSync(join(import.meta.dir, "r594"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(import.meta.dir, "r594", f)),
    ];
    const calls = files.map((f) => ({
      f: f.slice(import.meta.dir.length + 1),
      n: readFileSync(f, "utf8").split("devPackagesUrl(").length - 1,
      defines: /function residentPackage\b/.test(readFileSync(f, "utf8")),
    }));
    expect(calls.filter((c) => c.n > 0)).toEqual([{ f: "bc-app-content.ts", n: 1, defines: true }]);
    expect(calls.filter((c) => c.defines).map((c) => c.f)).toEqual(["bc-app-content.ts"]);
    for (const f of ["bc-republish.ts", "r594/cdo-publish.ts"])
      expect(readFileSync(join(import.meta.dir, f), "utf8")).toMatch(/\bresidentPackage,/);
  });
});
