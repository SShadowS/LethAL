# R-937 (R945) pre-commitment: seven measured refusal families join the v3 serve keep list

Written 2026-11-12 by lane preproc, before any measured run of the change. al-runner edge-42af5d384 (`current`).

## The change

`V3_SERVE_SAFE_REFUSALS` (packages/runner/src/al-runner-server.ts) gains seven entries, each anchored at both ends, one per family
the probe proved clean (`/coord/handoff/R-937/probe/README.md`, invented AL only):
`dotnet-exception`, `dotnet-no-object`, `dotnet-assembly`, `dotnet-member`, `dotnet-overload`, `stream-never-created`,
`dotnet-policy-timezone` (the time-zone member only). The free-text tails (`dotnet-exception`, `dotnet-assembly`) carry the same
`SAFE_TAIL` guard as `cascade`: a tail naming a panic, a timeout or a wall-time stop still closes the daemon. Not admitted: "InStream
method on an unassigned Variant" (never produced by the probe), and every family the probe did not measure.

What the probe measured, per family, on one serve daemon with the .NET helper: 20 rounds of a refused test then a reader, the reader
equal to the one after a passing test with the same writes and to a fresh daemon's; pid constant; no panic text. Nothing crossed
requests under any isolation; inside one run a refused test never left more state than a pass.

## Expected results

**Cryptography Management** (full, 1,389 mutants; config `/coord/handoff/R-933/v3.crypto.json`, sources `/coord/handoff/R-932/src`,
module pool `bch-sysapp-pool-excel-crypto@d9fad4a0933b+25661207`). Before: the run already measured on master 6abd6109
(`/coord/handoff/R-933/runs/crypto.after.*`). After: the same config on the R-937 branch head.
- Per mutant: verdict and killing test identical for all 1,389. Any difference is a BLOCK.
- Baseline: identical per test (53 pass, 13 error, 1 error+fail, 1 fail).
- Early daemon closes (R939 `serve-daemon-closed`, reason `refusal`): 344 before; after, at most 40. 315 of the 348 refusal rows
  match a new entry; a request still closes when any of its rows is outside the list.
- The mutant loop and its warm-up seconds fall (direction only).

**The v3 gate:** no figure moves. No gate fixture raises these refusals (the one DotNet fixture, `sandbox-codefree`, is not a v3 leg),
and the update gate's `serve-keep-reasons` fact is unchanged (it pins the five existing cases; a reworded text of a new entry only
stops matching and closes the daemon again).
