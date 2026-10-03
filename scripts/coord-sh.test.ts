import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envWithFakeBin } from "./fake-path-env.ts";

const COORD_SH = join(import.meta.dir, "coord.sh");

/** A temp bin dir with a fake `kraken` and a fake `deno`; each prints who it is, argv and the root. */
function fakeBin(): string {
  const bin = mkdtempSync(join(tmpdir(), "coord-sh-bin-"));
  for (const name of ["kraken", "deno"]) {
    const f = join(bin, name);
    writeFileSync(f, `#!/usr/bin/env bash\necho "${name} $* root=$CG_COORD_ROOT"\n`);
    chmodSync(f, 0o755);
  }
  return bin;
}

async function run(env: Record<string, string>, ...args: string[]) {
  const base = envWithFakeBin(fakeBin(), [
    "KRAKEN_PROJECT",
    "KRAKEN_AGENT",
    "CG_COORD_ROOT",
    "LETHAL_COORD_ROOT",
  ]);
  const p = Bun.spawn(["bash", COORD_SH, ...args], {
    env: { ...base, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out: out.trim(), err: err.trim(), code };
}

describe("scripts/coord.sh", () => {
  test("KRAKEN_PROJECT set: kraken coord with the inherited root, deno never called", async () => {
    const r = await run(
      { KRAKEN_PROJECT: "lethal", CG_COORD_ROOT: "/coord" },
      "status",
      "--lane",
      "code",
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe("kraken coord status --lane code root=/coord");
  });

  test("the owner's shell pane (KRAKEN_PROJECT, no KRAKEN_AGENT) behaves the same", async () => {
    const r = await run({ KRAKEN_PROJECT: "lethal", CG_COORD_ROOT: "/coord" }, "overview");
    expect(r.out).toBe("kraken coord overview root=/coord");
  });

  test("host: LETHAL_COORD_ROOT wins and an inherited CG_COORD_ROOT is ignored", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-sh-root-"));
    const r = await run({ LETHAL_COORD_ROOT: root, CG_COORD_ROOT: "/centralgauge" }, "doctor");
    expect(r.code).toBe(0);
    expect(r.out.startsWith("deno run --allow-all ")).toBe(true);
    expect(r.out.endsWith(` doctor root=${root}`)).toBe(true);
    expect(r.out).not.toContain("kraken");
    expect(r.out).not.toContain("centralgauge");
  });

  test("host root with MOVED-TO-KRAKEN: exit 3, text printed, nothing called", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-sh-moved-"));
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "MOVED-TO-KRAKEN"),
      "this coord moved into kraken; use kraken coord\n",
    );
    const r = await run({ LETHAL_COORD_ROOT: root }, "claim", "X");
    expect(r.code).toBe(3);
    expect(r.err).toContain("this coord moved into kraken");
    expect(r.out).toBe("");
  });
});
