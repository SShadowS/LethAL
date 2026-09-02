# R198 group-runner measurement driver.
#
# Drives the probe's web service over OData from PowerShell, the topology LethAL's runner uses.
# Every hang is bounded (T7_Hang ends itself after 45 s) so a negative result cannot wedge the
# container. Results are appended to results.log next to this script (the measured run is kept as results.measured.txt).

$ErrorActionPreference = 'Stop'
$base    = 'http://Cronus283:7048/BC/ODataV4'
$company = 'CRONUS Danmark A/S'
# Credentials come from the GITIGNORED fixtures/sandbox-data/lethal.config.local.json, never from
# a literal here: this repository is public.
$configPath = Join-Path $PSScriptRoot '..\..\fixtures\sandbox-data\lethal.config.local.json'
if (-not (Test-Path $configPath)) { throw "cannot read $configPath" }
$cfg  = (Get-Content $configPath -Raw | ConvertFrom-Json).bcdev
$user = $cfg.username; $pass = $cfg.password
if ([string]::IsNullOrEmpty($user) -or [string]::IsNullOrEmpty($pass)) { throw "$configPath : bcdev.username/password missing" }
$pair    = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${user}:${pass}"))
$headers = @{ Authorization = "Basic $pair"; 'Content-Type' = 'application/json' }
$q       = "?company=$([uri]::EscapeDataString($company))&tenant=default"
$log     = Join-Path $PSScriptRoot 'results.log'

