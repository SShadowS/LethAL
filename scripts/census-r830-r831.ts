#!/usr/bin/env bun
/**
 * R830 / R831 census: counts by PARSE, never by line grep. Output carries only counts, paths, line
 * numbers and operator names, never AL source (this repo is public).
 *
 *   bun scripts/census-r830-r831.ts <corpus-dir> <out.json>
 *
 * R831: `remove-assignment` sites (the operator's own `targets`) whose target is a subscript
 *   `Arr[..] := ..` inside a while/repeat, where (direct) the loop condition reads `Arr`, or (feed)
 *   the loop body holds `X := <expr reading Arr>` and the condition reads `X` (one hop only).
 * R830 shape 1: `void-method-call` sites (the operator's own `targets`) that are `Recv.M(..)` inside
 *   a loop whose condition reads `Recv` (leftmost identifier of the receiver chain).
 * R830 shape 2: `void-method-call` sites on a bare `P(..)` inside a loop. (a) some argument is a
 *   plain name the condition reads. (b) otherwise. For (b) an UPPER BOUND is also given: loops that
 *   hold a void-method-call site and whose condition names nothing the loop body assigns directly.
 * Loops are while/repeat up to the procedure/trigger boundary, like `hasEnclosingLoop`.
 */
import { writeFile } from "node:fs/promises";
import { hasEnclosingLoop, isIdentifierLike } from "../packages/builtin-tier1/src/loop-hazard";
import { removeAssignment } from "../packages/builtin-tier1/src/remove-assignment";
import { voidMethodCall } from "../packages/builtin-tier1/src/void-method-call";
import { argumentList } from "../packages/engine/src/ast/arguments";
import { ALNodeKind } from "../packages/engine/src/ast/node-kinds";
import { initParser } from "../packages/engine/src/ast/parser";
import type { ALSyntaxNode } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import { normalizeAlName } from "../packages/engine/src/semantic/resolve-var-ref";
import { collectAlFiles } from "./lib/collect-al-files";

const [projectDir, outPath] = process.argv.slice(2);
if (projectDir === undefined || outPath === undefined) {
  console.error("usage: bun scripts/census-r830-r831.ts <corpus-dir> <out.json>");
  process.exit(2);
}

const isLoop = (n: ALSyntaxNode): boolean =>
  n.kind === ALNodeKind.while_statement || n.kind === ALNodeKind.repeat_statement;
const isBoundary = (n: ALSyntaxNode): boolean =>
  n.kind === ALNodeKind.procedure || n.kind === ALNodeKind.trigger;

function enclosingLoops(n: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  for (let c = n.parent; c !== null && !isBoundary(c); c = c.parent) if (isLoop(c)) out.push(c);
  return out;
}

/** Every plain identifier read under `roots` (bare or quoted), member halves of `X.M` excluded. */
function namesUnder(roots: readonly ALSyntaxNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (n: ALSyntaxNode): void => {
    if (isIdentifierLike(n) && n.fieldName !== "member") out.add(normalizeAlName(n.text));
    for (const c of n.namedChildren) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

/** The loop's exit test: `condition` field plus `#if` tails/prefixes beside it (kept simple: every
 *  named child of the loop that is not its body). */
function conditionNames(loop: ALSyntaxNode): Set<string> {
  const parts = loop.namedChildren.filter(
    (c) => c.fieldName !== "body" && !c.rawKind.endsWith("_keyword"),
  );
  return namesUnder(parts);
}

/** Leftmost identifier of `A`, `A.B`, `A[1].B`, `A.B.C`. */
function rootName(n: ALSyntaxNode | null): string | null {
  let cur = n;
  while (cur !== null) {
    if (isIdentifierLike(cur)) return normalizeAlName(cur.text);
    if (cur.kind === ALNodeKind.field_access || cur.rawKind === "subscript_expression") {
      cur = cur.childForFieldName("object");
    } else return null;
  }
  return null;
}

const CURSOR_METHODS = new Set([
  "next",
  "read",
  "eos",
  "movenext",
  "find",
  "findset",
  "findfirst",
  "findlast",
]);

/** Does the loop's condition call a cursor method on `recv` (`while Rec.Next() <> 0`)? */
function cursorStepOn(loop: ALSyntaxNode, recv: string): boolean {
  const parts = loop.namedChildren.filter(
    (c) => c.fieldName !== "body" && !c.rawKind.endsWith("_keyword"),
  );
  const walk = (n: ALSyntaxNode): boolean => {
    if (n.kind === ALNodeKind.field_access) {
      const m = n.childForFieldName("member");
      if (
        m !== null &&
        rootName(n.childForFieldName("object")) === recv &&
        CURSOR_METHODS.has(normalizeAlName(m.text).toLowerCase())
      )
        return true;
    }
    return n.namedChildren.some(walk);
  };
  return parts.some(walk);
}

/** The methods the loop's condition calls on `recv`, lower-case. */
function condMethodsOn(loop: ALSyntaxNode, recv: string): string[] {
  const parts = loop.namedChildren.filter(
    (c) => c.fieldName !== "body" && !c.rawKind.endsWith("_keyword"),
  );
  const out = new Set<string>();
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.field_access) {
      const m = n.childForFieldName("member");
      if (m !== null && rootName(n.childForFieldName("object")) === recv) {
        out.add(normalizeAlName(m.text).toLowerCase());
      }
    }
    for (const ch of n.namedChildren) walk(ch);
  };
  for (const p of parts) walk(p);
  return [...out].sort();
}

