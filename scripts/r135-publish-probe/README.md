# R135 publish probe — what does a per-mutant artifact actually cost?

**Answer: publish + sync + install is a flat ~4.4 s, and NOTHING about what changed moves it.** A
one-property change, a no-change republish, and a real schema change (adding or dropping a stored
field) all cost the same. Measured 2026-08-14 against **Cronus281** (BC 28.0.46665.47126, the
container `fixtures/sandbox-app` targets), Windows Docker context, `alc` 18.0.38.8509.

    label               version  variant compileMs publishMs
    cold-first-publish  1.0.0.1  A             654      5278
    property-changed-1  1.0.0.2  B             634      4400
    no-change-control-1 1.0.0.3  B             651      4433
    property-changed-2  1.0.0.4  A             688      4563
    no-change-control-2 1.0.0.5  A             671      4491
    property-changed-3  1.0.0.6  B             673      4404
    no-change-control-3 1.0.0.7  B             664      4417
    schema-add-field-1  1.0.0.8  A             657      4328
    schema-drop-field-1 1.0.0.9  A             682      4453
    schema-add-field-2  1.0.0.10 A             677      4290
    schema-drop-field-2 1.0.0.11 A             749      4351
    schema-add-field-3  1.0.0.12 A             649      4330
    schema-drop-field-3 1.0.0.13 A             664      4624

    property-changed   publish median 4404 ms  (n=3)
    no-change control  publish median 4433 ms  (n=3)
    schema-changed     publish median 4351 ms  (n=6)
    compile median 664 ms over all rounds

An earlier run of the same script, before the schema phase was added, gave 4899 / 4464 / 4451 ms for
the property-changed rounds and a cold first publish of 8194 ms on a tenant that had never held the
extension. Same conclusion.

## Why this exists

`docs/roadmap/R135.md` asks for one number before any declarative-mutation operator can be specified:
**per-mutant publish + sync cost on a container for an artifact that differs by one property**, to be
weighed against the per-batch cost LethAL pays today. LethAL's mechanism is a runtime guard around
executable code, and a property cannot dispatch at runtime, so the only way to mutate a FlowField's
`CalcFormula` or a `SourceTableView` is to build a separate artifact per mutant and deploy each one.
The row lists three options and says the decision needs this measurement.

## The probe

`table 71540 "R135 Source"` (`"Entry No."` Integer PK, `"Main No."` Code[20], `Category` Code[10],
`Amount` Decimal) and `table 71541 "R135 Probe"`, whose only interesting member is a FlowField:

```al
field(2; "Category A Total"; Decimal)
{
    FieldClass = FlowField;
    CalcFormula = Sum("R135 Source".Amount where("Main No." = field("No."), "Category" = const('A')));
    Editable = false;
}
```

Variant A is `const('A')`; variant B is `const('B')`. One character, inside exactly the kind of
`where()` condition R135 names as the surface — "a wrong filter in a CalcFormula is a classic silent
bug".

`drive.ps1` alternates the variants, and after each property change republishes the SAME source under
a new version as a control, so the cost of the change is separable from the cost of publishing at
all. It then adds and drops an ordinary stored field, which is a real schema change, to test Option
B's premise directly.

Run it with:

    pwsh -File scripts/r135-publish-probe/drive.ps1 -ContainerName Cronus281 -Rounds 3

It unpublishes the probe and clears the tenant's schema ghost (`Sync-NAVApp -Mode Clean` while
unpublished — see the `al-probe` skill) unless `-SkipCleanup` is passed.

## What the numbers mean

1. **The publish is the cost; the change is free.** Property-changed 4404 ms, no-change 4433 ms,
   schema-changed 4351 ms. The three are within noise of each other, so BC is not doing meaningfully
   more work for a schema change than for nothing at all on an app this size. Every per-mutant
   deployment pays the full publish whatever the mutation is.

2. **Option B's premise does not hold.** R135's Option B restricts declarative mutations to
   schema-neutral rewrites "so ForceSync stays cheap". There is no cheap ForceSync to protect: the
   schema-neutral rounds cost the same as the schema-changing ones. Option B therefore shrinks the
   mutation surface and buys nothing on cost — strictly worse than Option A on the only axis it was
   proposed for.

3. **4.4 s is a FLOOR, not the per-mutant cost on a real project.** BC publishes whole extensions, so
   a per-mutant artifact for a real app is a whole-project publish. The measured figure for one is
   R45's Continia Document Output run: **deploy 40.8 s**, once, for the whole campaign. R90 measured
   single-file DO publishes on a hosted environment at **36–97 s** for 176 guards, with 331 guards
   timing out entirely. This probe's app is two tables; nothing here should be read as a real
   project's publish cost.

## Not measured

- Hosted (cloud) publish cost for a one-property change. R90's 36–97 s is the nearest figure and it
  is for a differently-shaped artifact.
- Whether repeated publishes degrade — 13 in a row showed no upward trend, but a campaign would do
  hundreds.
- The reliability axis. R44's proxy timeout and R90's publish failures are per-publish risks, so
  multiplying publishes multiplies exposure; this probe measured time, not failure rate.
