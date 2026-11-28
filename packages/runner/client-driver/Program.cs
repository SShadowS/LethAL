// PR-479 client-driver: drives ONE client-mode test op through a /cs ClientSession (BC client library, .NET 8).
// Spec: docs/superpowers/specs/2026-11-28-pr479a-bcdev-client-driver.md (amendments 1 and 2). Round 2 builds it; no server has run it yet.
//
// Protocol. stdin line 1 is ONE JSON command:
//   { configPath, webClientBaseUrl, company, codeunitId, methods: [declared method names, in order], attemptId, opSeq,
//     suiteName?, tenant?, diagnostic?: true (repeater state to stderr), deadlines?: { openSeconds, stepSeconds, testSeconds, goSeconds } }
// Later stdin lines are the TypeScript side's go signals: {"go":"bind"}, {"go":"end"}, {"go":"close"}.
// stdout: JSON lines {step, ok, ms, detail}. Steps: opened, readback, ready, bound, ran, ended, closed, and error (ok=false,
// detail {error: <name>, message}). stderr: first-chance exceptions and library events by name (R1240); never the login.
// Order: open -> `opened` -> page 130455 sets + every read-back (form stays open) -> `readback`, `ready` -> wait go:bind
// -> bind (page 91015, closed) -> re-check range/runner/company on 130455 -> run -> `ran` -> wait go:end
// -> End (ONLY if "All tests executed." was seen) -> `ended` -> wait go:close -> close -> `closed`.
// A refusal before `ready` happens with no op bound, so it cannot wedge the server.
// Any failure or passed deadline, or any exit before "All tests executed.", closes WITHOUT End.
// The login comes from the bcdev section of the config FILE (username, password); never argv or env; never printed.
using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Dynamics.Framework.UI.Client;
using Microsoft.Dynamics.Framework.UI.Client.Interactions;

// --self-test: asserts on the pure helpers, no server, no stdin. Exit 0 all pass, 1 any fail.
if (args.Contains("--self-test")) return SelfTest.Run();

var sw = Stopwatch.StartNew();
void Out(string step, bool ok, object detail = null)
{
    var o = new Dictionary<string, object> { ["step"] = step, ["ok"] = ok, ["ms"] = sw.ElapsedMilliseconds };
    if (detail != null) o["detail"] = detail;
    Console.Out.WriteLine(JsonSerializer.Serialize(o));
    Console.Out.Flush();
}
void Log(string s) => Console.Error.WriteLine($"{DateTime.UtcNow:HH:mm:ss.fff} {s}");

// A named refusal or failure; the name is what the TypeScript side maps to an error class.
// Exit codes: 0 ok, 3 refusal, 4 deadline, 5 config/command, 6 session error, 7 stdin closed early.
var exitCode = 0;
void Fail(string name, string message, int code)
{
    if (exitCode == 0) exitCode = code;
    Out("error", false, new { error = name, message });
}

// stdin: line 1 is the command, the rest are go signals, read on a background task into a channel.
var stdin = Channel.CreateUnbounded<string>();
_ = Task.Run(async () =>
{
    string line;
    while ((line = await Console.In.ReadLineAsync()) != null) stdin.Writer.TryWrite(line);
    stdin.Writer.TryComplete();
});
async Task<string> NextLine(TimeSpan limit, string what)
{
    using var cts = new CancellationTokenSource(limit);
    try { return await stdin.Reader.ReadAsync(cts.Token); }
    catch (OperationCanceledException) { throw new DriverFailure("deadline", $"{what}: no input within {limit.TotalSeconds}s", 4); }
    catch (ChannelClosedException) { throw new DriverFailure("stdin-closed", $"{what}: stdin closed before the go", 7); }
}

JsonElement cmd;
try { cmd = JsonDocument.Parse(await NextLine(TimeSpan.FromSeconds(30), "command")).RootElement; }
catch (Exception e) { Fail("bad-command", e.Message, 5); return exitCode; }

