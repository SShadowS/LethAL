import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QuarantineStore, QuarantineStoreNotADirectoryError } from "../src/quarantine-store";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

describe("R417: a quarantine store path that is not a directory is refused, on every platform", () => {
  const fileAtPath = () => {
    const p = join(scratch("lethal-qstore-"), "blocker");
    writeFileSync(p, "not a directory");
    return p;
  };

  test("read() refuses it, naming the path", async () => {
    const p = fileAtPath();
    const err = await new QuarantineStore(p).read("tier").catch((e) => e);
    expect(err).toBeInstanceOf(QuarantineStoreNotADirectoryError);
    expect(err.message).toContain(p);
  });

  test("clear() refuses it rather than answering 'cleared'", async () => {
    const err = await new QuarantineStore(fileAtPath()).clear("tier", 1).catch((e) => e);
    expect(err).toBeInstanceOf(QuarantineStoreNotADirectoryError);
  });

  test("a MISSING store dir is no record, and clear() of it is 'cleared'", async () => {
    const store = new QuarantineStore(join(scratch("lethal-qstore-"), "never-made"));
    expect(await store.read("tier")).toBeNull();
    expect(await store.clear("tier", 1)).toBe("cleared");
  });

  // Windows reports ENOENT for a child of a file (R413) where Linux reports ENOTDIR; both must
  // refuse, so this runs on every platform.
  test("a store dir whose PARENT (or grandparent) is a file is refused by read() and clear()", async () => {
    for (const tail of ["sub", join("sub", "deeper")]) {
      const file = fileAtPath();
      const store = new QuarantineStore(join(file, tail));
      const err = await store.read("tier").catch((e) => e);
      expect(err).toBeInstanceOf(QuarantineStoreNotADirectoryError);
      expect(err.message).toContain(file);
      expect(await store.clear("tier", 1).catch((e) => e)).toBeInstanceOf(
        QuarantineStoreNotADirectoryError,
      );
    }
  });

  test("a MISSING store dir several levels deep is still no record", async () => {
    const store = new QuarantineStore(join(scratch("lethal-qstore-"), "a", "b", "c"));
    expect(await store.read("tier")).toBeNull();
    expect(await store.clear("tier", 1)).toBe("cleared");
  });

  test("an existing empty store dir is no record", async () => {
    expect(await new QuarantineStore(scratch("lethal-qstore-")).read("tier")).toBeNull();
  });
});
