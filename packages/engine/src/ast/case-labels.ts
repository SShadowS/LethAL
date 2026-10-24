import type { ALSyntaxNode } from "./syntax-node";

/**
 * R732: would replacing `before` with `afterText` make a `case` label equal to another label of the
 * SAME case statement? alc rejects that (AL0402, one error per label, so one such mutant fails the
 * whole batch). ONE check for every operator, called where specs are admitted.
 *
 * `false` for a node that is not inside a case label (a branch body, anything else), and a nested
 * case is a different statement with its own labels.
 *
 * What alc counts as "the same label" was measured offline (2026-10-24): the label's own text with
 * comments and outer spacing ignored (`X = 1 /* c *\/` equals `X = 1`), and integer constants folded
 * (`1` equals `0 + 1` equals `01`). It did NOT merge `X=1` with `X = 1`, `x` with `X`, `(X = 1)` with
 * `X = 1`, `1 = X` with `X = 1` or `'A'` with `'a'`. {@link normalise} merges the first three (a
 * superset: refusing a site that would have compiled costs one mutant, missing one costs the batch).
 */
export function caseLabelCollides(before: ALSyntaxNode, afterText: string): boolean {
  let pattern: ALSyntaxNode | null = before;
  while (pattern !== null && pattern.parent !== null) {
    if (pattern.fieldName === "pattern" && pattern.parent.rawKind === "case_branch") break;
    if (pattern.parent.rawKind === "case_branch") return false; // inside a branch body
    pattern = pattern.parent;
  }
  const branch = pattern?.parent;
  if (pattern === null || branch === null || branch === undefined) return false;
  if (branch.rawKind !== "case_branch") return false;
  const mutated = normalise(
    pattern.text.slice(0, before.startIndex - pattern.startIndex) +
      afterText +
      pattern.text.slice(before.endIndex - pattern.startIndex),
  );
  const body = branch.parent;
  if (body === null) return false;
  for (const sibling of body.namedChildren) {
    if (sibling.rawKind !== "case_branch") continue;
    for (const label of sibling.namedChildren) {
      if (label.fieldName !== "pattern" || label.startIndex === pattern.startIndex) continue;
      if (normalise(label.text) === mutated) return true;
    }
  }
  return false;
}

/** Comments out, spacing out around punctuation, identifier case folded (string text kept), outer
 *  parentheses peeled, a pure integer expression replaced by its value. */
function normalise(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text.charAt(i);
    const two = text.slice(i, i + 2);
    if (two === "//") {
      while (i < text.length && text.charAt(i) !== "\n") i++;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      out += " ";
    } else if (c === "'") {
      let j = i + 1;
      while (j < text.length && (text.charAt(j) !== "'" || text.charAt(j + 1) === "'"))
        j += text.charAt(j) === "'" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += /\s/.test(c) ? " " : c.toLowerCase();
      i++;
    }
  }
  let s = out.replace(/ +/g, " ").trim();
  s = s.replace(/ ?([^\w' ]) ?/g, "$1");
  while (s.startsWith("(") && closesAtEnd(s)) s = s.slice(1, -1).trim();
  return foldInteger(s) ?? s;
}

function closesAtEnd(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i === s.length - 1;
  }
  return false;
}

/** `#<value>` for an expression of integer literals, `+`, `-`, `*` and parentheses, else `null`. */
function foldInteger(s: string): string | null {
  if (!/^[\d+\-*()]+$/.test(s)) return null;
  let pos = 0;
  const fail = Symbol("not foldable");
  const atom = (): number | typeof fail => {
    const c = s.charAt(pos);
    if (c === "(") {
      pos++;
      const v = sum();
      if (v === fail || s.charAt(pos) !== ")") return fail;
      pos++;
      return v;
    }
    const m = /^\d+/.exec(s.slice(pos));
    if (m === null) return fail;
    pos += m[0].length;
    return Number(m[0]);
  };
  const product = (): number | typeof fail => {
    let v = atom();
    while (v !== fail && s.charAt(pos) === "*") {
      pos++;
      const r = atom();
      v = r === fail ? fail : v * r;
    }
    return v;
  };
  const sum = (): number | typeof fail => {
    let v = product();
    while (v !== fail && (s.charAt(pos) === "+" || s.charAt(pos) === "-")) {
      const op = s.charAt(pos++);
      const r = product();
      v = r === fail ? fail : op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return v === fail || pos !== s.length ? null : `#${v}`;
}
