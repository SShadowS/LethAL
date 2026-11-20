// R814: the committed gated builds, the mechanical pin, and the manifest path of `checkGated`.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlRunnerV3UngatedBuildError,
  V3_PIN_FROM_ENV,
  checkGated,
  resolveV3Binary,
  v3InstallHint,
} from "../src/al-runner-v3-pin";
import {
  FROZEN_V3_PINS,
  type GatedBuildEntry,
  V3_BUILD_PINS,
  adoptV3Pin,
  findGatedBuild,
  findV3Pin,
  gatedBuilds,
  handV3Pin,
  newestGatedRelease,
  parseGatedBuilds,
  resetAdoptedV3Pins,
  v3ReadingsDigest,
} from "../src/al-runner-v3-pins";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ROOT_PIN = "alpha.12-d4bc8d3a5";
const HAND = new Set(V3_BUILD_PINS.map((p) => p.id));
const row = (over: Record<string, unknown> = {}) => ({
  id: "edge-abc123456",
  track: "edge",
  version: "al-runner 3.0.0-alpha.13+edge.20261105 (abc123456)",
  binarySha256: sha("b"),
  readingsFrom: ROOT_PIN,
  readingsDigest: sha("d"),
  lethalCommit: "a".repeat(40),
  gatedAt: "2026-11-05T00:00:00Z",
  ...over,
});

let dir = "";
afterEach(async () => {
  resetAdoptedV3Pins();
  if (dir !== "") await rm(dir, { recursive: true, force: true });
  dir = "";
});
async function binary(bytes: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "lethal-r814-"));
  const p = join(dir, "al-runner");
  await writeFile(p, bytes);
  return p;
}

describe("R814: an entry cannot carry a reading", () => {
  test("a well-formed row parses", () => {
    expect(parseGatedBuilds([row()], HAND)).toHaveLength(1);
  });
  test("any key beyond the fixed set refuses: legC, legT, xb, o1, anything", () => {
    for (const k of ["legC", "legT", "xb", "o1", "serveRowFields", "anything"])
      expect(() => parseGatedBuilds([row({ [k]: {} })], HAND)).toThrow(`unknown key "${k}"`);
  });
  test("readingsFrom must be a hand pin: an entry's id or nothing refuses", () => {
    const a = row();
    const b = row({ id: "edge-def", binarySha256: sha("c"), readingsFrom: a.id });
    expect(() => parseGatedBuilds([a, b], HAND)).toThrow("is no hand pin");
    expect(() => parseGatedBuilds([row({ readingsFrom: "nope" })], HAND)).toThrow("is no hand pin");
  });
  test("PR-117: batchFacts is an allowed key and must map names to strings; warnFacts the same", () => {
    expect(
      parseGatedBuilds([row({ batchFacts: { "batch-no-cross-row": "matches" } })], HAND),
    ).toHaveLength(1);
    expect(() => parseGatedBuilds([row({ batchFacts: { a: 1 } })], HAND)).toThrow(
      "batchFacts must map names to strings",
    );
    expect(() => parseGatedBuilds([row({ batchFacts: "matches" })], HAND)).toThrow(
      "batchFacts must map names to strings",
    );
    expect(() => parseGatedBuilds([row({ batchFacts: null })], HAND)).toThrow(
      "batchFacts must map names to strings",
    );
  });
  test("a duplicate id or a duplicate build refuses", () => {
    expect(() => parseGatedBuilds([row(), row({ binarySha256: sha("c") })], HAND)).toThrow(
      "duplicate",
    );
    expect(() => parseGatedBuilds([row(), row({ id: "other" })], HAND)).toThrow("duplicate");
  });
  test("a release needs a tag; bad shapes refuse", () => {
    expect(() => parseGatedBuilds([row({ track: "release" })], HAND)).toThrow("needs its tag");
    expect(() => parseGatedBuilds([row({ track: "other" })], HAND)).toThrow("track");
    expect(() => parseGatedBuilds([row({ binarySha256: "x" })], HAND)).toThrow("binarySha256");
    expect(() => parseGatedBuilds([row({ lethalCommit: "abc" })], HAND)).toThrow("lethalCommit");
    expect(() => parseGatedBuilds({}, HAND)).toThrow("not an array");
  });
  test("PR-255: track main parses (no tag needed); any other new track, nightly, still refuses", () => {
    const main = row({
      id: "main-9835579c6",
      track: "main",
      version: "al-runner 3.0.0-alpha.14+main.20261120 (9835579c6)",
    });
    expect(parseGatedBuilds([main], HAND)).toEqual([main] as unknown as GatedBuildEntry[]);
    expect(() => parseGatedBuilds([row({ track: "nightly" })], HAND)).toThrow(
      "track must be edge, release or main",
    );
  });
});