string S(string k) => cmd.TryGetProperty(k, out var v) && v.ValueKind != JsonValueKind.Null ? (v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString()) : null;
double Dl(string k, double d) => cmd.TryGetProperty("deadlines", out var ds) && ds.TryGetProperty(k, out var v) ? v.GetDouble() : d;

string baseUrl, company, codeunitId, attemptId, opSeq, suite, tenant;
List<string> declared;
bool diagnostic;
TimeSpan openDl, stepDl, testDl, goDl;
NetworkCredential cred;
try
{
    baseUrl = S("webClientBaseUrl") ?? throw new ArgumentException("webClientBaseUrl");
    company = S("company") ?? throw new ArgumentException("company");
    codeunitId = S("codeunitId") ?? throw new ArgumentException("codeunitId");
    attemptId = S("attemptId") ?? throw new ArgumentException("attemptId");
    opSeq = S("opSeq") ?? throw new ArgumentException("opSeq");
    suite = S("suiteName") ?? "DEFAULT";
    tenant = S("tenant") ?? "default";
    diagnostic = cmd.TryGetProperty("diagnostic", out var dg) && dg.ValueKind == JsonValueKind.True;
    declared = cmd.TryGetProperty("methods", out var ms) && ms.ValueKind == JsonValueKind.Array
        ? ms.EnumerateArray().Select(x => x.GetString()).ToList()
        : throw new ArgumentException("methods");
    if (declared.Count == 0) throw new ArgumentException("methods is empty");
    openDl = TimeSpan.FromSeconds(Dl("openSeconds", 30));
    stepDl = TimeSpan.FromSeconds(Dl("stepSeconds", 30));
    testDl = TimeSpan.FromSeconds(Dl("testSeconds", 540));
    goDl = TimeSpan.FromSeconds(Dl("goSeconds", 120));
    var cfgPath = S("configPath") ?? throw new ArgumentException("configPath");
    var bc = JsonDocument.Parse(File.ReadAllText(cfgPath)).RootElement.GetProperty("bcdev");
    if (bc.TryGetProperty("credentialsEnv", out _)) throw new DriverFailure("config-login-missing", "credentialsEnv is refused for the driver; the config file needs username and password", 5);
    if (!bc.TryGetProperty("username", out var u) || !bc.TryGetProperty("password", out var p) || u.GetString() is not { Length: > 0 } || p.GetString() is not { Length: > 0 })
        throw new DriverFailure("config-login-missing", "the config's bcdev section has no username and password", 5);
    cred = new NetworkCredential(u.GetString(), p.GetString());
}
catch (DriverFailure e) { Fail(e.Name, e.Message, e.Code); return exitCode; }
catch (Exception e) { Fail("bad-command", $"{e.GetType().Name}: {e.Message}", 5); return exitCode; }

// R1240: the open fails silently (state stays Busy), so every wait has a hard deadline and swallowed exceptions are logged.
AppDomain.CurrentDomain.FirstChanceException += (_, e) => Log($"first-chance {e.Exception.GetType().FullName}: {e.Exception.Message}");
TaskScheduler.UnobservedTaskException += (_, e) => Log($"unobserved {e.Exception.GetBaseException().GetType().FullName}: {e.Exception.GetBaseException().Message}");

// The company: ClientSessionParameters has NO company property (reflected below). The session is opened with a
// `company=` query on the /cs URL beside tenant. MEASURED LATER on bcwin that the query selects the company; until then
// the page 130455 CurrentCompanyName read-back is the fail-closed guard.
var companyProps = typeof(ClientSessionParameters).GetProperties().Where(x => x.Name.Contains("Company", StringComparison.OrdinalIgnoreCase)).Select(x => x.Name).ToList();
var url = $"{baseUrl.TrimEnd('/')}/cs?tenant={Uri.EscapeDataString(tenant)}&company={Uri.EscapeDataString(company)}";

