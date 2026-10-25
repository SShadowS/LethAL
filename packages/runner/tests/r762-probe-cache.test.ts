// R762 (lever 4): the contract-probe cache in AlRunnerV3Backend.status(). Each key part and each
// guard has a test per direction; the probe is stubbed with a call counter (never wall-clock).
// Nothing here touches /coord or /work/tools: every pinned build lives in a temp folder.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerV3Backend } from "../src/al-runner-v3-backend";
import * as contractNs from "../src/al-runner-v3-contract";
import type { V3ContractResult, V3Fact } from "../src/al-runner-v3-contract";
import { sha256OfFile } from "../src/al-runner-v3-pin";
import * as cacheNs from "../src/al-runner-v3-probe-cache";
import { buildBackend, parseCliConfig } from "../src/cli";
import { FRESH_PROBE_ENV, isCacheable, probeCodeHash } from "../src/al-runner-v3-probe-cache";
import type { SpawnFn } from "../src/publisher";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const VERSION = "al-runner 3.0.0-alpha.4+edge.20261022 (57f1e4f98)";
const versionOnly: SpawnFn = async () => ({ exitCode: 0, stdout: `${VERSION}\n`, stderr: "" });
const fact = (verdict: V3Fact["verdict"], kind: V3Fact["kind"] = "contract"): V3Fact => ({
  fact: "f",
  kind,
  verdict,
  expected: "x",
  measured: "m",
});
const PASS: V3ContractResult = { facts: [fact("matches"), fact("gone", "defect")] };

interface Env {
  readonly root: string;
  readonly bin: string;
  readonly deps: string;
  readonly alc: string;
}
let roots: string[] = [];
let probe: ReturnType<typeof spyOn<typeof contractNs, "runV3ContractProbe">>;
let result: V3ContractResult = PASS;
let warns: string[] = [];
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;

beforeEach(() => {
  result = PASS;
  warns = [];
  probe = spyOn(contractNs, "runV3ContractProbe").mockImplementation(async () => result);
  warn = spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  });
});
afterEach(async () => {
  probe.mockRestore();
  warn.mockRestore();
  // biome-ignore lint/performance/noDelete: an env var set to undefined becomes the string "undefined"
  delete process.env[FRESH_PROBE_ENV];
  for (const r of roots) await rm(r, { recursive: true, force: true });
  roots = [];
});

async function env(opts: { candidate?: boolean } = {}): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r762-"));
  roots.push(root);
  const deps = join(root, "deps");
  await mkdir(deps, { recursive: true });
  const NS = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';
  await writeFile(
    join(deps, "Microsoft_System Application.app"),
    buildFakeAppWithEntries({
      "NavxManifest.xml": `<?xml version="1.0"?><Package ${NS}><App Id="1" Name="System Application" Publisher="Microsoft" Version="28.0.46665.47126" /></Package>`,
    }),
  );
  const bin = join(root, "al-runner");
  await writeFile(bin, "binary");
  const alc = join(root, "alc");
  await writeFile(alc, "alc-v1");
  const e = { root, bin, deps, alc };
  if (opts.candidate !== true) await gate(e);
  return e;
}
async function gate(e: Env): Promise<void> {
  await writeFile(
    join(e.root, ".gated"),
    JSON.stringify({
      version: VERSION,
      binarySha256: await sha256OfFile(e.bin),
      lethalCommit: "a".repeat(40),
    }),
  );
}
function statusOf(e: Env, extra: { candidate?: boolean; freshProbe?: boolean } = {}) {
  const b = new AlRunnerV3Backend(
    {
      alRunnerPath: e.bin,
      instrumentedDir: join(e.root, "scratch"),
      testDir: join(e.root, "tests"),
      packagesDir: e.deps,
      bcVersion: "28.0.46665.47126",
      selectorObjectId: 79199,
      alcPath: e.alc,
      coverage: "none",
      ...extra,
    },
    versionOnly,
  );
  return b.status();
}
const entries = async (e: Env) =>
  (await readdir(e.root)).filter((f) => f.startsWith(".probe-cache-") && f.endsWith(".json"));

