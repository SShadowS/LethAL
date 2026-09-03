# E12: a Commit() inside a test body under the loop shape (stock runner, Codeunit isolation).
$ErrorActionPreference = 'Stop'
$base = 'http://Cronus283:7048/BC/ODataV4'; $company = 'CRONUS Danmark A/S'
$cfg = (Get-Content (Join-Path $PSScriptRoot '..\..\fixtures\sandbox-data\lethal.config.local.json') -Raw | ConvertFrom-Json).bcdev
$pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($cfg.username):$($cfg.password)"))
$headers = @{ Authorization = "Basic $pair"; 'Content-Type' = 'application/json' }
$q = "?company=$([uri]::EscapeDataString($company))&tenant=default"
$out = Join-Path $PSScriptRoot 'e12.measured.txt'
function Log([string]$s) { Write-Host $s; $s | Out-File $out -Append }
function Call([string]$a, [hashtable]$b) { (Invoke-RestMethod -Method Post -Uri "$base/R198ProbeApi_$a$q" -Headers $headers -Body ($b | ConvertTo-Json -Compress) -TimeoutSec 120).value }
Log "=== E12 $(Get-Date -Format s)"
Log ("clean before: " + (Call 'CleanRows' @{}))
$null = Call 'Configure' @{ progressMode = 'both'; stopOnFirstFailure = $false; runnerId = 0 }
$r = (Call 'RunLoop' @{ methods = 'T8_InsertAndCommit,T9_AssertK2Absent' }) | ConvertFrom-Json
Log ("same call, T8 then T9: " + (($r.perMethod | ForEach-Object { $_.method + '=' + $_.results.testResults[0].result + ($(if ($_.results.testResults[0].message) { ' "' + $_.results.testResults[0].message.Substring(0, [Math]::Min(90, $_.results.testResults[0].message.Length)) + '"' } else { '' })) }) -join ' ; ') + " | k2VisibleAfterRun=" + $r.k2VisibleAfterRun + " (k1VisibleAfterRun=" + $r.k1VisibleAfterRun + ", a key E12 never writes)")
$r2 = (Call 'RunLoop' @{ methods = 'T9_AssertK2Absent' }) | ConvertFrom-Json
Log ("next call (new session), T9 alone: " + $r2.perMethod[0].method + '=' + $r2.perMethod[0].results.testResults[0].result + ' ' + $r2.perMethod[0].results.testResults[0].message)
Log ("rows left (K2 committed?): " + (Call 'CleanRows' @{}))
