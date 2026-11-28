import { describe, expect, test } from "bun:test";
import type { ExecutionBackend, TestMethodRef, TestVerdict } from "../packages/runner/src/backend";
import { BcDevMcpBackend } from "../packages/runner/src/bcdev-backend";
import type { BcDevConfigSection } from "../packages/runner/src/cli";
import { WorkDateGuard } from "../packages/runner/src/workdate-guard";
import { CoverageRecordingBackend, probeOdataCfg } from "./probe-r58-differential";

// R1245 (PR-507): the probe's recording wrapper must hand runSession the real backend's every member. It forwarded a
// hand-picked list, so runSession's optional `baselinePhase` bracket (R1131) never reached bcdev's WorkDate guard and
// every fenced run threw NoBaselineWorkDateError at its first mutant answer.
describe("R1245: probe-r58-differential's recording wrapper", () => {
  const ref: TestMethodRef = { codeunitId: 50100, codeunitName: "T", method: "M" };
  /** A fenced bcdev stand-in: its answers go through a real WorkDateGuard, bracketed as bcdev's are. */
  const fencedFake = () => {
    const guard = new WorkDateGuard(true);
    const calls: string[] = [];
    const inner = {
      baselinePhase: (on: boolean, ...rest: unknown[]) => {
        calls.push(`baselinePhase(${[on, ...rest].join(",")})`);
        guard.baselinePhase(on);
      },
      batchWorkDate: () => guard.batchWorkDate(),
      activate: async (id: string | null) => {
        calls.push(`activate(${id})`);
      },
      // A coverage-"none" call (the cold kill confirm) answers with no coverage and, here, a failure.
      run: async (r: TestMethodRef, opts: { coverage?: string }) =>
        guard.check(
          (opts.coverage === "none"
            ? { ref: r, outcome: "fail", failureMessage: "confirm", workDate: "2026-10-01" }
            : {
                ref: r,
                outcome: "pass",
                workDate: "2026-10-01",
                coverage: {
                  entries: [{ objectType: "Codeunit", objectId: 50000, procedure: "P" }],
                },
              }) as unknown as TestVerdict,
        ),
    } as unknown as ExecutionBackend;
    return { inner, calls };
  };

  // Red: forward a fixed list again (no baselinePhase): the mutant answer throws R1131's NoBaselineWorkDateError.
  test("runSession's baseline bracket reaches the backend: a mutant answer after a dated baseline is scored", async () => {
    const { inner, calls } = fencedFake();
    const rec = new CoverageRecordingBackend(inner);
    const b = rec.backend;
    await b.baselinePhase?.(true);
    await b.activate(null);
    await b.run(ref, {} as never);
    await b.baselinePhase?.(false, true);
    expect(b.batchWorkDate?.()).toBe("2026-10-01");
    await b.activate("m1");
    expect((await b.run(ref, {} as never)).outcome).toBe("pass");
    expect(calls).toEqual([
      "baselinePhase(true)",
      "activate(null)",
      "baselinePhase(false,true)",
      "activate(m1)",
    ]);
    // Only the baseline run is recorded.
    expect([...rec.baselineCoverage]).toEqual([["T.M", ["Codeunit:50000::P"]]]);
  });

  // Red: record every activate(null) run again (the old rule): the confirm's empty set and failure replace the
  // baseline's, and the per-test oracle compares [] with [] (what the first live run of this fix showed).
  test("an unmutated run after the baseline bracket (the cold kill confirm) does not overwrite the baseline record", async () => {
    const { inner } = fencedFake();
    const rec = new CoverageRecordingBackend(inner);
    const b = rec.backend;
    await b.baselinePhase?.(true);
    await b.activate(null);
    await b.run(ref, {} as never);
    await b.baselinePhase?.(false, true);
    await b.activate("m1");
    await b.run(ref, {} as never);
    await b.activate(null);
    expect((await b.run(ref, { coverage: "none" } as never)).outcome).toBe("fail");
    expect([...rec.baselineCoverage]).toEqual([["T.M", ["Codeunit:50000::P"]]]);
    expect([...rec.baselineOutcome]).toEqual([["T.M", "pass"]]);
    expect([...rec.baselineFailure]).toEqual([]);
  });

  // Red: go back to a hand-picked list that misses a prototype method (instance fields are not checked here).
  test("every method of BcDevMcpBackend is reachable through the wrapper", () => {
    const inner = Object.create(BcDevMcpBackend.prototype) as ExecutionBackend;
    const b = new CoverageRecordingBackend(inner).backend as unknown as Record<string, unknown>;
    const missing = Object.getOwnPropertyNames(BcDevMcpBackend.prototype).filter(
      (n) => n !== "constructor" && typeof b[n] !== "function",
    );
    expect(missing).toEqual([]);
  });
});

// R986: the coverage-differential probe reaches the server its config names, as the bcdev itests do.
const plain: BcDevConfigSection = {
  mcpCommand: ["bcdev"],
  server: "http://192.0.2.10:7249",
  serverInstance: "BC",
  company: "CRONUS",
  username: "u",
  password: "p",
  packageCachePath: "/tmp/pkgs",
  controlSymbolPath: "/tmp/control.app",
};

describe("R986: probe-r58-differential's OData root", () => {
  test("follows the config's baseUrl (bc3's 7248), never a derived 7048", () => {
    const cfg = probeOdataCfg({
      ...plain,
      baseUrl: "http://192.0.2.10:7248/BC",
      apiBaseUrl: "http://192.0.2.10:7252/BC",
    });
    expect(cfg.baseUrl).toBe("http://192.0.2.10:7248/BC");
    expect(cfg.apiBaseUrl).toBe("http://192.0.2.10:7252/BC");
    expect([cfg.company, cfg.username]).toEqual(["CRONUS", "u"]);
  });
  test("with no baseUrl, the 7048 derivation stands (a config written before R589)", () => {
    expect(probeOdataCfg(plain).baseUrl).toBe("http://192.0.2.10:7048/BC");
  });
});
