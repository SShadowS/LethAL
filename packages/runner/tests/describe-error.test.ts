import { describe, expect, it } from "bun:test";
import { DESCRIBED_ERRNO_FIELDS, describeThrown } from "../src/describe-error";

/**
 * R65. A Bun spawn `ENOENT` arrives as an `Error` whose `message` is the EMPTY STRING — the
 * diagnostic content is on `code`/`path`/`syscall` instead. Every catch in this package used to
 * stringify `err.message` alone, so a wrong-platform binary (R64) surfaced as a bare `Error` with
 * no text at all and cost a long external debugging session to trace.
 *
 * The invariant these tests pin: `describeThrown` NEVER returns an empty or whitespace-only
 * string, whatever it is handed. An empty diagnosis is worse than a wrong one — it is the
 * empty-vs-empty "match" that is this project's signature bug.
 */
describe("describeThrown", () => {
  it("names the code, syscall and path when the message is empty (the Bun spawn ENOENT shape)", () => {
    const err = Object.assign(new Error(""), {
      code: "ENOENT",
      syscall: "spawn",
      path: "/ext/bin/linux/alc",
    });
    const described = describeThrown(err);
    expect(described).toContain("ENOENT");
    expect(described).toContain("/ext/bin/linux/alc");
    expect(described).toContain("spawn");
  });

  // The remaining R65 cause after R64 fixed the path: the AL extension's own activation is what
  // chmods bin/linux/alc, so an unpacked-but-never-activated VSIX has them non-executable.
  it("names EACCES and the path for a binary that exists but is not executable", () => {
    const err = Object.assign(new Error(""), {
      code: "EACCES",
      syscall: "spawn",
      path: "/ext/bin/linux/alc",
    });
    const described = describeThrown(err);
    expect(described).toContain("EACCES");
    expect(described).toContain("/ext/bin/linux/alc");
  });

  it("returns the message unchanged for an ordinary Error carrying no errno fields", () => {
    expect(describeThrown(new Error("alc exploded"))).toBe("alc exploded");
  });

  it("keeps BOTH the message and the errno detail when an error carries both", () => {
    const err = Object.assign(new Error("spawn alc ENOENT"), {
      code: "ENOENT",
      path: "/ext/bin/win32/alc.exe",
    });
    const described = describeThrown(err);
    expect(described).toContain("spawn alc ENOENT");
    expect(described).toContain("/ext/bin/win32/alc.exe");
    // Node's own spawn message already embeds the code; saying it twice is noise. Asserting the
    // COUNT is what makes this test able to fail — `toContain("ENOENT")` passes with the dedup,
    // without it, and with it inverted.
    expect(described.split("ENOENT").length - 1).toBe(1);
  });

  // A numeric code stringifies to a digit that trivially appears inside an unrelated message, so
  // deduping it by substring silently drops the one field the caller most needs.
  it("does not drop a NUMERIC code just because its digits appear in the message", () => {
    const err = Object.assign(new Error("timed out after 1200ms"), { code: 2 });
    expect(describeThrown(err)).toContain("(2)");
  });

  it("describes a non-Error throw", () => {
    expect(describeThrown("kaboom")).toContain("kaboom");
  });

  // Contract 1, stated directly. Anything that trims to empty here is R65 all over again.
  it.each([
    ["empty-message Error", new Error("")],
    ["whitespace-message Error", new Error("   ")],
    ["bare object", {}],
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["zero", 0],
  ])("never returns an empty description: %s", (_label, thrown) => {
    expect(describeThrown(thrown).trim().length).toBeGreaterThan(0);
  });

  // …and non-empty is not sufficient. `String({})` is "[object Object]" — non-empty, and it tells
  // the reader nothing, so it would satisfy the contract above on a technicality while leaving the
  // caller exactly as blind as R65 left them.
  it.each([
    ["bare object", {}, "object"],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
    ["empty-message Error", new Error(""), "Error"],
  ])("says WHAT was thrown when there is nothing to report: %s", (_label, thrown, expected) => {
    const described = describeThrown(thrown);
    expect(described).not.toBe("[object Object]");
    expect(described).toContain(expected);
  });

  // Contract 2. This runs inside catch blocks: if it throws, it replaces the caller's real error
  // with its own — R65's failure mode made worse. `String(err)` alone does not survive these.
  it.each([
    ["a null-prototype object", Object.create(null) as unknown],
    [
      "an object whose toString throws",
      {
        toString() {
          throw new Error("hostile");
        },
      },
    ],
    [
      "an Error whose message is not a string",
      Object.assign(new Error("x"), { message: 42 as unknown }),
    ],
  ])("never throws, whatever it is handed: %s", (_label, thrown) => {
    let described = "";
    expect(() => {
      described = describeThrown(thrown);
    }).not.toThrow();
    expect(described.trim().length).toBeGreaterThan(0);
  });

  // The field list is a CREDENTIAL boundary, not just a diagnostic one: `artifact.ts` and
  // `publisher.ts` print this output without redacting it, and `publisher.ts` passes
  // BC_SERVER_PASSWORD to the child through `opts.env`. Node hangs `spawnargs`/`cmd`/`env` on
  // spawn failures, so widening this list leaks credentials into an unredacted error string.
  // Pinned here so that widening it has to be a decision someone makes on purpose.
  it("reads ONLY code/syscall/path off a thrown error", () => {
    expect([...DESCRIBED_ERRNO_FIELDS]).toEqual(["code", "syscall", "path"]);
  });

  it("never surfaces argv or env off a spawn error", () => {
    const err = Object.assign(new Error(""), {
      code: "ENOENT",
      path: "/ext/bin/linux/altool",
      spawnargs: ["--password", "hunter2"],
      cmd: "altool --password hunter2",
      env: { BC_SERVER_PASSWORD: "hunter2" },
    });
    expect(describeThrown(err)).not.toContain("hunter2");
  });
});
