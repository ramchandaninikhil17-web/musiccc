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
$Shortcut.Description = 'MusicFlow v2.5 — Apple Orb, PiP Mini-Player, Pomodoro Focus, Ambient Sounds & Cloud Deploy'
$Shortcut.IconLocation = 'shell32.dll,168'
$Shortcut.WindowStyle = 1
$Shortcut.Save()

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " [SUCCESS] MusicFlow v2.5 Desktop shortcut created!" -ForegroundColor Green
Write-Host "" -ForegroundColor White
Write-Host " What's New in v2.5:" -ForegroundColor Yellow
Write-Host "   * Apple Transparent Floating Orb & Dynamic Island" -ForegroundColor White
Write-Host "   * Always-On-Top PiP Mini-Player for Multitasking" -ForegroundColor White
Write-Host "   * Pomodoro Focus Flow & Ambient Sound Generator" -ForegroundColor White
Write-Host "   * MediaSession Desktop & Lockscreen Controls" -ForegroundColor White
Write-Host "   * Global Keyboard Shortcuts (Space, P, F, N, M, D)" -ForegroundColor White
Write-Host "   * 1-Click Cloud Deployment (Render / Railway / Docker)" -ForegroundColor White
Write-Host "" -ForegroundColor White
Write-Host " Target: $TargetPath" -ForegroundColor Gray
Write-Host " Location: $ShortcutPath" -ForegroundColor Gray
Write-Host "=================================================" -ForegroundColor Cyan
