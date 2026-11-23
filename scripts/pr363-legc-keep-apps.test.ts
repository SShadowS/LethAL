// PR-363 (R1152): the generator of leg C's per-family keep apps, and the coverage pin that says why each keep entry is,
// or is not, judged by a serve case.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V3_SERVE_SAFE_REFUSALS } from "../packages/runner/src/al-runner-server";
import {
  SERVE_CASES,
  V3_KEEP_APP_FAMILIES,
  V3_KEEP_CASES,
} from "../packages/runner/src/al-runner-v3-contract";
import {
  KEEP_SELECTIONS,
  type KeepSelection,
  resolveSelections,
  writeKeepApps,
} from "./pr363-legc-keep-apps";
import { BASE_ID, FAMILIES, emitApp } from "./refusal-family";

/** sha256 of `JSON.stringify(emitApp(family))` taken from the tree BEFORE PR-363 (lane-code at 822e6214d). */
const FULL_APP_SHA256: Readonly<Record<string, string>> = {
  "untouched-handle": "d6ded01a2232a002aa2bb05b49916645a7973e9cba01b1b190131fbc7c277248",
  "dotnet-no-object": "98090b4e777758ff362905d042284696e517441ba088a49212a363c0e6c9b3fb",
  "platform-table-read": "f22c62c5820beb078b9516f8a93762fbb505e674a5d27b04e20896b41f5a0b1f",
  "permission-denial": "d0f64c4c0a5d4f2ae2e86c2bb252fef918f4cdd03f2877dcb57786f82110c4ea",
  "no-client": "8de572e3432a64c8db9a52b09c8c9a3accfe194c9ec8fe2b5e9e4cd5e1908d3d",
  "get-url": "2d03644781f3bc379ea51363e2ae0a6c6ebb8871757cad495773b78e5d3aa852",
  "table-connection": "60ec8b8db50ec9e34d3f20bd1940453aaae12400b394b9ced09ac950b947274f",
  "dotnet-exception": "f031b90150205b0fd104d65124a677a84762bd129f0c1f29c8022104d3f74aa4",
  "dotnet-exception-rsa": "7aca7db0baa64f2f31ffc78c7bf9f9c7ba9b52541aaa6581c9db7e294ee05179",
  "pubapp-flowfield": "7d17cb966c7723854d55a3b66b86d07c51522dbd9ff86818549957c8a4a922d1",
  "format-evaluate": "a3c3b5f4b60150285af0178771504ec2ef11065e96248a4bd159f7cdfc49c956",
  "t9-refusals": "934051bb7b9f781d0d05da6a17b87f3cb4f895ccfc49905a9b5d0d1e995efbf1",
  "record-filters": "69fad4adff9a0a49cf54366a2d5a64c48918ca090fddd36801616a79070511dd",
  "dates-formulas": "6a65cf96715c3d02047a59d8925690fb35b10d706f19b3ff80289a8d15b9c107",
  "json-text": "0649a0922166627e88adc80ce2e70c32559e55ef02443ae9440b4af0890153eb",
  "t10-refusals": "4abcc4bd8b51546a67c4dc1b4d65a3840170b6db0ac55af69ab9d14dc03da30a",
  "t12-refusals": "f8e1ace355f5b4e5df749d8a121616203843d4a795ec19e134656b0d4bc7230a",
  "x2-refusals": "91c55ee57dbe697a80591963d8022726e9fe23ce8aafd96f189bb85100c483b9",
  "x3-refusals": "0ef4566f0993242f904d4bf385ef39dc917ae0fa6c41ea369d4a00afa903888c",
  "y1-refusals": "83e391514bb35362a57b3426276e722ef48b25af3b0c5de8669601d5c7eeb5a2",
  "y2-xml": "2c9a64f47571c86d0391d13ba93e2dcdd3f4af1190188f94347ef9ebb6bfad3d",
  "y2-collation": "94862c82c367622279c2810b9b3c8b2f6ca33d72627420af4a36065344932c8b",
  // PR-373: the app bc4 and main-bf3a3e863 ran (the emitted AL equals /coord/handoff/PR-373/bc-check/src)
  "format-region": "484b0b635a4186fcb6ad1401f26db20243919458ff886d9aced6537e50464d9d",
  // PR-374: the apps bc4 and main-bf3a3e863 ran (each emitted AL equals /coord/handoff/PR-374/<family>/bc-check/src)
  "fieldref-convert": "19d1cd234c7cd4b5a1f1460f817e3e1375ae66c896aab3eb6641e6c07b0a43fc",
  "language-region": "333844813808aa878779a1116f79dea0a0a4c000fa9c85f84191c907cb1f3e51",
  // PR-375: the app bc4 and main-bf3a3e863 ran (the emitted AL equals /coord/handoff/PR-375/bc-check/src)
  "zip-blob": "6a2d30155dd6fee92991184e7c262e1e1a72139fe8e4ef785a6bfe424ab89b0e",
};

