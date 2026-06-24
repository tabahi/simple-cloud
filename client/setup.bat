@echo off
setlocal

:: Check Node.js is installed
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('Node.js is not installed. The browser will open the download page. Install it, then run setup.bat again.','simplecloud Setup',0,48)"
    start "" "https://nodejs.org/en/download"
    exit /b 1
)

:: Change to the client folder (where this .bat lives)
cd /d "%~dp0"

:: Install dependencies
call npm install
if %ERRORLEVEL% neq 0 (
    powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('npm install failed. Check your internet connection and try again.','simplecloud Setup',0,16)"
    pause
    exit /b 1
)

:: Write the startup entry and launch the app.
:: The app will show a setup wizard on first run if not yet configured.
node service\install.js
