import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printItestTarget } from "./config-path";
import { ServerOutOfUseError, markedServerFor, outOfUseDir, outOfUseRefusal } from "./out-of-use";

// R669. Every test plants its markers in its own temp dir: none reads the real /coord.
const MARKER =
  "# bc2 is OUT OF USE\n\n- **Reason:** SYNTH-REASON stranded op\n\n## How to clear it\n1. SYNTH-CLEAR restart\n";
const TOKEN = "r658-hang-abcdef12";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "out-of-use-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function refusal(
  files: Record<string, string>,
  env: Record<string, string>,
  override: "clearing" | "owner",
) {
  const logged: string[] = [];
  const r = outOfUseRefusal("bc2", {
    dir: dirWith(files),
    env,
    override,
    log: (l) => logged.push(l),
  });
  return { r, logged: logged.join("\n") };
}

describe("outOfUseRefusal", () => {
  test("no marker: no refusal, nothing logged", () => {
    expect(refusal({ "bc3.md": MARKER }, {}, "owner")).toEqual({ r: undefined, logged: "" });
  });

  test("a marker: refused by name, with its reason and how to clear it", () => {
    const { r } = refusal({ "bc2.md": MARKER }, {}, "owner");
    expect(r).toContain("bc2 is OUT OF USE:");
    expect(r).toContain("bc2.md exists, so this run refuses before any lease or server call");
    expect(r).toContain("SYNTH-REASON stranded op");
    expect(r).toContain("SYNTH-CLEAR restart");
  });

  test("clearing: the exact server passes, with the loud line naming the marker's reason", () => {
    const { r, logged } = refusal(
      { "bc2.md": MARKER },
      { LETHAL_OUT_OF_USE_CLEARING: "bc2" },
      "clearing",
    );
    expect(r).toBeUndefined();
    expect(logged).toContain("!!! bc2 has an out-of-use marker");
    expect(logged).toContain("overrides it for the clearing step");
    expect(logged).toContain("SYNTH-REASON stranded op");
  });

  test("clearing: a wrong, empty or bogus value refuses", () => {
    for (const v of ["bc3", "", "1", " bc2", "BC2", "all"]) {
      const { r, logged } = refusal(
        { "bc2.md": MARKER },
        { LETHAL_OUT_OF_USE_CLEARING: v },
        "clearing",
      );
      expect(r).toContain("bc2 is OUT OF USE");
      expect(logged).toBe("");
    }
  });

  test("owner: a marker with `owner: <token>` and the same token passes, loudly", () => {
    const { r, logged } = refusal(
      { "bc2.md": `${MARKER}owner: ${TOKEN}\n` },
      { LETHAL_OUT_OF_USE_OWNER: TOKEN },
      "owner",
    );
    expect(r).toBeUndefined();
    expect(logged).toContain("!!! bc2 has an out-of-use marker");
    expect(logged).toContain("owned by this run");
  });

  test("owner: a missing owner line, another token, a short token, or the clearing var refuses", () => {
    const cases: [Record<string, string>, Record<string, string>][] = [
      [{ "bc2.md": MARKER }, { LETHAL_OUT_OF_USE_OWNER: TOKEN }],
      [
        { "bc2.md": `${MARKER}owner: ${TOKEN}\n` },
        { LETHAL_OUT_OF_USE_OWNER: "r658-hang-00000000" },
      ],
      [{ "bc2.md": `${MARKER}owner: abc\n` }, { LETHAL_OUT_OF_USE_OWNER: "abc" }],
      [{ "bc2.md": `${MARKER}owner: \n` }, { LETHAL_OUT_OF_USE_OWNER: "" }],
      [{ "bc2.md": `${MARKER}owner: ${TOKEN}\n` }, { LETHAL_OUT_OF_USE_CLEARING: "bc2" }],
    ];
    for (const [files, env] of cases) {
      const { r, logged } = refusal(files, env, "owner");
      expect(r).toContain("bc2 is OUT OF USE");
      expect(logged).toBe("");
    }
  });
});

describe("markedServerFor: the dev port names the server, on the BC on Linux host only", () => {
  test("7049, 7149 and 7249 are bc1, bc2 and bc3", () => {
    expect(markedServerFor("192.168.2.157", 7049)).toBe("bc1");
    expect(markedServerFor("192.168.2.157", 7149)).toBe("bc2");
    expect(markedServerFor("192.168.2.157", 7249)).toBe("bc3");
  });

  test("an unknown port, or another host on a bc port, has no marker check", () => {
    expect(markedServerFor("192.168.2.157", 7349)).toBeUndefined(); // the talk's demo port
    expect(markedServerFor("cronus28", 7049)).toBeUndefined();
    expect(markedServerFor("10.0.0.1", 7249)).toBeUndefined();
  });
});

