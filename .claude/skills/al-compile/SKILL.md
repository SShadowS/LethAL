---
name: al-compile
description: Offline-compile an AL project with alc.exe and report diagnostics — the standalone verification for AL edits (AL has no unit-test harness here). Use when you changed AL in extensions/lethal-control or an emitted instrumented target and want to confirm it builds before the live gate. Invoke as /al-compile [project-dir].
---

# al-compile

Compile an AL project offline and report diagnostics. AL edits have no `bun test` — this + the live gate are the verification.

## Usage
`/al-compile` — compiles `extensions/lethal-control` (default).
`/al-compile <project-dir>` — compiles the given AL project (its `.alpackages` is the symbol cache).

## Procedure
```bash
# run from the repo root
if [ "$(uname -s)" = "Linux" ]; then
  # Linux: $LETHAL_ALC_DIR/alc first, then the extension's bin/linux/alc. Never an .exe.
  ALC="${LETHAL_ALC_DIR:+$LETHAL_ALC_DIR/alc}"
  [ -x "$ALC" ] || ALC=$(ls ~/.vscode/extensions/ms-dynamics-smb.al-*/bin/linux/alc 2>/dev/null | sort | tail -1)
else
  ALC=$(ls ~/.vscode/extensions/ms-dynamics-smb.al-*/bin/win32/alc.exe ~/.vscode/extensions/ms-dynamics-smb.al-*/bin/alc.exe 2>/dev/null | sort | tail -1)
fi
PROJ="${1:-extensions/lethal-control}"
CACHE="$PROJ/.alpackages"
OUT="$PROJ/.al-compile-check.app"
"$ALC" "/project:$PROJ" "/packagecachepath:$CACHE" "/out:$OUT"; echo "EXIT=$?"
rm -f "$OUT"
```

## Rules
- Git bash on Windows; never `2>nul` (use `2>/dev/null`).
- Report EVERY diagnostic verbatim. AL0789 (using ignored) is expected for the emitted target (no namespace); AL0454 (unresolved codeunit) means a missing dependency/symbol — a real break.
- Delete the scratch `.app`. Never publish, never touch a live container.
- For an emitted instrumented target, the LethAL Control dependency + `lethal-control.app` must be staged in the cache first (bcdev `deploy()` does this in a private staging copy) — otherwise the selector's `Codeunit "LC Control State"` reference is AL0454.
- Verdict: CLEAN (exit 0) or ERRORS (quote them).
