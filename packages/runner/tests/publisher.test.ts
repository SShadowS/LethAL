import { describe, expect, test } from "bun:test";
import { Publisher } from "../src/publisher";

function recordingSpawn(result = { exitCode: 0, stdout: "", stderr: "" }) {
  const calls: string[][] = [];
  const spawn = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return result;
  };
  return { calls, spawn };
}

const cfg = {
  alcPath: "C:/ext/bin/alc.exe",
  altoolPath: "C:/ext/bin/altool.exe",
  packageCachePath: "C:/proj/.alpackages",
  outputDir: "C:/out",
  server: "http://bcserver",
  serverInstance: "BC",
};

describe("Publisher.compile", () => {
  test("invokes alc with project, packagecache, out", async () => {
    const { calls, spawn } = recordingSpawn();
    const appPath = await new Publisher(cfg, spawn).compile("C:/instr");
    expect(calls[0]?.[0]).toBe("C:/ext/bin/alc.exe");
    expect(calls[0]).toContain("/project:C:/instr");
    expect(calls[0]).toContain("/packagecachepath:C:/proj/.alpackages");
    expect(appPath.startsWith("C:/out")).toBe(true);
  });

  test("failure surfaces stderr verbatim", async () => {
    const { spawn } = recordingSpawn({ exitCode: 1, stdout: "", stderr: "AL0132: nope" });
    await expect(new Publisher(cfg, spawn).compile("C:/instr")).rejects.toThrow("AL0132: nope");
  });
});

describe("Publisher.publish", () => {
  test("invokes altool publishapp with server params and ForceSync", async () => {
    const { calls, spawn } = recordingSpawn();
    await new Publisher(cfg, spawn).publish("C:/out/x.app");
    expect(calls[0]?.slice(0, 2)).toEqual(["C:/ext/bin/altool.exe", "publishapp"]);
    expect(calls[0]).toContain("C:/out/x.app");
    expect(calls[0]?.join(" ")).toContain("ForceSync");
  });
});