describe("PR-363: emitApp's subset option", () => {
  // Red: make `keep` filter always (or `only === undefined` keep nothing): the full output moves off the pinned hashes.
  test("the full output (no option) is byte-identical to before, for every family", () => {
    expect(Object.keys(FAMILIES).sort()).toEqual(Object.keys(FULL_APP_SHA256).sort());
    for (const [name, f] of Object.entries(FAMILIES)) {
      const sha = new Bun.CryptoHasher("sha256").update(JSON.stringify(emitApp(f))).digest("hex");
      expect({ name, sha }).toEqual({ name, sha: FULL_APP_SHA256[name] ?? "(no pinned hash)" });
    }
  });

  // Red: renumber the subset's codeunits (use the position in the subset instead of the cell's own index).
  test("a subset keeps each chosen cell's own codeunit id, drops the others, keeps the support objects", () => {
    const f = FAMILIES["t10-refusals"];
    if (f === undefined) throw new Error("no t10-refusals");
    const files = emitApp(f, undefined, [9, 23]);
    const al = files["src/Cells.al"] ?? "";
    expect(al.match(/^codeunit \d+ /gm)).toEqual([
      `codeunit ${BASE_ID + 1 + 9} `,
      `codeunit ${BASE_ID + 1 + 23} `,
    ]);
    expect(al).toContain(f.support);
    // idRanges still covers the whole family range (so every emitted id)
    const ranges = (
      JSON.parse(files["app.json"] ?? "{}") as { idRanges: { from: number; to: number }[] }
    ).idRanges;
    expect(ranges).toEqual([
      { from: BASE_ID, to: BASE_ID + 1 + f.cells.length + (f.extraIds ?? 0) },
    ]);
  });
});

