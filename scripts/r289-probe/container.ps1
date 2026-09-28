# R289 probe P1: container-side collector beside the real itest:hang gate. See README.md here and
# docs/superpowers/specs/2026-09-27-r289-probe-precommitment.md section 3.
#
#   pwsh -File scripts/r289-probe/container.ps1 -Container Cronus284 `
#     -Config fixtures/sandbox-hang/lethal.config.cronus284.json -Out <file> `
#     [-Parts sql,service,sessions,stats] [-StopFile <path>] [-Seconds <n>]
#
# Every 5 s, one JSON line per part, each stamped with host epoch ms (sentAt before the call,
# endAt after). Inside one tick the parts run in the order SQL, service, docker stats, sessions,
# and lines are written as each arrives, so a hanging Get-NAVServerSession cannot hide that tick's
# SQL rows. It does stall later ticks; run the sessions part as a second instance
# (-Parts sessions, its own -Out) to keep the SQL loop independent of the NST.
# On exit, one dump of the container's Application event log for the run window.
param(
  [Parameter(Mandatory = $true)][string]$Container,
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$Out,
  [string[]]$Parts = @('sql', 'service', 'stats', 'sessions'),
  [string]$StopFile = '',
  [int]$Seconds = 0
)
$ErrorActionPreference = 'Stop'
$env:DOCKER_CONTEXT = 'desktop-windows'

# `pwsh -File ... -Parts sql,service,stats` passes ONE string, not an array, so split on commas here.
# Without this no part matched and the collector wrote only its header line.
$known = @('sql', 'service', 'stats', 'sessions')
$Parts = @($Parts | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$unknown = @($Parts | Where-Object { $_ -notin $known })
if ($Parts.Count -eq 0 -or $unknown.Count -gt 0) { throw "refusing: -Parts must be some of $($known -join ','), got '$($Parts -join ',')'" }

$cfg = Get-Content $Config -Raw | ConvertFrom-Json
$server = $cfg.bcdev.server
if ([string]::IsNullOrEmpty($server)) { throw "${Config}: bcdev.server is missing" }
$cfgHost = ([uri]$server).Host
if ($cfgHost -ine $Container) { throw "refusing: config $Config points at $cfgHost, not -Container $Container" }

function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Emit($obj) { Add-Content -LiteralPath $Out -Value ($obj | ConvertTo-Json -Compress -Depth 6) }

$sqlQuery = "select r.session_id, r.blocking_session_id, r.wait_type, r.wait_time, r.wait_resource, r.command, t.text from sys.dm_exec_requests r cross apply sys.dm_exec_sql_text(r.sql_handle) t where r.session_id <> @@SPID"

$start = Get-Date
$startMs = Now
Emit @{ start = $startMs; container = $Container; config = $Config; parts = $Parts }

function Done {
  if ($StopFile -ne '' -and (Test-Path -LiteralPath $StopFile)) { return $true }
  if ($Seconds -gt 0 -and ((Now) - $startMs) -ge ($Seconds * 1000)) { return $true }
  return $false
}

while (-not (Done)) {
  $tick = Now
  $inParts = @($Parts | Where-Object { $_ -in @('sql', 'service', 'sessions') })
  if ($inParts.Count -gt 0) {
    $sent = Now
    try {
      # Streams one object per part, in this order; each is stamped on arrival.
      Invoke-ScriptInBcContainer -containerName $Container -argumentList ($inParts -join ','), $sqlQuery -scriptblock {
        param($partList, $q)
        $parts = $partList -split ','
        if ($parts -contains 'sql') {
          try {
            $db = (Get-NAVServerConfiguration -ServerInstance BC -KeyName DatabaseName)
            $rows = @(Invoke-Sqlcmd -ServerInstance 'localhost\SQLEXPRESS' -Database $db -Query $q -ErrorAction Stop |
                ForEach-Object {
                  $text = [string]$_.text
                  [pscustomobject]@{
                    session_id = $_.session_id; blocking_session_id = $_.blocking_session_id
                    wait_type = [string]$_.wait_type; wait_time = $_.wait_time
                    wait_resource = [string]$_.wait_resource; command = [string]$_.command
                    text = $text.Substring(0, [Math]::Min(400, $text.Length))
                  }
                })
            [pscustomobject]@{ part = 'sql'; rows = $rows }
          } catch {
            [pscustomobject]@{ part = 'sql'; sql = 'failed'; error = "$_" }
          }
        }
        if ($parts -contains 'service') {
          [pscustomobject]@{ part = 'service'; status = [string](Get-Service 'MicrosoftDynamicsNavServer$BC').Status }
        }
        if ($parts -contains 'sessions') {
          try {
            $s = @(Get-NAVServerSession -ServerInstance BC | Select-Object SessionID, ClientType, LoginDatetime, UserID |
                ForEach-Object { [pscustomobject]@{ SessionID = $_.SessionID; ClientType = [string]$_.ClientType; LoginDatetime = [string]$_.LoginDatetime; UserID = [string]$_.UserID } })
            [pscustomobject]@{ part = 'sessions'; sessions = $s }
          } catch {
            [pscustomobject]@{ part = 'sessions'; error = "$_" }
          }
        }
      } | ForEach-Object {
        $h = @{ sentAt = $sent; endAt = (Now) }
        foreach ($p in $_.PSObject.Properties) {
          if ($p.Name -notin @('PSComputerName', 'RunspaceId', 'PSShowComputerName')) { $h[$p.Name] = $p.Value }
        }
        Emit $h
      }
    } catch {
      Emit @{ part = 'invoke'; sentAt = $sent; endAt = (Now); error = "$_" }
    }
  }
  if ($Parts -contains 'stats') {
    $sent = Now
    try {
      $j = docker stats --no-stream $Container --format '{{json .}}'
      Emit @{ part = 'stats'; sentAt = $sent; endAt = (Now); stats = ($j | ConvertFrom-Json) }
    } catch {
      Emit @{ part = 'stats'; sentAt = $sent; endAt = (Now); error = "$_" }
    }
  }
  $wait = $tick + 5000 - (Now)
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
}

# Event log dump. TimeCreated is the container's clock, reported as it is.
$sent = Now
try {
  $events = Invoke-ScriptInBcContainer -containerName $Container -argumentList $start -scriptblock {
    param($after)
    @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $after } -ErrorAction SilentlyContinue |
        Where-Object { $_.ProviderName -like '*Dynamics*' } |
        ForEach-Object { [pscustomobject]@{ TimeCreated = $_.TimeCreated.ToString('o'); Id = $_.Id; Level = [string]$_.LevelDisplayName; Message = ([string]$_.Message).Substring(0, [Math]::Min(2000, ([string]$_.Message).Length)) } })
  }
  Emit @{ part = 'eventlog'; sentAt = $sent; endAt = (Now); entries = @($events | ForEach-Object { @{ TimeCreated = $_.TimeCreated; Id = $_.Id; Level = $_.Level; Message = $_.Message } }) }
} catch {
  Emit @{ part = 'eventlog'; sentAt = $sent; endAt = (Now); error = "$_" }
}
Emit @{ stop = (Now) }
