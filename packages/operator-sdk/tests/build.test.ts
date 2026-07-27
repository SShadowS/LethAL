import { describe, expect, it } from "bun:test";
import { build } from "../src/build";

describe("build", () => {
  it("emits a boolean literal", () => {
    expect(build.booleanLiteral(true).toAL()).toBe("true");
    expect(build.booleanLiteral(false).toAL()).toBe("false");
  });

  it("emits an integer literal", () => {
    expect(build.integerLiteral(42).toAL()).toBe("42");
  });

  it("emits a decimal literal with canonical format", () => {
    expect(build.decimalLiteral(1.5).toAL()).toBe("1.5");
  });

  it("emits an identifier", () => {
    expect(build.identifier("Amount").toAL()).toBe("Amount");
  });

  it("emits a binary op", () => {
    const expr = build.binaryOp(">", build.identifier("Amount"), build.integerLiteral(0));
    expect(expr.toAL()).toBe("Amount > 0");
  });

  it("emits nested binary op with explicit parentheses", () => {
    const expr = build.binaryOp(
      "+",
      build.binaryOp("*", build.identifier("a"), build.integerLiteral(2)),
      build.identifier("b"),
    );
    expect(expr.toAL()).toBe("(a * 2) + b");
  });

  it("emits a procedure call", () => {
    const expr = build.procedureCall("Helper", [build.integerLiteral(1)]);
    expect(expr.toAL()).toBe("Helper(1)");
  });

  it("rejects invalid identifier via assertIdentifier", () => {
    expect(() => build.identifier("")).toThrow(/identifier/);
    expect(() => build.identifier("1bad")).toThrow(/identifier/);
  });
});
