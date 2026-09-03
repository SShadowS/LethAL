# How does the HELD request of a session ended by StopSession come back: the 408 that names the
# AL StopSession call (what R53 measured and itest:hang pins), or something else? Repeats the E8
# shape N times and tallies the status codes. Bounded: T7_Hang ends itself after 45 s.
param([int]$Rounds = 8)
$ErrorActionPreference = 'Stop'
$base    = 'http://Cronus283:7048/BC/ODataV4'
$company = 'CRONUS Danmark A/S'
$configPath = Join-Path $PSScriptRoot '..\..\fixtures\sandbox-data\lethal.config.local.json'
$cfg  = (Get-Content $configPath -Raw | ConvertFrom-Json).bcdev
$pair    = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($cfg.username):$($cfg.password)"))
$headers = @{ Authorization = "Basic $pair"; 'Content-Type' = 'application/json' }
$q       = "?company=$([uri]::EscapeDataString($company))&tenant=default"
function Call([string]$action, [hashtable]$body) {
  (Invoke-RestMethod -Method Post -Uri "$base/R198ProbeApi_$action$q" -Headers $headers -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 120).value
}
$tally = @{}
$out = Join-Path $PSScriptRoot 'stop-race.measured.txt'
"=== stop race $(Get-Date -Format s) against $base, $Rounds rounds, alternating group/loop" | Out-File $out -Append
for ($i = 1; $i -le $Rounds; $i++) {
  $mode = if ($i % 2 -eq 1) { 'group' } else { 'loop' }
  $runner = if ($mode -eq 'group') { 71542 } else { 0 }
  $null = Call 'Configure' @{ progressMode = 'both'; stopOnFirstFailure = $false; runnerId = $runner }
  $action = if ($mode -eq 'group') { 'RunGroup' } else { 'RunLoop' }
  $job = Start-Job -ScriptBlock {
    param($base, $q, $headers, $action)
    $t0 = Get-Date
    try {
      $r = Invoke-RestMethod -Method Post -Uri "$base/R198ProbeApi_$action$q" -Headers $headers -Body (@{ methods = 'T1_InsertFixedKey,T7_Hang,T5_AfterFail' } | ConvertTo-Json -Compress) -TimeoutSec 300
      "OK " + [int]((Get-Date) - $t0).TotalMilliseconds
    } catch {
      $code = ''; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
      "$code " + [int]((Get-Date) - $t0).TotalMilliseconds + " " + $_.Exception.Message.Substring(0, [Math]::Min(120, $_.Exception.Message.Length))
    }
  } -ArgumentList $base, $q, $headers, $action
  Start-Sleep -Seconds 3
  $stop = Call 'StopIfAt' @{ methodName = 'T7_Hang' }
  $job | Wait-Job -Timeout 90 | Out-Null; $held = Receive-Job $job; Remove-Job $job -Force
  $code = ($held -split ' ')[0]
  $tally[$code] = 1 + [int]$tally[$code]
  $line = ("round {0} {1,-5} stop: {2,-40} held: {3}" -f $i, $mode, $stop.Substring(0, [Math]::Min(40, $stop.Length)), $held)
  Write-Host $line; $line | Out-File $out -Append
  Start-Sleep -Seconds 2
}
$t = "tally: " + (($tally.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')
Write-Host $t; $t | Out-File $out -Append