var http = new JsonHttpClient(new Uri(url), cred, AuthenticationScheme.UserNamePassword);
var session = new ClientSession(http, new NonDispatcher(), new TimerFactory<TaskTimer>());
ClientLogicalForm lastForm = null;
session.CommunicationError += (_, e) => Log($"event CommunicationError: {e.Exception?.GetType().FullName}: {e.Exception?.Message}");
session.UnhandledException += (_, e) => Log($"event UnhandledException: {e.Exception?.GetType().FullName}: {e.Exception?.Message}");
session.InvalidCredentialsError += (_, _) => Log("event InvalidCredentialsError");
session.MessageToShow += (_, e) => Log($"event MessageToShow: {e.Message}");
session.DialogToShow += (_, e) => Log($"event DialogToShow: {e.DialogToShow?.MainCaption} / {e.DialogToShow?.ControlIdentifier}");
session.FormToShow += (_, e) => { lastForm = e.FormToShow; Log($"event FormToShow: {e.FormToShow?.MainCaption}"); };

async Task Settle(Task t, TimeSpan limit, string what)
{
    var end = DateTime.UtcNow + limit;
    if (t != null && await Task.WhenAny(t, Task.Delay(limit)) != t) throw new DriverFailure("deadline", $"{what}: task not done in {limit.TotalSeconds}s (state {session.State})", 4);
    if (t != null && t.IsFaulted) throw new DriverFailure("session-error", $"{what}: {t.Exception.GetBaseException().GetType().Name}: {t.Exception.GetBaseException().Message}", 6);
    while (session.State != ClientSessionState.Ready)
    {
        if (session.State is ClientSessionState.InError or ClientSessionState.TimedOut or ClientSessionState.Closed)
            throw new DriverFailure("session-error", $"{what}: session state {session.State}: {session.LastException?.Message}", 6);
        if (DateTime.UtcNow > end) throw new DriverFailure("deadline", $"{what}: state still {session.State} after {limit.TotalSeconds}s", 4);
        await Task.Delay(50);
    }
}
Task Do(ClientInteraction i, string what, TimeSpan? limit = null) => Settle(session.InvokeInteractionAsync(i), limit ?? stepDl, what);

async Task<ClientLogicalForm> OpenPage(int page)
{
    lastForm = null;
    await Do(new OpenFormInteraction { Page = page.ToString() }, $"open page {page}");
    var end = DateTime.UtcNow + stepDl;
    while (lastForm == null && DateTime.UtcNow < end) await Task.Delay(50);
    return lastForm ?? session.OpenedForms?.LastOrDefault() ?? throw new DriverFailure("deadline", $"page {page}: no FormToShow within {stepDl.TotalSeconds}s", 4);
}
ClientLogicalControl Find(ClientLogicalForm f, string name) =>
    f.ContainedControls.FirstOrDefault(c => c.Name == name) ?? f.ContainedControls.FirstOrDefault(c => c.Caption == name)
    ?? throw new DriverFailure("control-missing", $"control '{name}' not on '{f.MainCaption}'", 3);
Task Set(ClientLogicalForm f, string name, string value) => Do(new SaveValueInteraction(Find(f, name), value), $"set {name}");
Task Act(ClientLogicalForm f, string name, TimeSpan? limit = null) => Do(new InvokeActionInteraction(Find(f, name)), $"action {name}", limit);
Task CloseForm(ClientLogicalForm f) => Do(new CloseFormInteraction(f), "close form");
string ReasonOf(ClientLogicalForm f) => f.ContainedControls.FirstOrDefault(c => c.Name == "Reason" || c.Caption == "Reason")?.StringValue ?? "<no Reason control>";
bool Yes(string s) => s != null && (s.Equals("Yes", StringComparison.OrdinalIgnoreCase) || s.Equals("true", StringComparison.OrdinalIgnoreCase));

async Task WaitGo(string go)
{
    var line = await NextLine(goDl, $"go:{go}");
    string got = null;
    try { got = JsonDocument.Parse(line).RootElement.GetProperty("go").GetString(); } catch { }
    if (got != go) throw new DriverFailure("unexpected-go", $"expected go:{go}, got {line}", 3);
}