describe("outOfUseDir", () => {
  test("LETHAL_COORD_ROOT, else kraken's CG_COORD_ROOT, else the default root", () => {
    expect(outOfUseDir({ LETHAL_COORD_ROOT: "/r" })).toBe(join("/r", "machine", "out-of-use"));
    expect(outOfUseDir({ KRAKEN_PROJECT: "lethal", CG_COORD_ROOT: "/k" })).toBe(
      join("/k", "machine", "out-of-use"),
    );
    expect(outOfUseDir({ CG_COORD_ROOT: "/k" })).toBe(
      join(process.platform === "win32" ? "H:\\lethal-coord" : "/coord", "machine", "out-of-use"),
    );
  });
});

describe("printItestTarget refuses a marked server after printing its target line", () => {
  function print(bcdev: object, dir: string, env: Record<string, string> = {}) {
    const cfg = join(mkdtempSync(join(tmpdir(), "out-of-use-cfg-")), "lethal.config.bc2.json");
    writeFileSync(cfg, JSON.stringify({ bcdev: { serverInstance: "BC", ...bcdev } }));
    const lines: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    console.error = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      printItestTarget(cfg, undefined, { dir, env });
      return { thrown: undefined as unknown, lines };
    } catch (e) {
      return { thrown: e, lines };
    } finally {
      console.log = log;
      console.error = err;
    }
  }
  const BC2 = { server: "http://192.168.2.157:7149", port: 7149 };

  test("no marker: no throw", () => {
    expect(print(BC2, dirWith({ "bc3.md": MARKER })).thrown).toBeUndefined();
  });

  test("bc2 marked: ServerOutOfUseError by name, after the target line", () => {
    const { thrown, lines } = print(BC2, dirWith({ "bc2.md": MARKER }));
    expect(thrown).toBeInstanceOf(ServerOutOfUseError);
    expect((thrown as Error).message).toContain("bc2 is OUT OF USE");
    expect((thrown as Error).message).toContain("SYNTH-REASON stranded op");
    expect(lines[0]).toContain("server=192.168.2.157:7149");
  });

  test("a config with no port at all is the default 7049, so bc1's marker refuses it", () => {
    const { thrown } = print({ server: "http://192.168.2.157" }, dirWith({ "bc1.md": MARKER }));
    expect(thrown).toBeInstanceOf(ServerOutOfUseError);
  });

  test("a Cronus28 config is never checked, even with every bc marker present", () => {
    const dir = dirWith({ "bc1.md": MARKER, "bc2.md": MARKER, "bc3.md": MARKER });
    expect(print({ server: "http://Cronus28" }, dir).thrown).toBeUndefined();
  });

  test("the owner override lets the wrapper's own marker through, loudly; the clearing one does not", () => {
    const dir = dirWith({ "bc2.md": `${MARKER}owner: ${TOKEN}\n` });
    const ok = print(BC2, dir, { LETHAL_OUT_OF_USE_OWNER: TOKEN });
    expect(ok.thrown).toBeUndefined();
    expect(ok.lines.join("\n")).toContain("owned by this run");
    expect(print(BC2, dir, { LETHAL_OUT_OF_USE_CLEARING: "bc2" }).thrown).toBeInstanceOf(
      ServerOutOfUseError,
    );
  });
});

describe("every BC itest reaches the check before anything reads its config", () => {
  const here = import.meta.dir;
  const itests = readdirSync(here).filter((f) => f.endsWith(".itest.ts"));

  test("the line after its config path is chosen is `printItestTarget(<path>);`, with the real marker dir", () => {
    const users = itests.filter((f) =>
      /itestConfigPath\(/.test(readFileSync(join(here, f), "utf8")),
    );
    const wrong = users.filter((f) => {
      const lines = readFileSync(join(here, f), "utf8").split("\n");
      const i = lines.findIndex((l) => /=\s*itestConfigPath\(/.test(l));
      return !/^\s*printItestTarget\(\w+\);\s*$/.test(lines[i + 1] ?? "");
    });
    expect(wrong).toEqual([]);
    expect(users.length).toBeGreaterThanOrEqual(14);
  });
});
