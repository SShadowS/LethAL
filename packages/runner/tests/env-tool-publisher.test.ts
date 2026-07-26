import { describe, expect, it } from "bun:test";
import { EnvToolClient } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";
import { EnvToolPublisher } from "../src/env-tool-publisher";

const CFG: EnvToolConfigSection = {
  toolPath: "tool.exe",
  publish: { command: ["publish", "{envId}", "{appFile}"] },
  resolve: [],
};
const BYTES = new Uint8Array([1, 2, 3]);
const DIGEST = Bun.SHA256.hash(BYTES, "hex");

function publisherWith(spawnResult: { exitCode: number; stdout: string; stderr: string }) {
  const calls: string[][] = [];
  // R22b: a fake that ignores `path` would still return BYTES/DIGEST no matter what file the
  // publisher asked to hash — silently passing even if the publisher hashed the WRONG file.
  // Recording the path lets every test below assert it was called with the artifact's own path.
  const readArtifactCalls: string[] = [];
  const client = new EnvToolClient(CFG, {
    spawn: async (argv) => {
      calls.push([...argv]);
      return spawnResult;
    },
  });
  const publishBlock = CFG.publish;
  if (publishBlock === undefined) throw new Error("fixture has no publish block");
  return {
    calls,
    readArtifactCalls,
    publisher: new EnvToolPublisher(
      client,
      publishBlock,
      { envId: "e1", serializerKey: "https://h|e1|default" },
      {
        readArtifact: async (path) => {
          readArtifactCalls.push(path);
          return BYTES;
        },
      },
    ),
  };
}

describe("EnvToolPublisher", () => {
  it("publishes an artifact whose digest still matches", async () => {
    const { calls, readArtifactCalls, publisher } = publisherWith({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    });
    await publisher.publish({
      appId: "a",
      artifactId: "0".repeat(32),
      appPath: "x.app",
      sha256: DIGEST,
      version: "1.0.0.1",
    } as never);
    expect(calls[0]).toEqual(["tool.exe", "publish", "e1", "x.app"]);
    expect(readArtifactCalls).toEqual(["x.app"]);
  });

  it("refuses to publish when the file changed after compilation", async () => {
    const { publisher } = publisherWith({ exitCode: 0, stdout: "{}", stderr: "" });
    await expect(
      publisher.publish({
        appId: "a",
        artifactId: "0".repeat(32),
        appPath: "x.app",
        sha256: "deadbeef",
        version: "1.0.0.1",
      } as never),
    ).rejects.toThrow(/digest/);
  });

  it("surfaces the tool's failure text so version-conflict recovery can parse it", async () => {
    const { publisher } = publisherWith({
      exitCode: 1,
      stdout: "Cannot install the extension because a newer version 1.0.0.9 was already installed.",
      stderr: "",
    });
    await expect(
      publisher.publish({
        appId: "a",
        artifactId: "0".repeat(32),
        appPath: "x.app",
        sha256: DIGEST,
        version: "1.0.0.1",
      } as never),
    ).rejects.toThrow(/newer version 1\.0\.0\.9/);
  });

  it("publishFile hashes at read instead of comparing to an expectation", async () => {
    const { calls, readArtifactCalls, publisher } = publisherWith({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    });
    await publisher.publishFile("lethal-control.app");
    expect(calls[0]).toEqual(["tool.exe", "publish", "e1", "lethal-control.app"]);
    expect(readArtifactCalls).toEqual(["lethal-control.app"]);
  });
});
