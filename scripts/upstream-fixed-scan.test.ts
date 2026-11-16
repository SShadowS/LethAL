import { describe, expect, test } from "bun:test";
import {
  type GhComment,
  type GhIssue,
  type ScanDeps,
  actionRows,
  ancestorFromExit,
  commitOfDirName,
  entriesOf,
  extractBuilds,
  formatRows,
  listOurIssues,
  maintainerComments,
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

const KNOWN = new Set(["bd44b20ea", "14e5d6937", "5a58a0f16", "deadbeef1", "cand000001"]);
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
      { id: "u106-a", issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/106" },
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
  test("quoted lines are dropped", () => {
    expect(
      extractBuilds("> I tested on `5a58a0f16`\n  > and `14e5d6937`\nNow `bd44b20ea`"),
    ).toEqual(["bd44b20ea"]);
  });
});

describe("maintainerComments", () => {
  test("newest first, our own comments never", () => {
    const c = maintainerComments([
      maint("old", "2026-11-01T00:00:00Z"),
      maint("new", "2026-11-05T00:00:00Z"),
      ours("later, ours", "2026-11-09T00:00:00Z"),
    ]);
    expect(c.map((x) => x.body)).toEqual(["new", "old"]);
  });
  test("only OWNER/MEMBER/COLLABORATOR count; there is no fallback to anyone else", () => {
    const drive: GhComment = {
      author: { login: "someone" },
      authorAssociation: "NONE",
      body: "me too",
      createdAt: "2026-11-20T00:00:00Z",
    };
    expect(
      maintainerComments([maint("m", "2026-11-01T00:00:00Z"), drive]).map((x) => x.body),
    ).toEqual(["m"]);
    expect(maintainerComments([drive])).toEqual([]);
    expect(maintainerComments([ours("x", "2026-11-01T00:00:00Z")])).toEqual([]);
  });
});

describe("ancestorFromExit", () => {
  test("0 is yes, 1 is no, anything else throws", () => {
    expect(ancestorFromExit(0, "")).toBe(true);
    expect(ancestorFromExit(1, "")).toBe(false);
    expect(() => ancestorFromExit(128, "fatal: Not a valid commit name")).toThrow("exited 128");
    expect(() => ancestorFromExit(137, "")).toThrow();
  });
});

