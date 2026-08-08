# R53 measurement driver.
#
# Reproduces the topology the roadmap entry is about: a WEB-SERVICE session busy in an AL loop
# (what a non-terminating mutant makes of RunMutant), and a second web-service session trying to
# end it from AL. Everything here is bounded so a negative result cannot wedge the container.

$ErrorActionPreference = 'Stop'
$base    = 'http://Cronus281:7048/BC/ODataV4'
$company = 'CRONUS Danmark A/S'
# Credentials come from the GITIGNORED fixtures/sandbox-app/lethal.config.local.json, never from a
# literal here — this repository is public. Same pattern as scripts/r83-probe/ and
# scripts/r72-probe/. The endpoint and company stay literal: they are the topology this probe is
# ABOUT, and neither is a credential.
$configPath = Join-Path $PSScriptRoot '..\..\fixtures\sandbox-app\lethal.config.local.json'
if (-not (Test-Path $configPath)) {
  throw "cannot read $configPath - see fixtures/README.md for the expected local-file setup"
}
$cfg     = (Get-Content $configPath -Raw | ConvertFrom-Json).bcdev
$user    = $cfg.username
$pass    = $cfg.password
if ([string]::IsNullOrEmpty($user) -or [string]::IsNullOrEmpty($pass)) {
  throw "$configPath : bcdev.username and bcdev.password must both be set"
}
$pair    = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${user}:${pass}"))
$headers = @{ Authorization = "Basic $pair"; 'Content-Type' = 'application/json' }
$q       = "?company=$([uri]::EscapeDataString($company))&tenant=default"

function Call([string]$action, [hashtable]$body, [int]$timeoutSec) {
  Invoke-RestMethod -Method Post -Uri "$base/$action$q" -Headers $headers `
    -Body ($body | ConvertTo-Json -Compress) -TimeoutSec $timeoutSec
}

# 1. Fire the hang asynchronously. 60s bound: long enough that the stop must be what ends it,
#    short enough that a failed stop self-clears.
$job = Start-Job -ScriptBlock {
  param($base, $q, $headers)
  $t0 = Get-Date
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$base/R53ProbeApi_HangFor$q" -Headers $headers `
           -Body (@{ ms = 60000 } | ConvertTo-Json -Compress) -TimeoutSec 300
    [pscustomobject]@{ outcome = 'returned'; value = $r.value; elapsedMs = ((Get-Date) - $t0).TotalMilliseconds }
  } catch {
    [pscustomobject]@{ outcome = 'threw'; value = $_.Exception.Message; elapsedMs = ((Get-Date) - $t0).TotalMilliseconds }
  }
} -ArgumentList $base, $q, $headers

# 2. Wait until the hung session has recorded its own id.
$hungId = 0
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and $hungId -eq 0) {
  Start-Sleep -Milliseconds 500
  try {
    $log = (Call 'R53ProbeApi_ReadLog' @{} 30).value
    if ($log -match 'rows:1=hanging@(\d+)') { $hungId = [int]$Matches[1] }
  } catch { }
}
Write-Host "HUNG SESSION ID: $hungId"
if ($hungId -eq 0) { Write-Host 'ABORT: never saw the hung session register'; Receive-Job $job -Wait | Out-String | Write-Host; exit 1 }

# 3. The measurement: stop it from AL, in another web-service session.
$stopT0 = Get-Date
$stop = (Call 'R53ProbeApi_StopOther' @{ targetSessionId = $hungId } 60).value
Write-Host "STOP RESULT: $stop"

# 4. Did the busy session actually END, and how fast?
$goneMs = -1
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $log = (Call 'R53ProbeApi_ReadLog' @{} 30).value
  if ($log -match 'hungSessionAlive:False') { $goneMs = ((Get-Date) - $stopT0).TotalMilliseconds; break }
}
Write-Host "GONE AFTER MS: $goneMs"

# 5. What the CLIENT of the hung call saw — the thing LethAL's transport would have to classify.
$res = Receive-Job $job -Wait
Remove-Job $job -Force
Write-Host "HUNG CALLER: outcome=$($res.outcome) elapsedMs=$([int]$res.elapsedMs) value=$($res.value)"

# 6. Final state: did the loop ever complete? 'finished-unstopped' present means the stop did NOT
#    end it and it simply ran out its own clock.
$final = (Call 'R53ProbeApi_ReadLog' @{} 30).value
Write-Host "FINAL LOG: $final"