(string Range, string Runner, string Company) CheckHeader(ClientLogicalForm f)
{
    var gotRange = Find(f, "TestCodeunitRangeFilter").StringValue;
    var gotRunner = Find(f, "TestRunnerCodeunitId").StringValue;
    var gotCompany = Find(f, "CurrentCompanyName").StringValue;
    if (gotRange != codeunitId) throw new DriverFailure("range-mismatch", $"codeunit range reads {gotRange}, wanted {codeunitId}", 3);
    if (gotRunner != "130450") throw new DriverFailure("runner-mismatch", $"runner id reads {gotRunner}, wanted 130450", 3);
    if (gotCompany != company) throw new DriverFailure("company-mismatch", $"CurrentCompanyName reads {gotCompany}, wanted {company}", 3);
    return (gotRange, gotRunner, gotCompany);
}

// diagnostic: true in the command prints the repeater's state at each load strategy to stderr as JSON.
void Diag(string point, ClientRepeaterControl rep)
{
    if (!diagnostic) return;
    var rows = rep.DefaultViewport.Select(r => r.ContainedControls.Select(c => new { name = c.Name, caption = c.Caption, value = c.StringValue }).ToList()).ToList();
    Log("diag " + JsonSerializer.Serialize(new { point, totalRowCount = rep.TotalRowCount, offset = rep.Offset, pageSize = rep.PageSize, viewportRows = rows.Count, rows }));
}

