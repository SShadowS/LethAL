# Published JSON Schemas

Machine-readable descriptions of what LethAL prints, for a consumer that wants to validate a file or
generate types rather than discover a shape change by crashing on it. Draft 2020-12.

| File | Describes | Version constant |
|---|---|---|
| [`explain-v4.schema.json`](explain-v4.schema.json) | `lethal explain <report.json>` on stdout | `EXPLAIN_SCHEMA_VERSION` = 4 |
| [`doctor-v1.schema.json`](doctor-v1.schema.json) | `lethal doctor --json` on stdout | `DOCTOR_SCHEMA_VERSION` = 1 |

**Not published yet:** the JSON report written by `--out` (`REPORT_SCHEMA_VERSION` = 2) and the
NDJSON event stream written by `--progress-out` (`STREAM_SCHEMA_VERSION` = 1). Both are versioned in
the code and neither has a schema here. See `docs/roadmap/R152.md`.

## What keeps these true

`packages/runner/tests/schemas.test.ts`, three ways, because a published schema that has drifted is
worse than no schema at all — it calls a correct document invalid, at every consumer that validates.

1. **Shape.** Each schema's leaf paths are asserted equal to the leaves walked out of the TypeScript
   declaration (`ExplainOutput`, `DoctorJsonOutput`), in both directions. A field added to the type
   with no schema entry fails; a schema property with no field fails.
2. **Value domains.** Every `enum` is asserted equal to the runtime constant it copies, so a value
   added to `Caveat` or `MutantErrorCause` cannot leave the schema behind.
3. **Real data.** The projection of a committed campaign report is validated against
   `explain-v4.schema.json`, capped and uncapped.

The validator in that test is small on purpose — type, const, enum, required, properties,
additionalProperties, items, minItems, local `$ref`. It is not a JSON Schema implementation and must
not become one. A schema here that needs a keyword it does not support is a signal to add a real
validator as a dependency.

## Versioning

A version bumps when a field is renamed or removed, when a field changes meaning, or when a value
domain changes **in either direction** — growing one is not free, because a consumer branches on the
value and an unrecognised one lands in whatever its else-branch says. **Adding a field does not
bump it**, so a consumer must tolerate properties it does not know.

A new version means a new file. `explain-v4.schema.json` stays as it is when a v5 arrives, so a
stored document remains checkable against the schema it was written under.
