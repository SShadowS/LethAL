// R1161: the hand pin of upstream main ef9f6a222 (pre-commitment docs/superpowers/specs/2026-11-22-r1161-main-ef9f6a222-pin.md).
// #8239 is fixed there, so the pin is the live root edge-d72d3197d's readings EXACTLY, with no o1.partnerLoginRefusal.
import { describe, expect, test } from "bun:test";
import { V3_BUILD_PINS, findV3Pin, handV3Pin, v3ReadingsDigest } from "../src/al-runner-v3-pins";

const ID = "main-ef9f6a222";
const V = "al-runner 3.0.0-alpha.14+main.20261122 (ef9f6a222)";
const SHA = "8d36889656d8152f5c84c17a47a2e22303744622390b717d5d646b04d0c53bfe";

describe("R1161: the main ef9f6a222 pin", () => {
  const pin = handV3Pin(ID);
  const root = handV3Pin("edge-d72d3197d");

  test("names the exact binary", () => {
    expect(pin?.version).toBe(V);
    expect(pin?.binarySha256).toBe(SHA);
  });
  test("the itest's lookup (findV3Pin by version AND sha) picks it; a flipped sha does not", () => {
    expect(findV3Pin(V, SHA)?.id).toBe(ID);
    expect(findV3Pin(V, `${SHA.slice(0, -1)}c`)?.id).not.toBe(ID);
  });
  test("is the root's readings exactly (same digest), with no partner-login refusal", () => {
    if (pin === undefined || root === undefined) throw new Error("pin or root missing");
    expect(pin.o1?.partnerLoginRefusal).toBeUndefined();
    const renamed = { ...pin, id: root.id, version: root.version, binarySha256: root.binarySha256 };
    expect(v3ReadingsDigest(renamed)).toBe(v3ReadingsDigest(root));
  });
  test("main-ccd0f823d stays the only pin with o1.partnerLoginRefusal, and the new pin comes after it", () => {
    expect(
      V3_BUILD_PINS.filter((p) => p.o1?.partnerLoginRefusal !== undefined).map((p) => p.id),
    ).toEqual(["main-ccd0f823d"]);
    const ids = V3_BUILD_PINS.map((p) => p.id);
    expect(ids.indexOf(ID)).toBeGreaterThan(ids.indexOf("main-ccd0f823d"));
  });
});
