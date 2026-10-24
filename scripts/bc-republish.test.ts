import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerOutOfUseError } from "../packages/runner/itest/out-of-use.ts";
import type { AppManifest } from "./bc-linux-setup.ts";
import {
  controlAction,
  guardDependents,
  packageStatus,
  parseArgs,
  publishOrder,
  refuseIfOutOfUse,
  republishPlan,
  roleOf,
} from "./bc-republish.ts";

describe("packageStatus (control: only a 404 means nothing resident)", () => {
  test("a 404 is absent and a 200 is present", () => {
    expect(packageStatus(404)).toBe("absent");
    expect(packageStatus(200)).toBe("present");
  });

  test("any other failure stops the run instead of reading as absent", () => {
    for (const s of [500, 502, 503, 400, 401, 403]) {
      expect(() => packageStatus(s)).toThrow(`HTTP ${s}`);
    }
  });
});

const app = (id: string, deps: string[] = []): AppManifest => ({
  id,
  name: `App ${id}`,
  publisher: "LethAL",
  version: "1.0.0.0",
  dependencies: deps.map((d) => ({ id: d, name: `App ${d}`, publisher: "LethAL" })),
});

describe("republishPlan", () => {
  // t <- tt (tests of t); n <- nt; u is unrelated
  const all = new Map<string, AppManifest>([
    ["tt", app("tt", ["t"])],
    ["t", app("t")],
    ["n", app("n")],
    ["nt", app("nt", ["n"])],
    ["u", app("u")],
  ]);

  test("publishes targets before tests and unpublishes tests before targets", () => {
    const p = republishPlan(["nt", "n"], all);
    expect(p.publish).toEqual(["n", "nt"]);
    expect(p.unpublish).toEqual(["nt", "n"]);
    expect(p.added).toEqual([]);
  });

  test("adds a fixture that depends on a requested app, and orders it after its target", () => {
    const p = republishPlan(["t"], all);
    expect(p.added).toEqual(["tt"]);
    expect(p.publish).toEqual(["t", "tt"]);
    expect(p.unpublish).toEqual(["tt", "t"]);
  });

  test("refuses an unknown fixture and a cycle", () => {
    expect(() => republishPlan(["nope"], all)).toThrow(/unknown fixture/);
    const cyc = new Map([
      ["a", app("a", ["b"])],
      ["b", app("b", ["a"])],
    ]);
    expect(() => republishPlan(["a"], cyc)).toThrow(/cycle/);
  });

  test("R604's real request: the four bc3 apps pull in their two tests apps", () => {
    const fixtures = join(import.meta.dir, "..", "fixtures");
    const real = new Map<string, AppManifest>();
    for (const d of readdirSync(fixtures)) {
      try {
        real.set(d, JSON.parse(readFileSync(join(fixtures, d, "app.json"), "utf8")) as AppManifest);
      } catch {}
    }
    const p = republishPlan(
      ["sandbox-app", "sandbox-hang", "sandbox-names", "sandbox-names-tests"],
      real,
    );
    expect([...p.added].sort()).toEqual(["sandbox-hang-tests", "sandbox-tests"]);
    for (const [target, tests] of [
      ["sandbox-app", "sandbox-tests"],
      ["sandbox-hang", "sandbox-hang-tests"],
      ["sandbox-names", "sandbox-names-tests"],
    ] as const) {
      expect(p.publish.indexOf(target)).toBeLessThan(p.publish.indexOf(tests));
      expect(p.unpublish.indexOf(tests)).toBeLessThan(p.unpublish.indexOf(target));
    }
  });
});