const pairs = new Map<string, number>();
const pairSites = new Map<string, string[]>();

function assignmentsIn(loop: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.assignment_statement) out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  walk(loop);
  return out;
}

interface Row {
  readonly file: string;
  readonly line: number;
  readonly shape: string;
}

await initParser();
const files = await collectAlFiles(projectDir);
if (files.length === 0) throw new Error(`census-r830-r831: no .al files under ${projectDir}`);
const ctx = buildSemanticContext(files);

const parseFailures: string[] = [];
const c = {
  files: files.length,
  parseFailures: 0,
  voidSitesTotal: 0,
  voidSitesInLoop: 0,
  loopWalkDisagreements: 0,
  r831: {
    removeAssignmentSites: 0,
    subscriptTargetSites: 0,
    subscriptTargetInLoop: 0,
    direct: 0,
    feed: 0,
    either: 0,
  },
  r830s1: { receiverCallInLoop: 0, conditionReadsReceiver: 0, ofWhichCursorStepInCondition: 0 },
  r830s2: {
    bareCallInLoop: 0,
    a: 0,
    b: 0,
    loopsWithVoidSite: 0,
    loopsBUpperBound: 0,
    sitesInBLoops: 0,
  },
};
const byTop = new Map<string, Record<string, number>>();
const bump = (file: string, key: string): void => {
  const top = file.split("/")[0] ?? "";
  const m = byTop.get(top) ?? {};
  m[key] = (m[key] ?? 0) + 1;
  byTop.set(top, m);
};
const rows: Row[] = [];
const add = (file: string, n: ALSyntaxNode, shape: string): void => {
  rows.push({ file, line: n.startPosition.row + 1, shape });
  bump(file, shape);
};

