# Third-review F2: a StopSession issued against a session that then FINISHES its request normally
# before the stop lands. Is the pending stop discarded, or delivered to whatever that pooled
# session serves next? Bounded: WaitForGo gives up after 20 s on its own.
param([int]$Rounds = 5)
$ErrorActionPreference = 'Stop'
$base    = 'http://Cronus283:7048/BC/ODataV4'
$company = 'CRONUS Danmark A/S'
$configPath = Join-Path $PSScriptRoot '..\..\fixtures\sandbox-data\lethal.config.local.json'
$cfg  = (Get-Content $configPath -Raw | ConvertFrom-Json).bcdev
$pair    = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($cfg.username):$($cfg.password)"))
$headers = @{ Authorization = "Basic $pair"; 'Content-Type' = 'application/json' }
$q       = "?company=$([uri]::EscapeDataString($company))&tenant=default"
$out = Join-Path $PSScriptRoot 'stop-after-finish.measured.txt'
function Log([string]$s) { Write-Host $s; $s | Out-File $out -Append }
function Call([string]$action, [hashtable]$body) {
  (Invoke-RestMethod -Method Post -Uri "$base/R198ProbeApi_$action$q" -Headers $headers -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 120).value
}
Log "=== stop-after-finish $(Get-Date -Format s) against $base, $Rounds rounds"
for ($i = 1; $i -le $Rounds; $i++) {
  $null = Call 'Configure' @{ progressMode = 'none'; stopOnFirstFailure = $false; runnerId = 0 }
  $job = Start-Job -ScriptBlock {
    param($base, $q, $headers)
    $t0 = Get-Date
    try {
      $r = Invoke-RestMethod -Method Post -Uri "$base/R198ProbeApi_WaitForGo$q" -Headers $headers -Body (@{ maxMs = 20000 } | ConvertTo-Json -Compress) -TimeoutSec 120
      "OK " + [int]((Get-Date) - $t0).TotalMilliseconds + " ms: " + $r.value
    } catch {
      $code = ''; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
      "ERR $code " + [int]((Get-Date) - $t0).TotalMilliseconds + " ms: " + $_.Exception.Message.Substring(0, [Math]::Min(140, $_.Exception.Message.Length))
    }
  } -ArgumentList $base, $q, $headers
  Start-Sleep -Milliseconds 1500
  $prog = (Call 'ReadProgress' @{}) | ConvertFrom-Json
  $stop = Call 'StopIfAt' @{ methodName = 'WAITGO' }
  $tStop = Get-Date
  $go = Call 'Go' @{}
  $pings = @()
  for ($p = 0; $p -lt 16; $p++) {
    try { $pings += (Call 'Ping' @{}) } catch { $code = ''; try { $code = [int]$_.Exception.Response.StatusCode } catch {}; $pings += "ERR $code" }
    Start-Sleep -Milliseconds 500
  }
  $job | Wait-Job -Timeout 60 | Out-Null; $held = Receive-Job $job; Remove-Job $job -Force
  $sids = ($pings | ForEach-Object { if ($_ -match 'session (\d+)') { $matches[1] } else { $_ } }) -join ','
  Log ("round $i waiter=session $($prog.sessionId) | $stop | held: $held | pings over 8 s after the stop: $sids")
  Start-Sleep -Seconds 3
}
Log "=== done $(Get-Date -Format s)"
