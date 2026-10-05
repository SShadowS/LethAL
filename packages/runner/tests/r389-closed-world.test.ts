import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type { ActivationConfig } from "../src/activation";
import { AlRunnerBackend } from "../src/al-runner-backend";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { closedWorldGuard, closedWorldOf } from "../src/closed-world";
import { testsInAlSource } from "../src/discovery";
import { DependentCountUnavailableError, HarnessVerifier } from "../src/harness";
import { explainNewTests, testDigestsOfModel } from "../src/test-digest";
import { buildTestAppModel } from "../src/testpage-scan";

/**
 * R389 guard (coord guard-build-plan.md): public and internal procedures are traced closed-world
 * only when the server says no published app depends on the test app. Every other answer, or no
 * answer, falls back. Fakes count their calls; nothing reads a clock.
 */

const CFG: ActivationConfig = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS Danmark A/S",
  username: "u",
  password: "p",
  tenant: "default",
};
const TEST_APP = "1f0a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";

/** A fake fetch that answers every call the same way and records each one. */
function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}
const answer = (inner: unknown) => ({ value: JSON.stringify(inner) });

describe("R389 HarnessVerifier.fetchDependentCount", () => {
  test("posts the app id to the DependentCount action and reads the count", async () => {
    for (const n of [0, 3]) {
      const f = fakeFetch(200, answer({ appId: TEST_APP, publishedDependents: n }));
      expect(await new HarnessVerifier(CFG, f.fetchFn).fetchDependentCount(TEST_APP)).toBe(n);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.url).toBe(
        "http://bc:7048/BC/ODataV4/LethALControl_DependentCount?company=CRONUS+Danmark+A%2FS&tenant=default",
      );
      expect(JSON.parse(f.calls[0]?.body ?? "")).toEqual({ appId: TEST_APP });
    }
  });

  test("a non-GUID is refused before any request", async () => {
    const f = fakeFetch(200, answer({ appId: "x", publishedDependents: 0 }));
    await expect(
      new HarnessVerifier(CFG, f.fetchFn).fetchDependentCount("not-a-guid"),
    ).rejects.toThrow(/not a bare GUID/);
    expect(f.calls).toHaveLength(0);
  });

  test("a missing count, a non-integer, a negative or another app's echo throws, never a plausible 0", async () => {
    for (const inner of [
      { appId: TEST_APP },
      { appId: TEST_APP, publishedDependents: "0" },
      { appId: TEST_APP, publishedDependents: 1.5 },
      { appId: TEST_APP, publishedDependents: -1 },
      { appId: "00000000-0000-0000-0000-000000000000", publishedDependents: 0 },
    ]) {
      const f = fakeFetch(200, answer(inner));
      await expect(
        new HarnessVerifier(CFG, f.fetchFn).fetchDependentCount(TEST_APP),
      ).rejects.toThrow();
    }
  });

  test("a control app without the action (404) is DependentCountUnavailableError; a server error is not", async () => {
    const missing = fakeFetch(404, "No HTTP resource was found that matches the request URI");
    await expect(
      new HarnessVerifier(CFG, missing.fetchFn).fetchDependentCount(TEST_APP),
    ).rejects.toBeInstanceOf(DependentCountUnavailableError);
    const failed = fakeFetch(500, "DependentCount: boom");
    const err = await new HarnessVerifier(CFG, failed.fetchFn).fetchDependentCount(TEST_APP).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DependentCountUnavailableError);
  });
});

/** A backend with the optional action, counting its calls. */
function counting(answerWith: () => Promise<number>) {
  const seen: string[] = [];
  return {
    seen,
    backend: {
      dependentCount: (appId: string) => {
        seen.push(appId);
        return answerWith();
      },
    },
  };
}