describe("R814: the committed file", () => {
  test("every row parses, and its readings digest equals its hand pin's today", () => {
    expect(gatedBuilds().length).toBeGreaterThan(0);
    for (const e of gatedBuilds()) {
      const root = handV3Pin(e.readingsFrom);
      expect(root).toBeDefined();
      if (root !== undefined)
        expect([e.id, v3ReadingsDigest(root)]).toEqual([e.id, e.readingsDigest]);
    }
  });
  // PR-209 amendment 10: live rows read the new readings, frozen rows keep the old ones.
  const OLD_DIGEST = "e8ce7f407331a81d7f1abe10748d6eaf0094de9379af90ec34c66739c1dae3ac";
  const NEW_DIGEST = "df57baf0e46da269f6f9e685be0f473a80092eea1c972dd77b8ca6877d13bb15";
  // PR-255: a row gated on (or judged against) the main-9835579c6 pin: the root's readings plus o1.partnerLoginRefusal. Its
  // own digest, pinned here, so an edit of that pin (or a row naming it with another digest) fails like any other.
  const MAIN_PIN = "main-9835579c6";
  const MAIN_DIGEST = "d60c889b7afb23a3077b667b7f6b512aca95923b6f3b4ae2266d1a0c5d045521";
  test("PR-255: the main-9835579c6 pin's digest is the pinned one", () => {
    const p = handV3Pin(MAIN_PIN);
    if (p === undefined) throw new Error("no main pin");
    expect(v3ReadingsDigest(p)).toBe(MAIN_DIGEST);
  });
  /** The ids of rows whose digest differs from its hand pin's today. */
  const badRows = (rows: readonly GatedBuildEntry[]) =>
    rows
      .filter((e) => {
        const p = handV3Pin(e.readingsFrom);
        return p === undefined || v3ReadingsDigest(p) !== e.readingsDigest;
      })
      .map((e) => e.id);
  /** PR-255: the digest a live row must carry: its pin's own if it reads from main-9835579c6, else the new one. */
  const liveDigest = (e: GatedBuildEntry) =>
    e.readingsFrom === MAIN_PIN ? MAIN_DIGEST : NEW_DIGEST;
  test("PR-209 amendment 10: live rows sit at the new digest (PR-255: main-9835579c6's rows at its own), frozen rows at the old one", () => {
    const rows = gatedBuilds();
    const frozen = rows.filter((e) => handV3Pin(e.readingsFrom)?.frozen !== undefined);
    expect(frozen.length).toBe(11);
    for (const e of frozen) expect([e.id, e.readingsDigest]).toEqual([e.id, OLD_DIGEST]);
    for (const e of rows.filter((x) => !frozen.includes(x)))
      expect([e.id, e.readingsDigest]).toEqual([e.id, liveDigest(e)]);
    expect(badRows(rows)).toEqual([]);
  });
  test("PR-255: a row reading from main-9835579c6 passes at its own digest and fails at the new one; a row reading from the root fails at main's", () => {
    const base = gatedBuilds().find((e) => handV3Pin(e.readingsFrom)?.frozen === undefined);
    if (base === undefined) throw new Error("need a live row");
    const mainRow = {
      ...base,
      id: "main-9835579c6",
      track: "main" as const,
      readingsFrom: MAIN_PIN,
      readingsDigest: MAIN_DIGEST,
    };
    expect(liveDigest(mainRow)).toBe(MAIN_DIGEST);
    expect(badRows([mainRow])).toEqual([]);
    expect(badRows([{ ...mainRow, readingsDigest: NEW_DIGEST }])).toEqual(["main-9835579c6"]);
    expect(badRows([{ ...base, readingsDigest: MAIN_DIGEST }])).toEqual([base.id]);
  });
  test("PR-209 amendment 10: a frozen row with the new digest fails, and a live row with the old digest fails", () => {
    const rows = gatedBuilds();
    const frozen = rows.find((e) => handV3Pin(e.readingsFrom)?.frozen !== undefined);
    const off = badRows(rows);
    const live = rows.find(
      (e) => handV3Pin(e.readingsFrom)?.frozen === undefined && !off.includes(e.id),
    );
    if (frozen === undefined || live === undefined) throw new Error("need a row of each kind");
    const swap = (id: string, readingsDigest: string) =>
      rows.map((e) => (e.id === id ? { ...e, readingsDigest } : e));
    // Rows already off before the swap (a row awaiting its refresh) are not this test's concern.
    const newBad = (r: readonly GatedBuildEntry[]) => badRows(r).filter((i) => !off.includes(i));
    expect(newBad(swap(frozen.id, NEW_DIGEST))).toEqual([frozen.id]);
    expect(newBad(swap(live.id, OLD_DIGEST))).toEqual([live.id]);
  });
  test("PR-209 amendment 10: the frozen readings' digest is the old one, and alpha.12's equals its row's", () => {
    expect(FROZEN_V3_PINS.length).toBe(2);
    for (const p of FROZEN_V3_PINS) {
      expect(p.frozen?.reason).toContain("PR-209 amendment 10");
      expect(v3ReadingsDigest(p)).toBe(OLD_DIGEST);
    }
    const a12 = gatedBuilds().find((e) => e.id === "alpha.12-d4bc8d3a5");
    const pin = handV3Pin(a12?.readingsFrom ?? "");
    expect(pin?.frozen).toBeDefined();
    expect(pin === undefined ? "" : v3ReadingsDigest(pin)).toBe(a12?.readingsDigest ?? "no row");
    expect(pin?.o1?.cdoApps).toBe(18);
  });
  test("PR-209 amendment 10: findV3Pin never answers a build with a frozen pin; adoption refuses one", () => {
    for (const id of ["edge-d72d3197d", "alpha.12-d4bc8d3a5"]) {
      const live = V3_BUILD_PINS.find((p) => p.id === id);
      if (live === undefined) throw new Error(`no live pin ${id}`);
      const found = findV3Pin(live.version, live.binarySha256);
      expect(found?.id).toBe(id);
      expect(found?.frozen).toBeUndefined();
      expect(found?.legT.total).toBe(450);
    }
    expect(V3_BUILD_PINS.some((p) => p.frozen !== undefined)).toBe(false);
    expect(() => adoptV3Pin("v", sha("x"), "edge-d72d3197d-frozen-pre-pr209")).toThrow("frozen");
  });
  test("the digest moves when a reading moves, and ignores the build's identity", () => {
    const root = handV3Pin(ROOT_PIN);
    if (root === undefined) throw new Error("no root pin");
    const same = { ...root, id: "x", version: "y", binarySha256: "z" };
    expect(v3ReadingsDigest(same)).toBe(v3ReadingsDigest(root));
    const moved = { ...root, legT: { ...root.legT, total: root.legT.total + 1 } };
    expect(v3ReadingsDigest(moved)).not.toBe(v3ReadingsDigest(root));
    const legC = { ...root.legC };
    legC["sleep-is-noop"] = { ...legC["sleep-is-noop"], measured: /other/ } as never;
    expect(v3ReadingsDigest({ ...root, legC })).not.toBe(v3ReadingsDigest(root));
  });
  test("the manifest has a newest release, with a tag", () => {
    expect(newestGatedRelease()?.tag).toMatch(/^v3\.0\.0-alpha\.\d+$/);
  });
});

