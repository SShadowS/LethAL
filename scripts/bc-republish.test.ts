import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AppManifest } from "./bc-linux-setup.ts";
import { controlAction, downgradeRefusal, parseArgs, republishPlan } from "./bc-republish.ts";

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

describe("downgradeRefusal (before anything is removed, R605)", () => {
  const base = { dir: "sandbox-app", publishVersion: "1.0.0.2", minted: false };

  test("refuses when the server holds the app above the version to publish, naming --mint", () => {
    const r = downgradeRefusal([{ ...base, resident: ["1.0.20747.27757"] }]);
    expect(r).toContain("refused before removing anything");
    expect(r).toContain("sandbox-app: the server holds 1.0.20747.27757, above 1.0.0.2");
    expect(r).toContain("--mint sandbox-app");
  });

  test("passes when the version to publish is the same, higher, or nothing is resident", () => {
    expect(downgradeRefusal([{ ...base, resident: ["1.0.0.2"] }])).toBeNull();
    expect(downgradeRefusal([{ ...base, resident: ["1.0.0.1"] }])).toBeNull();
    expect(downgradeRefusal([{ ...base, resident: [] }])).toBeNull();
    expect(
      downgradeRefusal([
        { ...base, publishVersion: "1.0.20747.36583", minted: true, resident: ["1.0.20747.27757"] },
      ]),
    ).toBeNull();
  });

  test("compares numerically, not as strings", () => {
    // "1.0.0.10" > "1.0.0.9" numerically, but not lexically
    expect(
      downgradeRefusal([{ ...base, publishVersion: "1.0.0.9", resident: ["1.0.0.10"] }]),
    ).not.toBeNull();
    expect(
      downgradeRefusal([{ ...base, publishVersion: "1.0.0.10", resident: ["1.0.0.9"] }]),
    ).toBeNull();
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
