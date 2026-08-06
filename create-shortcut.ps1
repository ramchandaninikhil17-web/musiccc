$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath 'MusicFlow.lnk'
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = 'C:\Users\ramch\Downloads\musiccc\MusicFlow.exe'
$Shortcut.WorkingDirectory = 'C:\Users\ramch\Downloads\musiccc'
$Shortcut.Description = 'Start MusicFlow Music Player (Lite App)'
$Shortcut.IconLocation = 'shell32.dll,168'
$Shortcut.WindowStyle = 1
$Shortcut.Save()
Write-Host 'Desktop shortcut to MusicFlow.exe created successfully!'
