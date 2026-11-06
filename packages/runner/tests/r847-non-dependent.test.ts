import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type { PackageUnread } from "../src/backend";
import {
  type FieldItem,
  type FieldOwnerRow,
  type InstalledDependent,
  type ObjectItem,
  type ObjectOwnerRow,
  UnfilteredExtensionsQueryError,
} from "../src/harness";
import type { PackageMember, SourceMember } from "../src/member-clash";
import {
  READ_BUDGET_MS,
  controlObjects,
  newObjects,
  newTableFields,
  readInBatches,
} from "../src/non-dependent-clash";
import {
  type DeclaredObject,
  type NonDependentArgs,
  type ObjectClashCheckArgs,
  ObjectClashError,
  checkObjectClashes,
  resolveTableIds,
} from "../src/object-clash";
import { buildFakeApp } from "./helpers/fake-app";

/**
 * R847 Part 1: the check for an installed app that is NOT a dependent, driven through the real
 * `checkObjectClashes` with a stateful fake server. Every assertion that nothing was asked or read is
 * a call counter, and the clock is a fake the fake server advances; nothing reads a real one. The
 * control app that would serve the reads is not published (Part 2), so what the server SAYS is
 * faked here and proven there.
 */

const TARGET_ID = "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a91";
const X_ID = "9f3c2b1a-0000-4000-8000-000000000001";
const BASE_APP_DASHED = "437dbf0e-84ff-417a-965d-ed2bb9650972";
const BASE_APP_BARE = "437dbf0e84ff417a965ded2bb9650972";
const FOUNDATION_DASHED = "f3552374-a1f2-4356-848e-196002525837";
const INJ = { selectorId: 79290, controlId: 79291, tableId: 79292 };

const TARGET_DEP: InstalledDependent = {
  id: TARGET_ID,
  name: "Target",
  publisher: "LethAL",
  version: "1.0.0.0",
};
const X_DEP: InstalledDependent = {
  id: X_ID,
  name: "Other App",
  publisher: "Elsewhere",
  version: "2.0.0.0",
};

const pkg = (appId: string, version: string, extra: Record<string, unknown[]> = {}): Uint8Array =>
  new Uint8Array(buildFakeApp({ AppId: appId, Version: version, ...extra }));

/** The target as installed before this run: one codeunit and one table, no injected codeunits. */
const baseWith = (extra: Record<string, unknown[]> = {}, version = "1.0.0.0"): Uint8Array =>
  pkg(TARGET_ID, version, {
    Codeunits: [{ Id: 50100, Name: "Target Logic" }],
    Tables: [{ Id: 50102, Name: "Old Table" }],
    ...extra,
  });
const TWO_TABLES_SRC = `codeunit 50100 "Target Logic"
{
}

table 50102 "Old Table"
{
    fields
    {
        field(1; Id; Integer) { }
    }
}

table 50101 "New Table"
{
    fields
    {
        field(1; Id; Integer) { }
    }
}
`;
const CODEUNIT_SRC = 'codeunit 50100 "Target Logic"\n{\n}\n';
const CUSTOMER_EXT_SRC = `codeunit 50100 "Target Logic"
{
}

tableextension 50110 "Cust Ext" extends Customer
{
    fields
    {
        field(50000; "New Field"; Integer) { }
    }
}
`;
/** The injected codeunits, already in an installed target (a re-run after a gate's mint). */
const MINTED = [
  { Id: INJ.selectorId, Name: "LethAL selector" },
  { Id: INJ.controlId, Name: "LethAL control" },
  { Id: INJ.tableId, Name: "Mutation Upgrade" },
];

type Answer = InstalledDependent | "unresolved";

class Server {
  installed: readonly string[] | Error = ["1.0.0.0"];
  versionCalls = 0;
  objectCalls: { items: ObjectItem[]; maxMs: number; timeoutMs: number }[] = [];
  fieldCalls: { items: FieldItem[]; maxMs: number; timeoutMs: number }[] = [];
  fetched: string[] = [];
  readonly clock = { t: 0 };
  /** What owns each `kind:id`; anything not here is `none`. */
  owners = new Map<string, Answer>([
    ["Codeunit:50100", TARGET_DEP],
    ["Table:50102", TARGET_DEP],
  ]);
  /** The field rows, by `table:id` or `table:name:<name>`. */
  fields = new Map<string, { app: Answer; fieldName: string; tableName: string }>();
  objectCost = 0;
  fieldCost = 0;
  objectLimit = Number.POSITIVE_INFINITY;
  objectError: Error | undefined;
  packages = new Map<string, Uint8Array | PackageUnread>();
  depApps = new Map<string, Uint8Array[]>();