describe("publishOrder and roleOf (R599: nothing is removed, so no dependent is added)", () => {
  const all = new Map<string, AppManifest>([
    ["tt", app("tt", ["t"])],
    ["t", app("t")],
    ["u", app("u")],
  ]);

  test("only the requested apps, each after the requested apps it depends on", () => {
    expect(publishOrder(["t"], all)).toEqual(["t"]);
    expect(publishOrder(["tt", "t"], all)).toEqual(["t", "tt"]);
  });

  test("a fixture some fixture depends on is a target; the rest are dependents", () => {
    expect(roleOf("t", all)).toBe("target");
    expect(roleOf("tt", all)).toBe("dependent");
    expect(roleOf("u", all)).toBe("dependent");
    expect(() => roleOf("nope", all)).toThrow(/unknown fixture/);
  });

  test("a PUBLISH_PLAN target with no dependent (sandbox-probes) is a target, so it is told --mint (M4)", () => {
    const probes = new Map<string, AppManifest>([["sandbox-probes", app("p")]]);
    expect(roleOf("sandbox-probes", probes)).toBe("target");
  });
});

describe("R-707: guardDependents compiles unrequested dependents before anything is published", () => {
  const all = new Map<string, AppManifest>([
    ["tt", app("tt", ["t"])],
    ["t", app("t")],
  ]);
  const run = async (requested: string[], failing: string[]) => {
    const compiled: string[] = [];
    const published: string[][] = [];
    let error: Error | undefined;
    try {
      await guardDependents(
        requested,
        all,
        async (dir) => {
          compiled.push(dir);
          if (failing.includes(dir))
            throw new Error(
              `alc failed on ${dir} (exit 1):\nsrc/Dep.al(7,21): error AL0135: no argument given`,
            );
        },
        async () => void published.push(publishOrder(requested, all)),
      );
    } catch (e) {
      error = e as Error;
    }
    return { compiled, published, error };
  };

  test("(a) a breaking change is refused by name, and nothing is published", async () => {
    const r = await run(["t"], ["tt"]);
    expect(r.error?.message).toContain(
      "refuse dependent-breaks: App tt (src/Dep.al(7,21): error AL0135",
    );
    expect(r.published.length).toBe(0);
  });

  test("(b) a compatible change publishes, after one compile per dependent", async () => {
    const r = await run(["t"], []);
    expect(r.error).toBeUndefined();
    expect(r.compiled).toEqual(["tt"]);
    expect(r.published).toEqual([["t"]]);
  });

  test("(c) a dependent requested with its target is not compiled a second time", async () => {
    const r = await run(["tt", "t"], ["tt"]);
    expect(r.error).toBeUndefined();
    expect(r.compiled.length).toBe(0);
    expect(r.published).toEqual([["t", "tt"]]);
  });
});

describe("controlAction (never removes the control app)", () => {
  const pinned = { version: "1.0.0.23", sha256: "aa" };

  test("publishes up from a lower version or from nothing", () => {
    expect(controlAction({ version: "1.0.0.22", sha256: "bb" }, pinned)).toBe("publish");
    expect(controlAction(null, pinned)).toBe("publish");
  });

  test("does nothing at the pinned build, and refuses a higher or a same-version-other-content one", () => {
    expect(controlAction({ version: "1.0.0.23", sha256: "aa" }, pinned)).toBe("already-pinned");
    expect(() => controlAction({ version: "1.0.0.24", sha256: "aa" }, pinned)).toThrow(
      /above the pinned/,
    );
    expect(() => controlAction({ version: "1.0.0.23", sha256: "cc" }, pinned)).toThrow(
      /not the pinned build/,
    );
  });
});

