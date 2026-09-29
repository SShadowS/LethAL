import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { ALNodeKind } from "./node-kinds";
import { type ALSyntaxNode, type NamedNodeVisitor, walkNamedFlat } from "./syntax-node";

/**
 * The lowercase hex BLAKE3 of the UTF-8 of `node`'s canonical string (see `CanonicalHasher`).
 *
 * RUST-03 S4.2d. One pre-order walk encodes the canonical string's fragments, in order, into one
 * reusable buffer and feeds each full buffer to BLAKE3; the string itself is never built. It used
 * to be built by joining a new string at every level, and every node's `namedChildren` was read
 * twice, which on the whole Base Application was about 1.8 GB of the manifest phase's transient.
 * A native `FlatNode` is walked by index (`walkNamedFlat`); any other node (a `withText` node, the
 * WASM reference wrapper) through `ALSyntaxNode`, reading `namedChildren` once per node.
 */
export function astSubtreeHash(node: ALSyntaxNode): string {
  const hasher = new CanonicalHasher();
  walk(node, hasher);
  return hasher.digest();
}

function walk(node: ALSyntaxNode, v: NamedNodeVisitor): void {
  if (walkNamedFlat(node, v)) return;
  const children = node.namedChildren;
  if (!v.descends(node.kind, children.length > 0)) {
    v.leaf(node.kind, node.fieldName, node.text);
    return;
  }
  v.open(node.kind);
  for (const child of children) walk(child, v);
  v.close();
}

/**
 * Field names on the two node shapes where an identifier is a NAME rather than a variable.
 *
 * R166. Every identifier used to become a positional id, which is right for a local variable and
 * wrong for a method or field name: `DataMain.Delete(false)`, `DataMain.Insert(false)` and
 * `DataMain.Modify(false)` all serialised as `id0.id1(false)` and hashed IDENTICALLY, so three
 * different mutations shared one identity. Measured on the gift card demo, the three guard clauses
 * `Error(CardBlockedErr, CardNo)`, `Error(CardExpiredErr, CardNo)` and
 * `Error(InsufficientBalanceErr, CardNo)` collapsed the same way, and their three mutants are killed
 * by three DIFFERENT tests.
 *
 * `design.md` §5.1 calls the identity key's inputs "local variable names canonicalized to positional
 * ids" and says the hash "changes when the expression's structure or operators change". A method
 * name is neither a local variable nor structure, so erasing it was outside what the rule promised.
 *
 * The narrowing keeps the property the canonicalisation exists for: an identifier in VARIABLE
 * position is still positional, so a local rename still leaves the hash alone. Only these two
 * positions keep their text.
 */
const NAME_POSITION_FIELDS: ReadonlySet<string> = new Set([
  // `Rec.Delete`: the part after the dot, whether it is a method or a field.
  "member",
  // `Foo()`: an unqualified callee.
  "function",
]);

/** The buffer the canonical bytes are gathered in before BLAKE3 sees them. The golden test
 *  (`hash-golden.test.ts`) places surrogate pairs across this boundary. */
const BUFFER_BYTES = 4096;
const encoder = new TextEncoder();
// One buffer for every call: astSubtreeHash is synchronous and never re-entered.
const buffer = new Uint8Array(BUFFER_BYTES);
/** `buffer.subarray(k)`, made once per offset, so encoding a fragment allocates no view. */
const tails: Uint8Array[] = [];
const constants = new Map<string, Uint8Array>();
/** The bytes of a constant fragment (a kind name, a bracket, an identifier number), encoded once. */
function constant(s: string): Uint8Array {
  let bytes = constants.get(s);
  if (bytes === undefined) {
    bytes = encoder.encode(s);
    constants.set(s, bytes);
  }
  return bytes;
}
const SPACE = constant(" ");
const OPEN = constant("(");
const CLOSE = constant(")");
const NAME = constant("(name ");
const numbered: Uint8Array[] = [];

