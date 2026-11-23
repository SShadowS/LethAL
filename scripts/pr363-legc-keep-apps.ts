/**
 * PR-363 (R1152): the apps behind leg C's per-family `serve-keep-reasons` requests. One app per refusal family, holding
 * ONLY the cells chosen here, each at its own codeunit id. The selection is pinned by (entry, family, cell type, method,
 * state); a cell missing from `FAMILIES` (or matched twice) throws by name.
 *
 * Usage: bun scripts/pr363-legc-keep-apps.ts --out <dir>
 * Writes `<dir>/<family>/{app.json,src/Cells.al}` and `<dir>/manifest.json`, and prints the manifest (JSON) on stdout:
 * `[{ family, dir, cases: [{ entry, name }] }]`, `name` being the serve test name (`Codeunit<id>.Cell`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BASE_ID, FAMILIES, bcCheckApp, emitApp } from "./refusal-family";

/** [keep entry, family, cell type, cell method, cell state]. */
export type KeepSelection = readonly [string, string, string, string, string];

export const KEEP_SELECTIONS: readonly KeepSelection[] = [
  // platform-table-read: the ten platform-table entries the serve daemon produces
  ["platform-no-provider", "platform-table-read", "TObject", "IsEmpty", "fresh"],
  ["company-table-read-named", "platform-table-read", "TCompany", "IsEmpty", "fresh"],
  ["license-permission", "platform-table-read", "TLicensePermission", "IsEmpty", "fresh"],
  ["api-webhook-entity", "platform-table-read", "TAPIWebhookEntity", "IsEmpty", "fresh"],
  ["power-bi-blob", "platform-table-read", "TPowerBIBlob", "IsEmpty", "fresh"],
  ["page-action-promoted-area", "platform-table-read", "TPageAction", "IsEmpty", "fresh"],
  [
    "power-bi-default-selection",
    "platform-table-read",
    "TPowerBIDefaultSelection",
    "IsEmpty",
    "fresh",
  ],
  ["media-read", "platform-table-read", "TMedia", "IsEmpty", "fresh"],
  [
    "application-object-metadata",
    "platform-table-read",
    "TApplicationObjectMetadata",
    "IsEmpty",
    "fresh",
  ],
  [
    "permission-set-whole-object-type",
    "platform-table-read",
    "TMetadataPermission",
    "IsEmpty",
    "fresh",
  ],
  // untouched-handle (fieldref-method-never-assigned: a non-Class method, since Class also matches fieldref-never-assigned)
  ["stream-never-created", "untouched-handle", "OutStream", "Write", "untouched"],
  ["fieldref-method-never-assigned", "untouched-handle", "FieldRef", "Caption", "untouched"],
  // get-url
  ["geturl-unpinned-object-type", "get-url", "GetUrl", "Table", "Default"],
  ["geturl-phone-tablet-desktop", "get-url", "GetUrl", "Codeunit", "Tablet"],
  // table-connection
  [
    "register-table-connection-other-string",
    "table-connection",
    "Connection",
    "Register",
    "UrlMarker",
  ],
  ["crm-insert-through-table-connection", "table-connection", "CRMTriggerRow", "Insert", "marker"],
  // t9
  ["setfilter-value-expected", "t9-refusals", "Filter", "SetFilterDots", "t9"],
  ["evaluate-decimal-comparison", "t9-refusals", "Evaluate", "Gt100", "t9"],
  ["report-parameters-no-xml-declaration", "t9-refusals", "Report", "SaveAs", "t9"],
  ["boolean-false-to-biginteger", "t9-refusals", "Conversion", "FieldValue", "t9"],
  ["recordref-method-not-open", "t9-refusals", "RecordRef", "Duplicate", "closed"],
  // t10
  ["keyref-method-never-assigned", "t10-refusals", "KeyRef", "FieldCount", "never assigned"],
  ["setfilter-unexpected-gt-date-range", "t10-refusals", "Filter", "SetFilterAngle", "t10"],
  ["setfilter-date-text-no-form", "t10-refusals", "Filter", "SetFilterDate", "-1M"],
  ["setfilter-not-a-biginteger", "t10-refusals", "Filter", "SetFilterBigInt", "GL00000000"],
  ["setfilter-empty-term", "t10-refusals", "Filter", "SetFilterEmptyTerm", "t10"],
  ["page-run-recordref", "t10-refusals", "Page", "Run", "RecordRef"],
  ["page-run-unassigned-variant", "t10-refusals", "Page", "Run", "unassigned Variant"],
  ["recordref-gettable-text-not-a-record", "t10-refusals", "RecordRef", "GetTable", "Text"],
  ["report-saveas-id-zero", "t10-refusals", "Report", "SaveAs", "id 0"],
  [
    "xmldocument-readfrom-not-instream",
    "t10-refusals",
    "XmlDocument",
    "ReadFrom",
    "not an InStream",
  ],
  ["outstream-untouched-handle", "t10-refusals", "Media", "ExportStream", "untouched OutStream"],
  ["code-gl-to-biginteger", "t10-refusals", "Conversion", "FieldRefSetRange", "Code"],
  ["calcdate-outside-range", "t10-refusals", "Date", "CalcDate", "t10"],
  // t12
  ["evaluate-decimal-nul-run", "t12-refusals", "Evaluate", "NulDecimal", "6 NULs"],
  ["conversion-text-to-blob", "t12-refusals", "Conversion", "TextToBlob", "xml"],
  ["conversion-text-to-integer", "t12-refusals", "Conversion", "TextToInteger", "=18"],
  ["report-saveas2-untouched-handle", "t12-refusals", "Report", "SaveAs", "untouched handle"],
  ["fieldref-calcfield-not-flowfield", "t12-refusals", "FieldRef", "CalcField", "not a FlowField"],
  ["action-left-another-row", "t12-refusals", "Page", "Action", "another row in Rec"],
  // x2
  ["recordref-gettable-integer-123", "x2-refusals", "RecordRef", "GetTable", "Integer 123"],
  // y2-xml
  ["xml-unassigned-node", "y2-xml", "XmlCell", "UnassignedNodeAfterChildren", "y2"],
  ["xml-unassigned-element", "y2-xml", "XmlCell", "UnassignedElementSetAttr", "y2"],
  ["xml-node-as-content", "y2-xml", "XmlCell", "NodeAsContent", "y2"],
  ["xml-attribute-collection-other", "y2-xml", "XmlCell", "AttrCollectionGet", "y2"],
  ["xml-name-measured-chars", "y2-xml", "XmlCell", "Name1Plus", "y2"],
  // y2-collation
  ["collation-no-weight-measured", "y2-collation", "Collation", "CjkPlain", "y2c"],
];

