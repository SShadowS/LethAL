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
});

describe("redact", () => {
  it("replaces every secret occurrence", () => {
    expect(redact("user=admin pw=hunter2 again hunter2", ["hunter2"])).toBe(
      "user=admin pw=*** again ***",
    );
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
    const users = { command: ["env", "users"], reads: { username: "0.username" } };
    const io = fakeSpawn([{ exitCode: 0, stdout: '[{"username":"admin"}]', stderr: "" }]);
    expect(await new EnvToolClient(CFG, io).run(users, "resolve[1]", {})).toEqual({
      username: "admin",
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
});
