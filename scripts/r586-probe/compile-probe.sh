#!/usr/bin/env bash
# R586: how alrunner (al-runtime-rs) reports AL that does not compile, and whether app.json
# preprocessorSymbols are read. Works on copies of the probe projects. Measurement tool only.
# Usage: compile-probe.sh <alrunner> <out dir>
set -u
A="$1"; OUT="$2"
P="$(cd "$(dirname "$0")" && pwd)"
export ALRUNNER_CACHE="${ALRUNNER_CACHE:-/work/tools/al-runtime-rs/cache}"
W="$OUT/compile-work"; rm -rf "$W"; mkdir -p "$W"
: > "$OUT/compile-INDEX.tsv"

variant() { # variant <name> <old text> <new text> [file]
  local name="$1" old="$2" new="$3" file="${4:-src/ProbeLogic.Codeunit.al}"
  rm -rf "$W/$name"; mkdir -p "$W/$name"
  cp -r "$P/probe-app" "$P/probe-tests" "$W/$name/"
  bun "$P/replace-in-copy.ts" "$W/$name/probe-app/$file" "$old" "$new" || return
  (cd "$W/$name" && timeout 900 "$A" test --output-json --test-exact Codeunit50650.Passes --test-exact Codeunit50650.ArmIs probe-app probe-tests > "$OUT/compile-$name.out" 2> "$OUT/compile-$name.err")
  printf '%s\texit=%s\n' "$name" "$?" >> "$OUT/compile-INDEX.tsv"
}
# Syntax error inside Add (the routine Passes calls).
variant syntax-in-called 'exit(A + B);' 'exit(A + );'
# Type error inside Add.
variant type-in-called 'exit(A + B);' "exit('x');"
# Type error inside a routine Passes does NOT call (Spin).
variant type-in-uncalled 'I += 1;' "I := 'x';"
# Unknown procedure inside an uncalled routine.
variant unknown-call-uncalled 'I += 1;' 'I := NoSuchProc();'
# Syntax error that breaks the object structure.
variant object-broken 'procedure Spin(): Integer' 'procedure Spin(: Integer'
# app.json preprocessorSymbols (no --define).
variant appjson-symbols '"features": []' '"features": [], "preprocessorSymbols": ["LETHALB"]' app.json
exit 0
