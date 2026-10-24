# R737 pre-commitment, addendum 1 (lane bugs, R-737, 2026-10-24): C3 missed as worded, explained

Written after the cost run. The pre-commitment (`2026-10-24-r737-preproc-receiver-precommitment.md`, master
3df6e2c9) is not edited; this records the one miss and its explanation.

## The miss
C3 said every changed baseapp file would be one of the ten R_loop files. The cost run on `lethal/r737`
(code commit 2cd47ee7; `/coord/handoff/R-737/cost/`) changed exactly one baseapp file, and it is not one of
them: `Manufacturing/Setup/ManufacturingSetup.Table.al`, 42 specs -> 40, 2 removed (`lethal.empty-block` and
`lethal.return-value` in `IsFeatureKeyFlushingMethodManualWithoutPickEnabled`). Nothing was added.

## Explanation (trace: `/coord/handoff/R-737/cost/trace-baseapp.txt`)
Two of the ten R_loop files, `Manufacturing/MfgCreateInventoryPutaway.Codeunit.al` and
`Manufacturing/Warehouse/Activity/MfgCreateInvtPickMovement.Codeunit.al`, call that procedure from inside a
loop through a `ManufacturingSetup` receiver declared in a var-section `#if`. With the receiver now typed, the
hang readers follow the call into the callee and refuse the callee's mutants that can change the loop's
outcome. Those mutants live in the CALLEE's file. C3's wording assumed every refusal lands in the caller's
(loop) file; the reach census lists the loop files, not the files of the procedures they call.

The change is fail-closed (2 refusals gained, 0 lost), it is caused by exactly the mechanism R737 adds, and it
stays within C3's intent (refusals reached only from the census's loop sites). C2 held as worded: dc's 7
removed specs are in the loop file itself because the callee is in the same file.

## Corrected statement of C3 (for the record, not a new prediction)
Every changed baseapp file is an R_loop file or the file of a procedure an R_loop site calls through a
census receiver; specs removed are bounded by those files' spec counts; nothing is added.