describe("R389 closedWorldOf: the guard", () => {
  test("count 0 and no internalsVisibleTo: public and internal are closed-world", async () => {
    const c = counting(async () => 0);
    const r = await closedWorldOf({ id: TEST_APP }, c.backend);
    expect(r.closedWorld).toEqual({ public: true, internal: true });
    expect(c.seen).toEqual([TEST_APP]);
  });

  test("count 0 with internalsVisibleTo: public closed-world, internal falls back", async () => {
    const c = counting(async () => 0);
    for (const ivt of [[{ id: "a", name: "b", publisher: "c" }], [], "x"]) {
      const r = await closedWorldOf({ id: TEST_APP, internalsVisibleTo: ivt }, c.backend);
      expect(r.closedWorld).toEqual({ public: true, internal: false });
    }
  });

  test("count above 0: both fall back", async () => {
    const r = await closedWorldOf({ id: TEST_APP }, counting(async () => 1).backend);
    expect(r.closedWorld).toEqual({ public: false, internal: false });
    expect(r.why).toContain("1 published app");
  });

  test("an older control app (no action): falls back, quietly", async () => {
    const r = await closedWorldOf(
      { id: TEST_APP },
      counting(async () => {
        throw new DependentCountUnavailableError("404");
      }).backend,
    );
    expect(r.closedWorld).toEqual({ public: false, internal: false });
    expect(r.warn).toBe(false);
  });

  test("the action errors: falls back, with a warning", async () => {
    const r = await closedWorldOf(
      { id: TEST_APP },
      counting(async () => {
        throw new Error("permission denied");
      }).backend,
    );
    expect(r.closedWorld).toEqual({ public: false, internal: false });
    expect(r.warn).toBe(true);
    expect(r.why).toContain("permission denied");
  });

  test("a backend without the action (al-runner) falls back and is never asked", async () => {
    const r = await closedWorldOf({ id: TEST_APP }, {});
    expect(r.closedWorld).toEqual({ public: false, internal: false });
    expect("dependentCount" in AlRunnerBackend.prototype).toBe(false);
    // Control: the bcdev backend is the one that has it.
    expect("dependentCount" in BcDevMcpBackend.prototype).toBe(true);
  });

  test("an app.json without an id falls back without asking", async () => {
    const c = counting(async () => 0);
    for (const j of [{}, { id: 5 }, null]) {
      const r = await closedWorldOf(j, c.backend);
      expect(r.closedWorld).toEqual({ public: false, internal: false });
    }
    expect(c.seen).toEqual([]);
  });

  test("closedWorldGuard reads the test app's app.json; an unreadable one falls back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lethal-r389-guard-"));
    try {
      const c = counting(async () => 0);
      expect((await closedWorldGuard(c.backend, dir)).closedWorld).toEqual({
        public: false,
        internal: false,
      });
      writeFileSync(join(dir, "app.json"), `﻿${JSON.stringify({ id: TEST_APP })}`);
      expect((await closedWorldGuard(c.backend, dir)).closedWorld).toEqual({
        public: true,
        internal: true,
      });
      expect(c.seen).toEqual([TEST_APP]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R389 the guard in the digest's recorded parts", () => {
  beforeAll(async () => {
    await initParser();
  });
  const files = [
    {
      path: "T.al",
      text: `codeunit 50100 "T"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure A()\n    begin\n    end;\n}\n`,
    },
  ];
  const I = { dependencies: "d", buildInputs: "b" };

  test("parts record the guard; a flip reads as cause closed-world, the same guard as none", () => {
    const model = buildTestAppModel(files);
    const tests = files.flatMap((f) => testsInAlSource(f.path, f.text));
    const closed = testDigestsOfModel(model, tests, {
      ...I,
      closedWorld: { public: true, internal: true },
    });
    const open = testDigestsOfModel(model, tests, I);
    expect(closed.parts.closedWorld).toBe("public+internal");
    expect(open.parts.closedWorld).toBe("none");
    const ref = tests.map((t) => ({ ref: t, recorded: true }));
    expect([...explainNewTests(model, I, ref, closed.parts).causes.keys()]).toEqual([
      "closed-world",
    ]);
    expect([
      ...explainNewTests(
        model,
        { ...I, closedWorld: { public: true, internal: true } },
        ref,
        closed.parts,
      ).causes.keys(),
    ]).toEqual(["reach"]);
  });
});