export interface KeepManifestEntry {
  readonly family: string;
  readonly dir: string;
  readonly cases: readonly { readonly entry: string; readonly name: string }[];
}

/** The pinned selection resolved to cell indices, grouped by family (in first-use order). Throws by name. */
export function resolveSelections(
  sel: readonly KeepSelection[] = KEEP_SELECTIONS,
): Map<string, { index: number; entry: string }[]> {
  const byFamily = new Map<string, { index: number; entry: string }[]>();
  const seen = new Map<string, string>();
  for (const [entry, family, type, method, state] of sel) {
    const fam = FAMILIES[family];
    if (fam === undefined) throw new Error(`pr363-legc-keep-apps: ${entry}: no family ${family}`);
    const hits = fam.cells.flatMap((c, i) =>
      c.type === type && c.method === method && c.state === state ? [i] : [],
    );
    const [index] = hits;
    if (index === undefined || hits.length !== 1)
      throw new Error(
        `pr363-legc-keep-apps: ${entry}: ${hits.length} cells ${family} ${type}/${method}/${state} (need exactly one)`,
      );
    const cell = fam.cells[index];
    if (cell?.reader !== undefined)
      throw new Error(`pr363-legc-keep-apps: ${entry}: a two-test cell has no single test name`);
    const key = `${family}#${index}`;
    const clash = seen.get(key);
    if (clash !== undefined)
      throw new Error(`pr363-legc-keep-apps: ${entry} and ${clash} select the same cell ${key}`);
    seen.set(key, entry);
    const list = byFamily.get(family) ?? [];
    list.push({ index, entry });
    byFamily.set(family, list);
  }
  return byFamily;
}

/** Writes one app folder per family under `out` and returns the manifest. */
export function writeKeepApps(out: string): KeepManifestEntry[] {
  const manifest: KeepManifestEntry[] = [];
  for (const [family, picks] of resolveSelections()) {
    const fam = FAMILIES[family];
    if (fam === undefined) throw new Error(`pr363-legc-keep-apps: no family ${family}`);
    const dir = resolve(out, family);
    const base = bcCheckApp(fam);
    const files = emitApp(
      fam,
      { id: base.id, name: `LethAL Keep Cases ${family}` },
      picks.map((p) => p.index),
    );
    for (const [rel, text] of Object.entries(files)) {
      const path = join(dir, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    manifest.push({
      family,
      dir,
      cases: picks.map((p) => ({ entry: p.entry, name: `Codeunit${BASE_ID + 1 + p.index}.Cell` })),
    });
  }
  return manifest;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  if (values.out === undefined)
    throw new Error("usage: bun scripts/pr363-legc-keep-apps.ts --out <dir>");
  const manifest = writeKeepApps(values.out);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(resolve(values.out), "manifest.json"), text);
  process.stdout.write(text);
}
