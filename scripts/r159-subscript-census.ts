#!/usr/bin/env bun
/**
 * R159's `subscript_expression` candidate: what the non-literal-index sites look like, and how many
 * there are on the file list R013's rule actually prices against.
 *
 * The answer refused the candidate. R159's remainder census had counted 53 over all 554 files of the
 * corpus; on the 417 the rule's instrument parses (`.al`, excluding `.dependencies`) it is **29**,
 * against a floor of 36. The 24 lost were subscripts in vendored dependency AL that LethAL never
 * mutates. The old 53 reproduces to the digit with the filter removed, so the gap is the filter and
 * nothing else.
 *
 * It is corpus-relative in exactly the way R181 measured: 80 on `DC/Cloud`, 0 on
 * `BusinessCentral.Sentinel`. The rule prices on the reference corpus by hash, and there it refuses.
 *
 * Kept because a refusal on one number should be re-runnable: the shape breakdown (what the object
 * is, what the index is, what context the subscript sits in) is what a future proposal would need,
 * and none of it was recorded anywhere else.
 *
 *   bun scripts/r159-subscript-census.ts <corpus-dir>
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { initParser, parseAL } from "../packages/engine/src/ast/parser";
import { type ALSyntaxNode, wrapRoot } from "../packages/engine/src/ast/syntax-node";
import { corpusEntries, describeFingerprint, fingerprintCorpus } from "./corpus-fingerprint";

const dir = process.argv[2] ?? "";
await initParser();
console.log(describeFingerprint(dir, await fingerprintCorpus(dir)));
const entries = await corpusEntries(dir);

const hist = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const parentKinds = new Map<string, number>(),
  indexKinds = new Map<string, number>(),
  objKinds = new Map<string, number>(),
  arity = new Map<string, number>();
const samples: string[] = [];
let inBody = 0,
  literalIdx = 0,
  claimable = 0;

function walk(n: ALSyntaxNode, parent: ALSyntaxNode | null, anc: string[]) {
  if (
    n.rawKind === "subscript_expression" &&
    anc.some((k) => k === "procedure" || k === "trigger_declaration")
  ) {
    inBody++;
    let hasLit = false;
    const idx: ALSyntaxNode[] = [];
    const kids = n.namedChildren;
    const obj = kids[0];
    const idxs = kids.slice(1);
    for (const d of idxs) {
      const f = (x: ALSyntaxNode): boolean => x.rawKind === "integer" || x.namedChildren.some(f);
      if (f(d)) hasLit = true;
    }
    if (hasLit) {
      literalIdx++;
    } else {
      claimable++;
      hist(parentKinds, parent?.rawKind ?? "(none)");
      hist(objKinds, obj?.rawKind ?? "?");
      hist(arity, String(idxs.length));
      for (const d of idxs) hist(indexKinds, d.rawKind);
      if (samples.length < 14)
        samples.push(
          n.text.replace(/\s+/g, " ").slice(0, 60) + "   <parent " + (parent?.rawKind ?? "?") + ">",
        );
    }
  }
  for (const c of n.namedChildren) walk(c, n, [...anc, n.rawKind]);
}
for (const rel of entries)
  walk(wrapRoot(parseAL(await readFile(join(dir, rel), "utf8"))), null, []);
const show = (t: string, m: Map<string, number>) => {
  console.log(`\n${t}`);
  for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(v).padStart(4)}  ${k}`);
};
console.log(
  `\nsubscript_expression in bodies: ${inBody}   literal index (shift-integer's): ${literalIdx}   NON-literal (claimable): ${claimable}`,
);
show("index expression kind (of claimable):", indexKinds);
show("number of indices:", arity);
show("object kind:", objKinds);
show("parent kind (context):", parentKinds);
console.log("\nsamples:");
for (const s of samples) console.log("  " + s);