describe("PR-363: the generator", () => {
  // Red: delete a cell from a family, or edit a selection's state: the selector throws by name.
  test("every one of the 47 selections names exactly one existing cell; 10 families", () => {
    expect(KEEP_SELECTIONS).toHaveLength(V3_KEEP_CASES); // 47: the contract checks the manifest against this count
    const byFamily = resolveSelections();
    expect(byFamily.size).toBe(V3_KEEP_APP_FAMILIES);
    expect([...byFamily.values()].reduce((n, v) => n + v.length, 0)).toBe(47);
  });

  test("a missing cell, a missing family and a doubly chosen cell each throw by name", () => {
    const base = KEEP_SELECTIONS[0];
    if (base === undefined) throw new Error("no selections");
    const [entry, family, type, method, state] = base;
    expect(() => resolveSelections([[entry, family, type, method, "no such state"]])).toThrow(
      `${entry}: 0 cells`,
    );
    expect(() => resolveSelections([[entry, "no-such-family", type, method, "fresh"]])).toThrow(
      `${entry}: no family no-such-family`,
    );
    expect(() => resolveSelections([base, ["another-entry", family, type, method, state]])).toThrow(
      `another-entry and ${entry} select the same cell`,
    );
  });

  // Red: renumber cells in the subset; give two families one app id; drop `--out`'s manifest case names.
  test("the written apps hold only the chosen cells at their own ids, with a distinct app id per family", () => {
    const out = mkdtempSync(join(tmpdir(), "pr363-keep-"));
    try {
      const manifest = writeKeepApps(out);
      expect(manifest).toHaveLength(V3_KEEP_APP_FAMILIES);
      expect(manifest.reduce((n, m) => n + m.cases.length, 0)).toBe(47);
      const ids = new Set<string>();
      for (const m of manifest) {
        const al = readFileSync(join(m.dir, "src", "Cells.al"), "utf8");
        const appJson = JSON.parse(readFileSync(join(m.dir, "app.json"), "utf8")) as {
          id: string;
          idRanges: { from: number; to: number }[];
        };
        ids.add(appJson.id);
        const emitted = [...al.matchAll(/^codeunit (\d+) /gm)].map((x) => Number(x[1]));
        const wanted = m.cases.map((c) => Number(/^Codeunit(\d+)\.Cell$/.exec(c.name)?.[1]));
        // the family's support codeunits (51000, and any after the cells) are emitted too; only the cell ids are chosen
        const cells = emitted.filter(
          (id) => id > BASE_ID && id <= BASE_ID + (FAMILIES[m.family]?.cells.length ?? 0),
        );
        expect(cells.sort()).toEqual(wanted.sort());
        const range = appJson.idRanges[0];
        for (const id of emitted)
          expect(id >= (range?.from ?? 1) && id <= (range?.to ?? 0)).toBe(true);
      }
      expect(ids.size).toBe(V3_KEEP_APP_FAMILIES);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

/**
 * Every keep entry that has NO serve case, with the reason. A new entry in V3_SERVE_SAFE_REFUSALS that is in neither
 * SERVE_CASES, KEEP_SELECTIONS nor this map fails the test below: add a case, or name the reason here.
 */
const word = (reason: string, names: string): [string, string][] =>
  names
    .split(/\s+/)
    .filter((n) => n !== "")
    .map((n) => [n, reason]);
const UNJUDGED: ReadonlyMap<string, string> = new Map([
  // needs the .NET sidecar, which leg C runs without
  ...word(
    "needs-dotnet-sidecar",
    `dotnet-exception dotnet-no-object dotnet-assembly dotnet-member dotnet-overload dotnet-policy-timezone
     dotnet-timezone-display-name dotnet-timezone-get-utc-offset dotnet-mock-graph-query
     dotnet-page-summary-get-summary-fields dotnet-page-summary-get-available-table-fields
     dotnet-learn-has-in-geo-support dotnet-copilot-gpt-token-count dotnet-zip-central-directory-corrupt
     dotnet-json-writer-no-token-to-close dotnet-json-writer-start-object-in-object
     dotnet-json-writer-end-array-no-token dotnet-json-writer-property-in-array
     copystream-untouched-to-dotnet zip-archive-invalid-data zip-dispose-over-held-bytes`,
  ),
  // needs a daemon started with --no-client
  ...word(
    "needs-no-client",
    `no-client-current-client-type no-client-page-run no-client-page-runmodal
     no-client-report-request-page-handler no-client-run-request-page`,
  ),
  // needs a dependency app (Permissions Mock) or BaseApp
  ...word(
    "needs-dependency-or-baseapp",
    `denial-read-system-table denial-read-system-table-writes denial-read-flowfield-system-table
     denial-modify-missing-row saveas-layout-statement saveas-layout-sales-invoice company-open-subscriber-writes
     relation-field-no-dimension-set-entry-dimension-code relation-field-no-sales-invoice-header-ship-to-post-code
     relation-field-no-sales-invoice-header-dimension-set-id`,
  ),
  // produced one-shot only: in serve the cell refuses with a text no entry keeps (also two of R1153's 12)
  ...word("serve-text-unkept", "geturl-company-characters geturl-object-type-or-arguments"),
  // R1153 (a): never matched (al-runner ends the text with " (not pinned)"); the other ten of its 12
  ...word(
    "r1153-not-kept-today",
    `yaml-list-indent yaml-null-or-number yaml-blank-line-nested yaml-flow-quoted-key
     dotnet-copilot-platform-authorization gotokey-statement-no-row asdecimal-text-control
     page-no-record-onopenpage xmlport-import-header part-visible-other-shape`,
  ),
  // the old wording, which no family cell produces on current
  ...word("old-wording-no-cell", "company-table-read company-findset"),
  // no family cell yet (a later item may add cells)
  ...word(
    "no-family-cell-yet",
    `find-empty-set-u8013 find-empty-set-time-zone file-name-got-guid sql-counter-stored
     xmlport-unbound-text-element feature-key-rollback setfilter-not-a-number blob-to-integer
     user-windows-sid deleteall-filter-group-1 consistent-filter-group-1 autoformat-expression-procedure
     database-sid-no-user clear-xmlwriteoptions removecookie-last error-errorinfo-not-created
     query-metadata-al-namespace xml-name-empty evaluate-now-date evaluate-now-time evaluate-format-2
     httpclient-relative-path`,
  ),
]);

describe("PR-363: every keep entry is judged by a case or pinned with its reason", () => {
  const all = Object.keys(V3_SERVE_SAFE_REFUSALS);
  const old = new Set(SERVE_CASES.map(([e]) => e));
  const fresh = new Set(KEEP_SELECTIONS.map(([e]) => e));

  // Red: add a key to V3_SERVE_SAFE_REFUSALS (or drop a name from UNJUDGED): the three sets no longer cover it.
  test("SERVE_CASES, the 47 new cases and the pinned map are exactly the keep list, with no overlap", () => {
    const pinned = new Set(UNJUDGED.keys());
    // a name listed twice would collapse in the Map and fall short; PR-365 added 3 RelationFieldNo rows (BaseApp tables)
    expect(UNJUDGED.size).toBe(72);
    for (const e of fresh) expect(old.has(e)).toBe(false);
    for (const e of pinned) expect(old.has(e) || fresh.has(e)).toBe(false);
    expect([...old, ...fresh, ...pinned].sort()).toEqual([...all].sort());
    expect(new Set(KEEP_SELECTIONS.map((s) => s[0])).size).toBe(47);
  });

  test("the reasons are exactly the spec's categories", () => {
    expect([...new Set(UNJUDGED.values())].sort()).toEqual(
      [
        "needs-dotnet-sidecar",
        "needs-dependency-or-baseapp",
        "needs-no-client",
        "no-family-cell-yet",
        "old-wording-no-cell",
        "r1153-not-kept-today",
        "serve-text-unkept",
      ].sort(),
    );
    // every dotnet-*, no-client-* and denial-* entry is in its category
    for (const e of all) {
      if (e.startsWith("no-client-")) expect(UNJUDGED.get(e)).toBe("needs-no-client");
      if (e.startsWith("denial-")) expect(UNJUDGED.get(e)).toBe("needs-dependency-or-baseapp");
      if (e.startsWith("zip-")) expect(UNJUDGED.get(e)).toBe("needs-dotnet-sidecar");
      if (e.startsWith("dotnet-") && e !== "dotnet-copilot-platform-authorization")
        expect(UNJUDGED.get(e)).toBe("needs-dotnet-sidecar");
    }
  });

  test("R1153's 12 are exactly the two serve-text-unkept entries and the ten r1153 ones; the Company wordings are named", () => {
    const r1153 = [...UNJUDGED].filter(
      ([, r]) => r === "r1153-not-kept-today" || r === "serve-text-unkept",
    );
    expect(r1153.map(([e]) => e).sort()).toEqual(
      [
        "yaml-list-indent",
        "yaml-null-or-number",
        "yaml-blank-line-nested",
        "yaml-flow-quoted-key",
        "dotnet-copilot-platform-authorization",
        "gotokey-statement-no-row",
        "asdecimal-text-control",
        "page-no-record-onopenpage",
        "xmlport-import-header",
        "part-visible-other-shape",
        "geturl-company-characters",
        "geturl-object-type-or-arguments",
      ].sort(),
    );
    expect(UNJUDGED.get("company-table-read")).toBe("old-wording-no-cell");
    expect(UNJUDGED.get("company-findset")).toBe("old-wording-no-cell");
    expect(fresh.has("company-table-read-named")).toBe(true);
  });
});