/**
 * Emits the canonical string of a subtree, fragment by fragment in pre-order, as UTF-8 into
 * `buffer`, feeding BLAKE3 whenever the next fragment does not fit. The string, unchanged since
 * R166:
 * - only named children are visited, in order;
 * - an identifier is `(name <text>)` when its field is `member` or `function`, and otherwise
 *   `(identifier #<n>)`, `n` numbering each distinct text from 0 in pre-order (names are not
 *   numbered), before any look at its children;
 * - an integer, decimal, text or boolean literal, and any other node with no named child, is
 *   `(<kind> <text>)`;
 * - any other node is `(<kind>`, then a space and each named child, then `)`.
 * No normalisation: whitespace, CRLF, case and Unicode are hashed as they are.
 *
 * A fragment is never split across a flush: each is encoded whole, and the buffer is flushed first
 * if it does not fit (a fragment larger than the buffer is fed on its own). So a surrogate pair is
 * never encoded in halves, and the bytes are exactly the UTF-8 of the whole string.
 */
class CanonicalHasher implements NamedNodeVisitor {
  private readonly scope = new Map<string, number>();
  private readonly hash = blake3.create();
  private pos = 0;
  private root = true;

  descends(kind: string, hasNamedChild: boolean): boolean {
    return hasNamedChild && kind !== ALNodeKind.identifier && !isLiteral(kind);
  }

  leaf(kind: string, fieldName: string | null, text: string): void {
    this.separate();
    if (kind === ALNodeKind.identifier) {
      // R166: a NAME keeps its text; a variable keeps its positional id.
      if (fieldName !== null && NAME_POSITION_FIELDS.has(fieldName)) {
        this.bytes(NAME);
        this.text(text);
        this.bytes(CLOSE);
        return;
      }
      let n = this.scope.get(text);
      if (n === undefined) {
        n = this.scope.size;
        this.scope.set(text, n);
      }
      let bytes = numbered[n];
      if (bytes === undefined) {
        bytes = encoder.encode(`(identifier #${n})`);
        numbered[n] = bytes;
      }
      this.bytes(bytes);
      return;
    }
    // Literals, and leaf named nodes (no named children), carry their terminal text as part of
    // their identity. In this grammar, operator tokens like `comparison_operator` are
    // named-but-leaf nodes whose `text` is the actual operator (`>` vs `>=`), and must participate
    // in the hash so that an operator swap changes the hash.
    this.bytes(OPEN);
    this.bytes(constant(kind));
    this.bytes(SPACE);
    this.text(text);
    this.bytes(CLOSE);
  }

  open(kind: string): void {
    this.separate();
    this.bytes(OPEN);
    this.bytes(constant(kind));
  }

  close(): void {
    this.bytes(CLOSE);
  }

  digest(): string {
    this.flush();
    return bytesToHex(this.hash.digest());
  }

  /** Every node after the subtree's root is a named child of an open node: a space precedes it. */
  private separate(): void {
    if (this.root) this.root = false;
    else this.bytes(SPACE);
  }

  private bytes(b: Uint8Array): void {
    if (b.length > BUFFER_BYTES - this.pos) {
      this.flush();
      if (b.length > BUFFER_BYTES) {
        this.hash.update(b);
        return;
      }
    }
    buffer.set(b, this.pos);
    this.pos += b.length;
  }

  private text(s: string): void {
    let tail = tails[this.pos];
    if (tail === undefined) {
      tail = buffer.subarray(this.pos);
      tails[this.pos] = tail;
    }
    const into = encoder.encodeInto(s, tail);
    if (into.read === s.length) {
      this.pos += into.written;
      return;
    }
    // It does not fit in what is left: flush, then encode it whole from the start of the buffer.
    this.flush();
    const whole = encoder.encodeInto(s, buffer);
    if (whole.read === s.length) {
      this.pos = whole.written;
      return;
    }
    // Larger than the whole buffer: fed on its own.
    this.pos = 0;
    this.hash.update(encoder.encode(s));
  }

  private flush(): void {
    if (this.pos > 0) this.hash.update(buffer.subarray(0, this.pos));
    this.pos = 0;
  }
}

function isLiteral(kind: string): boolean {
  return (
    kind === ALNodeKind.integer_literal ||
    kind === ALNodeKind.decimal_literal ||
    kind === ALNodeKind.text_literal ||
    kind === ALNodeKind.boolean_literal
  );
}