  nd(over: Partial<NonDependentArgs> = {}): NonDependentArgs {
    return {
      targetPublisher: "LethAL",
      targetName: "Target",
      installedVersions: async () => {
        this.versionCalls++;
        if (this.installed instanceof Error) throw this.installed;
        return this.installed;
      },
      objectOwners: async (items, maxMs, timeoutMs) => {
        this.objectCalls.push({ items: [...items], maxMs, timeoutMs });
        this.clock.t += this.objectCost;
        if (this.objectError !== undefined) throw this.objectError;
        const rows: ObjectOwnerRow[] = [];
        for (const item of items.slice(0, this.objectLimit)) {
          const a = this.owners.get(`${item.kind}:${item.id}`);
          rows.push(
            a === undefined
              ? { ...item, outcome: "none" }
              : a === "unresolved"
                ? { ...item, outcome: "unresolved" }
                : { ...item, outcome: "owner", app: a },
          );
        }
        return { read: rows.length, rows };
      },
      fieldOwners: async (items, maxMs, timeoutMs) => {
        this.fieldCalls.push({ items: [...items], maxMs, timeoutMs });
        this.clock.t += this.fieldCost;
        const rows: FieldOwnerRow[] = items.map((item) => {
          const hit = this.fields.get(
            "id" in item ? `${item.table}:${item.id}` : `${item.table}:name:${item.name}`,
          );
          if (hit === undefined) return { ...item, outcome: "none" };
          if (hit.app === "unresolved") return { ...item, outcome: "unresolved" };
          return {
            ...item,
            outcome: "owner",
            app: hit.app,
            fieldName: hit.fieldName,
            tableName: hit.tableName,
          };
        });
        return { read: rows.length, rows };
      },
      readDependencyApp: async (id) => this.depApps.get(id) ?? { unread: "not in the cache" },
      ...over,
    };
  }

  args(
    src: string,
    over: Partial<ObjectClashCheckArgs> = {},
    nd: Partial<NonDependentArgs> | null = {},
  ): ObjectClashCheckArgs {
    return {
      dependents: [],
      testsAppId: undefined,
      targetFiles: [{ path: "Target.al", text: src }],
      targetSymbols: [],
      injected: INJ,
      fetchPackage: async (app) => {
        this.fetched.push(app.name);
        return this.packages.get(app.name) ?? { unread: "not installed" };
      },
      readTestSources: async () => [],
      testSymbols: [],
      targetAppId: TARGET_ID,
      targetDependencies: [],
      transitive: [],
      startedMs: 0,
      now: () => this.clock.t,
      ...(nd === null ? {} : { nonDependent: this.nd(nd) }),
      ...over,
    };
  }
}

const has = (warnings: readonly string[], re: RegExp): boolean => warnings.some((w) => re.test(w));
const fetchedCount = (s: Server, name: string): number =>
  s.fetched.filter((n) => n === name).length;

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  );
}

beforeAll(async () => {
  await initParser();
});