describe("R814: findV3Pin and adoption", () => {
  const version = "al-runner 3.0.0-alpha.99+edge.20991231 (fff000111)";
  test("no pin, no entry, no adoption: undefined", () => {
    expect(findV3Pin(version, sha("x"))).toBeUndefined();
  });
  test("adopted: the hand pin's readings, the SAME objects, under that hand pin's id", () => {
    adoptV3Pin(version, sha("x"), ROOT_PIN);
    const pin = findV3Pin(version, sha("x"));
    const root = handV3Pin(ROOT_PIN);
    expect(pin?.id).toBe(ROOT_PIN);
    expect(pin?.legC).toBe(root?.legC);
    expect(pin?.legT).toBe(root?.legT);
    expect(pin?.version).toBe(version);
  });
  test("adoption is per exact build: another sha or version stays unpinned", () => {
    adoptV3Pin(version, sha("x"), ROOT_PIN);
    expect(findV3Pin(version, sha("y"))).toBeUndefined();
    expect(findV3Pin(`${version} `, sha("x"))).toBeUndefined();
  });
  test("an unknown id throws by name", () => {
    expect(() => adoptV3Pin(version, sha("x"), "no-such-pin")).toThrow(
      "al-runner-v3-unknown-readings",
    );
  });
  test("a hand pin always wins over an adoption for its own build", () => {
    const hand = V3_BUILD_PINS[0];
    if (hand === undefined) throw new Error("no pins");
    adoptV3Pin(hand.version, hand.binarySha256, ROOT_PIN);
    expect(findV3Pin(hand.version, hand.binarySha256)?.id).toBe(hand.id);
  });
});

