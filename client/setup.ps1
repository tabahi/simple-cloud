# simple-cloud Windows client installer
# Usage:
#   irm https://raw.githubusercontent.com/tabahi/simple-cloud/refs/heads/main/client/setup.ps1 | iex

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # faster Invoke-WebRequest on PS5

$installDir  = Join-Path $env:LOCALAPPDATA 'simple-cloud-client'
$zipUrl      = 'https://github.com/tabahi/simple-cloud/archive/refs/heads/main.zip'
$tempZip     = Join-Path $env:TEMP 'simple-cloud-main.zip'
$tempExtract = Join-Path $env:TEMP 'simple-cloud-extract'

function Show-Box($msg, $title, $icon) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($msg, $title, 0, $icon) | Out-Null
}

# Show a VB InputBox. Returns the entered string, or empty string if cancelled.
function Show-InputBox($prompt, $title, $default) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    return [Microsoft.VisualBasic.Interaction]::InputBox($prompt, $title, $default)
}

# Prompt for a required field. Re-prompts once with an error message if left blank.
# Returns the trimmed value, or empty string if the user cancels both attempts.
function Prompt-Required($prompt, $title, $default) {
    $val = (Show-InputBox $prompt $title $default).Trim()
    if ($val) { return $val }
    return (Show-InputBox "This field is required.`n`n$prompt" $title $default).Trim()
}

# Node.js check
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Show-Box (
        'Node.js is not installed.' + [char]10 + [char]10 +
        'The browser will open the download page. Install Node.js 20 LTS,' + [char]10 +
        'then re-run this command.'
    ) 'simple-cloud Setup' 48
    Start-Process 'https://nodejs.org/en/download'
    exit 1
}

$prevLocation = Get-Location

try {
    Write-Host 'Downloading simple-cloud...' -ForegroundColor Cyan
    Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip -UseBasicParsing

    Write-Host 'Extracting...' -ForegroundColor Cyan
    if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
    Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force

    Write-Host "Installing to $installDir..." -ForegroundColor Cyan
    if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force }
    Move-Item "$tempExtract\simple-cloud-main\client" $installDir

    Write-Host 'Installing dependencies...' -ForegroundColor Cyan
    Set-Location $installDir
    & npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Check your internet connection and try again.' }

    # ── Configure .env ────────────────────────────────────────────────────────
    $configDir         = Join-Path $env:APPDATA 'simplecloud'
    $envFile           = Join-Path $configDir '.env'
    $defaultSyncFolder = 'C:\simplecloudData'

    if (Test-Path $envFile) {
        Write-Host "Existing configuration found at $envFile" -ForegroundColor Green
    } else {
        Add-Type -AssemblyName PresentationFramework
        $welcome = [System.Windows.MessageBox]::Show(
            'simple-cloud needs a few settings before it can start.' + [char]10 + [char]10 +
            'Click OK to configure it now, or Cancel to edit the config file manually later.',
            'simple-cloud Setup', 1, 64)

        if ($welcome -eq 'OK') {
            $serverUrl = Prompt-Required `
                'Enter the server URL shown by setup.sh (e.g. https://yourserver:11277):' `
                'simple-cloud — Server URL' 'https://'

            $token = Prompt-Required `
                ("Enter the signing key from the server." + [char]10 + [char]10 +
                 "On the server, run:  cat /opt/scserver/config/token.txt") `
                'simple-cloud — Signing Key' ''

            $syncFolder = Prompt-Required `
                'Local folder to keep in sync:' `
                'simple-cloud — Sync Folder' $defaultSyncFolder

            if ($serverUrl -and $token -and $syncFolder) {
                New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$envContent = @"
# simple-cloud client configuration
SC_SERVER_URL=$serverUrl
SC_TOKEN=$token
SC_SYNC_FOLDER=$syncFolder
SC_SYNC_INTERVAL_SECONDS=300
SC_LOG_LEVEL=info
SC_IGNORE_SSL_ERRORS=false
SC_LARGE_FILE_LAZY_SYNC_MB=100
SC_LARGE_FILE_IGNORE_MB=500
"@
                Set-Content -Path $envFile -Value $envContent -Encoding utf8
                Write-Host "Configuration saved to $envFile" -ForegroundColor Green

                if (-not (Test-Path $syncFolder)) {
                    New-Item -ItemType Directory -Path $syncFolder -Force | Out-Null
                    Write-Host "Created sync folder: $syncFolder" -ForegroundColor Green
                }
            } else {
                Write-Host "Configuration incomplete — edit manually before running: $envFile" -ForegroundColor Yellow
            }
        } else {
            New-Item -ItemType Directory -Path $configDir -Force | Out-Null
            Write-Host "Configuration skipped — edit before running: $envFile" -ForegroundColor Yellow
        }
    }
    # ─────────────────────────────────────────────────────────────────────────

    Write-Host 'Registering auto-start and launching...' -ForegroundColor Cyan
    & node "$installDir\service\install.js"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to register auto-start.' }

    Write-Host ''
    Write-Host 'Done! simple-cloud is running.' -ForegroundColor Green
    Write-Host "Installed to: $installDir" -ForegroundColor Green
    Write-Host 'The tray icon should appear in the system tray (bottom-right corner, or the ^ overflow).' -ForegroundColor Green
}
catch {
    Write-Host "Setup failed: $_" -ForegroundColor Red
    Show-Box "Setup failed:`n`n$_" 'simple-cloud Setup' 16
    exit 1
}
finally {
    Set-Location $prevLocation
    Remove-Item $tempZip     -Force         -ErrorAction SilentlyContinue
    Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
}