describe("R847 skip and base set", () => {
  test("a first publish (not installed) asks the server nothing and reads no package", async () => {
    const s = new Server();
    s.installed = [];
    expect(await checkObjectClashes(s.args(CODEUNIT_SRC))).toEqual([]);
    expect(s.versionCalls).toBe(1);
    expect(s.objectCalls).toHaveLength(0);
    expect(s.fieldCalls).toHaveLength(0);
    expect(s.fetched).toEqual([]);
  });

  test("a failed read of 'installed' warns and is never read as a first publish", async () => {
    const s = new Server();
    s.installed = new Error("boom");
    const w = await checkObjectClashes(s.args(CODEUNIT_SRC));
    expect(has(w, /could not tell whether the target is installed \(boom\)/)).toBe(true);
    expect(s.objectCalls).toHaveLength(0);
    expect(s.fetched).toEqual([]);
  });

  test("an UnfilteredExtensionsQueryError from that read is rethrown, not a warning", async () => {
    const s = new Server();
    s.installed = new UnfilteredExtensionsQueryError("refused");
    const err = await rejection(checkObjectClashes(s.args(CODEUNIT_SRC)));
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
  });

  test("a re-run after a mint: the installed target already holds the injected codeunits, so NO control call is made", async () => {
    const s = new Server();
    s.packages.set(
      "Target",
      baseWith({ Codeunits: [{ Id: 50100, Name: "Target Logic" }, ...MINTED] }),
    );
    expect(await checkObjectClashes(s.args(CODEUNIT_SRC))).toEqual([]);
    expect(s.fetched).toEqual(["Target"]);
    expect(s.objectCalls).toHaveLength(0);
    expect(s.fieldCalls).toHaveLength(0);
  });

  test("only what is new is asked: the base set is taken off, with one known-installed control per kind first", async () => {
    const s = new Server();
    s.packages.set(
      "Target",
      baseWith({ Codeunits: [{ Id: 50100, Name: "Target Logic" }, MINTED[0]] }),
    );
    await checkObjectClashes(s.args(CODEUNIT_SRC));
    expect(s.objectCalls).toHaveLength(1);
    expect(s.objectCalls[0]?.items).toEqual([
      { kind: "Codeunit", id: 50100 },
      { kind: "Codeunit", id: INJ.controlId },
      { kind: "Codeunit", id: INJ.tableId },
    ]);
  });

  test("the INSTALLED version is named: a newer published build with the injected codeunits is not the base", async () => {
    const s = new Server();
    s.installed = ["1.0.0.0"];
    s.packages.set(
      "Target",
      baseWith({ Codeunits: [{ Id: 50100, Name: "Target Logic" }, ...MINTED] }, "1.0.0.9"),
    );
    const w = await checkObjectClashes(s.args(CODEUNIT_SRC));
    expect(has(w, /version 1\.0\.0\.9, not the installed 1\.0\.0\.0/)).toBe(true);
    // Not the base: all three injected codeunits are asked (and no control: there is no base).
    const asked = s.objectCalls[0]?.items.map((i) => i.id);
    expect(asked).toContain(INJ.selectorId);
    expect(asked).toContain(INJ.controlId);
    expect(asked).toContain(INJ.tableId);
  });

  test("two installed versions: no base set, the whole set is asked, and it warns", async () => {
    const s = new Server();
    s.installed = ["1.0.0.0", "1.0.0.5"];
    const w = await checkObjectClashes(s.args(CODEUNIT_SRC));
    expect(has(w, /2 installed versions/)).toBe(true);
    expect(s.fetched).toEqual([]);
    expect(s.objectCalls[0]?.items.map((i) => i.id)).toContain(50100);
  });

  test("an unreadable installed package falls back to the whole set under the budget, and warns", async () => {
    const s = new Server();
    const w = await checkObjectClashes(s.args(CODEUNIT_SRC)); // no package set: unread
    expect(has(w, /could not be read \(.*not installed.*\)/)).toBe(true);
    expect(s.objectCalls[0]?.items.map((i) => i.id)).toContain(50100);
  });
});

describe("R847 the step runs whatever the dependents read said", () => {
  const clashing = (): Server => {
    const s = new Server();
    s.packages.set("Target", baseWith());
    s.owners.set("Codeunit:79291", X_DEP);
    s.packages.set(
      "Other App",
      pkg(X_ID, "2.0.0.0", { Codeunits: [{ Id: 79291, Name: "Theirs" }] }),
    );
    return s;
  };

  test("dependents [] still refuses a clash with an app that is not a dependent, from that app's package", async () => {
    const s = clashing();
    const err = await rejection(checkObjectClashes(s.args(CODEUNIT_SRC, { dependents: [] })));
    expect(err).toBeInstanceOf(ObjectClashError);
    const e = err as ObjectClashError;
    expect(e.findings).toHaveLength(1);
    const [f] = e.findings;
    expect(f?.notDependent).toBe(true);
    expect(f?.app.id).toBe(X_ID);
    expect(f?.kind).toBe("Codeunit");
    expect(f?.id).toBe(INJ.controlId);
    expect(f?.read).toBe("installed-package");
    expect(f?.target.where).toStartWith("injected");
    expect(e.memberFindings).toEqual([]);
    // The base was read, then the lead's own package: that is what refused.
    expect(s.fetched).toEqual(["Target", "Other App"]);
  });

  test("a dependents read that FAILED still runs the step", async () => {
    const s = clashing();
    const err = await rejection(
      checkObjectClashes(s.args(CODEUNIT_SRC, { dependents: { error: new Error("no control") } })),
    );
    expect(err).toBeInstanceOf(ObjectClashError);
    expect(s.objectCalls).toHaveLength(1);
  });

  test("the text says the app is NOT KNOWN to be a dependent, and to remove the clash in the target or that app", async () => {
    const s = clashing();
    const e = (await rejection(checkObjectClashes(s.args(CODEUNIT_SRC)))) as ObjectClashError;
    expect(e.message).toContain("(not known to be a dependent)");
    expect(e.message).toContain("remove the clash in the target, or in that app");
    expect(e.message).not.toContain("Republish the named app built against this target");
    expect(e.message).toContain("set selectorIds in the config");
  });

  test("a clash on an object from the target's SOURCE does not tell the user to republish the unrelated app", async () => {
    const s = new Server();
    s.packages.set(
      "Target",
      baseWith({ Codeunits: [{ Id: 50100, Name: "Target Logic" }, ...MINTED] }),
    );
    s.owners.set("Codeunit:50200", X_DEP);
    s.packages.set(
      "Other App",
      pkg(X_ID, "2.0.0.0", { Codeunits: [{ Id: 50200, Name: "Theirs" }] }),
    );
    const src = `${CODEUNIT_SRC}\ncodeunit 50200 "New Source Codeunit"\n{\n}\n`;
    const e = (await rejection(checkObjectClashes(s.args(src)))) as ObjectClashError;
    expect(e).toBeInstanceOf(ObjectClashError);
    expect(e.findings.map((f) => [f.id, f.notDependent, f.target.where])).toEqual([
      [50200, true, "Target.al"],
    ]);
    expect(e.message).toContain("remove the clash in the target, or in that app");
    expect(e.message).not.toContain("Republish the named app built against this target");
    expect(e.message).not.toContain("set selectorIds");
  });

  test("with no nonDependent argument (a backend that is not bcdev) nothing is asked and an empty dependents list returns at once", async () => {
    const s = new Server();
    expect(await checkObjectClashes(s.args(CODEUNIT_SRC, {}, null))).toEqual([]);
    expect(s.versionCalls).toBe(0);
  });
});

