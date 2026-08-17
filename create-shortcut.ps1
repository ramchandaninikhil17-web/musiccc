[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($ScriptDir)) {
    $ScriptDir = (Get-Location).Path
}

$DesktopPath = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath 'MusicFlow.lnk'

$TargetPath = Join-Path $ScriptDir 'MusicFlow.exe'
if (-not (Test-Path $TargetPath)) {
    $TargetPath = Join-Path $ScriptDir 'start.bat'
}

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetPath
$Shortcut.WorkingDirectory = $ScriptDir
$Shortcut.Description = 'MusicFlow v3.0 — Premium Desktop Music Engine'
$Shortcut.IconLocation = 'shell32.dll,168'
$Shortcut.WindowStyle = 1
$Shortcut.Save()

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " [SUCCESS] MusicFlow v3.0 Desktop shortcut created!" -ForegroundColor Green
Write-Host "" -ForegroundColor White
Write-Host " What's New in v3.0:" -ForegroundColor Yellow
Write-Host "   * AI Mood & Vibe Questionnaire DJ Engine" -ForegroundColor White
Write-Host "   * Instant Zero-Lag Launch & Startup" -ForegroundColor White
Write-Host "   * Apple Transparent Floating Orb & Dynamic Island" -ForegroundColor White
Write-Host "   * Always-On-Top PiP Mini-Player for Multitasking" -ForegroundColor White
Write-Host "   * Pomodoro Focus Flow & Ambient Sound Generator" -ForegroundColor White
Write-Host "   * 10-Band Equalizer & Bass Boost DSP" -ForegroundColor White
Write-Host "   * Global Keyboard Shortcuts (Space, P, F, N, M, D)" -ForegroundColor White
Write-Host "" -ForegroundColor White
Write-Host " Target: $TargetPath" -ForegroundColor Gray
Write-Host " Location: $ShortcutPath" -ForegroundColor Gray
Write-Host "=================================================" -ForegroundColor Cyan
