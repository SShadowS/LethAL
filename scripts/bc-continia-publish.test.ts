import { describe, expect, test } from "bun:test";
import { buildFakeAppWithEntries } from "../packages/runner/tests/helpers/fake-app.ts";
import { type ExtensionRow, sha256Of } from "./bc-app-content.ts";
import { type PublishOps, parseArgs, run } from "./bc-continia-publish.ts";

const CS = "Continia Software";

function app(
  name: string,
  version: string,
  deps: { name: string; publisher: string; min: string }[] = [],
  src = "x",
): Buffer {
  const d = deps
    .map(
      (x) =>
        `<Dependency Id="id-${x.name}" Name="${x.name}" Publisher="${x.publisher}" MinVersion="${x.min}" />`,
    )
    .join("");
  return buildFakeAppWithEntries({
    "NavxManifest.xml": `<Package><App Id="id-${name}" Name="${name}" Publisher="${CS}" Version="${version}" /><Dependencies>${d}</Dependencies><Build Timestamp="t" CompilerVersion="18.0.1.1" /></Package>`,
    "src/a.al": src,
  });
}

const rowOf = (version: string): ExtensionRow => {
  const [a = 0, b = 0, c = 0, d = 0] = version.split(".").map(Number);
  return {
    packageId: "p",
    displayName: "x",
    isInstalled: true,
    versionMajor: a,
    versionMinor: b,
    versionBuild: c,
    versionRevision: d,
  };
};

/** Resident packages by `publisher|name`; `ms` maps Microsoft app names to versions. */
function fake(resident: Record<string, Buffer> = {}, ms: Record<string, string> = {}) {
  const calls: string[] = [];
  const published: string[] = [];
  const ops: PublishOps = {
    async resident(p, n) {
      calls.push(`resident ${p}|${n}`);
      return resident[`${p}|${n}`] ?? null;
    },
    async rows(id) {
      calls.push(`rows ${id}`);
      const hit = Object.values(resident).find((b) => b.includes(`Id="${id}"`));
      return hit === undefined ? [] : [rowOf(versionIn(hit))];
    },
    async publish(fileName, bytes) {
      calls.push(`publish ${fileName}`);
      published.push(fileName);
      const m = /App Id="[^"]*" Name="([^"]*)"/.exec(bytes.toString("latin1"));
      if (m?.[1] !== undefined && !skipStore.has(m[1])) resident[`${CS}|${m[1]}`] = bytes;
    },
    async residentVersion(p, n) {
      calls.push(`residentVersion ${p}|${n}`);
      if (p === "Microsoft") return ms[n] ?? null;
      const b = resident[`${p}|${n}`];
      return b === undefined ? null : versionIn(b);
    },
  };
  const skipStore = new Set<string>();
  return { ops, calls, published, resident, skipStore };
}

function versionIn(b: Buffer): string {
  return /Version="([^"]*)"/.exec(b.toString("latin1"))?.[1] ?? "?";
}

const MS = { Application: "28.4.0.0", System: "28.4.0.0", "Base Application": "28.4.0.0" };
const run1 = async (
  files: Record<string, Buffer>,
  order: string[],
  f: ReturnType<typeof fake>,
  extra: string[] = [],
) => {
  const log: string[] = [];
  const args = parseArgs([
    "--server",
    "bc3",
    "--lane",
    "L",
    "--token-dir",
    "/t",
    "--dir",
    "/d",
    ...extra,
    "--",
    ...order,
  ]);
  const err = await run(args, {
    ops: f.ops,
    read: (p) => files[p.replace("/d/", "")] as Buffer,
    log: (s) => log.push(s),
  }).then(
    () => undefined,
    (e: Error) => e,
  );
  return { log: log.join("\n"), err };
};

const sys = app("Sys", "28.5.0.336834");
const core = app("Core", "28.5.0.336883", [{ name: "Sys", publisher: CS, min: "28.5.0.0" }]);
const files = { "sys.app": sys, "core.app": core };

