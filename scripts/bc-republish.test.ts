import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AppManifest } from "./bc-linux-setup.ts";
import { parseArgs, republishPlan } from "./bc-republish.ts";

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

describe("parseArgs", () => {
  test("republish needs a lane (R598: never a default holder)", () => {
    expect(() => parseArgs(["republish", "--server", "bc3", "sandbox-app"])).toThrow(
      /--lane is required/,
    );
    expect(parseArgs(["republish", "--server", "bc3", "--lane", "preproc", "sandbox-app"])).toEqual(
      {
        mode: "republish",
        server: "bc3",
        lane: "preproc",
        apps: ["sandbox-app"],
      },
    );
  });

  test("refuses a bad server, no apps, an unknown flag, and a lane on alpackages", () => {
    expect(() => parseArgs(["republish", "--server", "bc4", "--lane", "x", "a"])).toThrow(
      /--server/,
    );
    expect(() => parseArgs(["republish", "--server", "bc1", "--lane", "x"])).toThrow(
      /at least one/,
    );
    expect(() =>
      parseArgs(["republish", "--server", "bc1", "--lane", "x", "--force", "a"]),
    ).toThrow(/unknown argument/);
    expect(() => parseArgs(["alpackages", "--server", "bc1", "--lane", "x", "a"])).toThrow(
      /no --lane/,
    );
    expect(parseArgs(["alpackages", "--server", "bc2", "a", "b"])).toEqual({
      mode: "alpackages",
      server: "bc2",
      apps: ["a", "b"],
    });
    expect(() => parseArgs(["setup"])).toThrow(/usage/);
  });
});
