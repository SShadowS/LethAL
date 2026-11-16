import { describe, expect, test } from "bun:test";
import {
  type GhComment,
  type GhIssue,
  type ScanDeps,
  actionRows,
  commitOfDirName,
  entriesOf,
  extractBuilds,
  formatRows,
  latestMaintainerComment,
  listOurIssues,
  readOnlyGh,
  scan,
  summariseRepros,
} from "./upstream-fixed-scan";

const maint = (body: string, createdAt: string, url = `https://x/${createdAt}`): GhComment => ({
  author: { login: "StefanMaron" },
  authorAssociation: "MEMBER",
  body,
  createdAt,
  url,
});
const ours = (body: string, createdAt: string): GhComment => ({
  author: { login: "SShadowS" },
  authorAssociation: "NONE",
  body,
  createdAt,
  url: `https://x/ours-${createdAt}`,
});

/** Recorded shapes of `gh issue list --json number,title,comments` (bodies trimmed). */
const ISSUES: GhIssue[] = [
  {
    number: 100,
    title: "fixed in current",
    comments: [
      maint("Thanks. The new edge build (`bd44b20ea`) changes one item.", "2026-11-10T00:00:00Z"),
      ours("Thank you, will re-run.", "2026-11-11T00:00:00Z"),
    ],
  },
  {
    number: 101,
    title: "no maintainer comment",
    comments: [ours("report", "2026-11-01T00:00:00Z")],
  },
  {
    number: 102,
    title: "build not pinned yet",
    comments: [maint("It is on the edge now, `14e5d6937`.", "2026-11-12T00:00:00Z")],
  },
  {
    number: 103,
    title: "batch issue, step one only",
    comments: [maint("Fixed on edge-5a58a0f16 and `deadbeef1`.", "2026-11-13T00:00:00Z")],
  },
  {
    number: 104,
    title: "maintainer asked a question",
    comments: [maint("Do you plan a pull request for this one?", "2026-11-12T00:00:00Z")],
  },
];

const KNOWN = new Set(["bd44b20ea", "14e5d6937", "5a58a0f16", "deadbeef1"]);
const CURRENT = "5a58a0f16";
// ancestors of current: bd44b20ea, 5a58a0f16 (itself), deadbeef1 is not.
const ANCESTORS: Record<string, string[]> = {
  [CURRENT]: ["bd44b20ea", "5a58a0f16"],
  cand000001: ["14e5d6937"],
};