describe("order and dependencies", () => {
  test("an app before its dependency is refused by name, nothing published", async () => {
    const f = fake({}, MS);
    const { err, log } = await run1(files, ["core.app", "sys.app"], f);
    expect(err?.message).toContain("NOTHING was published");
    expect(log).toContain("refuse    order Core (position 1) depends on Sys");
    expect(f.published).toEqual([]);
  });

  test("a dependency neither listed nor on the server is refused", async () => {
    const f = fake({}, MS);
    const { err, log } = await run1(files, ["core.app"], f);
    expect(err).toBeDefined();
    expect(log).toContain("Core: needs Continia Software Sys >= 28.5.0.0, absent");
    expect(f.published).toEqual([]);
  });

  test("a dependency already on the server at the minimum satisfies a short list", async () => {
    const f = fake({ [`${CS}|Sys`]: sys }, MS);
    const { err } = await run1(files, ["core.app"], f);
    expect(err).toBeUndefined();
    expect(f.published).toEqual([`${CS}_Core_28.5.0.336883.app`]);
  });

  test("a Microsoft dependency below its minimum is refused", async () => {
    const f = fake({}, { ...MS, "Base Application": "27.0.0.0" });
    const needy = app("Needy", "1.0.0.0", [
      { name: "Base Application", publisher: "Microsoft", min: "28.0.0.0" },
    ]);
    const { err, log } = await run1({ "n.app": needy }, ["n.app"], f);
    expect(err).toBeDefined();
    expect(log).toContain("needs Microsoft Base Application >= 28.0.0.0, has 27.0.0.0");
  });
});

