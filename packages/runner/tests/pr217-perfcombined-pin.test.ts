// PR-217: the perf-combined pin (pre-commitment docs/superpowers/specs/2026-11-19-pr217-perfcombined-pin-precommitment.md,
// master d2153c9ed): a fork test build for PERF-10, never `current`. It must equal the live root edge-d72d3197d's readings
// plus ONLY o1.partnerLoginRefusal, so any change to the root moves it too, and nothing else can ride on it.
import { describe, expect, test } from "bun:test";
import { O1_PARTNER_LOGIN_TEXT } from "../itest/alrunner-v3-legs";
import { V3_BUILD_PINS, gatedBuilds, handV3Pin, v3ReadingsDigest } from "../src/al-runner-v3-pins";

const ID = "perfcombined-2bb4b6861";

describe("PR-217: the perf-combined pin", () => {
  const pin = handV3Pin(ID);
  const root = handV3Pin("edge-d72d3197d");

  test("names the exact binary", () => {
    expect(pin?.version).toBe("al-runner 3.0.0-alpha.14 (2bb4b6861)");
    expect(pin?.binarySha256).toBe(
      "f824dee326e1f9dc3e63045214297353d8e32299ca2677f4bfc3184411b2fc9b",
    );
  });

  test("is the root's readings plus ONLY o1.partnerLoginRefusal (by digest of the pin without that field)", () => {
    if (pin === undefined || root === undefined) throw new Error("pin or root missing");
    const { partnerLoginRefusal, ...o1Rest } = pin.o1 ?? {
      cdoWorkDate: "",
      issue: "",
      evidence: "",
    };
    expect(partnerLoginRefusal).toBeDefined();
    const stripped = {
      ...pin,
      id: root.id,
      version: root.version,
      binarySha256: root.binarySha256,
      o1: o1Rest,
    };
    expect(v3ReadingsDigest(stripped)).toBe(v3ReadingsDigest(root));
    // and the field is what the root lacks
    expect(root.o1?.partnerLoginRefusal).toBeUndefined();
  });

  test("its text is exactly the itest's O1 partner-login text", () => {
    expect(pin?.o1?.partnerLoginRefusal?.text).toBe(O1_PARTNER_LOGIN_TEXT);
    expect(pin?.o1?.partnerLoginRefusal?.issue).toMatch(/\/8239$/);
  });

  test("it is the only pin with the field, never the last (current's) pin, and no gated-build row names it", () => {
    expect(
      V3_BUILD_PINS.filter((p) => p.o1?.partnerLoginRefusal !== undefined).map((p) => p.id),
    ).toEqual([ID]);
    expect(V3_BUILD_PINS[V3_BUILD_PINS.length - 1]?.id).not.toBe(ID);
    expect(gatedBuilds().some((r) => r.readingsFrom === ID)).toBe(false);
  });
});
