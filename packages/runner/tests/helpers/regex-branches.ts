// PR-362 (R1186): the branches of a keep entry's regex. A branch is one alternative of one non-capturing group: a
// `(?:a|b|c)` group gives a, b and c; an optional `(?:x)?` group gives x and the empty text. Lookaheads (`(?!`, `(?=`)
// are conditions, not branches, and are never split. Each branch's regex is the entry's source with ONLY that group
// fixed to that alternative; every other group stays as it is.

export type Branch = {
  /** Stable name: the entry, then the group's 1-based number, then the alternative's own regex source (`∅` if empty). */
  readonly key: string;
  readonly re: RegExp;
};

type Group = {
  readonly open: number;
  readonly close: number;
  readonly bars: readonly number[];
  readonly optional: boolean;
};

/** Every `(?:` group of `src` outside any lookahead (nor inside one), with the positions of its top-level `|`. */
export function nonCapturingGroups(src: string): Group[] {
  const out: Group[] = [];
  const stack: { open: number; kind: "nc" | "look" | "other"; bars: number[] }[] = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
    } else if (c === "(") {
      const kind = src.startsWith("(?:", i)
        ? "nc"
        : /^\(\?<?[=!]/.test(src.slice(i, i + 4))
          ? "look"
          : "other";
      stack.push({ open: i, kind, bars: [] });
    } else if (c === "|") {
      stack[stack.length - 1]?.bars.push(i);
    } else if (c === ")") {
      const g = stack.pop();
      if (g === undefined) throw new Error(`unbalanced ) at ${i} in ${src}`);
      // A group inside a lookahead is part of a condition, never a branch.
      const inLook = stack.some((s) => s.kind === "look");
      if (g.kind === "nc" && !inLook)
        out.push({ open: g.open, close: i, bars: g.bars, optional: src[i + 1] === "?" });
    }
  }
  if (stack.length > 0 || inClass) throw new Error(`unbalanced regex source ${src}`);
  return out.sort((a, b) => a.open - b.open);
}

/** The branches of `re` (an entry named `entry`): none when it has no splittable group. */
export function branchesOf(entry: string, re: RegExp): Branch[] {
  const src = re.source;
  const out: Branch[] = [];
  nonCapturingGroups(src).forEach((g, gi) => {
    if (g.bars.length === 0 && !g.optional) return;
    const cuts = [g.open + 3, ...g.bars.map((b) => b + 1)];
    const ends = [...g.bars, g.close];
    const alts = cuts.map((s, k) => src.slice(s, ends[k]));
    if (g.optional) alts.push("");
    const after = g.optional ? g.close + 2 : g.close + 1;
    for (const alt of alts) {
      const fixed = `${src.slice(0, g.open)}(?:${alt})${src.slice(after)}`;
      out.push({
        key: `${entry} #${gi + 1} ${alt === "" ? "∅" : alt}`,
        re: new RegExp(fixed, re.flags),
      });
    }
  });
  return out;
}