describe("decisions", () => {
  test("absent apps publish in order and are read back", async () => {
    const f = fake({}, MS);
    const { err, log } = await run1(files, ["sys.app", "core.app"], f);
    expect(err).toBeUndefined();
    expect(f.published).toEqual([`${CS}_Sys_28.5.0.336834.app`, `${CS}_Core_28.5.0.336883.app`]);
    expect(log).toContain("publish   new Sys 28.5.0.336834");
    expect(log).toContain(`raw sha256 ${sha256Of(sys)} = local`);
  });

  test("same content is skipped", async () => {
    const f = fake({ [`${CS}|Sys`]: sys, [`${CS}|Core`]: core }, MS);
    const { err, log } = await run1(files, ["sys.app", "core.app"], f);
    expect(err).toBeUndefined();
    expect(log).toContain("skip      Sys 28.5.0.336834: same content");
    expect(f.published).toEqual([]);
  });

  test("a lower resident version is an upgrade", async () => {
    const f = fake({ [`${CS}|Sys`]: app("Sys", "28.4.0.1") }, MS);
    const { err, log } = await run1({ "sys.app": sys }, ["sys.app"], f);
    expect(err).toBeUndefined();
    expect(log).toContain("publish   upgrade Sys 28.4.0.1 -> 28.5.0.336834");
    expect(f.published).toHaveLength(1);
  });

  test("a higher resident version is refused", async () => {
    const f = fake({ [`${CS}|Sys`]: app("Sys", "29.0.0.1") }, MS);
    const { err, log } = await run1({ "sys.app": sys }, ["sys.app"], f);
    expect(err?.message).toContain("NOTHING was published");
    expect(log).toContain("refuse    above-build Sys");
  });

  test("the same version with other content is refused", async () => {
    const f = fake({ [`${CS}|Sys`]: app("Sys", "28.5.0.336834", [], "other") }, MS);
    const { err, log } = await run1({ "sys.app": sys }, ["sys.app"], f);
    expect(err).toBeDefined();
    expect(log).toContain("refuse    same-version-other-content Sys");
    expect(f.published).toEqual([]);
  });

  test("one refusal stops every publish, including an app that was fine", async () => {
    const f = fake({ [`${CS}|Core`]: app("Core", "99.0.0.0") }, MS);
    const { err } = await run1(files, ["sys.app", "core.app"], f);
    expect(err).toBeDefined();
    expect(f.published).toEqual([]);
  });

  test("--predict decides and publishes nothing", async () => {
    const f = fake({}, MS);
    const { err, log } = await run1(files, ["sys.app", "core.app"], f, ["--predict"]);
    expect(err).toBeUndefined();
    expect(log).toContain("predicted: nothing published");
    expect(f.published).toEqual([]);
  });

  test("PR-128 (R1110): an app it would publish that declares a text-optimized field gets the Full-Text Search note; others do not", async () => {
    const onboarding = buildFakeAppWithEntries({
      "NavxManifest.xml": `<Package><App Id="id-Onb" Name="Onb" Publisher="${CS}" Version="30.0.0.0" /><Dependencies></Dependencies><Build Timestamp="t" CompilerVersion="18.0.1.1" /></Package>`,
      "SymbolReference.json": JSON.stringify({
        Tables: [
          {
            Id: 5,
            Name: "KYC Company",
            Fields: [
              { Id: 1, Name: "Name", Properties: [{ Name: "OptimizeForTextSearch", Value: "1" }] },
            ],
          },
        ],
      }),
    });
    const f = fake({}, MS);
    const { err, log } = await run1(
      { ...files, "onb.app": onboarding },
      ["sys.app", "onb.app"],
      f,
      ["--predict"],
    );
    expect(err).toBeUndefined();
    const notes = log.split("\n").filter((l) => l.trimStart().startsWith("note"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Onb");
    expect(notes[0]).toContain("KYC Company.Name");
    expect(notes[0]).toContain("Full-Text Search");
  });

  test("PR-128: an app already resident with the same content (skipped) gets no note", async () => {
    const onboarding = buildFakeAppWithEntries({
      "NavxManifest.xml": `<Package><App Id="id-Onb" Name="Onb" Publisher="${CS}" Version="30.0.0.0" /><Dependencies></Dependencies><Build Timestamp="t" CompilerVersion="18.0.1.1" /></Package>`,
      "SymbolReference.json": JSON.stringify({
        Tables: [
          {
            Id: 5,
            Name: "T",
            Fields: [
              { Id: 1, Name: "N", Properties: [{ Name: "OptimizeForTextSearch", Value: "1" }] },
            ],
          },
        ],
      }),
    });
    const f = fake({ [`${CS}|Onb`]: onboarding }, MS);
    const { log } = await run1({ "onb.app": onboarding }, ["onb.app"], f, ["--predict"]);
    expect(log).not.toContain("Full-Text Search");
  });

  test("a read-back that does not match fails loudly", async () => {
    const f = fake({}, MS);
    f.skipStore.add("Sys");
    const { err } = await run1({ "sys.app": sys }, ["sys.app"], f);
    expect(err?.message).toContain("read-back of Sys");
  });
});

describe("--ids", () => {
  test("reads rows per id and never lists extensions", async () => {
    const f = fake({ [`${CS}|Sys`]: sys }, MS);
    const log: string[] = [];
    const args = parseArgs([
      "--server",
      "bc2",
      "--lane",
      "L",
      "--token-dir",
      "/t",
      "--ids",
      "id-Sys",
      "other",
    ]);
    expect(args.ids).toEqual(["id-Sys", "other"]);
    await run(args, { ops: f.ops, read: () => Buffer.alloc(0), log: (s) => log.push(s) });
    expect(f.calls).toEqual(["rows id-Sys", "rows other"]);
    expect(log.join("\n")).toContain("ids       other: rows: none");
    expect(f.published).toEqual([]);
  });
});

describe("parseArgs", () => {
  test("needs a lane, a token dir and something to do", () => {
    expect(() => parseArgs(["--server", "bc1", "--token-dir", "/t", "--", "a.app"])).toThrow(
      "--lane",
    );
    expect(() => parseArgs(["--server", "bc1", "--lane", "L", "--token-dir", "/t"])).toThrow(
      "name app files",
    );
    expect(() =>
      parseArgs(["--server", "bc9", "--lane", "L", "--token-dir", "/t", "--ids", "x"]),
    ).toThrow("--server");
  });

  test("--held-lease is carried, and absent unless given", () => {
    const base = ["--server", "bc4", "--lane", "L", "--token-dir", "/t", "--ids", "x"];
    expect(parseArgs(base).heldLease).toBeUndefined();
    expect(parseArgs([...base.slice(0, 6), "--held-lease", "tok", "--ids", "x"]).heldLease).toBe(
      "tok",
    );
    expect(() => parseArgs([...base.slice(0, 6), "--held-lease", "--ids", "x"])).toThrow(
      "--held-lease needs a value",
    );
  });
});
