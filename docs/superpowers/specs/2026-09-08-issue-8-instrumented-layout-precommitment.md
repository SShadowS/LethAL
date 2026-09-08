# Pre-commitment: the instrumented tree keeps the project's directory structure (issue #8)

Written **before** the change and before any gate ran. The point of writing it first is that a
prediction recorded after a green run is not a prediction.

## What is being changed

`writeInstrumentedProject` (`packages/schemata/src/project.ts`) writes each instrumented `.al` file
to `join(targetDir, basename(f.path))`. `prepareBatchProject`
(`packages/runner/src/orchestrator.ts`) copies the project's remaining `.al` files the same flat
way. Both change to write at the file's own project-relative path.

The duplicate-basename guard in `prepareBatchProject` is deleted with them. It exists only because
of the flattening, and its own comment says so.

## Why, measured rather than assumed

Issue #8 reports a `controladdin` failing to compile with `AL0327: Missing file
'./EditorAddin/pageworks-editor.js'`. The reporter inferred the resources were never copied. They
ARE copied: `prepareBatchProject` copies every non-`.al` project file "with their directory
structure intact", into the same `targetDir` that `writeInstrumentedProject` just wrote, from the
same caller (`orchestrator.ts:1091-1102`).

The failure is the mismatch the flattening creates, which is consequence 2 of the reporter's own
analysis:

```text
source     src/Studio/X.ControlAddIn.al   ->  Scripts = './EditorAddin/x.js'
                                             resolves to src/Studio/EditorAddin/x.js
instrumented  <batch>/X.ControlAddIn.al   ->  same relative path now resolves to
                                             <batch>/EditorAddin/x.js
resource copied to                           <batch>/src/Studio/EditorAddin/x.js
```

The asset is present and the compiler looks somewhere else. So no new copying is needed: keeping
the `.al` file at its own depth makes the existing copy correct.

## The prediction

**No verdict moves, and no manifest field moves.**

The reasoning, so that a wrong prediction is informative rather than vague:

1. `MutantManifestEntry.file` is `f.path`, the project-relative path. It is the input to the write,
   not the destination, so it is unchanged by definition.
2. `identityTupleOf` keys on `astHash`, `codeunitName`, procedure, span and operator. None is a
   function of where the file was written.
3. `buildLineMap` already reads its project dir with `readdir(..., { recursive: true })`
   (`line-map.ts:344`), so it finds files at depth without change.
4. `LineMap` keys on `(objectType, objectId)`, which is path-independent.
5. `stageForCompile` and the al-runner backend both copy the tree with `{ recursive: true }`.

**Specifically predicted, to be checked after:**

- `itest:alrunner` stays **3 killed / 16 survived / 0 no-coverage** over 19, and every per-mutant
  verdict is identical.
- An offline `alc` compile of an instrumented fixture succeeds in both layouts, and the two
  `mutant-manifest.json` files are byte-identical.

**What would refute it.** Any verdict change, any manifest difference, or a compile that succeeds
flat and fails nested. A compile that fails NESTED and succeeds flat would mean `alc` resolves
something against the project root that the flattening was accidentally satisfying, which would be
worth knowing and would send this back to the drawing board rather than being patched around.

## Known limits of the verification

`itest:bcdev`, `itest:tables` and `itest:envtool` need a container or a hosted environment and are
not being run for this change, on instruction. `itest:alrunner` needs only the dotnet tool and does
exercise deploy from the instrumented dir, so it is the live check available here. The offline
manifest diff covers the part `alrunner` cannot see, which is whether the emitted mutation set is
byte-for-byte the same.

This is stated as a limit rather than folded away: three gates that would have exercised this are
not being run, and if the change is wrong in a way only they would catch, this document is where
that gap was recorded.
