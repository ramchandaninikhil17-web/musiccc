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
$Shortcut.Description = 'Start MusicFlow Music Player'
$Shortcut.IconLocation = 'shell32.dll,168'
$Shortcut.WindowStyle = 1
$Shortcut.Save()

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " [SUCCESS] MusicFlow Desktop shortcut created!" -ForegroundColor Green
Write-Host " Target: $TargetPath" -ForegroundColor Gray
Write-Host " Location: $ShortcutPath" -ForegroundColor Gray
Write-Host "=================================================" -ForegroundColor Cyan

