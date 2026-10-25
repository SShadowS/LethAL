# R759 pre-commitment, addendum 1 (lane bugs, R-759b, 2026-10-25): the live run moves to bc3 with a bc3 probe build

Committed before the live run. The pre-commitment (`2026-10-25-r759-verify-narrowing-precommitment.md`, master
d550809b) is not edited.

## What changes
- Server: bc3 (the pre-commitment allowed "bc1 (or bc3 if bc1 is unavailable; same predictions)"). bc1 was out of use
  when R-759b resumed; bc3 runs the proof.
- Probe build: id SET 1 rebuilt offline against bc3's cached System symbols (`drive.ts --build --server bc3`;
  `/coord/handoff/R-759b/probe-build-bc3.md`). Names, versions and app ids are the same as the bc1 build; the sha256s
  differ (the build embeds the server's symbols):
  - L1 R740 Probe Lib 1.0.0.1 `5f457b42934e80419e6e54f402b9250d9acae7db6fc5a5d01e797c713423d918`
  - L2 R740 Probe Lib 1.0.0.2 `587689340d2b94c2fc18ea6e8279f1b45433f693709a2ff1ebcdf1aed1165dc2`
  - P R740 Probe Target 1.0.0.1 `8b1c18a19677e9dd604a889edfe44b3a72f570587966efd7f60d0b5a2aac62f5`
  - Q R740 Probe Tests 1.0.0.1 `dfe5548b999806a4297fde212c232247a6c66b4b5075c92d4a10654735a734d7`
- Code: the head of `lethal/r759` now includes master (R745's `--exclude-test` and everything since); the branch's own
  change is unchanged.

## What does not change
Every prediction P1-P10 stands as written, including the step-1 read-back (only 1.0.0.1 rows of set 1 on bc3, else stop
and mint a set 3 under a further addendum) and P6's corrected caveat set from R745's addendum 1.
