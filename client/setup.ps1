# simplecloud Windows client installer
# Usage:
#   irm https://raw.githubusercontent.com/tabahi/simple-cloud/refs/heads/main/client/setup.ps1 | iex

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # faster Invoke-WebRequest on PS5

$installDir  = Join-Path $env:LOCALAPPDATA 'simplecloud-client'
$zipUrl      = 'https://github.com/tabahi/simple-cloud/archive/refs/heads/main.zip'
$tempZip     = Join-Path $env:TEMP 'simplecloud-main.zip'
$tempExtract = Join-Path $env:TEMP 'simplecloud-extract'

function Show-Box($msg, $title, $icon) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($msg, $title, 0, $icon) | Out-Null
}

# Node.js check
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Show-Box (
        'Node.js is not installed.' + [char]10 + [char]10 +
        'The browser will open the download page. Install Node.js 20 LTS,' + [char]10 +
        'then re-run this command.'
    ) 'simplecloud Setup' 48
    Start-Process 'https://nodejs.org/en/download'
    exit 1
}

$prevLocation = Get-Location

try {
    Write-Host 'Downloading simplecloud...' -ForegroundColor Cyan
    Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip -UseBasicParsing

    Write-Host 'Extracting...' -ForegroundColor Cyan
    if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
    Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force

    Write-Host "Installing to $installDir..." -ForegroundColor Cyan
    if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force }
    Move-Item "$tempExtract\simplecloud-main\client" $installDir

    Write-Host 'Installing dependencies...' -ForegroundColor Cyan
    Set-Location $installDir
    & npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Check your internet connection and try again.' }

    Write-Host 'Registering auto-start and launching...' -ForegroundColor Cyan
    & node "$installDir\service\install.js"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to register auto-start.' }

    Write-Host ''
    Write-Host 'Done! simplecloud is running.' -ForegroundColor Green
    Write-Host "Installed to: $installDir" -ForegroundColor Green
    Write-Host 'The tray icon should appear in the system tray (bottom-right corner, or the ^ overflow).' -ForegroundColor Green
}
catch {
    Write-Host "Setup failed: $_" -ForegroundColor Red
    Show-Box "Setup failed:`n`n$_" 'simplecloud Setup' 16
    exit 1
}
finally {
    Set-Location $prevLocation
    Remove-Item $tempZip     -Force         -ErrorAction SilentlyContinue
    Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
}
