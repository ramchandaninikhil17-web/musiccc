# MusicFlow — hidden launcher (PowerShell fallback)
#
# Used only when the native MusicFlow.exe could not be compiled. Mirrors the
# logic in MusicFlowLauncher.cs: find a live server, start one if needed, then
# open the app window with autoplay enabled.
#
# Launch this via:
#   powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File launch-musicflow.ps1

$ErrorActionPreference = 'SilentlyContinue'

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($AppDir)) { $AppDir = (Get-Location).Path }
Set-Location $AppDir

$FirstPort = 3000
$LastPort = 3010
$StartupTimeoutSec = 30

function Test-MusicFlowPort([int]$Port) {
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" `
            -TimeoutSec 1 -UseBasicParsing
        if ($res.StatusCode -eq 200 -and $res.Content -match 'musicflow') { return $true }
    } catch { }
    return $false
}

function Get-PortHint {
    try {
        $file = Join-Path $AppDir 'data\runtime.json'
        if (Test-Path $file) {
            $info = Get-Content $file -Raw | ConvertFrom-Json
            if ($info.port) { return [int]$info.port }
        }
    } catch { }
    return 0
}

function Find-RunningServer {
    $hint = Get-PortHint
    if ($hint -ne 0 -and (Test-MusicFlowPort $hint)) { return $hint }
    foreach ($p in $FirstPort..$LastPort) {
        if ($p -eq $hint) { continue }
        if (Test-MusicFlowPort $p) { return $p }
    }
    return 0
}

function Find-Browser {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

$port = Find-RunningServer

if ($port -eq 0) {
    if (-not (Test-Path (Join-Path $AppDir 'node_modules'))) {
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c npm install' `
            -WorkingDirectory $AppDir -WindowStyle Hidden -Wait
    }

    Start-Process -FilePath 'node' -ArgumentList 'server.js' `
        -WorkingDirectory $AppDir -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 100
        $port = Find-RunningServer
        if ($port -ne 0) { break }
    }
}

if ($port -eq 0) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "MusicFlow's server did not start within $StartupTimeoutSec seconds.`r`n`r`n" +
        "Check that Node.js is installed, then run start.bat in`r`n$AppDir`r`nto see the error.",
        'MusicFlow') | Out-Null
    exit 1
}

$url = "http://localhost:$port/?autoplay=1"
$browser = Find-Browser

if ($browser) {
    $profileDir = Join-Path $env:LOCALAPPDATA 'MusicFlowAppData'
    # --autoplay-policy is what lets the resumed track start without a click.
    $args = @(
        "--app=$url"
        "--user-data-dir=$profileDir"
        '--autoplay-policy=no-user-gesture-required'
        '--window-size=1280,820'
        '--no-first-run'
        '--no-default-browser-check'
        '--disable-features=Translate'
    )
    Start-Process -FilePath $browser -ArgumentList $args
} else {
    Start-Process $url
}
