import { describe, expect, it } from "bun:test";
import { EnvToolClient, redact, renderCommand } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";

const CFG: EnvToolConfigSection = {
  toolPath: "C:/tools/continia.exe",
  vars: { profile: "bc28-w1" },
  publish: { command: ["publish", "{envId}", "{appFile}", "--profile", "{profile}"] },
  resolve: [],
};

function fakeSpawn(results: Array<{ exitCode: number; stdout: string; stderr: string }>) {
  const calls: string[][] = [];
  let i = 0;
  return {
    calls,
    spawn: async (argv: readonly string[]) => {
      calls.push([...argv]);
      const r = results[i];
      i += 1;
      if (r === undefined) throw new Error("fake spawn: no result queued");
      return r;
    },
  };
}

/**
 * A fake spawn that honours `opts.signal`: instead of resolving immediately, it waits for the
 * signal to abort (or resolves immediately if a signal was never passed or is already aborted),
 * then resolves with `result` — mirroring Bun.spawn's real behaviour when killed via AbortSignal
 * (it resolves with exitCode 143 / SIGTERM, it does NOT throw). Driven by the AbortController's
 * own timer, never a real wall-clock wait in the test itself.
 */
function fakeSpawnHonoringAbort(result: { exitCode: number; stdout: string; stderr: string }) {
  const calls: string[][] = [];
  return {
    calls,
    spawn: async (
      argv: readonly string[],
      opts?: { signal?: AbortSignal; env?: Record<string, string> },
    ) => {
      calls.push([...argv]);
      const signal = opts?.signal;
      if (signal !== undefined && !signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return result;
    },
  };
}

describe("renderCommand", () => {
  it("prefixes toolPath and substitutes LethAL placeholders and vars", () => {
    const argv = renderCommand(CFG.publish as never, CFG, { envId: "e1", appFile: "a.app" });
    expect(argv).toEqual([
      "C:/tools/continia.exe",
      "publish",
      "e1",
      "a.app",
      "--profile",
      "bc28-w1",
    ]);
  });

  it("throws when a placeholder has no supplied value", () => {
    expect(() => renderCommand(CFG.publish as never, CFG, { envId: "e1" })).toThrow(/appFile/);
  });

  it("throws (never ships the literal text) when a vars value references a LethAL placeholder missing from supplied", () => {
    // Reproduces the design doc's own worked example: vars.envName references {runId}, but no
    // runId is supplied. Before the fix this silently produced the literal argument
    // "lethal-{runId}" instead of failing.
    const cfg: EnvToolConfigSection = {
      ...CFG,
      vars: { envName: "lethal-{runId}" },
    };
    const createBlock = { command: ["env", "create", "--name", "{envName}"] };
    expect(() => renderCommand(createBlock, cfg, { envId: "e1", appFile: "a.app" })).toThrow(
      /vars\.envName.*\{runId\}/s,
    );
  });

  it("does not throw rendering a DIFFERENT block that never references an unresolved vars entry", () => {
    // vars.tag is referenced only by `publish`'s command and itself references {appFile}. Task 2's
    // validation already rejects a vars entry nothing anywhere references, so `tag` reaching this
    // point means SOME block uses it — but that must not make rendering `deleteEnv` (which never
    // mentions `tag`, and has no reason to have `appFile` supplied) throw about an unresolved
    // {appFile}. That would be a spurious abort of a run that should succeed, landing at teardown.
    const cfg: EnvToolConfigSection = {
      ...CFG,
      vars: { tag: "{appFile}-suffix" },
      publish: { command: ["publish", "{envId}", "{appFile}", "--tag", "{tag}"] },
    };
    const deleteBlock = { command: ["env", "delete", "{envId}"] };
    expect(renderCommand(deleteBlock, cfg, { envId: "e1" })).toEqual([
      "C:/tools/continia.exe",
      "env",
      "delete",
      "e1",
    ]);
  });
});

describe("redact", () => {
  it("replaces every secret occurrence", () => {
    expect(redact("user=admin pw=hunter2 again hunter2", ["hunter2"])).toBe(
      "user=admin pw=*** again ***",
    );
  });

  it("redacts longest-first so a secret that is a substring of another is not left partially exposed", () => {
    // "ab" is a substring of "abc123". Processing shortest-first would consume the "ab" inside
    // "abc123" FIRST, leaving a mangled "***c123" behind that the later "abc123" pass can no
    // longer match (it's not contiguous text anymore) — the longer secret would never fully
    // vanish. Longest-first redacts "abc123" whole before "ab" is ever considered.
    expect(redact("token=abc123 short=ab", ["ab", "abc123"])).toBe("token=*** short=***");
  });
});

describe("EnvToolClient.run", () => {
  const block = { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } };

  it("reads a declared dot path out of stdout", async () => {
    const io = fakeSpawn([{ exitCode: 0, stdout: '{"url":"https://h/e1"}', stderr: "" }]);
    const client = new EnvToolClient(CFG, io);
    expect(await client.run(block, "resolve[0]", { envId: "e1" })).toEqual({
      baseUrl: "https://h/e1",
    });
    expect(io.calls[0]?.slice(1)).toEqual(["env", "get", "e1", "--json"]);
  });

  it("indexes arrays with numeric path segments", async () => {
    // A 2+ element array indexed at a NON-zero position — a single-element array indexed "0"
    // cannot distinguish real indexing from a mutant that constant-folds the index to 0.
    const users = { command: ["env", "users"], reads: { username: "1.username" } };
    const io = fakeSpawn([
      { exitCode: 0, stdout: '[{"username":"admin"},{"username":"other"}]', stderr: "" },
    ]);
    expect(await new EnvToolClient(CFG, io).run(users, "resolve[1]", {})).toEqual({
      username: "other",
    });
  });

  it("throws with exit code and stderr on non-zero exit", async () => {
    const io = fakeSpawn([{ exitCode: 2, stdout: "", stderr: "boom" }]);
    await expect(
      new EnvToolClient(CFG, io).run(block, "resolve[0]", { envId: "e1" }),
    ).rejects.toThrow(/exit 2.*boom/s);
  });

  it("throws naming key, path and command when the path is missing", async () => {
    const io = fakeSpawn([{ exitCode: 0, stdout: '{"other":1}', stderr: "" }]);
    await expect(
      new EnvToolClient(CFG, io).run(block, "resolve[0]", { envId: "e1" }),
    ).rejects.toThrow(/baseUrl.*url.*env get/s);
  });

  it("throws on an empty resolved value rather than passing it on", async () => {
    const io = fakeSpawn([{ exitCode: 0, stdout: '{"url":""}', stderr: "" }]);
    await expect(
      new EnvToolClient(CFG, io).run(block, "resolve[0]", { envId: "e1" }),
    ).rejects.toThrow(/empty/);
  });

  it("echoes stdout on a parse failure for a non-credential block", async () => {
    const io = fakeSpawn([{ exitCode: 0, stdout: "not json at all", stderr: "" }]);
    await expect(
      new EnvToolClient(CFG, io).run(block, "resolve[0]", { envId: "e1" }),
    ).rejects.toThrow(/not json/);
  });

  it("NEVER echoes stdout on a parse failure for a credential-bearing block", async () => {
    // The password was never read as a value, so value-based redaction cannot scrub it.
    const creds = {
      command: ["env", "users"],
      reads: { username: "0.username", password: "0.password" },
    };
    const io = fakeSpawn([{ exitCode: 0, stdout: '[{"password":"hunter2"', stderr: "" }]);
    const err = await new EnvToolClient(CFG, io)
      .run(creds, "resolve[1]", {})
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).not.toContain("hunter2");
    expect(err).toMatch(/withheld/);
  });

  it("redacts a known secret in a non-zero-exit error", async () => {
    const io = fakeSpawn([{ exitCode: 1, stdout: "", stderr: "auth failed for hunter2" }]);
    const client = new EnvToolClient(CFG, io);
    client.addSecret("hunter2");
    const err = await client
      .run(block, "resolve[0]", { envId: "e1" })
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).not.toContain("hunter2");
    expect(err).toContain("***");
  });

  it("NEVER echoes stdout or stderr on a non-zero exit for a credential-bearing block", async () => {
    // The reviewer's counter-test: hard-coding readsCredentials to false on ONLY this branch (the
    // JSON-parse-failure branch stayed intact) still let the full suite pass — proof this half of
    // credential withholding had no regression protection. This is the more likely real failure:
    // `env users --json` exiting non-zero while dumping the user table to stderr.
    const creds = {
      command: ["env", "users"],
      reads: { username: "0.username", password: "0.password" },
    };
    const io = fakeSpawn([
      {
        exitCode: 1,
        stdout: '[{"username":"admin","password":"hunter2"}]',
        stderr: "fatal: dumping table failed, password=hunter2",
      },
    ]);
    const err = await new EnvToolClient(CFG, io)
      .run(creds, "resolve[1]", {})
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).not.toContain("hunter2");
    expect(err).toMatch(/withheld/);
  });

  it("distinguishes a timed-out block from an ordinary crash", async () => {
    // Verified live: Bun.spawn killed via AbortSignal resolves (does not throw) with exitCode 143
    // and signalCode "SIGTERM". Driven by a tiny configured timeout and a fake spawn that resolves
    // only once aborted — no real wall-clock wait.
    const cfg: EnvToolConfigSection = { ...CFG, timeoutSeconds: 0.01 };
    const io = fakeSpawnHonoringAbort({ exitCode: 143, stdout: "", stderr: "" });
    const err = await new EnvToolClient(cfg, io)
      .run(block, "resolve[0]", { envId: "e1" })
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).toMatch(/timed out/i);
    expect(err).toContain("0.01");
    expect(err).not.toMatch(/exit 143/);
  });

  it("passes envTool.cwd through to spawn when the config sets one", async () => {
    const cfg: EnvToolConfigSection = { ...CFG, cwd: "C:/some/tool/dir" };
    let seenCwd: string | undefined;
    const io = {
      spawn: async (argv: readonly string[], opts?: { cwd?: string }) => {
        seenCwd = opts?.cwd;
        return { exitCode: 0, stdout: '{"url":"https://h/e1"}', stderr: "" };
      },
    };
    await new EnvToolClient(cfg, io).run(block, "resolve[0]", { envId: "e1" });
    expect(seenCwd).toBe("C:/some/tool/dir");
  });

  it("defaults cwd to the project dir supplied at construction when envTool.cwd is absent", async () => {
    let seenCwd: string | undefined;
    const io = {
      spawn: async (argv: readonly string[], opts?: { cwd?: string }) => {
        seenCwd = opts?.cwd;
        return { exitCode: 0, stdout: '{"url":"https://h/e1"}', stderr: "" };
      },
    };
    // Third constructor arg is the default cwd cli.ts supplies (the project dir) — CFG itself
    // has no `cwd` field, so this proves the fallback, not an explicit config value.
    await new EnvToolClient(CFG, io, "C:/proj").run(block, "resolve[0]", { envId: "e1" });
    expect(seenCwd).toBe("C:/proj");
  });

  it("envTool.cwd wins over the constructor's default project dir", async () => {
    const cfg: EnvToolConfigSection = { ...CFG, cwd: "C:/explicit" };
    let seenCwd: string | undefined;
    const io = {
      spawn: async (argv: readonly string[], opts?: { cwd?: string }) => {
        seenCwd = opts?.cwd;
        return { exitCode: 0, stdout: '{"url":"https://h/e1"}', stderr: "" };
      },
    };
    await new EnvToolClient(cfg, io, "C:/proj").run(block, "resolve[0]", { envId: "e1" });
    expect(seenCwd).toBe("C:/explicit");
  });

  it("attributes a renderCommand failure to the named block", async () => {
    // Reproduced: run(block, "resolve[3]", {}) with a missing {envId} previously reported no
    // mention of "resolve[3]" at all, because renderCommand's throw bypassed the
    // `envTool.${name}:` prefix every other failure in run() carries.
    const missingEnvIdBlock = { command: ["env", "get", "{envId}"] };
    const io = fakeSpawn([]);
    const err = await new EnvToolClient(CFG, io)
      .run(missingEnvIdBlock, "resolve[3]", {})
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).toContain("resolve[3]");
    expect(io.calls.length).toBe(0);
  });
});
