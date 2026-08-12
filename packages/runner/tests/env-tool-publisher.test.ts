import { describe, expect, it } from "bun:test";
import { decidePublishOutcome } from "../src/deployment-verifier";
import { EnvToolClient } from "../src/env-tool";
import type { EnvToolConfigSection } from "../src/env-tool";
import type { EnvToolBlock } from "../src/env-tool";
import { EnvToolPublisher } from "../src/env-tool-publisher";
import { recordPublishOutcome } from "../src/publish-ceiling";
import { ResultsStore } from "../src/store";

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

  it("publishFile treats BC's duplicate-package-ID rejection as already-published", async () => {
    // A packageId is content-derived: the same .app file republished yields exactly this
    // rejection, and it means the goal state — this exact package on the environment — already
    // holds. Observed live 2026-08-12: the envtool gate's second run against the same
    // environment died here republishing the identical publishApps entry.
    const { publisher } = publisherWith({
      exitCode: 1,
      stdout:
        '{"success": false, "message": "A duplicate package ID is detected. Cannot publish an ' +
        "extension with packageId: '0ececc10', appId: 'ff7935bb', name: 'LethAL Sandbox Tests', " +
        "publisher: 'LethAL' and version: '1.0.0.2', because the same package ID already exists " +
        'in a published extension."}',
      stderr: "",
    });
    await expect(publisher.publishFile("tests.app")).resolves.toBeUndefined();
  });

  it("publishFile still surfaces every other rejection", async () => {
    const { publisher } = publisherWith({
      exitCode: 1,
      stdout: '{"success": false, "message": "The operation timed out."}',
      stderr: "",
    });
    await expect(publisher.publishFile("tests.app")).rejects.toThrow(/timed out/);
  });

  it("publish (mutated artifacts) does NOT get the duplicate-package skip", async () => {
    // Every compiled artifact carries a fresh random version, so a duplicate packageId on THIS
    // path signals a genuine fault (two sessions racing, a stale artifact) and must stay loud.
    const { publisher } = publisherWith({
      exitCode: 1,
      stdout: '{"success": false, "message": "A duplicate package ID is detected."}',
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
    ).rejects.toThrow(/duplicate package ID/);
  });
});

/**
 * R107's acceptance criterion, stated in the row as the thing that IS the close: a stub env-tool
 * that exits 0 while printing a failure body must move its `publish_outcomes` row from
 * `indeterminate` to `failed`.
 *
 * The two tests are one differential — SAME stub output, SAME publish path, the only difference is
 * whether the config declares `successWhen`. Without the declaration the publish reads as fine and
 * the store records `indeterminate`; with it, the publish throws, `decidePublishOutcome` sees a
 * failed publish, and the store records `failed`. `failed` is the only outcome R90's per-tier
 * ceiling learns from, so before this change the hosted tier — the exact tier the ceiling exists
 * for — could never learn its own ceiling.
 */
describe("R107 — an exit-0 publish that reports failure reaches the store as `failed`", () => {
  const FAILURE_BODY = '{"success": false, "message": "The operation timed out."}';

  /** Mirrors bcdev-backend's deploy step: publish, catch, decide, record. */
  async function outcomeOf(successWhen: { path: string; equals: string } | undefined) {
    const block: EnvToolBlock = {
      command: ["publish", "{envId}", "{appFile}"],
      ...(successWhen !== undefined ? { successWhen } : {}),
    };
    const client = new EnvToolClient(
      { ...CFG, publish: block },
      {
        spawn: async () => ({ exitCode: 0, stdout: FAILURE_BODY, stderr: "" }),
      },
    );
    const publisher = new EnvToolPublisher(
      client,
      block,
      { envId: "e1", serializerKey: `https://h|e1|${successWhen === undefined ? "off" : "on"}` },
      { readArtifact: async () => BYTES },
    );
    let publishOk = true;
    try {
      await publisher.publish({
        appId: "a",
        artifactId: "0".repeat(32),
        appPath: "x.app",
        sha256: DIGEST,
        version: "1.0.0.1",
      } as never);
    } catch {
      publishOk = false;
    }
    // No server to ask, so identity is `unavailable` — the same state a real run is in when the
    // publish never landed.
    const outcome = decidePublishOutcome(publishOk, {
      status: "unavailable",
      detail: "no server in this test",
    });
    const store = new ResultsStore(":memory:");
    recordPublishOutcome(store, "tier-a", 176, outcome, "x.al");
    return store.publishOutcomes("tier-a")[0]?.outcome;
  }

  it("records `indeterminate` when no successWhen is declared — the measured hole", async () => {
    expect(await outcomeOf(undefined)).toBe("indeterminate");
  });

  it("records `failed` once successWhen is declared", async () => {
    expect(await outcomeOf({ path: "success", equals: "true" })).toBe("failed");
  });
});