describe("R814: checkGated", () => {
  const seed = () => {
    const e = newestGatedRelease();
    if (e === undefined) throw new Error("no gated release");
    return e;
  };

  test("candidate: LETHAL_V3_PIN_FROM adopts; without candidate mode it is ignored", async () => {
    const p = await binary("cand");
    const v = "al-runner 3.0.0-alpha.99 (fff000111)";
    process.env[V3_PIN_FROM_ENV] = ROOT_PIN;
    try {
      await expect(checkGated(p, v)).rejects.toThrow(AlRunnerV3UngatedBuildError);
      expect(findV3Pin(v, sha("cand"))).toBeUndefined();
      await checkGated(p, v, { candidate: true });
      expect(findV3Pin(v, sha("cand"))?.id).toBe(ROOT_PIN);
    } finally {
      delete process.env[V3_PIN_FROM_ENV];
    }
  });

  test("a candidate with no env stays unpinned", async () => {
    const p = await binary("cand2");
    const v = "al-runner 3.0.0-alpha.99 (fff000222)";
    await checkGated(p, v, { candidate: true });
    expect(findV3Pin(v, sha("cand2"))).toBeUndefined();
  });

  test("a .gated with readingsFrom adopts; an unknown one refuses by name", async () => {
    const p = await binary("mech");
    const v = "al-runner 3.0.0-alpha.99 (fff000333)";
    const gated = (from: string) =>
      JSON.stringify({
        version: v,
        binarySha256: sha("mech"),
        lethalCommit: "a".repeat(40),
        readingsFrom: from,
      });
    await writeFile(join(dir, ".gated"), gated(ROOT_PIN));
    const g = await checkGated(p, v);
    expect(g.readingsFrom).toBe(ROOT_PIN);
    expect(g.source).toBeUndefined();
    expect(findV3Pin(v, sha("mech"))?.id).toBe(ROOT_PIN);
    resetAdoptedV3Pins();
    await writeFile(join(dir, ".gated"), gated("no-such-pin"));
    await expect(checkGated(p, v)).rejects.toThrow("al-runner-v3-unknown-readings");
  });

  test("the manifest: a listed release passes with no .gated, and says where it came from", async () => {
    const p = await binary("listed");
    const v = "al-runner 3.0.0-alpha.99 (fff000444)";
    const entry = (track: string): GatedBuildEntry =>
      ({
        ...row({ track, tag: "v3.0.0-alpha.99", version: v, binarySha256: sha("listed") }),
        warnFacts: { "serve-keep-reasons": "matches" },
        batchFacts: { "batch-no-cross-row": "matches", "batch-lane-hint-only": "diverged" },
      }) as unknown as GatedBuildEntry;
    const g = await checkGated(p, v, {
      findBuild: (a, b) => (a === v && b === sha("listed") ? entry("release") : undefined),
    });
    expect(g).toMatchObject({
      version: v,
      binarySha256: sha("listed"),
      lethalCommit: "a".repeat(40),
      source: "manifest",
      readingsFrom: ROOT_PIN,
      warnFacts: { "serve-keep-reasons": "matches" },
      // PR-117: the manifest path carries the row's batchFacts into the record the backend reads.
      batchFacts: { "batch-no-cross-row": "matches", "batch-lane-hint-only": "diverged" },
    });
    await expect(checkGated(p, v, { findBuild: () => entry("edge") })).rejects.toThrow(
      "not a gated build",
    );
    // PR-255: a main row is a record of what `current` was, never the manifest.
    await expect(checkGated(p, v, { findBuild: () => entry("main") })).rejects.toThrow(
      "not a gated build",
    );
    await expect(checkGated(p, v, { findBuild: () => undefined })).rejects.toThrow(
      "not a gated build",
    );
  });

  test("PR-117: the manifest path keeps only verdicts in batchFacts (a non-verdict value is dropped), and none at all when nothing is left", async () => {
    const p = await binary("listed2");
    const v = "al-runner 3.0.0-alpha.99 (fff000555)";
    const entry = (batchFacts: Record<string, unknown>): GatedBuildEntry =>
      ({
        ...row({
          track: "release",
          tag: "v3.0.0-alpha.99",
          version: v,
          binarySha256: sha("listed2"),
        }),
        batchFacts,
      }) as unknown as GatedBuildEntry;
    const g = await checkGated(p, v, {
      findBuild: () => entry({ "batch-no-cross-row": "matches", junk: "pass", n: 1 }),
    });
    expect(g.batchFacts).toEqual({ "batch-no-cross-row": "matches" });
    const none = await checkGated(p, v, { findBuild: () => entry({ junk: "pass" }) });
    expect("batchFacts" in none).toBe(false);
  });

  test("the seed row is findable by its exact build", () => {
    const e = seed();
    expect(findGatedBuild(e.version, e.binarySha256)).toBe(e);
    expect(findGatedBuild(e.version, sha("other"))).toBeUndefined();
    expect(findV3Pin(e.version, e.binarySha256)?.id).toBe(e.readingsFrom);
  });

  test("same version line, another sha: refused, naming the tag and the install command", async () => {
    const e = seed();
    const p = await binary("not the release");
    const refusal = await checkGated(p, e.version).catch((x: unknown) => x);
    expect(refusal).toBeInstanceOf(AlRunnerV3UngatedBuildError);
    const text = String(refusal);
    expect(text).toContain(sha("not the release"));
    expect(text).toContain(`sh -s -- ${e.tag}`);
    expect(text).toContain("alRunnerV3.path");
  });

  test("a missing binary is a refusal with the install command, never a raw ENOENT", async () => {
    const refusal = await checkGated(join(tmpdir(), "no-such-al-runner"), "x").catch(
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(AlRunnerV3UngatedBuildError);
    expect(String(refusal)).toContain("does not exist");
    expect(String(refusal)).toContain(v3InstallHint());
  });

  test("a .gated that mismatches still refuses, even for a version the manifest lists", async () => {
    const e = seed();
    const p = await binary("planted");
    await writeFile(
      join(dir, ".gated"),
      JSON.stringify({
        version: e.version,
        binarySha256: e.binarySha256,
        lethalCommit: "a".repeat(40),
      }),
    );
    await expect(checkGated(p, e.version)).rejects.toThrow("pins");
  });
});

describe("R814: a session resolves `current` once", () => {
  test("resolveV3Binary follows the link; a path that does not resolve stays", async () => {
    dir = await mkdtemp(join(tmpdir(), "lethal-r814-"));
    await mkdir(join(dir, "build-a"));
    await writeFile(join(dir, "build-a", "al-runner"), "a");
    await symlink(join(dir, "build-a"), join(dir, "current"));
    const real = resolveV3Binary(join(dir, "current", "al-runner"));
    expect(real).toBe(await realpath(join(dir, "build-a", "al-runner")));
    expect(real).not.toContain("current");
    expect(resolveV3Binary("/no/such/path")).toBe("/no/such/path");
  });
});