describe("R762: a hit skips the probe", () => {
  test("the second session of the same inputs does not run the probe and says so", async () => {
    const e = await env();
    const a = await statusOf(e);
    expect(a.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(warns.join("\n")).toMatch(/probe ran fresh \(key [0-9a-f]{12}; no entry\)/);
    const b = await statusOf(e);
    expect(b.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(warns.join("\n")).toMatch(/probe from cache \(key [0-9a-f]{12}\)/);
    expect(b.details).toMatch(/probe from cache/);
    expect((await entries(e)).length).toBe(1);
  });
});

describe("R762: each key part re-runs the probe", () => {
  test("binary sha256", async () => {
    const e = await env();
    await statusOf(e);
    await writeFile(e.bin, "binary-2");
    await gate(e);
    await statusOf(e);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  test("probe code hash", async () => {
    const e = await env();
    await statusOf(e);
    const h = spyOn(cacheNs, "probeCodeHash").mockResolvedValue("changed");
    try {
      await statusOf(e);
    } finally {
      h.mockRestore();
    }
    expect(probe).toHaveBeenCalledTimes(2);
  });
  test("packages fingerprint", async () => {
    const e = await env();
    await statusOf(e);
    await writeFile(join(e.deps, "Other.app"), "not an app");
    await statusOf(e);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  test("alc identity", async () => {
    const e = await env();
    await statusOf(e);
    await writeFile(e.alc, "alc-v2");
    await statusOf(e);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  test("other direction: a file that is not an .app does not move the fingerprint", async () => {
    const e = await env();
    await statusOf(e);
    await writeFile(join(e.deps, "notes.txt"), "x");
    await statusOf(e);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("R762: a bad entry or a bad result means run the probe", () => {
  test("a corrupt entry re-runs it and is replaced by a good one", async () => {
    const e = await env();
    await statusOf(e);
    const [name] = await entries(e);
    expect(name).toBeDefined();
    await writeFile(join(e.root, name ?? ""), "{ not json");
    expect((await statusOf(e)).ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(warns.join("\n")).toMatch(/unusable/);
    await statusOf(e);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  test("an entry whose stored key differs re-runs it", async () => {
    const e = await env();
    await statusOf(e);
    const [name] = await entries(e);
    const p = join(e.root, name ?? "");
    const doc = JSON.parse(await readFile(p, "utf8"));
    doc.key.bcVersion = "1.2.3.4";
    await writeFile(p, JSON.stringify(doc));
    await statusOf(e);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  test("an unreadable entry (a directory in its place) re-runs it", async () => {
    const e = await env();
    await statusOf(e);
    const [name] = await entries(e);
    const p = join(e.root, name ?? "");
    await rm(p);
    await mkdir(p);
    expect((await statusOf(e)).ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  for (const [label, r] of [
    ["a diverged contract fact", { facts: [fact("diverged")] }],
    ["a diverged defect fact", { facts: [fact("matches"), fact("diverged", "defect")] }],
    ["a refused defect fact", { facts: [fact("matches"), fact("refused", "defect")] }],
    ["an unlike-bc fact", { facts: [fact("matches"), fact("unlike-bc", "defect")] }],
    ["an unmeasurable fact", { facts: [fact("unmeasurable")] }],
  ] as const) {
    test(`${label} is not cached; the probe runs each time`, async () => {
      result = r;
      const e = await env();
      // A `refused` defect fact only warns; the others refuse. Neither is stored.
      const ok = label === "a refused defect fact";
      expect((await statusOf(e)).ok).toBe(ok);
      expect((await statusOf(e)).ok).toBe(ok);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(await entries(e)).toEqual([]);
    });
  }
  test("a hand-written entry holding a diverged result is never read as a pass", async () => {
    const e = await env();
    await statusOf(e);
    const [name] = await entries(e);
    const p = join(e.root, name ?? "");
    const doc = JSON.parse(await readFile(p, "utf8"));
    doc.result = { facts: [fact("diverged")] };
    await writeFile(p, JSON.stringify(doc));
    result = PASS;
    expect((await statusOf(e)).ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  test("isCacheable: a pass is cacheable, a diverged one is not", () => {
    expect(isCacheable(PASS)).toBe(true);
    expect(isCacheable({ facts: [fact("diverged")] })).toBe(false);
  });
});

describe("R762: forced fresh and never-cached sessions", () => {
  test("cfg.freshProbe runs the probe although an entry exists", async () => {
    const e = await env();
    await statusOf(e);
    await statusOf(e, { freshProbe: true });
    expect(probe).toHaveBeenCalledTimes(2);
  });
  test(`${FRESH_PROBE_ENV}=1 runs the probe although an entry exists`, async () => {
    const e = await env();
    await statusOf(e);
    process.env[FRESH_PROBE_ENV] = "1";
    await statusOf(e);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  test("other direction: the env var set to 0 does not force it", async () => {
    const e = await env();
    await statusOf(e);
    process.env[FRESH_PROBE_ENV] = "0";
    await statusOf(e);
    expect(probe).toHaveBeenCalledTimes(1);
  });
  test("a candidate session neither reads nor writes the cache", async () => {
    const e = await env({ candidate: true });
    await statusOf(e, { candidate: true });
    await statusOf(e, { candidate: true });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(await entries(e)).toEqual([]);
  });
  test("a candidate does not read a normal session's entry", async () => {
    const e = await env();
    await statusOf(e);
    await statusOf(e, { candidate: true });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe("R762: --fresh-probe reaches the backend", () => {
  const argv = ["run", "--project", "p", "--tests", "t", "--backend", "al-runner-v3"];
  test("the flag parses to freshProbe, and is absent without it", () => {
    expect(parseCliConfig([...argv, "--fresh-probe"])).toMatchObject({ freshProbe: true });
    expect(parseCliConfig(argv)).not.toHaveProperty("freshProbe");
  });
  test("buildBackend threads it into the al-runner-v3 config, and only when set", async () => {
    if (process.platform !== "linux") return; // v3 is refused off Linux (M9)
    const build = async (freshProbe: boolean) => {
      const e = await env();
      await writeFile(
        join(e.root, "app.json"),
        JSON.stringify({
          id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
          idRanges: [{ from: 79000, to: 79199 }],
          runtime: "17.0",
        }),
      );
      const b = await buildBackend(
        {
          mode: "run",
          projectDir: e.root,
          testDir: e.root,
          backendKind: "al-runner-v3",
          ...(freshProbe ? { freshProbe: true } : {}),
        } as Parameters<typeof buildBackend>[0],
        {
          alRunnerV3: {
            packagesDir: e.deps,
            bcVersion: "28.0.46665.47126",
            alcPath: "/fake/alc",
            coverage: "none",
          },
        },
        e.root,
        undefined,
        {},
        { selectorId: 79199, controlId: 79198, tableId: 79197 },
      );
      return (b as unknown as { cfg: { freshProbe?: boolean } }).cfg.freshProbe;
    };
    expect(await build(true)).toBe(true);
    expect(await build(false)).toBeUndefined();
  });
});

describe("R762: the gates always run fresh", () => {
  test("the v3 itest sets the fresh-probe variable before any session starts", async () => {
    const src = await readFile(join(import.meta.dir, "../itest/al-runner-v3.itest.ts"), "utf8");
    expect(src).toMatch(/process\.env\[FRESH_PROBE_ENV\] = "1"/);
  });
  test("leg C calls the probe directly, never through the cache", async () => {
    const src = await readFile(join(import.meta.dir, "../itest/al-runner-v3.itest.ts"), "utf8");
    expect(src).toMatch(/await runV3ContractProbe\(/);
  });
  test("probeCodeHash is stable for the same files and undefined when one is missing", async () => {
    const a = await probeCodeHash();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await probeCodeHash()).toBe(a);
    expect(await probeCodeHash(import.meta.dir, ["no-such-file.ts"])).toBeUndefined();
  });
});
