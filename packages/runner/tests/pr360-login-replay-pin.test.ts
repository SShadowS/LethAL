// PR-360 (R1185): al-runner's login replay is pinned OFF on every al-runner child, and an ambient ALRUNNER_LOGIN_REPLAY*
// never reaches a child that did not ask for it. Pre-commitment: docs/superpowers/specs/2026-11-23-pr360-login-replay-off-pin.md.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defaultServerSpawn } from "../src/al-runner-server";
import {
  V3_LOGIN_REPLAY_ENV,
  mergeChildEnv,
  v3ChildEnv,
  v3MutantDaemonEnv,
  v3UnpinnedEnv,
} from "../src/al-runner-v3-seed";
import { defaultSpawn } from "../src/publisher";

const NAMES = [
  "ALRUNNER_LOGIN_REPLAY",
  "ALRUNNER_LOGIN_REPLAY_CHECK",
  "ALRUNNER_PR360_OTHER",
] as const;
/** Runs `f` with the three names set in the parent's environment, then restores them. */
async function withAmbient<T>(f: () => T | Promise<T>): Promise<T> {
  const saved = NAMES.map((n) => process.env[n]);
  process.env.ALRUNNER_LOGIN_REPLAY = "1";
  process.env.ALRUNNER_LOGIN_REPLAY_CHECK = "1";
  process.env.ALRUNNER_PR360_OTHER = "kept";
  try {
    return await f();
  } finally {
    NAMES.forEach((n, i) => {
      const v = saved[i];
      if (v === undefined) Reflect.deleteProperty(process.env, n);
      else process.env[n] = v;
    });
  }
}
const echo = [
  process.execPath,
  "-e",
  "process.stdout.write([process.env.ALRUNNER_LOGIN_REPLAY ?? 'none', process.env.ALRUNNER_LOGIN_REPLAY_CHECK ?? 'none'].join(','))",
];

describe("PR-360: the replay is pinned off", () => {
  test("the name is upstream's", () => {
    expect(V3_LOGIN_REPLAY_ENV).toBe("ALRUNNER_LOGIN_REPLAY");
  });

  // Red: remove `[V3_LOGIN_REPLAY_ENV]: "0"` from v3ChildEnv (and from v3UnpinnedEnv for its line).
  test("every env helper carries 0, and an extra of 1 does not win", () => {
    expect(v3ChildEnv().ALRUNNER_LOGIN_REPLAY).toBe("0");
    expect(v3ChildEnv({ ALRUNNER_LOGIN_REPLAY: "1" }).ALRUNNER_LOGIN_REPLAY).toBe("0");
    expect(v3MutantDaemonEnv().ALRUNNER_LOGIN_REPLAY).toBe("0");
    expect(v3UnpinnedEnv().ALRUNNER_LOGIN_REPLAY).toBe("0");
  });

  test("a real one-shot child and a real serve child read 0 beside an ambient 1; _CHECK does not reach them", async () => {
    await withAmbient(async () => {
      expect((await defaultSpawn(echo, { env: v3ChildEnv() })).stdout).toBe("0,none");
      const h = defaultServerSpawn(echo, { env: v3ChildEnv() });
      let out = "";
      for await (const c of h.stdout) out += new TextDecoder().decode(c);
      await h.wait?.();
      expect(out).toBe("0,none");
      // The other direction: with no env option the child inherits everything, so the env option is what pins.
      expect((await defaultSpawn(echo)).stdout).toBe("1,1");
    });
  });
});

// Review LOW 1. Red: restore `{ ...v3ChildEnv(cache), ...serverEnv }` in al-runner-v3-contract.ts.
test("no source spreads anything AFTER v3ChildEnv's pins (a later spread could switch the replay on)", () => {
  const dir = join(import.meta.dir, "../src");
  const late = /\.\.\.v3(?:ChildEnv|MutantDaemonEnv)\([^)]*\)\s*,\s*\.\.\./;
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => late.test(readFileSync(join(dir, f), "utf8")));
  expect(hits).toEqual([]);
});

describe("PR-360: mergeChildEnv drops an ambient ALRUNNER_LOGIN_REPLAY*", () => {
  // Red: remove the PR-360 loop in mergeChildEnv.
  test("dropped unless asked for; an unrelated ALRUNNER_* name is kept", async () => {
    await withAmbient(() => {
      const m = mergeChildEnv({});
      expect(Object.hasOwn(m, "ALRUNNER_LOGIN_REPLAY")).toBe(false);
      expect(Object.hasOwn(m, "ALRUNNER_LOGIN_REPLAY_CHECK")).toBe(false);
      expect(m.ALRUNNER_PR360_OTHER).toBe("kept");
    });
  });

  // Red: drop the `!Object.hasOwn(extra, k)` condition (an asked-for value would be removed too).
  test("a name the extras set keeps the extras' value", async () => {
    await withAmbient(() => {
      const m = mergeChildEnv({ ALRUNNER_LOGIN_REPLAY: "0", ALRUNNER_LOGIN_REPLAY_CHECK: "1" });
      expect(m.ALRUNNER_LOGIN_REPLAY).toBe("0");
      expect(m.ALRUNNER_LOGIN_REPLAY_CHECK).toBe("1");
    });
  });
});
