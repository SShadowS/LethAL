// PR-255: the hand pin of upstream main 9835579c6 (pre-commitment docs/superpowers/specs/2026-11-20-pr255-main-build-as-current.md,
// amendment 1): the live root edge-d72d3197d's readings plus ONLY o1.partnerLoginRefusal, so any change to the root moves it
// too, and nothing else can ride on it.
import { describe, expect, test } from "bun:test";
import { O1_PARTNER_LOGIN_TEXT } from "../itest/alrunner-v3-legs";
import { V3_BUILD_PINS, handV3Pin, v3ReadingsDigest } from "../src/al-runner-v3-pins";

const ID = "main-9835579c6";

describe("PR-255: the main 9835579c6 pin", () => {
  const pin = handV3Pin(ID);
  const root = handV3Pin("edge-d72d3197d");

  test("names the exact binary", () => {
    expect(pin?.version).toBe("al-runner 3.0.0-alpha.14+main.20261120 (9835579c6)");
    expect(pin?.binarySha256).toBe(
      "b91d49d7b6af8ea9ed7bd429f14312cde19025c0676a1278822f37dfaca03d24",
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
    expect(root.o1?.partnerLoginRefusal).toBeUndefined();
  });

  test("its text is exactly the itest's O1 partner-login text", () => {
    expect(pin?.o1?.partnerLoginRefusal?.text).toBe(O1_PARTNER_LOGIN_TEXT);
    expect(pin?.o1?.partnerLoginRefusal?.issue).toMatch(/\/8239$/);
  });

  test("it is the only pin with the field, and it comes after the root edge-d72d3197d", () => {
    expect(
      V3_BUILD_PINS.filter((p) => p.o1?.partnerLoginRefusal !== undefined).map((p) => p.id),
    ).toEqual([ID]);
    const ids = V3_BUILD_PINS.map((p) => p.id);
    expect(ids.indexOf(ID)).toBeGreaterThan(ids.indexOf("edge-d72d3197d"));
  });
});
