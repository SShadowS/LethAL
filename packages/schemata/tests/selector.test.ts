import { describe, it, expect } from "bun:test";
import { emitMutationSelector } from "../src/selector";

describe("emitMutationSelector", () => {
  it("produces a SingleInstance codeunit with Active and SetActive", () => {
    const src = emitMutationSelector({ objectId: 60000 });
    expect(src).toContain("codeunit 60000");
    expect(src).toContain("SingleInstance = true");
    expect(src).toContain("procedure Active(MutantId: Text): Boolean");
    expect(src).toContain("procedure SetActive(MutantId: Text)");
    expect(src).toContain("procedure ClearActive()");
    expect(src).toContain("if ActiveId = '' then");
  });

  it("embeds the chosen object id verbatim", () => {
    const src = emitMutationSelector({ objectId: 60042 });
    expect(src).toContain("codeunit 60042");
  });
});
