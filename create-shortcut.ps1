# MusicFlow — Desktop shortcut installer
#
# 1. Compiles MusicFlowLauncher.cs into a native MusicFlow.exe (zero console
#    flash, launches in ~50ms) using the C# compiler that ships with the
#    .NET Framework. Falls back to a hidden PowerShell launcher if absent.
# 2. Creates "MusicFlow" on the Desktop, with the app's own icon.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrEmpty($ScriptDir)) { $ScriptDir = (Get-Location).Path }

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Gray }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "  MusicFlow - Desktop Shortcut Installer" -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------- icon
$IconPath = Join-Path $ScriptDir 'public\icons\musicflow.ico'
$HaveIcon = Test-Path $IconPath
if (-not $HaveIcon) { Write-Warn "musicflow.ico missing - using a generic icon" }

# ---------------------------------------------------------------- compile
$SourcePath   = Join-Path $ScriptDir 'MusicFlowLauncher.cs'
$LauncherExe  = Join-Path $ScriptDir 'MusicFlow.exe'
$Compiled     = $false

$CscCandidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$Csc = $CscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($Csc -and (Test-Path $SourcePath)) {
    Write-Step "Compiling native launcher with $(Split-Path -Leaf $Csc)..."

    # The stale exe must go first: if csc fails we want to know, rather than
    # silently shipping a shortcut that points at an old build. The previous
    # MusicFlow.exe was compiled from source that requested /health instead of
    # /api/health, which made every launch wait out the full startup timeout.
    if (Test-Path $LauncherExe) { Remove-Item $LauncherExe -Force -ErrorAction SilentlyContinue }

    $cscArgs = @(
        '/nologo'
        '/target:winexe'
        '/optimize+'
        '/platform:anycpu'
        '/r:System.dll'
        '/r:System.Windows.Forms.dll'
        "/out:`"$LauncherExe`""
    )
    if ($HaveIcon) { $cscArgs += "/win32icon:`"$IconPath`"" }
    $cscArgs += "`"$SourcePath`""

    $log = & $Csc $cscArgs 2>&1
    if ((Test-Path $LauncherExe) -and $LASTEXITCODE -eq 0) {
        $Compiled = $true
        Write-Ok "MusicFlow.exe built ($([math]::Round((Get-Item $LauncherExe).Length / 1KB, 1)) KB)"
    } else {
        Write-Warn "Compile failed - falling back to the PowerShell launcher"
        $log | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
    }
} else {
    Write-Warn "C# compiler not found - using the PowerShell launcher"
}

# ---------------------------------------------------------------- target
$FallbackPs1 = Join-Path $ScriptDir 'launch-musicflow.ps1'

if ($Compiled) {
    $TargetPath = $LauncherExe
    $Arguments  = ''
} elseif (Test-Path $FallbackPs1) {
    # -WindowStyle Hidden keeps the console from flashing on screen.
    $TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $Arguments  = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$FallbackPs1`""
} else {
    $TargetPath = Join-Path $ScriptDir 'start.bat'
    $Arguments  = ''
}

if (-not (Test-Path $TargetPath)) { throw "Launch target not found: $TargetPath" }

# ---------------------------------------------------------------- shortcut
$DesktopPath  = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath 'MusicFlow.lnk'

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath       = $TargetPath
$Shortcut.Arguments        = $Arguments
$Shortcut.WorkingDirectory = $ScriptDir
$Shortcut.Description      = 'MusicFlow - open and resume playback'
$Shortcut.WindowStyle      = 7   # minimised: nothing to show but the app window
if ($HaveIcon) { $Shortcut.IconLocation = "$IconPath,0" }
elseif ($Compiled) { $Shortcut.IconLocation = "$LauncherExe,0" }
else { $Shortcut.IconLocation = 'shell32.dll,168' }
$Shortcut.Save()

Write-Ok "Desktop shortcut created"

# Also drop one in the Start Menu so it is searchable and pinnable.
try {
    $StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'MusicFlow.lnk'
    $sm = $WshShell.CreateShortcut($StartMenu)
    $sm.TargetPath       = $TargetPath
    $sm.Arguments        = $Arguments
    $sm.WorkingDirectory = $ScriptDir
    $sm.Description      = 'MusicFlow - open and resume playback'
    $sm.WindowStyle      = 7
    if ($HaveIcon) { $sm.IconLocation = "$IconPath,0" }
    $sm.Save()
    Write-Ok "Start Menu entry created (searchable, pinnable)"
} catch {
    Write-Warn "Could not create the Start Menu entry: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "-------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "  Launcher : $TargetPath" -ForegroundColor Gray
Write-Host "  Shortcut : $ShortcutPath" -ForegroundColor Gray
Write-Host ""
Write-Host "  Double-click MusicFlow on your Desktop." -ForegroundColor White
Write-Host "  It opens in its own window and resumes the track you" -ForegroundColor White
Write-Host "  were last playing, from the second you left off." -ForegroundColor White
Write-Host "-------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