describe("parseArgs", () => {
  const LT = ["--lane", "preproc", "--token-dir", "/tmp/t"];

  test("needs a lane (R598: never a default holder) and a token dir", () => {
    expect(() =>
      parseArgs(["republish", "--server", "bc3", "--token-dir", "/tmp/t", "sandbox-app"]),
    ).toThrow(/--lane is required/);
    expect(() =>
      parseArgs(["republish", "--server", "bc3", "--lane", "preproc", "sandbox-app"]),
    ).toThrow(/--token-dir is required/);
    expect(parseArgs(["republish", "--server", "bc3", ...LT, "sandbox-app"])).toEqual({
      mode: "republish",
      server: "bc3",
      lane: "preproc",
      tokenDir: "/tmp/t",
      apps: ["sandbox-app"],
      mint: [],
    });
  });

  test("a flag's value may not be another flag", () => {
    expect(() =>
      parseArgs(["republish", "--server", "bc3", "--lane", "--mint", "a", "--token-dir", "/t"]),
    ).toThrow(/--lane needs a value/);
    expect(() => parseArgs(["republish", "--server", "--lane", "x", ...LT, "a"])).toThrow(
      /--server needs a value/,
    );
    expect(() =>
      parseArgs(["republish", "--server", "bc3", "--lane", "x", "--token-dir", "--mint", "a"]),
    ).toThrow(/--token-dir needs a value/);
  });

  test("--mint names a fixture to publish at a minted version, and adds it to the plan", () => {
    expect(parseArgs(["republish", "--server", "bc3", ...LT, "--mint", "a", "b"])).toEqual({
      mode: "republish",
      server: "bc3",
      lane: "preproc",
      tokenDir: "/tmp/t",
      apps: ["a", "b"],
      mint: ["a"],
    });
    expect(() => parseArgs(["republish", "--server", "bc3", ...LT, "--mint"])).toThrow(
      /--mint needs/,
    );
    expect(() => parseArgs(["alpackages", "--server", "bc3", ...LT, "--mint", "a"])).toThrow(
      /no --mint/,
    );
  });

  test("control takes no fixture; the others need one; a bad server or flag is refused", () => {
    expect(parseArgs(["control", "--server", "bc2", ...LT]).mode).toBe("control");
    expect(() => parseArgs(["control", "--server", "bc2", ...LT, "a"])).toThrow(/takes no fixture/);
    expect(() => parseArgs(["republish", "--server", "bc4", ...LT, "a"])).toThrow(/--server/);
    expect(() => parseArgs(["republish", "--server", "bc1", ...LT])).toThrow(/at least one/);
    expect(() => parseArgs(["republish", "--server", "bc1", ...LT, "--force", "a"])).toThrow(
      /unknown argument/,
    );
    expect(parseArgs(["alpackages", "--server", "bc2", ...LT, "a", "b"]).apps).toEqual(["a", "b"]);
    expect(() => parseArgs(["setup"])).toThrow(/usage/);
  });
});

describe("R669: a server with an out-of-use marker is refused before any lease", () => {
  function markerDir(): string {
    const dir = join(mkdtempSync(join(tmpdir(), "republish-ooo-")), "machine", "out-of-use");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bc3.md"), "# bc3 is OUT OF USE\n- **Reason:** SYNTH-REASON\n");
    return dir;
  }

  test("no marker for the server: no throw", () => {
    expect(() => refuseIfOutOfUse("bc2", markerDir(), {}, () => {})).not.toThrow();
  });

  test("a marker: ServerOutOfUseError by name, with its reason", () => {
    expect(() => refuseIfOutOfUse("bc3", markerDir(), {}, () => {})).toThrow(ServerOutOfUseError);
    expect(() => refuseIfOutOfUse("bc3", markerDir(), {}, () => {})).toThrow("SYNTH-REASON");
  });

  test("only the clearing override for that exact server passes, loudly; the owner one does not", () => {
    const logged: string[] = [];
    const clearing = { LETHAL_OUT_OF_USE_CLEARING: "bc3" };
    const log = (l: string) => logged.push(l);
    expect(() => refuseIfOutOfUse("bc3", markerDir(), clearing, log)).not.toThrow();
    expect(logged.join("\n")).toContain("overrides it for the clearing step");
    for (const env of [
      { LETHAL_OUT_OF_USE_CLEARING: "bc2" },
      { LETHAL_OUT_OF_USE_OWNER: "0f1e2d3c4b5a69788796a5b4c3d2e1f0" },
    ])
      expect(() => refuseIfOutOfUse("bc3", markerDir(), env, () => {})).toThrow(
        ServerOutOfUseError,
      );
  });

  test("main calls the check before it dispatches to any mode (each mode leases)", () => {
    const src = readFileSync(join(import.meta.dir, "bc-republish.ts"), "utf8");
    const main = src.slice(src.indexOf("async function main()"));
    const call = "refuseIfOutOfUse(args.server, outOfUseDir(process.env), process.env);";
    const check = main.indexOf(call);
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(main.indexOf("await alpackages(args)"));
  });
});