var allExecuted = false;
var ended = false;
try
{
    var p = new ClientSessionParameters { CultureId = "en-US", UICultureId = "en-US" };
    p.AdditionalSettings.Add("IncludeControlIdentifier", true);
    await Settle(session.OpenSessionAsync(p), openDl, "open session");
    Out("opened", true, new { state = session.State.ToString(), companyParameter = new { reflectedProperties = companyProps, via = "url-query", company } });

    // Page 130455: set, READ BACK everything, and keep the form open. All of it happens BEFORE any op exists, so a
    // refusal here closes the session with nothing bound (nothing to wedge).
    var f = await OpenPage(130455);
    await Set(f, "CurrentSuiteName", suite);
    await Set(f, "TestCodeunitRangeFilter", codeunitId);
    await Set(f, "TestRunnerCodeunitId", "130450");
    var (gotRange, gotRunner, gotCompany) = CheckHeader(f);

    // The method lines: a repeater whose rows carry cells "Name" and "Run" (and "Line Type", when present, to skip the
    // codeunit line). Cell names are unmeasured on BC 28.4: a missing column is a named refusal. Only the first viewport is
    // read; more rows than it holds is refused, never skipped.
    var rep = f.ContainedControls.OfType<ClientRepeaterControl>().FirstOrDefault() ?? throw new DriverFailure("control-missing", "no repeater (method lines) on page 130455", 3);
    Diag("after-range", rep);
    var rows = rep.DefaultViewport.ToList();
    // The repeater may load lazily. Strategies, in order: (a) the viewport as it is; (b) Scroll when it is empty but
    // TotalRowCount > 0; (c) the page's Refresh action. Still empty: fall through to the refusal below.
    if (rows.Count == 0 && rep.TotalRowCount > 0)
    {
        try { await Settle(rep.Scroll(0, new ClientInteractionsOptions()), stepDl, "scroll method lines"); }
        catch (DriverFailure e) when (e.Name == "session-error") { Log($"scroll failed: {e.Message}"); }
        Diag("after-scroll", rep);
        rows = rep.DefaultViewport.ToList();
    }
    if (rows.Count == 0)
    {
        var refresh = f.ContainedControls.FirstOrDefault(c => c.Name == "Refresh" || c.Caption == "Refresh");
        if (refresh != null) await Do(new InvokeActionInteraction(refresh), "action Refresh");
        else Log("no Refresh action on page 130455");
        Diag("after-refresh", rep);
        rows = rep.DefaultViewport.ToList();
    }
    // Paging: the viewport holds PageSize rows (20 on bcwin; the codeunit there has 80 lines). Scroll until the collected
    // rows equal TotalRowCount, merging by identity so an overlap or a repeated page never double-counts. Whether Scroll's
    // argument is an absolute offset or a delta is unmeasured: the first call tries absolute and reads Offset back.
    Line ReadLine(ClientLogicalControl row)
    {
        var cells = row.ContainedControls.ToList();
        string Cell(params string[] ns) => cells.FirstOrDefault(c => ns.Contains(c.Name) || ns.Contains(c.Caption))?.StringValue;
        return new Line(Cell("Test Codeunit", "Codeunit ID", "Codeunit No.") ?? "", Cell("Name"), Cell("Line Type"), Cell("Run"));
    }
    var collected = new SortedDictionary<long, Line>();
    void Collect(string point)
    {
        Diag(point, rep);
        Pure.MergePage(collected, rep.Offset, rep.DefaultViewport.Select(ReadLine).ToList());
    }
    Collect("page-0");
    var maxPages = (int)(rep.TotalRowCount / Math.Max(1, rep.PageSize)) + 3;
    string scrollMode = null; // null = unknown, "absolute", "delta"
    for (var page = 1; collected.Count < rep.TotalRowCount && page <= maxPages; page++)
    {
        var want = collected.Count == 0 ? 0 : collected.Keys.Max() + 1;
        var before = (long)rep.Offset;
        var seen = collected.Count;
        async Task Go(long arg) => await Settle(rep.Scroll(arg, new ClientInteractionsOptions()), stepDl, $"scroll method lines to {arg}");
        if (scrollMode != "delta")
        {
            await Go(want);
            // From offset 0 the two readings agree; assume absolute, and switch if a later call lands at before+want.
            if (before != 0 && rep.Offset == before + want) scrollMode = "delta";
            else if (rep.Offset != before) scrollMode = "absolute";
        }
        if (scrollMode != "absolute" && rep.Offset == before)
        {
            await Go(want - before);
            if (rep.Offset == before) throw new DriverFailure("methods-viewport-incomplete", $"Scroll moved Offset neither as absolute {want} nor as delta {want - before} (stays {before})", 3);
            scrollMode = "delta";
        }
        Collect($"page-{page}");
        if (collected.Count == seen) break; // no new row: do not loop on the same page
    }
    if (collected.Count < rep.TotalRowCount) throw new DriverFailure("methods-viewport-incomplete", $"{rep.TotalRowCount} lines, collected {collected.Count} (page size {rep.PageSize}, scroll {scrollMode ?? "not tried"})", 3);
    var lines = new List<(string Name, bool Run)>();
    foreach (var row in collected.Values)
    {
        // Measured on bcwin (BC 28.4, 2026-11-28): the cell reads the option ORDINAL ("1" = Function, "0" = Codeunit).
        // Ordinal only: a caption would break on a translated BC. A missing column (null) keeps the row.
        if (row.LineType != null && !Pure.IsFunctionLine(row.LineType)) continue;
        var nm = row.Name ?? throw new DriverFailure("control-missing", "method line has no Name cell", 3);
        var run = row.Run ?? throw new DriverFailure("control-missing", "method line has no Run cell", 3);
        lines.Add((nm, Yes(run)));
    }
    if (!lines.Select(l => l.Name).SequenceEqual(declared))
        throw new DriverFailure("methods-mismatch", $"page lines [{string.Join(", ", lines.Select(l => l.Name))}] differ from declared [{string.Join(", ", declared)}]", 3);
    var off = lines.Where(l => !l.Run).Select(l => l.Name).ToList();
    if (off.Count > 0) throw new DriverFailure("run-flag-false", $"Run is not set on: {string.Join(", ", off)}", 3);
    Out("readback", true, new { range = gotRange, runner = gotRunner, company = gotCompany, methods = lines.Select(l => l.Name) });

    // Ready: the TypeScript side Activates, then sends go:bind.
    Out("ready", true);
    await WaitGo("bind");
    // PR-479 review S4: ONE total deadline for the op, from the bind to `ran`. testSeconds is the control's run bound
    // (its 600 s cap) minus 60 s, and it holds across the whole RunNextTest loop, not per call, so this deadline always
    // fires before the control's own bound.
    var opEnd = DateTime.UtcNow + testDl;

    // Bind through page 91015 (page 130455 stays open beside it): Bound = Yes and Reason empty, else refuse.
    var bf = await OpenPage(91015);
    await Set(bf, "Attempt Id", attemptId);
    await Set(bf, "Op Seq", opSeq);
    await Act(bf, "Bind");
    var bound = Find(bf, "Bound").StringValue;
    var reason = ReasonOf(bf);
    if (!Yes(bound) || reason != "") throw new DriverFailure("bind-refused", $"Bound={bound}, Reason={reason}", 3);
    Out("bound", true, new { bound, reason });
    await CloseForm(bf);

    // A sanity check of the LOCAL form state only (PR-479 review N1): the library's copy of page 130455's controls, which
    // the bind cannot change, so this cannot fail. It is NOT a server read.
    CheckHeader(f);

    await Act(f, "ClearTestResults");
    var results = new List<string>();
    while (true)
    {
        var left = opEnd - DateTime.UtcNow;
        if (left <= TimeSpan.Zero) throw new DriverFailure("deadline", $"no 'All tests executed.' within {testDl.TotalSeconds}s of the bind", 4);
        await Act(f, "RunNextTest", left);
        var json = Find(f, "TestResultJson").StringValue;
        if (json == "All tests executed.") { allExecuted = true; break; }
        if (!string.IsNullOrEmpty(json)) results.Add(json);
    }
    Out("ran", true, new { results });
    await CloseForm(f);

    await WaitGo("end");
    // End ONLY when every test ran. (allExecuted is always true here; the check keeps the rule next to the call.)
    if (allExecuted)
    {
        var ef = await OpenPage(91015);
        await Set(ef, "Attempt Id", attemptId);
        await Set(ef, "Op Seq", opSeq);
        await Act(ef, "End");
        var endedVal = Find(ef, "Ended").StringValue;
        var endReason = ReasonOf(ef);
        if (!Yes(endedVal) || endReason != "") throw new DriverFailure("end-refused", $"Ended={endedVal}, Reason={endReason}", 3);
        ended = true;
        Out("ended", true, new { ended = endedVal, reason = endReason });
        await CloseForm(ef);
        await WaitGo("close");
    }
}
catch (DriverFailure e) { Fail(e.Name, e.Message, e.Code); }
catch (Exception e) { Fail("session-error", $"{e.GetType().Name}: {e.Message}", 6); }
finally
{
    // Closing without End when the run did not finish: the op stays in flight (the TypeScript side decides).
    try
    {
        session.CloseSessionAsync();
        var end = DateTime.UtcNow + stepDl;
        while (session.State != ClientSessionState.Closed && session.State != ClientSessionState.InError && DateTime.UtcNow < end) await Task.Delay(50);
        Out("closed", session.State == ClientSessionState.Closed, new { state = session.State.ToString(), ended });
    }
    catch (Exception e) { Out("closed", false, new { error = "close-failed", message = $"{e.GetType().Name}: {e.Message}", ended }); }
}
return exitCode;