function Log([string]$s) { $s | Tee-Object -FilePath $log -Append }
function Call([string]$action, [hashtable]$body, [int]$timeoutSec = 120) {
  $r = Invoke-RestMethod -Method Post -Uri "$base/R198ProbeApi_$action$q" -Headers $headers `
         -Body ($body | ConvertTo-Json -Compress) -TimeoutSec $timeoutSec
  return $r.value
}
function CallJson([string]$action, [hashtable]$body, [int]$timeoutSec = 120) {
  return (Call $action $body $timeoutSec) | ConvertFrom-Json
}
function Configure([string]$mode, [bool]$stop, [int]$runner) { Log ("configure: " + (Call 'Configure' @{ progressMode = $mode; stopOnFirstFailure = $stop; runnerId = $runner })) }
function Summ($r) {
  # per-method results: name=result (0 blank/not run, 1 failure, 2 success, 3 skipped)
  $parts = @()
  if ($r.results) { foreach ($t in $r.results.testResults) { $m = $t.method + '=' + $t.result; if ($t.message) { $m += ' "' + $t.message.Substring(0, [Math]::Min(110, $t.message.Length)) + '"' }; $parts += $m } }
  if ($r.perMethod) { foreach ($t in $r.perMethod) { if ($t.skipped) { $parts += ($t.method + '=skipped') } else { $res = $t.results.testResults[0]; $m = $t.method + '=' + $res.result + ' ' + $t.elapsedMs + 'ms'; if ($res.message) { $m += ' "' + $res.message.Substring(0, [Math]::Min(110, $res.message.Length)) + '"' }; $parts += $m } } }
  return ('elapsed=' + $r.elapsedMs + 'ms k1After=' + $r.k1VisibleAfterRun + ' | ' + ($parts -join ' ; ') + ' | trace=[' + $r.progress.trace + '] session=' + $r.progress.sessionId + '/' + $r.apiSession)
}
function StartAsync([string]$action, [hashtable]$body) {
  Start-Job -ScriptBlock {
    param($base, $q, $headers, $action, $body)
    $t0 = Get-Date
    try {
      $r = Invoke-RestMethod -Method Post -Uri "$base/R198ProbeApi_$action$q" -Headers $headers -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 300
      "OK after $([int]((Get-Date) - $t0).TotalMilliseconds) ms: " + $r.value.Substring(0, [Math]::Min(400, $r.value.Length))
    } catch {
      $code = ''; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
      "ERR $code after $([int]((Get-Date) - $t0).TotalMilliseconds) ms: " + $_.Exception.Message.Substring(0, [Math]::Min(300, $_.Exception.Message.Length))
    }
  } -ArgumentList $base, $q, $headers, $action, $body
}

Log "=== R198 probe run $(Get-Date -Format s) against $base"
$STOCK = 130450; $FN = 71542

Log "--- E0 clean: leftover probe rows (a non-zero count is a leak across CALLS)"
Log (Call 'CleanRows' @{})

Log "--- E1 CONTROL, stock runner 130450 (Codeunit isolation), T1 inserts K1 then T2 asserts absent, ONE suite run"
Configure 'none' $false $STOCK
Log (Summ (CallJson 'RunGroup' @{ methods = 'T1_InsertFixedKey,T2_AssertAbsent' }))

Log "--- E2 Function-isolation runner, no progress writes, same pair"
Configure 'none' $false $FN
Log (Summ (CallJson 'RunGroup' @{ methods = 'T1_InsertFixedKey,T2_AssertAbsent' }))

Log "--- E3 Function-isolation runner, progress Commit()ed in BOTH triggers, same pair (does the runner's Commit leak T1's row?)"
Configure 'both' $false $FN
Log (Summ (CallJson 'RunGroup' @{ methods = 'T1_InsertFixedKey,T2_AssertAbsent' }))

Log "--- E3b same, Commit only in OnBeforeTestRun"
Configure 'before' $false $FN
Log (Summ (CallJson 'RunGroup' @{ methods = 'T1_InsertFixedKey,T2_AssertAbsent' }))

Log "--- E4 cross-session read while the group sleeps in T3 (progress 'both')"
Configure 'both' $false $FN
$job = StartAsync 'RunGroup' @{ methods = 'T1_InsertFixedKey,T3_Sleep,T5_AfterFail' }
Start-Sleep -Seconds 3
Log ("reader sees: " + (Call 'ReadProgress' @{}))
$job | Wait-Job -Timeout 60 | Out-Null; Log ("group returned: " + (Receive-Job $job)); Remove-Job $job -Force

Log "--- E5 stop at first failure: T1,T2,T4_Fail,T5,T6 with stopOnFirstFailure (T5/T6 must not run; trace shows whether OnAfterTestRun fires for a skipped method)"
Configure 'both' $true $FN
Log (Summ (CallJson 'RunGroup' @{ methods = 'T1_InsertFixedKey,T2_AssertAbsent,T4_Fail,T5_AfterFail,T6_ReadProgress' }))

Log "--- E6 what a test method itself sees of the progress row (T6 always 'fails' to carry the data)"
Configure 'both' $false $FN
Log (Summ (CallJson 'RunGroup' @{ methods = 'T1_InsertFixedKey,T6_ReadProgress' }))

Log "--- E7 LOOP mode (one call, today's one-method suite run repeated, stock runner): isolation and per-method cost"
Configure 'both' $false 0
Log (Summ (CallJson 'RunLoop' @{ methods = 'T1_InsertFixedKey,T2_AssertAbsent,T5_AfterFail,T5_AfterFail,T5_AfterFail,T5_AfterFail,T5_AfterFail,T5_AfterFail' }))
Log "--- E7b GROUP mode, same eight methods requested (platform runs each declared method once; the request's repeats collapse)"
Configure 'both' $false $FN
Log (Summ (CallJson 'RunGroup' @{ methods = 'T1_InsertFixedKey,T2_AssertAbsent,T5_AfterFail' }))
Log "--- E7c TODAY's shape: eight separate calls of one method each (loop mode with one method), wall-clock from the client"
Configure 'none' $false 0
$t0 = Get-Date
for ($i = 0; $i -lt 8; $i++) { $null = Call 'RunLoop' @{ methods = 'T5_AfterFail' } }
Log ("eight one-method calls: " + [int]((Get-Date) - $t0).TotalMilliseconds + " ms total from the client")
Log "--- E7d loop mode with stop at first failure: T1,T4_Fail,T5 (T5 must be skipped)"
Configure 'both' $true 0
Log (Summ (CallJson 'RunLoop' @{ methods = 'T1_InsertFixedKey,T4_Fail,T5_AfterFail' }))

Log "--- E8 STOP inside a group: T1,T7_Hang(45 s bound),T5; a stop for T1 must be refused, a stop for T7 must end the session and the held call must get a 408 well before 45 s"
Configure 'both' $false $FN
$job = StartAsync 'RunGroup' @{ methods = 'T1_InsertFixedKey,T7_Hang,T5_AfterFail' }
Start-Sleep -Seconds 4
Log ("progress before stop: " + (Call 'ReadProgress' @{}))
Log ("stop for T1: " + (Call 'StopIfAt' @{ methodName = 'T1_InsertFixedKey' }))
Log ("stop for T7: " + (Call 'StopIfAt' @{ methodName = 'T7_Hang' }))
$job | Wait-Job -Timeout 90 | Out-Null; Log ("held call returned: " + (Receive-Job $job)); Remove-Job $job -Force
Log ("progress after stop: " + (Call 'ReadProgress' @{}))

Log "--- E8b same in LOOP mode"
Configure 'both' $false 0
$job = StartAsync 'RunLoop' @{ methods = 'T1_InsertFixedKey,T7_Hang,T5_AfterFail' }
Start-Sleep -Seconds 4
Log ("progress before stop: " + (Call 'ReadProgress' @{}))
Log ("stop for T7: " + (Call 'StopIfAt' @{ methodName = 'T7_Hang' }))
$job | Wait-Job -Timeout 90 | Out-Null; Log ("held call returned: " + (Receive-Job $job)); Remove-Job $job -Force
Log ("progress after stop: " + (Call 'ReadProgress' @{}))

Log "--- E9 clean: rows left behind by everything above (must be 0)"
Log (Call 'CleanRows' @{})
Log "=== done $(Get-Date -Format s)"
