// R254 arm (DRAFT r2): the base report a reportextension extends. Holds no code on purpose, so
// every mutant in this arm sits in the EXTENSION. Processing-only over the EXISTING table 79302
// "Data Related" (no new table, no `platform` dependency), scoped to the arm's own 'BAND' rows,
// which only BandReportSumsBands seeds and BC rolls back after it (R32).
report 79340 "Data Band Report"
{
    ProcessingOnly = true;
    UsageCategory = None;

    dataset
    {
        dataitem(BandItem; "Data Related")
        {
            DataItemTableView = where("Main No." = const('BAND'));
        }
    }
}
