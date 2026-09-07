param(
  [string]$OutputDir = "$env:RUNNER_TEMP\codexpro-gui-probe",
  [string]$ElectronExe = $env:CODEXPRO_GUI_ELECTRON_EXE
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Find-Chrome {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path $_) }
  return $candidates | Select-Object -First 1
}

function Get-ElectronLikeProcessCount {
  $count = 0
  foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
    try {
      if (-not $process.Path) { continue }
      $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($process.Path)
      $text = "{0} {1}" -f $info.ProductName, $info.FileDescription
      if ($text -match '(?i)electron') { $count++ }
    } catch {
      continue
    }
  }
  return $count
}

$runnerSession = (Get-Process -Id $PID).SessionId
$explorerSameSession = @(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $runnerSession })
$interactiveDesktop = $explorerSameSession.Count -gt 0
$chrome = Find-Chrome
$electronBefore = Get-ElectronLikeProcessCount
$chromeBefore = @(Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$newChromeIds = @()
$newElectronIds = @()
$screenshotCreated = $false
$chromeLaunchOk = $false
$electronTargetConfigured = [bool]($ElectronExe -and (Test-Path $ElectronExe))
$electronLaunchOk = $false

try {
  if ($chrome) {
    $profileDir = Join-Path $OutputDir 'chrome-profile'
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    $docsPath = (Resolve-Path (Join-Path $PSScriptRoot '..\docs\index.html')).Path
    $page = ([Uri]$docsPath).AbsoluteUri
    Start-Process -FilePath $chrome -ArgumentList @(
      '--new-window',
      '--no-first-run',
      '--no-default-browser-check',
      "--user-data-dir=$profileDir",
      $page
    ) | Out-Null
    Start-Sleep -Seconds 5

    $chromeAfter = @(Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $newChromeIds = @($chromeAfter | Where-Object { $_ -notin $chromeBefore })
    $chromeLaunchOk = $newChromeIds.Count -gt 0
  }

  if ($electronTargetConfigured) {
    $electronName = [System.IO.Path]::GetFileNameWithoutExtension($ElectronExe)
    $electronBeforeIds = @(Get-Process -Name $electronName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    Start-Process -FilePath $ElectronExe | Out-Null
    Start-Sleep -Seconds 5
    $electronAfterIds = @(Get-Process -Name $electronName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $newElectronIds = @($electronAfterIds | Where-Object { $_ -notin $electronBeforeIds })
    $electronLaunchOk = $newElectronIds.Count -gt 0
  }

  if ($interactiveDesktop) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      $screenshotPath = Join-Path $OutputDir 'desktop.png'
      $bitmap.Save($screenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $graphics.Dispose()
      $bitmap.Dispose()
      $screenshotCreated = Test-Path $screenshotPath
    } catch {
      $screenshotCreated = $false
    }
  }

  $electronAfter = Get-ElectronLikeProcessCount
  $report = [ordered]@{
    runner_session = $runnerSession
    interactive_desktop = $interactiveDesktop
    chrome_found = [bool]$chrome
    chrome_launch_ok = $chromeLaunchOk
    chrome_test_processes = $newChromeIds.Count
    electron_target_configured = $electronTargetConfigured
    electron_launch_ok = $electronLaunchOk
    electron_like_processes_before = $electronBefore
    electron_like_processes_after = $electronAfter
    screenshot_created = $screenshotCreated
  }

  $report | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $OutputDir 'report.json')

  Write-Host "GUI_PROBE interactive_desktop=$interactiveDesktop"
  Write-Host "GUI_PROBE chrome_found=$([bool]$chrome) chrome_launch_ok=$chromeLaunchOk"
  Write-Host "GUI_PROBE electron_target_configured=$electronTargetConfigured electron_launch_ok=$electronLaunchOk"
  Write-Host "GUI_PROBE electron_like_processes=$electronAfter"
  Write-Host "GUI_PROBE screenshot_created=$screenshotCreated"

  if (-not $interactiveDesktop) {
    Write-Warning 'The runner is not in the logged-in desktop session. GUI automation cannot click visible windows until the runner runs interactively.'
  }
  if (-not $chrome) {
    Write-Warning 'Google Chrome was not found in the common install locations.'
  }
} finally {
  foreach ($id in $newChromeIds) {
    try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch {}
  }
  foreach ($id in $newElectronIds) {
    try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch {}
  }
  $profileDir = Join-Path $OutputDir 'chrome-profile'
  if (Test-Path $profileDir) {
    Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
  }
}