// One method-line row as read from the repeater. LineType null = the column is absent.
record Line(string CodeunitId, string Name, string LineType, string Run);

static class Pure
{
    // Measured on bcwin (BC 28.4, 2026-11-28): "Line Type" reads the option ORDINAL, "1" = Function, "0" = Codeunit.
    // Ordinal only: a caption would break on a translated BC.
    public static bool IsFunctionLine(string lineType) => lineType == "1";

    static (string, string, string) Id(Line l) => (l.CodeunitId ?? "", l.Name ?? "", l.LineType ?? "");

    // Merges one viewport page read at `offset` into the rows collected so far, keyed by absolute row index. A row whose
    // identity (codeunit id + name + line type) is already collected is skipped, so overlap and a repeated page never
    // double-count. Order is by row index, whatever order the pages arrived in. A different row at an index already
    // taken means the offset is wrong: refuse.
    public static void MergePage(SortedDictionary<long, Line> acc, long offset, IReadOnlyList<Line> page)
    {
        var seen = new HashSet<(string, string, string)>(acc.Values.Select(Id));
        for (var i = 0; i < page.Count; i++)
        {
            var idx = offset + i;
            if (acc.TryGetValue(idx, out var have))
            {
                if (Id(have) != Id(page[i])) throw new DriverFailure("methods-viewport-incomplete", $"row {idx} reads '{Id(page[i])}' but '{Id(have)}' was collected there", 3);
                continue;
            }
            if (seen.Add(Id(page[i]))) acc[idx] = page[i];
        }
    }
}

