[CmdletBinding(SupportsShouldProcess)]
param(
  [ValidateNotNullOrEmpty()]
  [string]$TaskName = "CodexPro",

  [ValidateRange(1, 60)]
  [int]$IntervalMinutes = 1,

  [ValidateRange(5, 300)]
  [int]$InitialDelaySeconds = 15,

  [switch]$StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "windows:recover is only available on Windows."
}

Import-Module ScheduledTasks -ErrorAction Stop

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$recoveryTriggerId = "CodexProRecovery"
$preservedTriggers = @($task.Triggers | Where-Object { $_.Id -ne $recoveryTriggerId })
$recoveryTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddSeconds($InitialDelaySeconds) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$recoveryTrigger.Id = $recoveryTriggerId
$updatedTriggers = @($preservedTriggers) + @($recoveryTrigger)

if ($PSCmdlet.ShouldProcess($TaskName, "Install a repeating recovery trigger every $IntervalMinutes minute(s)")) {
  Set-ScheduledTask -TaskName $TaskName -Trigger $updatedTriggers -ErrorAction Stop | Out-Null
}

$updatedTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$installedTrigger = @($updatedTask.Triggers | Where-Object { $_.Id -eq $recoveryTriggerId })
if ($installedTrigger.Count -ne 1) {
  throw "Recovery trigger verification failed for scheduled task '$TaskName'."
}

$expectedInterval = "PT${IntervalMinutes}M"
if ($installedTrigger[0].Repetition.Interval -ne $expectedInterval) {
  throw "Recovery trigger interval mismatch: expected $expectedInterval, got $($installedTrigger[0].Repetition.Interval)."
}

if ($updatedTask.Settings.MultipleInstances -ne "IgnoreNew") {
  throw "Scheduled task '$TaskName' must use MultipleInstances=IgnoreNew before enabling the repeating recovery trigger."
}

if ($StartNow -and $updatedTask.State -ne "Running") {
  if ($PSCmdlet.ShouldProcess($TaskName, "Start scheduled task")) {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  }
}

$finalTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
[pscustomobject]@{
  TaskName = $TaskName
  State = $finalTask.State
  RecoveryTrigger = $recoveryTriggerId
  RecoveryInterval = $installedTrigger[0].Repetition.Interval
  PreservedTriggers = $preservedTriggers.Count
  MultipleInstances = $finalTask.Settings.MultipleInstances
}
