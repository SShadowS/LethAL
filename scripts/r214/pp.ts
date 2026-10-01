// R-214 plan r2 scratch: the TEXTUAL preprocessor half of the predictor. It shares no code with the
// product's arm evaluator: it reads directive LINES, not the tree's condition nodes.
// r2 (Decision 6): (a) the condition parser is the grammar measured in "alc's precedence,
// measured"; (b) a leading U+FEFF is stripped before matching directive lines; (c) --full.
// Also, to match Decision 2's refusal list: an undecided file is REFUSED WHOLE (the product
// generates no mutant in it), a line/marker mismatch is `marker-mismatch` (was a STOP), an `#if`
// never closed is `unbalanced`, `#define L M` is `bad-define`, and a condition is evaluated only
// when its outer region is active (dead code never refuses a file).
//
// Usage: bun pp.ts <project-dir> <symbols-csv|""> <twin-dir> <regions.json> [--full <full-dir>]
//        bun pp.ts --self-test <battery.txt>...   (case files: <battery dir>/cases/<id>.al)
//
// Effective symbols = app.json "preprocessorSymbols" (if any) plus the given list, then per file
// `#define`/`#undef` lines applied in order while the current region is active (alc: measured).
//
// Per file it writes to regions.json:
//   inactive:  byte ranges [start, end) of lines inside an arm the symbols compile out;
//   lifted:    byte ranges of ACTIVE arms of statement-position preproc_conditional_statement nodes
//              (the only place the fix adds sites);
//   undecided: a reason (code plus line number, never source text), or null;
//   directiveLines / markerNodes: the cross-check (a mismatch makes the file undecided).
// The lift twin blanks every preproc_conditional_statement's directive lines and inactive-arm lines
// (spaces, EOLs kept, so offsets are unchanged). The FULL twin blanks EVERY directive line and
// every inactive line: the source alc actually compiles.
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { initParser, parseAL } from "H:/LethAL-wt/lane-preproc/packages/engine/src/ast/parser";
import {
  type ALSyntaxNode,
  visit,
  wrapRoot,
} from "H:/LethAL-wt/lane-preproc/packages/engine/src/ast/syntax-node";

await initParser();

