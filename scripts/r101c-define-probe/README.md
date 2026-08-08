# R101(c) probe — what does `alc` do when a preprocessor symbol is NOT defined?

**Answer: it does not fail. It compiles the other branch, cleanly, and emits a different artifact.**
That silence is the whole defect. A loud failure would have been harmless.

Measured 2026-08-09 with the AL compiler from `ms-dynamics-smb.al-18.0.2498801`
(`Microsoft (R) AL Compiler version 18.0.38.8509`). Offline only — no BC server involved.

## Why this exists

R101(c) was filed as "al-runner has no `--define`". That framing is wrong twice over, and the row
now says so:

1. The gap is in **LethAL's OWN `alc` step first**. A search for `/define` across
   `packages/runner/src` and `packages/schemata/src` returned nothing, so the instrumented target
   was compiled from whichever branch the compiler picks with no symbols at all.
2. al-runner 2.1.1 **does** have the flag — two of them: `--define SYM` and
   `--preprocessor-symbols A,B,...`, and its own help says each entry of the second "is validated
   identically to `--define`".

## The measurement

`src/DefineProbe.Codeunit.al` carries two `#if` sites on two different symbols, each with a complete
implementation on both branches — the shape real code has, where an `#if` selects between two
working implementations rather than between working and broken.

Four compiles of the same source, changing only `/define:`:

| `/define:` | exit | artifact bytes |
| --- | --- | --- |
| (omitted) | 0 | 3473 |
| `LETHAL_PROBE_SYMBOL` | 0 | 3505 |
| `LETHAL_PROBE_SYMBOL,LETHAL_PROBE_SECOND` | 0 | 3516 |
| `LETHAL_PROBE_SYMBOL;LETHAL_PROBE_SECOND` | 0 | 3517 |

Four distinct SHA-256 hashes. **Every compile succeeded.**

Two things follow directly:

- **An undefined symbol is silent.** Nothing warns, nothing fails; a different program is built. So a
  project whose real build defines a symbol LethAL does not pass gets instrumented, mutated and
  SCORED on code the customer does not ship, and no artifact of the run says so.
- **Both separators work** for the list form. Comma is what LethAL sends, because it is what
  al-runner's own `--preprocessor-symbols A,B,...` uses and one spelling across the two compile paths
  is worth more than supporting two here.

## The part that is specific to LethAL, and is worse

The AST layer does not evaluate `#if` at all — tree-sitter treats the directives as trivia. Running
`generateMutationSet` over this probe produces **3** specs, and they sit in BOTH branches:

```
lethal.empty-block   "begin\n#if LETHAL_PROBE_SYMBOL\n        exit('DEFINED-BRANCH')"
lethal.empty-block   "begin\n#if LETHAL_PROBE_SYMBOL\n        for I := 1 to 10 do\n  "
lethal.return-value  "exit(Total)"
```

`exit(Total)` lives inside `#if LETHAL_PROBE_SYMBOL`. With the symbol undefined, `alc` drops that
whole block — including the mutation guard wrapped around it — so the mutant is deployed but
unreachable and comes back `survived` or `no-coverage`. Both of those read as statements about the
test suite. Neither is one.

## Reproducing

```bash
ALC="$HOME/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/alc.exe"
# symbols: any BC 28 .alpackages (this probe declares no dependencies)
cp fixtures/sandbox-data-tests/.alpackages/*.app scripts/r101c-define-probe/.alpackages/

P='/project:U:/Git/LethAL/scripts/r101c-define-probe'
C='/packagecachepath:U:/Git/LethAL/scripts/r101c-define-probe/.alpackages'
OUT="C:/Users/SShadowS/AppData/Local/Temp/r101c2"

"$ALC" "$P" "$C" "/out:$OUT/none.app"
"$ALC" "$P" "$C" /define:LETHAL_PROBE_SYMBOL "/out:$OUT/one.app"
"$ALC" "$P" "$C" /define:LETHAL_PROBE_SYMBOL,LETHAL_PROBE_SECOND "/out:$OUT/comma.app"
sha256sum "$OUT"/*.app
```

Never published to a server, and it has no dependencies, so nothing has to be cleaned up afterwards.
`.alpackages` is gitignored.