static class SelfTest
{
    static int fails;
    static void Check(string name, bool ok)
    {
        Console.Out.WriteLine($"{(ok ? "PASS" : "FAIL")} {name}");
        if (!ok) fails++;
    }
    static Line L(string n, string t = "1") => new("50100", n, t, "Yes");
    static string Names(SortedDictionary<long, Line> a) => string.Join(",", a.Select(kv => $"{kv.Key}:{kv.Value.Name}"));

    public static int Run()
    {
        Check("IsFunctionLine \"1\" is true", Pure.IsFunctionLine("1"));
        Check("IsFunctionLine \"0\" is false", !Pure.IsFunctionLine("0"));
        Check("IsFunctionLine \"2\" is false", !Pure.IsFunctionLine("2"));
        Check("IsFunctionLine \"Function\" is false", !Pure.IsFunctionLine("Function"));
        Check("IsFunctionLine \"\" is false", !Pure.IsFunctionLine(""));
        Check("IsFunctionLine null is false", !Pure.IsFunctionLine(null));

        var a = new SortedDictionary<long, Line>();
        Pure.MergePage(a, 0, new[] { L("CU", "0"), L("A"), L("B") });
        Pure.MergePage(a, 2, new[] { L("B"), L("C"), L("D") }); // overlap on B
        Check("overlapping pages merge without double count", Names(a) == "0:CU,1:A,2:B,3:C,4:D");
        Pure.MergePage(a, 2, new[] { L("B"), L("C"), L("D") }); // the same page again
        Check("a repeated page adds nothing", a.Count == 5);

        var o = new SortedDictionary<long, Line>();
        Pure.MergePage(o, 3, new[] { L("D"), L("E") });
        Pure.MergePage(o, 0, new[] { L("A"), L("B"), L("C") }); // lower offset arrives later
        Check("an out-of-order offset keeps row order", Names(o) == "0:A,1:B,2:C,3:D,4:E");

        var c = new SortedDictionary<long, Line>();
        Pure.MergePage(c, 0, new[] { L("A"), L("B") });
        var refused = false;
        try { Pure.MergePage(c, 1, new[] { L("X") }); } catch (DriverFailure) { refused = true; }
        Check("a different row at a taken index is refused", refused);

        var t = new SortedDictionary<long, Line>();
        Pure.MergePage(t, 0, new[] { L("A", "1"), L("A", "0") });
        Check("same name, different line type are two rows", t.Count == 2);

        Console.Out.WriteLine(fails == 0 ? "self-test ok" : $"self-test FAILED ({fails})");
        return fails == 0 ? 0 : 1;
    }
}

class DriverFailure : Exception
{
    public string Name { get; }
    public int Code { get; }
    public DriverFailure(string name, string message, int code) : base(message) { Name = name; Code = code; }
}