class Undecided extends Error {}
const KEYWORDS = new Set(["and", "or", "not", "true", "false"]);
// The measured grammar:
//   or := and ("or" and)*;  and := unary ("and" unary)*;  unary := "not" unary | primary;
//   primary := "(" or ")" | "true" | "false" | symbol;  symbol := [A-Za-z_][A-Za-z0-9_]*
// keywords case-insensitive, symbols case-sensitive. Anything else refuses.
function evalCond(text: string, syms: Set<string>, line: number): boolean {
  const src = text.replace(/\/\/.*$/, "").trim();
  const bad = () => new Undecided(`unparsed-condition at line ${line}`);
  const toks: string[] = [];
  for (let k = 0; k < src.length; ) {
    const c = src[k] ?? "";
    if (c === " " || c === "\t" || c === "\r") {
      k++;
      continue;
    }
    if (c === "(" || c === ")") {
      toks.push(c);
      k++;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(k));
    if (m === null) throw bad(); // `!`, `&&`, `||`, `==`, a leading digit, any other character
    toks.push(m[0]);
    k += m[0].length;
  }
  let i = 0;
  const peek = () => toks[i]?.toLowerCase();
  const unary = (): boolean => {
    const t = toks[i++];
    if (t === undefined) throw bad();
    const lt = t.toLowerCase();
    if (lt === "not") return !unary();
    if (t === "(") {
      const v = or();
      if (toks[i++] !== ")") throw bad();
      return v;
    }
    if (lt === "true") return true;
    if (lt === "false") return false;
    if (t === ")" || KEYWORDS.has(lt)) throw bad(); // a bare keyword as an operand
    return syms.has(t);
  };
  const and = (): boolean => {
    let v = unary();
    while (peek() === "and") {
      i++;
      const r = unary();
      v = v && r;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (peek() === "or") {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  const v = or();
  if (i !== toks.length) throw bad(); // leftover tokens
  return v;
}

const DIRECTIVE = /^[ \t]*#[ \t]*(if|elif|else|endif|define|undef)(?![A-Za-z0-9_])(.*)$/i;
const MARKERS = new Set(["preproc_if", "preproc_elif", "preproc_else", "preproc_endif"]);
const COUNTED = new Set([...MARKERS, "preproc_define", "preproc_undef"]);

type Line = { start: number; end: number; text: string };
type Analysis = {
  lines: Line[];
  lineActive: boolean[];
  isDirective: boolean[];
  undecided: string | null;
  directiveLines: number;
  markerNodes: number;
  root: ALSyntaxNode;
};
function analyze(src: string, base: Set<string>): Analysis {
  const lines: Line[] = [];
  for (let s = 0; s <= src.length; ) {
    const nl = src.indexOf("\n", s);
    const e = nl < 0 ? src.length : nl + 1;
    let text = src.slice(s, e).replace(/\r?\n$/, "");
    if (s === 0 && text.startsWith("\uFEFF")) text = text.slice(1); // (b) BOM
    lines.push({ start: s, end: e, text });
    if (nl < 0) break;
    s = e;
  }
  type Frame = { parentActive: boolean; taken: boolean; active: boolean; sawElse: boolean };
  const syms = new Set(base);
  const stack: Frame[] = [];
  const cur = () => stack.at(-1)?.active ?? true;
  const lineActive: boolean[] = [];
  const isDirective: boolean[] = [];
  let undecided: string | null = null;
  let directiveLines = 0;
  for (const [n, l] of lines.entries()) {
    const m = DIRECTIVE.exec(l.text);
    isDirective[n] = m !== null;
    lineActive[n] = cur();
    if (m === null) continue;
    directiveLines++;
    if (undecided !== null) continue;
    const kind = (m[1] ?? "").toLowerCase();
    const rest = m[2] ?? "";
    try {
      if (kind === "if") {
        const pa = cur();
        const v = pa ? evalCond(rest, syms, n + 1) : false;
        stack.push({ parentActive: pa, taken: v, active: pa && v, sawElse: false });
      } else if (kind === "elif") {
        const f = stack.at(-1);
        if (f === undefined || f.sawElse) throw new Undecided(`unbalanced at line ${n + 1}`);
        const v = f.parentActive ? evalCond(rest, syms, n + 1) : false;
        f.active = f.parentActive && !f.taken && v;
        f.taken = f.taken || v;
      } else if (kind === "else") {
        const f = stack.at(-1);
        if (f === undefined || f.sawElse) throw new Undecided(`unbalanced at line ${n + 1}`);
        f.active = f.parentActive && !f.taken;
        f.taken = true;
        f.sawElse = true;
      } else if (kind === "endif") {
        if (stack.pop() === undefined) throw new Undecided(`unbalanced at line ${n + 1}`);
      } else if (cur()) {
        const sym = rest.replace(/\/\/.*$/, "").trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(sym))
          throw new Undecided(`bad-define at line ${n + 1}`);
        if (kind === "define") syms.add(sym);
        else syms.delete(sym);
      }
    } catch (err) {
      if (!(err instanceof Undecided)) throw err;
      undecided = err.message;
    }
  }
  if (undecided === null && stack.length > 0) undecided = `unbalanced at line ${lines.length}`;
  const root = wrapRoot(parseAL(src));
  let markerNodes = 0;
  visit(root, (node) => {
    if (COUNTED.has(node.rawKind)) markerNodes++;
  });
  if (undecided === null && directiveLines !== markerNodes)
    undecided = `marker-mismatch (${directiveLines} directive lines, ${markerNodes} markers)`;
  // An undecided file is refused whole; its twins keep every arm (only directive lines blanked),
  // so they still parse, and predict.ts drops every row of it.
  if (undecided !== null) for (let n = 0; n < lines.length; n++) lineActive[n] = true;
  return { lines, lineActive, isDirective, undecided, directiveLines, markerNodes, root };
}

// ---- self-test: the parser against the measured battery ----
if (process.argv[2] === "--self-test") {
  // Probes that share a case file (battery.sh / battery2.sh).
  const FILE: Record<string, string> = {
    "def-in-live": "def-in-dead",
    "undef-app": "def-undef-app",
    "app-only": "app-union",
  };
  // Rejected by alc but not modelled by Decision 2 (the compile fails before any mutant runs):
  // row 34 (`#endif A`), row 35 (directive after code), row 46 (`#define` after the first token).
  const NOT_MODELLED = new Set(["endif-text", "if-midline", "def-mid", "def-after-object"]);
  let bad = 0;
  let rows = 0;
  for (const bat of process.argv.slice(3)) {
    for (const l of readFileSync(bat, "utf8").split("\n")) {
      if (l.trim() === "") continue;
      const [id = "", d = "", a = "", b = "", o = ""] = l.split("\t");
      const defs = d.slice("defines=".length);
      const app = a.slice("app=".length);
      const built = b
        .slice("built=[".length, -1)
        .split(" ")
        .filter((x) => x !== "");
      const rejected = o.slice("other=".length).trim() !== "";
      const src = readFileSync(join(dirname(bat), "cases", `${FILE[id] ?? id}.al`), "utf8");
      const base = new Set([
        ...(defs === "-" ? [] : defs.split(",")),
        ...(app === "-" ? [] : app.split(",")),
      ]);
      const r = analyze(src, base);
      const mine = r.lines
        .flatMap((x, n) => {
          const m = /exit\((ARM\d+)\)/.exec(x.text);
          return m !== null && r.lineActive[n] && !r.isDirective[n] ? [m[1] ?? ""] : [];
        })
        .sort();
      let verdict: string;
      if (rejected) {
        if (r.undecided !== null) verdict = `ok refused (${r.undecided})`;
        else if (NOT_MODELLED.has(id)) verdict = "ok not-modelled (alc rejects; Decision 2)";
        else verdict = "BAD alc rejected, pp accepted";
      } else if (id === "kw-as-sym") {
        verdict =
          r.undecided !== null ? `ok refused row 21 (${r.undecided})` : "BAD row 21 not refused";
      } else if (id === "in-comment") {
        verdict = r.undecided?.startsWith("marker-mismatch")
          ? `ok refused row 49 (${r.undecided})`
          : "BAD row 49 not refused";
      } else if (r.undecided !== null) verdict = `BAD refused (${r.undecided})`;
      else verdict = mine.join(" ") === built.join(" ") ? "ok" : `BAD built=[${mine.join(" ")}]`;
      rows++;
      if (verdict.startsWith("BAD")) bad++;
      console.log(
        `${id}\t${d}\t${a}\talc=[${built.join(" ")}]${rejected ? " rejected" : ""}\t${verdict}`,
      );
    }
  }
  console.log(`self-test rows ${rows} bad ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

// ---- the predictor half ----
const argv = process.argv.slice(2);
const fullAt = argv.indexOf("--full");
const fullDir = fullAt >= 0 ? argv[fullAt + 1] : undefined;
const pos = fullAt >= 0 ? [...argv.slice(0, fullAt), ...argv.slice(fullAt + 2)] : argv;
const [projectDir, symbolsCsv = "", twinDir, regionsPath] = pos;
if (projectDir === undefined || twinDir === undefined || regionsPath === undefined)
  throw new Error("usage: pp.ts <project> <symbols-csv> <twin-dir> <regions.json> [--full <dir>]");

let appSymbols: string[] = [];
try {
  const raw = JSON.parse(
    readFileSync(join(projectDir, "app.json"), "utf8").replace(/^\uFEFF/, ""),
  ).preprocessorSymbols;
  if (raw !== undefined) appSymbols = raw as string[];
} catch {
  /* no app.json: no app.json symbols */
}
const base = new Set([...appSymbols, ...symbolsCsv.split(",").filter((s) => s !== "")]);
const out: Record<string, unknown> = {};

function walkFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walkFiles(p) : [p];
  });
}
const put = (dir: string | undefined, rel: string, content: string | null, abs: string) => {
  if (dir === undefined) return;
  const dest = join(dir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (content === null) copyFileSync(abs, dest);
  else writeFileSync(dest, content);
};

for (const abs of walkFiles(projectDir)) {
  const rel = relative(projectDir, abs);
  if (!rel.toLowerCase().endsWith(".al")) {
    put(twinDir, rel, null, abs);
    put(fullDir, rel, null, abs);
    continue;
  }
  const src = readFileSync(abs, "utf8");
  if (!/^[ \t]*#[ \t]*(if|define|undef)/im.test(src.replace(/^\uFEFF/, ""))) {
    put(twinDir, rel, null, abs);
    put(fullDir, rel, null, abs);
    continue;
  }
  const a = analyze(src, base);
  const { lines, lineActive, isDirective } = a;
  const containers: ALSyntaxNode[] = [];
  visit(a.root, (node) => {
    if (node.rawKind === "preproc_conditional_statement") containers.push(node);
  });
  const inStatementPosition = (n: ALSyntaxNode): boolean => {
    const p = n.parent;
    if (p === null) return false;
    if (p.rawKind === "statement_block" || p.rawKind === "code_block") return true;
    return p.rawKind === "preproc_conditional_statement" && inStatementPosition(p);
  };
  const lineOf = (offset: number): number => {
    let lo = 0,
      hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lines[mid]?.start ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const twin = src.split("");
  const full = src.split("");
  const blank = (t: string[], from: number, to: number) => {
    for (let k = from; k < to; k++)
      if (t[k] !== "\n" && t[k] !== "\r" && t[k] !== "\uFEFF") t[k] = " ";
  };
  for (const [n, l] of lines.entries())
    if (isDirective[n] || !lineActive[n]) blank(full, l.start, l.end);
  const lifted: [number, number][] = [];
  const blankedDirectives: [number, number][] = [];
  for (const c of containers) {
    const first = lineOf(c.startIndex);
    const last = lineOf(c.endIndex - 1);
    for (let n = first; n <= last; n++) {
      const l = lines[n];
      if (l === undefined) continue;
      if (isDirective[n]) blankedDirectives.push([l.start, l.end]);
      if (isDirective[n] || !lineActive[n]) blank(twin, l.start, l.end);
    }
    if (!inStatementPosition(c)) continue;
    const markers = c.children.filter((k) => MARKERS.has(k.rawKind));
    for (let m = 0; m + 1 < markers.length; m++) {
      const from = lineOf(markers[m]?.startIndex ?? 0) + 1;
      const to = lineOf(markers[m + 1]?.startIndex ?? 0);
      if (from < to && lineActive[from])
        lifted.push([lines[from]?.start ?? 0, lines[to]?.start ?? 0]);
    }
  }
  put(twinDir, rel, twin.join(""), abs);
  put(fullDir, rel, full.join(""), abs);
  const inactive: [number, number][] = [];
  for (const [n, l] of lines.entries()) {
    if (lineActive[n] || isDirective[n]) continue;
    const prev = inactive.at(-1);
    if (prev !== undefined && prev[1] === l.start) prev[1] = l.end;
    else inactive.push([l.start, l.end]);
  }
  out[rel.replaceAll("\\", "/")] = {
    inactive,
    lifted,
    blankedDirectives,
    undecided: a.undecided,
    directiveLines: a.directiveLines,
    markerNodes: a.markerNodes,
  };
}
writeFileSync(regionsPath, JSON.stringify({ symbols: [...base], files: out }, null, 1));
