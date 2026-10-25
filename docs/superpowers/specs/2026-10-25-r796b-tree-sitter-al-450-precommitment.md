# R796 pre-commitment (R-796b): the tree-sitter-al 4.5.0 upgrade

Written 2026-10-25 by lethal-bugs, before any build of the upgrade. The merge is HELD until after the talk (not before
Wed 28 Oct unless the owner says so).
Basis: R-796's scratch measurement (R796 §"Big-corpus dumps (2026-10-25/26)", master 601b2e98) and R-726c's
(`/coord/handoff/R-726c/ts450.md`). Since 601b2e98, master's only engine-side commits are R726c's test-timeout changes,
which change no generation code.

## The change
- Pin tree-sitter-al `=4.5.0`, with the five files that carry the version and hashes: `Cargo.toml`/`Cargo.lock`,
  `scripts/check-native-grammar.ts`, `GRAMMAR_PIN`, `native/src/lib.rs` `GRAMMAR_VERSION`, `scripts/native-notices.ts`.
  Regenerate `statement-containers.json` and refresh the vendored WASM reference to 4.5.0.
- R217: classify the 7 new statement containers (`case_body`, `preproc_conditional_case`,
  `preproc_split_block_close_after_endif`, `preproc_split_block_end_in_else`, `preproc_split_case_extended`,
  `preproc_split_open_statement`, `preproc_split_var_section_tail`), and drop `preproc_conditional_var` as a container.
  Each new container is classified so that the statements it holds get exactly the mutation slots their 4.4.1 parse
  gave them, wherever 4.4.1 parsed them as statements.
- Re-pin the 10 engine tests that move for grammar reasons (2 R217, 2 R327 that now pin direct members, 2 ERROR hash
  goldens, 3 R214, 1 R295), each with a one-line reason.
- `IDENTITY_SCHEME` 42 -> 43, because the big corpora gain sites.

## Predicted figures (`corpus-snapshot.ts diff`, 4.4.1 against the built branch, both at the build's base master)
| corpus | projects | added | removed | tuples moved | ordinals moved | tags changed |
|---|---|---|---|---|---|---|
| fixtures | 25 | 0 | 0 | 0 | 0 | 0 |
| CDO | 6 | 0 | 0 | 0 | 0 | 0 |
| DO | 7 | 0 | 0 | 0 | 0 | 0 |
| BC.History (`bch`) | 519 | 98 | 14 | 0 | 2 | 0 |
| DC | 14 | 3 | 0 | 0 | 0 | 0 |

- **Per key:** the added and removed rows are exactly R796's.
  - Per operator: swap-call-arguments 71, swap-additive 1, empty-block 1, flip-boolean-literal 1, void-method-call 2, validate-to-assign 5, remove-setrange 7, swap-find-direction 5, swap-modify-flag 4, remove-testfield 4.
  - Removed: void-method-call 11, flip-boolean-literal 3.
  - Per project: Application Test Library +36, Base Application +4, Tests-ERM +26/-5, Tests-SCM +15, Tests-SCM-Service +12/-5, Tests-VAT +5/-4, DC Cloud +3.
- **Hang counts:** Tests-SCM's hang-capable count moves 152 -> 146. No other project's hang or skipped count moves.
- **Gates:** every gate's frozen figures are unchanged, because the fixtures are identical. That covers the full `itest:alrunner-v3`, per mutant, on `current`. No BC leg is run. If a fixture figure moves, the work stops and the orchestrator is told.
- **Identity bump:** the committed baselines at scheme 42 then lag the scheme. R682's check lists them; no verdict changes. Re-recording them is bookkeeping, in the merge window.

## Judgement
Any difference from the table, or from the per-key rows, is a BLOCK until explained in a dated addendum, never an edit
of this file. A difference caused by the R217 classification of a new container is a BLOCK too: the classification
must reproduce 4.4.1's slots, so it adds or removes nothing by itself.