describe("R847 leads are never refusals", () => {
  const base = (): Server => {
    const s = new Server();
    s.packages.set("Target", baseWith());
    return s;
  };

  test("an owner that is the target passes, and nothing else is read", async () => {
    const s = base();
    s.owners.set("Codeunit:79291", TARGET_DEP);
    expect(await checkObjectClashes(s.args(CODEUNIT_SRC))).toEqual([]);
    expect(s.fetched).toEqual(["Target"]);
  });

  test("unresolved warns, so a failed join on the target's own row cannot refuse", async () => {
    const s = base();
    s.owners.set("Codeunit:79291", "unresolved");
    const w = await checkObjectClashes(s.args(CODEUNIT_SRC));
    expect(has(w, /could not tell which installed app owns Codeunit 79291/)).toBe(true);
    expect(s.fetched).toEqual(["Target"]);
  });

  test("a dependent that was COMPARED is not read a second time", async () => {
    const s = base();
    s.owners.set("Codeunit:79291", X_DEP);
    s.packages.set("Other App", pkg(X_ID, "2.0.0.0", { Codeunits: [{ Id: 1, Name: "Mine" }] }));
    expect(await checkObjectClashes(s.args(CODEUNIT_SRC, { dependents: [X_DEP] }))).toEqual([]);
    expect(fetchedCount(s, "Other App")).toBe(1);
  });

  test("a dependent that was NOT compared (its read failed) goes to its package again as a lead", async () => {
    const s = base();
    s.owners.set("Codeunit:79291", X_DEP);
    // No package for it: the loop cannot read it, and neither can the lead.
    const w = await checkObjectClashes(s.args(CODEUNIT_SRC, { dependents: [X_DEP] }));
    expect(fetchedCount(s, "Other App")).toBe(2);
    expect(
      w.filter((x) => /could not read the installed package of Other App/.test(x)),
    ).toHaveLength(2);
  });

  test("a lead whose package has no real clash passes", async () => {
    const s = base();
    s.owners.set("Codeunit:79291", X_DEP);
    s.packages.set("Other App", pkg(X_ID, "2.0.0.0", { Codeunits: [{ Id: 1, Name: "Mine" }] }));
    expect(await checkObjectClashes(s.args(CODEUNIT_SRC))).toEqual([]);
    expect(fetchedCount(s, "Other App")).toBe(1);
  });

  test("a lead's package that is the wrong app or version is unreadable: it warns and does not refuse", async () => {
    const s = base();
    s.owners.set("Codeunit:79291", X_DEP);
    s.packages.set(
      "Other App",
      pkg(X_ID, "9.9.9.9", { Codeunits: [{ Id: INJ.controlId, Name: "Theirs" }] }),
    );
    const w = await checkObjectClashes(s.args(CODEUNIT_SRC));
    expect(has(w, /could not read the installed package of Other App/)).toBe(true);
  });

  test("an unreadable lead warns", async () => {
    const s = base();
    s.owners.set("Codeunit:79291", X_DEP);
    s.packages.set("Other App", { unread: "HTTP 500" });
    const w = await checkObjectClashes(s.args(CODEUNIT_SRC));
    expect(has(w, /could not read the installed package of Other App .*HTTP 500/)).toBe(true);
  });

  test("the same id in ANOTHER kind passes", async () => {
    const s = base();
    s.owners.set("Codeunit:79291", X_DEP);
    s.packages.set(
      "Other App",
      pkg(X_ID, "2.0.0.0", { Tables: [{ Id: INJ.controlId, Name: "T" }] }),
    );
    expect(await checkObjectClashes(s.args(CODEUNIT_SRC))).toEqual([]);
  });

  test("Moved on the other side warns and does not refuse", async () => {
    const s = new Server();
    s.packages.set(
      "Target",
      baseWith({ Codeunits: [{ Id: 50100, Name: "Target Logic" }, ...MINTED] }),
    );
    s.owners.set("Table:50101", X_DEP);
    s.packages.set(
      "Other App",
      pkg(X_ID, "2.0.0.0", {
        Tables: [
          {
            Id: 50101,
            Name: "Theirs",
            Properties: [{ Name: "ObsoleteState", Value: "Moved" }],
          },
        ],
      }),
    );
    const w = await checkObjectClashes(s.args(TWO_TABLES_SRC));
    expect(has(w, /Table 50101 is marked Moved on Other App/)).toBe(true);
    expect(fetchedCount(s, "Other App")).toBe(1);
  });
});