describe("scan", () => {
  test("each class, with the comment's url, date and excerpt", async () => {
    const { d } = deps();
    const rows = await scan(d, ISSUES);
    const by = (n: number) => rows.find((r) => r.number === n);
    expect(by(100)).toMatchObject({
      class: "build-named-in-current",
      builds: ["bd44b20ea"],
      commentUrl: "https://x/2026-11-10T00:00:00Z",
      commentDate: "2026-11-10T00:00:00Z",
      excerpt: "Thanks. The new edge build (`bd44b20ea`) changes one item.",
    });
    expect(by(101)?.class).toBe("no-build-named");
    expect(by(101)?.commentUrl).toBeUndefined();
    expect(by(102)?.class).toBe("build-named-not-pinned");
    // EVERY named build must be in current: deadbeef1 is not, so one of two is not enough.
    expect(by(103)?.class).toBe("build-named-not-pinned");
    expect(by(104)?.class).toBe("no-build-named");
  });

  test("the excerpt is about 120 characters of one line, shown after the builds", async () => {
    const long = `Fixed in \`bd44b20ea\`.\n${"word ".repeat(60)}`;
    const issues: GhIssue[] = [
      { number: 1, title: "t", comments: [maint(long, "2026-11-01T00:00:00Z")] },
    ];
    const [row] = await scan(deps().d, issues);
    expect(row?.excerpt?.length).toBe(120);
    expect(row?.excerpt?.includes("\n")).toBe(false);
    const line = formatRows(row ? [row] : [])[0] ?? "";
    expect(line.indexOf("builds: bd44b20ea")).toBeLessThan(line.indexOf('comment: "Fixed in'));
  });

  test("a quoted line naming our pinned build is not a build the maintainer named", async () => {
    const issues: GhIssue[] = [
      {
        number: 1,
        title: "t",
        comments: [maint("> still wrong on `bd44b20ea`\nLooking at it.", "2026-11-01T00:00:00Z")],
      },
    ];
    const [row] = await scan(deps().d, issues);
    expect(row).toMatchObject({ class: "no-build-named", builds: [] });
  });

  test("R1083: a later comment that names nothing is reported, and the older build is kept, not hidden", async () => {
    const issues: GhIssue[] = [
      {
        number: 1,
        title: "t",
        comments: [
          maint("Fixed in `bd44b20ea`.", "2026-11-01T00:00:00Z"),
          maint("Thanks for the report!", "2026-11-03T00:00:00Z"),
        ],
      },
    ];
    const [row] = await scan(deps().d, issues);
    expect(row).toMatchObject({
      class: "latest-comment-names-no-build",
      builds: ["bd44b20ea"],
      excerpt: "Thanks for the report!",
    });
  });

  test("R1083: a plan after a build-naming comment is no action, whatever its entry says", async () => {
    // the #8038 shape: an older comment fixed another item in a build; the newest is a plan (a corpus probe)
    const issues: GhIssue[] = [
      {
        number: 8038,
        title: "batch",
        comments: [
          maint("The new edge build (`bd44b20ea`) runs one item.", "2026-11-10T00:00:00Z"),
          maint("I'll put your cells into a corpus probe.", "2026-11-15T00:00:00Z"),
        ],
      },
    ];
    const rows = await scan(
      deps({
        manifest: [
          {
            id: "u8038-x",
            issue: "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues/8038",
          },
        ],
        reproRows: [{ repro: "u8038-x", test: "t", change: "still-differs" }],
      }).d,
      issues,
    );
    expect(rows[0]?.class).toBe("latest-comment-names-no-build");
    expect(rows[0]?.excerpt).toBe("I'll put your cells into a corpus probe.");
    expect(actionRows(rows)).toEqual([]);
  });

  test("R1083: when the newest maintainer comment names the build, the class is as before", async () => {
    const issues: GhIssue[] = [
      {
        number: 2,
        title: "t",
        comments: [
          maint("Planning it.", "2026-11-01T00:00:00Z"),
          maint("Fixed in `bd44b20ea`.", "2026-11-03T00:00:00Z"),
        ],
      },
    ];
    const [row] = await scan(deps().d, issues);
    expect(row?.class).toBe("build-named-in-current");
  });

  test("a comment by someone who is no OWNER/MEMBER/COLLABORATOR names no build", async () => {
    const drive: GhComment = {
      author: { login: "someone" },
      authorAssociation: "NONE",
      body: "try `bd44b20ea`",
      createdAt: "2026-11-01T00:00:00Z",
    };
    const [row] = await scan(deps().d, [{ number: 1, title: "t", comments: [drive] }]);
    expect(row?.class).toBe("no-build-named");
  });

  test("candidate: in-candidate only when every build is in it and not all in current", async () => {
    const { d } = deps({ candidate: "cand000001" });
    const rows = await scan(d, ISSUES);
    expect(rows.find((r) => r.number === 102)?.class).toBe("build-named-in-candidate");
    expect(rows.find((r) => r.number === 100)?.class).toBe("build-named-in-current");
    expect(rows.find((r) => r.number === 103)?.class).toBe("build-named-not-pinned");
  });

  test("a current or candidate the clone does not know throws, after one fetch", async () => {
    const a = deps({ currentCommit: async () => "0000000ff" });
    await expect(scan(a.d, ISSUES)).rejects.toThrow("current commit 0000000ff");
    expect(a.seen.fetches).toBe(1);
    const b = deps({ candidate: "1111111ee" });
    await expect(scan(b.d, ISSUES)).rejects.toThrow("candidate commit 1111111ee");
  });

  test("a current that is unknown until the fetch is accepted", async () => {
    let fetched = false;
    const { d } = deps({
      known: async (c) => (c === CURRENT ? fetched : KNOWN.has(c)),
      fetch: async () => {
        fetched = true;
      },
    });
    const rows = await scan(d, ISSUES);
    expect(rows.length).toBe(ISSUES.length);
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
    expect(rows[0]).toMatchObject({ class: "no-build-named", builds: [] });
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

  test("action list: a build named in current with no entry, or with an entry that still differs", async () => {
    const issues: GhIssue[] = [
      ...ISSUES,
      {
        number: 105,
        title: "named, no entry",
        comments: [maint("`bd44b20ea`", "2026-11-02T00:00:00Z")],
      },
      {
        number: 106,
        title: "named, entry still differs",
        comments: [maint("first step in `bd44b20ea`", "2026-11-02T00:00:00Z")],
      },
    ];
    const { d } = deps({
      reproRows: [
        { repro: "u100-a", test: "t", change: "still-matches" },
        { repro: "u103-a", test: "t", change: "still-differs" },
        { repro: "u103-b", test: "t", change: "still-matches" },
        { repro: "u106-a", test: "t", change: "still-differs" },
      ],
    });
    const rows = await scan(d, issues);
    const actions = actionRows(rows);
    // #103 differs too, but its build is not in current: no action yet.
    expect(actions.map((a) => a.row.number)).toEqual([105, 106]);
    expect(actions[0]?.why).toContain("no regression entry");
    expect(actions[1]?.why).toContain("still differs");
    const text = formatRows(rows).join("\n");
    expect(text).toContain("#103 batch issue, step one only | build-named-not-pinned");
    expect(text).toContain("repro: 1 differ, 1 match");
    expect(text).toContain(
      "counts: build-named-in-current 3, no-build-named 2, build-named-not-pinned 2",
    );
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
    // `maintainerComments` only READS a comment; any other write-like name fails this.
    expect(
      names.filter(
        (n) => /post|comment|close|label|edit|create/i.test(n) && n !== "maintainerComments",
      ),
    ).toEqual([]);
  });
});

test("commitOfDirName: edge and numbered release names", () => {
  expect(commitOfDirName("/work/tools/al-runner-v3/edge-5a58a0f16-5a58a0f16")).toBe("5a58a0f16");
  expect(commitOfDirName("3.0.0-alpha.14-ef00a6a8f")).toBe("ef00a6a8f");
  expect(() => commitOfDirName("current")).toThrow();
});