for (const { path, root } of files) {
  if (root.hasError) {
    c.parseFailures += 1;
    parseFailures.push(path);
  }
  const loopsWithVoid = new Map<ALSyntaxNode, ALSyntaxNode[]>();
  const walk = (n: ALSyntaxNode): void => {
    // ---- R831
    if (n.kind === ALNodeKind.assignment_statement && removeAssignment.targets(n, ctx)) {
      c.r831.removeAssignmentSites += 1;
      const left = n.childForFieldName("left") ?? n.namedChildren[0] ?? null;
      if (left !== null && left.rawKind === "subscript_expression") {
        c.r831.subscriptTargetSites += 1;
        const arr = rootName(left);
        const loops = enclosingLoops(n);
        if (arr !== null && loops.length > 0) {
          c.r831.subscriptTargetInLoop += 1;
          const direct = loops.some((l) => conditionNames(l).has(arr));
          const feed = loops.some((l) => {
            const cond = conditionNames(l);
            return assignmentsIn(l).some((a) => {
              if (a === n) return false;
              const lt = a.childForFieldName("left") ?? a.namedChildren[0] ?? null;
              const rt =
                a.childForFieldName("right") ?? a.namedChildren[a.namedChildren.length - 1] ?? null;
              const x = lt !== null && isIdentifierLike(lt) ? normalizeAlName(lt.text) : null;
              return x !== null && cond.has(x) && rt !== null && namesUnder([rt]).has(arr);
            });
          });
          if (direct) {
            c.r831.direct += 1;
            add(path, n, "r831-direct");
          }
          if (feed) {
            c.r831.feed += 1;
            add(path, n, "r831-feed");
          }
          if (direct || feed) {
            c.r831.either += 1;
            add(path, n, "r831-either");
          }
        }
      }
    }
    // ---- R830
    if (n.kind === ALNodeKind.procedure_call && voidMethodCall.targets(n, ctx)) {
      c.voidSitesTotal += 1;
      const loops = enclosingLoops(n);
      if (loops.length > 0 !== hasEnclosingLoop(n)) c.loopWalkDisagreements += 1;
      if (loops.length > 0) {
        c.voidSitesInLoop += 1;
        for (const l of loops) {
          const a = loopsWithVoid.get(l) ?? [];
          a.push(n);
          loopsWithVoid.set(l, a);
        }
        const fn = n.childForFieldName("function");
        if (fn !== null && fn.kind === ALNodeKind.field_access) {
          c.r830s1.receiverCallInLoop += 1;
          const recv = rootName(fn.childForFieldName("object"));
          if (recv !== null && loops.some((l) => conditionNames(l).has(recv))) {
            c.r830s1.conditionReadsReceiver += 1;
            add(path, n, "r830-receiver");
            {
              const nearest = loops.find((l) => conditionNames(l).has(recv));
              const cond = nearest === undefined ? [] : condMethodsOn(nearest, recv);
              const call = normalizeAlName(
                fn.childForFieldName("member")?.text ?? "?",
              ).toLowerCase();
              const key = `${cond.join("+") || "(no method)"} | ${call}`;
              pairs.set(key, (pairs.get(key) ?? 0) + 1);
              const s = pairSites.get(key) ?? [];
              if (s.length < 3) s.push(`${path}:${n.startPosition.row + 1}`);
              pairSites.set(key, s);
            }
            // Sub-split: the condition steps the receiver itself with a cursor method (a record loop).
            if (loops.some((l) => cursorStepOn(l, recv))) {
              c.r830s1.ofWhichCursorStepInCondition += 1;
              add(path, n, "r830-receiver-cursor");
            } else add(path, n, "r830-receiver-noncursor");
          }
        } else if (fn !== null && isIdentifierLike(fn)) {
          c.r830s2.bareCallInLoop += 1;
          const argNames = argumentList(n)
            .filter(isIdentifierLike)
            .map((a) => normalizeAlName(a.text));
          const hit = loops.some((l) => {
            const cond = conditionNames(l);
            return argNames.some((a) => cond.has(a));
          });
          if (hit) {
            c.r830s2.a += 1;
            add(path, n, "r830-bare-a");
          } else {
            c.r830s2.b += 1;
            add(path, n, "r830-bare-b");
          }
        }
      }
    }
    for (const ch of n.namedChildren) walk(ch);
  };
  walk(root);
  // (b) upper bound: loops holding a void site whose condition names nothing the body assigns.
  const counted = new Set<ALSyntaxNode>();
  for (const [loop, sites] of loopsWithVoid) {
    c.r830s2.loopsWithVoidSite += 1;
    const cond = conditionNames(loop);
    const assigned = new Set<string>();
    for (const a of assignmentsIn(loop)) {
      const r = rootName(a.childForFieldName("left") ?? a.namedChildren[0] ?? null);
      if (r !== null) assigned.add(r);
    }
    if (![...cond].some((x) => assigned.has(x))) {
      c.r830s2.loopsBUpperBound += 1;
      add(path, loop, "r830-b-loop");
      for (const s of sites) counted.add(s);
    }
  }
  c.r830s2.sitesInBLoops += counted.size;
}

const summary = { projectDir, ...c, byTopFolder: Object.fromEntries([...byTop].sort()) };
console.log(JSON.stringify(summary, null, 2));
await writeFile(
  outPath.replace(/\.json$/, ".pairs.json"),
  JSON.stringify(
    [...pairs]
      .sort((a, b) => b[1] - a[1])
      .map(([pair, count]) => ({ pair, count, sites: pairSites.get(pair) ?? [] })),
    null,
    2,
  ),
);
if (c.voidSitesTotal === 0)
  throw new Error("census-r830-r831: zero void-method-call sites, refusing");
await writeFile(outPath, JSON.stringify({ summary, parseFailures, rows }, null, 2), "utf8");
console.log(`wrote ${outPath}`);