describe("R847 blind kinds", () => {
  test("a control that does not come back owned by the target makes the kind unseen: it warns, never clean, never refuses", async () => {
    const s = new Server();
    s.packages.set(
      "Target",
      baseWith({ Codeunits: [{ Id: 50100, Name: "Target Logic" }, ...MINTED] }),
    );
    // AllObj shows no row for the control table (Table:50102 is not owned) but names X for the new one.
    s.owners.delete("Table:50102");
    s.owners.set("Table:50101", X_DEP);
    s.packages.set("Other App", pkg(X_ID, "2.0.0.0", { Tables: [{ Id: 50101, Name: "Theirs" }] }));
    const w = await checkObjectClashes(s.args(TWO_TABLES_SRC));
    expect(has(w, /Table: the server's object table cannot be trusted.*came back "none"/)).toBe(
      true,
    );
    expect(has(w, /1 new Table object\(s\) were NOT checked/)).toBe(true);
    expect(fetchedCount(s, "Other App")).toBe(0);
  });

  test("a control that comes back owned by ANOTHER app makes the kind unseen too, and names that app", async () => {
    const s = new Server();
    s.packages.set(
      "Target",
      baseWith({ Codeunits: [{ Id: 50100, Name: "Target Logic" }, ...MINTED.slice(0, 1)] }),
    );
    s.owners.set("Codeunit:50100", X_DEP);
    s.owners.set("Codeunit:79291", X_DEP);
    s.packages.set(
      "Other App",
      pkg(X_ID, "2.0.0.0", { Codeunits: [{ Id: INJ.controlId, Name: "Theirs" }] }),
    );
    const w = await checkObjectClashes(s.args(CODEUNIT_SRC));
    expect(
      has(w, /Codeunit: the server's object table cannot be trusted.*owned by Other App/),
    ).toBe(true);
    expect(fetchedCount(s, "Other App")).toBe(0);
  });

  test("a kind the installed target declares nothing of has no control: it warns", async () => {
    const s = new Server();
    s.packages.set("Target", baseWith({ Tables: [] }));
    const src = `${CODEUNIT_SRC}\ntable 50101 "New Table"\n{\n    fields\n    {\n        field(1; Id; Integer) { }\n    }\n}\n`;
    const w = await checkObjectClashes(s.args(src));
    expect(has(w, /declares no object of this kind to use as a control/)).toBe(true);
  });

  test("a control that was not read (a partial read) makes its kind unseen", async () => {
    const s = new Server();
    s.packages.set("Target", baseWith());
    s.objectLimit = 0;
    const w = await checkObjectClashes(s.args(CODEUNIT_SRC));
    expect(has(w, /its control object was not read/)).toBe(true);
    expect(has(w, /NOT read/)).toBe(true);
  });
});

describe("R847 the budget and the batches", () => {
  const manyCodeunits = (n: number): string =>
    Array.from({ length: n }, (_, i) => `codeunit ${60000 + i} "C ${i}"\n{\n}\n`).join("\n") +
    CODEUNIT_SRC;

  test("MaxMs is the time left, sent with each call, and a call is split at 200 items", async () => {
    const s = new Server();
    s.packages.set("Target", baseWith());
    s.objectCost = 4000;
    await checkObjectClashes(s.args(manyCodeunits(250)));
    expect(s.objectCalls.map((c) => c.items.length)).toEqual([200, 54]);
    expect(s.objectCalls.map((c) => c.maxMs)).toEqual([READ_BUDGET_MS, READ_BUDGET_MS - 4000]);
    expect(s.objectCalls.map((c) => c.timeoutMs)).toEqual([READ_BUDGET_MS, READ_BUDGET_MS - 4000]);
  });

  test("past the deadline no further call is made, and it warns, never refuses", async () => {
    const s = new Server();
    s.packages.set("Target", baseWith());
    s.objectCost = READ_BUDGET_MS + 1;
    const w = await checkObjectClashes(s.args(manyCodeunits(250)));
    expect(s.objectCalls).toHaveLength(1);
    expect(has(w, /54 of 254 object\(s\) were NOT read/)).toBe(true);
  });

  test("a call that answers fewer rows than it was given ends the read, and warns", async () => {
    const s = new Server();
    s.packages.set("Target", baseWith());
    s.objectLimit = 100;
    const w = await checkObjectClashes(s.args(manyCodeunits(250)));
    expect(s.objectCalls).toHaveLength(1);
    expect(has(w, /154 of 254 object\(s\) were NOT read/)).toBe(true);
  });

  test("the budget is shared by objects and fields", async () => {
    const s = new Server();
    s.packages.set(
      "Target",
      baseWith({ Codeunits: [{ Id: 50100, Name: "Target Logic" }, ...MINTED] }),
    );
    s.depApps.set(BASE_APP_DASHED, [
      pkg(BASE_APP_DASHED, "28.0.0.0", { Tables: [{ Id: 18, Name: "Customer" }] }),
    ]);
    s.objectCost = 0;
    // Two new objects (Table 50101 and a control) are read first and use the whole budget.
    s.owners.set("Table:50102", TARGET_DEP);
    s.objectCost = READ_BUDGET_MS;
    const src = `${CUSTOMER_EXT_SRC}\ntable 50102 "Old Table"\n{\n    fields\n    {\n        field(1; Id; Integer) { }\n    }\n}\n\ntable 50101 "New Table"\n{\n    fields\n    {\n        field(1; Id; Integer) { }\n    }\n}\n`;
    const w = await checkObjectClashes(s.args(src));
    expect(s.objectCalls).toHaveLength(1);
    expect(s.fieldCalls).toHaveLength(0);
    expect(has(w, /2 of 2 field\(s\) were NOT read/)).toBe(true);
  });

  test("a failed read warns and does not fail the run; only an UnfilteredExtensionsQueryError is rethrown", async () => {
    const s = new Server();
    s.packages.set("Target", baseWith());
    s.objectError = new Error("HTTP 404");
    const w = await checkObjectClashes(s.args(CODEUNIT_SRC));
    expect(has(w, /the keyed read of 4 object\(s\) failed \(HTTP 404\)/)).toBe(true);
    s.objectError = new UnfilteredExtensionsQueryError("refused");
    expect(await rejection(checkObjectClashes(s.args(CODEUNIT_SRC)))).toBeInstanceOf(
      UnfilteredExtensionsQueryError,
    );
  });
});

describe("R847 fields on a table the target does not own", () => {
  const withFields = (): Server => {
    const s = new Server();
    // The installed target already holds the tableextension (without the new field) and the minted
    // codeunits, so the only thing new is the field, and the Customer table id is read offline.
    s.packages.set(
      "Target",
      baseWith({
        Codeunits: [{ Id: 50100, Name: "Target Logic" }, ...MINTED],
        TableExtensions: [
          { Id: 50110, Name: "Cust Ext", TargetObject: `#${BASE_APP_BARE}#Customer`, Fields: [] },
        ],
      }),
    );
    s.owners.set("TableExtension:50110", TARGET_DEP);
    s.depApps.set(BASE_APP_DASHED, [
      pkg(BASE_APP_DASHED, "28.0.0.0", { Tables: [{ Id: 18, Name: "Customer" }] }),
    ]);
    s.packages.set(
      "Other App",
      pkg(X_ID, "2.0.0.0", {
        TableExtensions: [
          {
            Id: 60000,
            Name: "X Cust",
            TargetObject: `#${BASE_APP_BARE}#Customer`,
            Fields: [{ Id: 50000, Name: "Other" }],
          },
        ],
      }),
    );
    return s;
  };

  test("a field id an app that is not a dependent owns refuses, from that app's package", async () => {
    const s = withFields();
    s.fields.set("18:50000", { app: X_DEP, fieldName: "Other", tableName: "Customer" });
    const e = (await rejection(checkObjectClashes(s.args(CUSTOMER_EXT_SRC)))) as ObjectClashError;
    expect(e).toBeInstanceOf(ObjectClashError);
    expect(e.findings).toEqual([]);
    expect(e.memberFindings).toHaveLength(1);
    const [m] = e.memberFindings;
    expect(m?.rule).toBe("field-id");
    expect(m?.notDependent).toBe(true);
    expect(m?.app.id).toBe(X_ID);
    expect(m?.ownerName).toBe("Customer");
    // The target's items were asked by id and by name, with the table id read offline.
    expect(s.fieldCalls[0]?.items).toEqual([
      { table: 18, id: 50000 },
      { table: 18, name: "New Field" },
    ]);
    expect(s.objectCalls).toHaveLength(0);
  });

  test("a name that differs only in case is not a lead (BC accepts it): X's package is not read", async () => {
    const s = withFields();
    s.fields.set("18:name:New Field", {
      app: X_DEP,
      fieldName: "NEW FIELD",
      tableName: "Customer",
    });
    expect(await checkObjectClashes(s.args(CUSTOMER_EXT_SRC))).toEqual([]);
    expect(fetchedCount(s, "Other App")).toBe(0);
  });

  test("an exact name is a lead", async () => {
    const s = withFields();
    s.fields.set("18:name:New Field", {
      app: X_DEP,
      fieldName: "New Field",
      tableName: "Customer",
    });
    s.packages.set(
      "Other App",
      pkg(X_ID, "2.0.0.0", {
        TableExtensions: [
          {
            Id: 60000,
            Name: "X Cust",
            TargetObject: `#${BASE_APP_BARE}#Customer`,
            Fields: [{ Id: 60001, Name: "New Field" }],
          },
        ],
      }),
    );
    const e = (await rejection(checkObjectClashes(s.args(CUSTOMER_EXT_SRC)))) as ObjectClashError;
    expect(e).toBeInstanceOf(ObjectClashError);
    expect(e.memberFindings.map((m) => m.rule)).toEqual(["field-name"]);
    expect(fetchedCount(s, "Other App")).toBe(1);
  });

  test("a row for another table (a wrong TableName) is not followed, and warns", async () => {
    const s = withFields();
    s.fields.set("18:50000", { app: X_DEP, fieldName: "Other", tableName: "Vendor" });
    const w = await checkObjectClashes(s.args(CUSTOMER_EXT_SRC));
    expect(has(w, /table 18 is called "Vendor" on the server, not "Customer"/)).toBe(true);
    expect(fetchedCount(s, "Other App")).toBe(0);
  });

  test("a table name with two ids in the dependencies' symbols warns and its fields are not read", async () => {
    const s = withFields();
    s.depApps.set(FOUNDATION_DASHED, [
      pkg(FOUNDATION_DASHED, "28.0.0.0", { Tables: [{ Id: 19, Name: "Customer" }] }),
    ]);
    const w = await checkObjectClashes(s.args(CUSTOMER_EXT_SRC));
    expect(has(w, /table "customer" has 2 ids/)).toBe(true);
    expect(s.fieldCalls).toHaveLength(0);
  });

  test("a table name found in no dependency warns and its fields are not read", async () => {
    const s = withFields();
    s.depApps.clear();
    const w = await checkObjectClashes(s.args(CUSTOMER_EXT_SRC));
    expect(has(w, /no table "customer" in the symbols/)).toBe(true);
    expect(s.fieldCalls).toHaveLength(0);
  });

  test("a field of a table the target OWNS is not asked (a non-dependent cannot extend it)", async () => {
    const s = new Server();
    s.packages.set(
      "Target",
      baseWith({ Codeunits: [{ Id: 50100, Name: "Target Logic" }, ...MINTED] }),
    );
    // The table's id IS resolvable from the package cache, so only the own-table rule keeps it out.
    s.depApps.set(BASE_APP_DASHED, [
      pkg(BASE_APP_DASHED, "28.0.0.0", { Tables: [{ Id: 50102, Name: "Old Table" }] }),
    ]);
    const src = `${CODEUNIT_SRC}\ntable 50102 "Old Table"\n{\n    fields\n    {\n        field(1; Id; Integer) { }\n        field(2; Extra; Integer) { }\n    }\n}\n`;
    const w = await checkObjectClashes(s.args(src));
    expect(s.fieldCalls).toHaveLength(0);
    expect(has(w, /no table|has \d+ ids/)).toBe(false);
  });
});

describe("R847 the pure parts", () => {
  const obj = (kind: DeclaredObject["kind"], id: number): DeclaredObject => ({
    kind,
    id,
    name: `${kind} ${id}`,
    where: "x",
  });
  const sm = (over: Partial<SourceMember>): SourceMember => ({
    container: "Table",
    ownerName: "Customer",
    ownerKey: "customer",
    own: false,
    id: 1,
    name: "A",
    moved: false,
    where: "x",
    ...over,
  });
  const pm = (over: Partial<PackageMember>): PackageMember => ({
    container: "Table",
    ownerApp: "a".repeat(32),
    ownerName: "Customer",
    ownerKey: "customer",
    id: 1,
    name: "A",
    moved: false,
    where: "x",
    ...over,
  });

  test("newObjects takes the base off by (kind, id), each once; the same id in another kind stays new", () => {
    const got = newObjects(
      [obj("Codeunit", 1), obj("Codeunit", 1), obj("Codeunit", 2), obj("Table", 2)],
      [obj("Codeunit", 2)],
    );
    expect(got.map((o) => `${o.kind}:${o.id}`)).toEqual(["Codeunit:1", "Table:2"]);
    expect(newObjects([obj("Codeunit", 2)], undefined)).toHaveLength(1);
  });

  test("controlObjects gives one base object for each kind asked, and none for a kind the base lacks", () => {
    const got = controlObjects(
      [obj("Codeunit", 9), obj("Table", 9), obj("Page", 9)],
      [obj("Codeunit", 1), obj("Codeunit", 2), obj("Table", 3)],
    );
    expect(got.map((o) => `${o.kind}:${o.id}`)).toEqual(["Codeunit:1", "Table:3"]);
  });

  test("newTableFields: new by id, by name, or both; own tables, enums and held fields are left out", () => {
    const got = newTableFields(
      [
        sm({ id: 1, name: "A" }), // held by id and name: not new
        sm({ id: 2, name: "A" }), // id new, name held
        sm({ id: 1, name: "B" }), // name new, id held
        sm({ id: 3, name: "C" }), // both
        sm({ id: 4, name: "D", own: true }),
        sm({ container: "Enum", id: 5, name: "E" }),
        sm({ id: 3, name: "C" }), // a repeat
      ],
      [pm({ id: 1, name: "A" })],
    );
    expect(got.map((f) => `${f.id}:${f.name}:${f.byId}:${f.byName}`)).toEqual([
      "2:A:true:false",
      "1:B:false:true",
      "3:C:true:true",
    ]);
    expect(newTableFields([sm({ id: 1, name: "A" })], undefined)).toHaveLength(1);
  });

  test("readInBatches throws when a call's row count is not its read count", async () => {
    const err = await rejection(
      readInBatches([1, 2], async () => ({ read: 2, rows: ["a"] }), {
        now: () => 0,
        deadlineMs: 10,
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("answered 1 row(s) and read=2");
  });

  test("resolveTableIds reads a REAL alc package: the table's id by its name, case-insensitively", async () => {
    const real = new Uint8Array(
      readFileSync(join(import.meta.dir, "..", "..", "..", "scripts", "testdata", "r845-base.app")),
    );
    const warnings: string[] = [];
    const baseId = "5a0c4f6e-3b1d-4e57-9a28-7d6c1e0b8f31";
    const got = await resolveTableIds(
      ["r845 base t", "no such table"],
      [baseId, "00000000000000000000000000000001"],
      async (id) => (id === baseId ? [real] : { unread: "absent" }),
      (m) => warnings.push(m),
    );
    expect(got.get("r845 base t")).toBe(50100);
    expect(got.has("no such table")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no table "no such table"');
  });

  test("resolveTableIds warns on a package that cannot be read, once, and leaves the name out", async () => {
    const warnings: string[] = [];
    const got = await resolveTableIds(
      ["customer"],
      [BASE_APP_BARE],
      async () => [new Uint8Array([1, 2, 3])],
      (m) => warnings.push(m),
    );
    expect(got.size).toBe(0);
    expect(has(warnings, /unreadable/)).toBe(true);
    expect(has(warnings, /no table "customer"/)).toBe(true);
  });
});