function deps(over: Partial<ScanDeps> = {}) {
  const seen = { ancestorCalls: [] as string[][], fetches: 0 };
  const d: ScanDeps = {
    gh: async () => JSON.stringify(ISSUES),
    currentCommit: async () => CURRENT,
    known: async (c) => KNOWN.has(c),
    fetch: async () => {
      seen.fetches++;
    },
    isAncestor: async (a, b) => {
      seen.ancestorCalls.push([a, b]);
      return (ANCESTORS[b] ?? []).includes(a);
    },
    manifest: [
      { id: "u100-a", issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/100" },
      { id: "u103-a", issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/103" },
      { id: "u103-b", issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/103" },
      {
        id: "u1000-x",
        issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/1000",
      },
    ],
    ...over,
  };
  return { d, seen };
}

describe("extractBuilds", () => {
  test("backticked ids, edge-<hex>, several, and no words", () => {
    expect(extractBuilds("The new edge build (`bd44b20ea`) changes one item")).toEqual([
      "bd44b20ea",
    ]);
    expect(extractBuilds("on the edge now, `14e5d6937`")).toEqual(["14e5d6937"]);
    expect(extractBuilds("Fixed on edge-5a58a0f16 and `DEADBEEF1`.")).toEqual([
      "5a58a0f16",
      "deadbeef1",
    ]);
    expect(
      extractBuilds("`abcdefabc` is only letters; `Codeunit` too; plain 5a58a0f16 is not quoted"),
    ).toEqual([]);
    expect(extractBuilds("`bd44b20ea` and again `bd44b20ea`")).toEqual(["bd44b20ea"]);
  });
});

describe("latestMaintainerComment", () => {
  test("ignores our later comments and picks the newest of the maintainer's", () => {
    const c = latestMaintainerComment([
      maint("old", "2026-11-01T00:00:00Z"),
      maint("new", "2026-11-05T00:00:00Z"),
      ours("later, ours", "2026-11-09T00:00:00Z"),
    ]);
    expect(c?.body).toBe("new");
  });
  test("prefers OWNER/MEMBER/COLLABORATOR over a newer drive-by comment", () => {
    const drive: GhComment = {
      author: { login: "someone" },
      authorAssociation: "NONE",
      body: "me too",
      createdAt: "2026-11-20T00:00:00Z",
    };
    expect(latestMaintainerComment([maint("m", "2026-11-01T00:00:00Z"), drive])?.body).toBe("m");
    expect(latestMaintainerComment([drive])?.body).toBe("me too");
  });
  test("none", () => {
    expect(latestMaintainerComment([ours("x", "2026-11-01T00:00:00Z")])).toBeUndefined();
  });
});

describe("scan", () => {
  test("each class, with the comment's url and date", async () => {
    const { d } = deps();
    const rows = await scan(d, ISSUES);
    const by = (n: number) => rows.find((r) => r.number === n);
    expect(by(100)).toMatchObject({
      class: "fixed-in-current",
      builds: ["bd44b20ea"],
      commentUrl: "https://x/2026-11-10T00:00:00Z",
      commentDate: "2026-11-10T00:00:00Z",
    });
    expect(by(101)?.class).toBe("no-fix-reported");
    expect(by(101)?.commentUrl).toBeUndefined();
    expect(by(102)?.class).toBe("fixed-not-pinned");
    expect(by(103)?.class).toBe("fixed-in-current"); // one of two builds is enough
    expect(by(104)?.class).toBe("no-fix-reported");
  });

  test("candidate: fixed-in-candidate only when not already in current", async () => {
    const { d } = deps({ candidate: "cand000001" });
    const rows = await scan(d, ISSUES);
    expect(rows.find((r) => r.number === 102)?.class).toBe("fixed-in-candidate");
    expect(rows.find((r) => r.number === 100)?.class).toBe("fixed-in-current");
  });

  test("an id the clone does not know is fetched once, then dropped as no build", async () => {
    const issues: GhIssue[] = [
      {
        number: 1,
        title: "t",
        comments: [maint("see `1234567ab` and `7654321cd`", "2026-11-01T00:00:00Z")],
      },
    ];
    const { d, seen } = deps();
    const rows = await scan(d, issues);
    expect(seen.fetches).toBe(1);
    expect(rows[0]).toMatchObject({ class: "no-fix-reported", builds: [] });
  });

  test("entries: ends with /<number>, never a longer number", async () => {
    const { d } = deps();
    expect(entriesOf(d.manifest, 100)).toEqual(["u100-a"]);
    expect(entriesOf(d.manifest, 103)).toEqual(["u103-a", "u103-b"]);
    expect(entriesOf(d.manifest, 1)).toEqual([]);
    expect(entriesOf(d.manifest, 1000)).toEqual(["u1000-x"]);
  });

  test("repro summary counts differ, match and other per issue's entries", () => {
    const rows = [
      { repro: "u103-a", test: "t1", change: "still-differs" },
      { repro: "u103-a", test: "t2", change: "still-matches" },
      { repro: "u103-b", test: "t3", change: "flipped" },
      { repro: "u103-b", test: "t4", change: "error" },
      { repro: "u100-a", test: "t5", change: "still-differs" },
    ];
    expect(summariseRepros(rows, ["u103-a", "u103-b"])).toEqual({ differ: 1, match: 2, other: 1 });
  });

  test("action list: fixed-in-current with no entry, or with an entry that still differs", async () => {
    const issues: GhIssue[] = [
      ...ISSUES,
      {
        number: 105,
        title: "fixed, no entry",
        comments: [maint("`bd44b20ea`", "2026-11-02T00:00:00Z")],
      },
    ];
    const { d } = deps({
      reproRows: [
        { repro: "u100-a", test: "t", change: "still-matches" },
        { repro: "u103-a", test: "t", change: "still-differs" },
        { repro: "u103-b", test: "t", change: "still-matches" },
      ],
    });
    const rows = await scan(d, issues);
    const actions = actionRows(rows);
    expect(actions.map((a) => a.row.number)).toEqual([103, 105]);
    expect(actions[0]?.why).toContain("still differs");
    expect(actions[1]?.why).toContain("no regression entry");
    const text = formatRows(rows).join("\n");
    expect(text).toContain("#103 batch issue, step one only | fixed-in-current");
    expect(text).toContain("repro: 1 differ, 1 match");
    expect(text).toContain("counts: fixed-in-current 3, no-fix-reported 2, fixed-not-pinned 1");
  });

  test("without a repro report no summary is made", async () => {
    const rows = await scan(deps().d, ISSUES);
    expect(rows.every((r) => r.repro === undefined)).toBe(true);
  });
});

describe("read-only", () => {
  test("listOurIssues calls only `issue list` and parses the rows", async () => {
    const calls: (readonly string[])[] = [];
    const gh = readOnlyGh(async (a) => {
      calls.push(a);
      return JSON.stringify(ISSUES);
    });
    expect((await listOurIssues(gh)).length).toBe(ISSUES.length);
    expect(calls.every((a) => a[0] === "issue" && (a[1] === "list" || a[1] === "view"))).toBe(true);
    expect(calls[0]).toContain("--author");
  });
  test("readOnlyGh refuses every write subcommand", () => {
    const gh = readOnlyGh(async () => "");
    for (const bad of [
      ["issue", "comment", "1"],
      ["issue", "close", "1"],
      ["issue", "edit", "1"],
      ["api", "-X", "POST"],
      ["pr", "comment"],
    ])
      expect(() => gh(bad)).toThrow("read-only");
  });
  test("the module exports no function named like a write", async () => {
    const names = Object.keys(await import("./upstream-fixed-scan"));
    // `latestMaintainerComment` only READS a comment; any other write-like name fails this.
    expect(
      names.filter(
        (n) => /post|comment|close|label|edit|create/i.test(n) && n !== "latestMaintainerComment",
      ),
    ).toEqual([]);
  });
});

test("commitOfDirName: edge and numbered release names", () => {
  expect(commitOfDirName("/work/tools/al-runner-v3/edge-5a58a0f16-5a58a0f16")).toBe("5a58a0f16");
  expect(commitOfDirName("3.0.0-alpha.14-ef00a6a8f")).toBe("ef00a6a8f");
  expect(() => commitOfDirName("current")).toThrow();
});
