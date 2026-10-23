// Moved unchanged from `al-runner-backend.test.ts` when R654 S3 deleted that file with the .NET
// al-runner: these two tests are about `MsInMemoryBackend`, not al-runner.
import { describe, expect, test } from "bun:test";
import { MsInMemoryBackend } from "../src/ms-inmemory-backend";

describe("MsInMemoryBackend", () => {
  test("throws with a pointer to the spec", () => {
    const b = new MsInMemoryBackend();
    expect(() => b.capabilities()).toThrow(/2026-07-17-layer-4/);
  });

  test("compileCheck also throws with a pointer to the spec", () => {
    const b = new MsInMemoryBackend();
    expect(() => b.compileCheck()).toThrow(/2026-07-17-layer-4/);
  });
});
