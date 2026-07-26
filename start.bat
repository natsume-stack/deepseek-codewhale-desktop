@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: ============================================================
::  CodeWhale Desktop launcher
::  Commands: dev / release / backend / frontend / build
:: ============================================================

title CodeWhale Desktop Launcher

cd /d "%~dp0"

:: ANSI colors
for /f %%a in ('echo prompt $E^| cmd') do set "ESC=%%a"
set "INFO=%ESC%[92m"
set "WARN=%ESC%[93m"
set "ERR=%ESC%[91m"
set "TITLE=%ESC%[96m"
set "DIM=%ESC%[90m"
set "RESET=%ESC%[0m"

:: Non-interactive usage: start.bat dev|release|backend|frontend|build|check|clean
:: Interactive usage: shows the menu and pauses before returning.
set "NON_INTERACTIVE=0"
if not "%~1"=="" set "NON_INTERACTIVE=1"
if "%NON_INTERACTIVE%"=="1" (
    if /i "%~1"=="dev" goto tauri_dev
    if /i "%~1"=="release" goto release
    if /i "%~1"=="backend" goto backend
    if /i "%~1"=="frontend" goto frontend
    if /i "%~1"=="build" goto build_only
    if /i "%~1"=="check" goto check_env
    if /i "%~1"=="clean" goto clean
    echo %ERR%Unknown command: %~1%RESET%
    echo %DIM%Usage: start.bat [dev^|release^|backend^|frontend^|build^|check^|clean]%RESET%
    exit /b 1
)

:menu
cls
echo %TITLE%============================================================%RESET%
echo %TITLE%               CodeWhale Desktop Launcher                 %RESET%
echo %TITLE%============================================================%RESET%
echo.
echo  %DIM%DeepSeek native coding agent - Tauri 2 + Rust + React%RESET%
echo.
echo  %INFO%[1]%RESET% Start Tauri dev       %DIM%Desktop shell with hot reload%RESET%
echo  %INFO%[2]%RESET% Build release         %DIM%Rust release + sidecar + Tauri%RESET%
echo  %INFO%[3]%RESET% Start backend         %DIM%cargo run on 127.0.0.1:8787%RESET%
echo  %INFO%[4]%RESET% Start frontend        %DIM%Vite at http://localhost:5173%RESET%
echo  %INFO%[5]%RESET% Build server release  %DIM%cargo build --release%RESET%
echo  %INFO%[6]%RESET% Check environment     %DIM%Rust / Node / Tauri status%RESET%
echo  %INFO%[7]%RESET% Clean build output    %DIM%cargo clean + rmdir dist%RESET%
echo.
echo  %WARN%[0]%RESET% Exit
echo.
set /p choice="Select [0-7]: "

if "%choice%"=="1" goto tauri_dev
if "%choice%"=="2" goto release
if "%choice%"=="3" goto backend
if "%choice%"=="4" goto frontend
if "%choice%"=="5" goto build_only
if "%choice%"=="6" goto check_env
if "%choice%"=="7" goto clean
if "%choice%"=="0" exit /b 0
echo %ERR%Invalid selection%RESET%
timeout /t 1 >nul
goto menu

:tauri_dev
cls
echo %TITLE%=== Start Tauri dev ===%RESET%
echo.
call :check_rust
if errorlevel 1 goto pause_back
call :check_node
if errorlevel 1 goto pause_back
echo %INFO%==> Preparing frontend dependencies...%RESET%
cd /d "%~dp0frontend"
if not exist "node_modules" (
    echo %WARN%==> node_modules is missing; running npm install...%RESET%
    call npm install
    if errorlevel 1 (
        echo %ERR%npm install failed%RESET%
        goto pause_back
    )
)
echo %INFO%==> Starting Tauri dev (sidecar + frontend + desktop shell)...%RESET%
echo %DIM%Close the desktop window to stop the development session.%RESET%
echo.
call npm run tauri:dev
set rc=%errorlevel%
cd /d "%~dp0"
if %rc% neq 0 (
    echo %ERR%Tauri dev failed. Exit code: %rc%%RESET%
) else (
    echo %INFO%Tauri dev stopped%RESET%
)
goto pause_back

:release
cls
echo %TITLE%=== Build release ===%RESET%
echo.
call :check_rust
if errorlevel 1 goto pause_back
call :check_node
if errorlevel 1 goto pause_back
echo %INFO%==> 1/3 Building Rust release...%RESET%
cargo build --release
if errorlevel 1 (
    echo %ERR%Rust release build failed%RESET%
    goto pause_back
)
echo %INFO%==> 2/3 Preparing sidecar...%RESET%
cd /d "%~dp0frontend"
if not exist "node_modules" (
    call npm install
)
call npm run tauri:prep
if errorlevel 1 (
    echo %ERR%Sidecar preparation failed%RESET%
    cd /d "%~dp0"
    goto pause_back
)
echo %INFO%==> 3/3 Building Tauri release...%RESET%
call npx tauri build
set rc=%errorlevel%
cd /d "%~dp0"
if %rc% neq 0 (
    echo %ERR%Release build failed. Exit code: %rc%%RESET%
) else (
    echo %INFO%Release bundle: frontend/src-tauri/target/release/bundle/%RESET%
)
goto pause_back

:backend
cls
echo %TITLE%=== Start backend (Rust) ===%RESET%
echo.
call :check_rust
if errorlevel 1 goto pause_back
if not exist ".env" (
    if exist ".env.example" (
        echo %WARN%==> .env is missing. Configure the API key before sending chat requests.%RESET%
    )
)
set "RUST_LOG=info,codewhale_server=debug"
echo %INFO%==> cargo run (debug)...%RESET%
echo %DIM%Listening at http://127.0.0.1:8787%RESET%
echo %DIM%Press Ctrl+C to stop.%RESET%
echo.
cargo run
set rc=%errorlevel%
if %rc% neq 0 (
    echo %ERR%Backend stopped with error. Exit code: %rc%%RESET%
) else (
    echo %INFO%Backend stopped%RESET%
)
goto pause_back

:frontend
cls
echo %TITLE%=== Start frontend (Vite) ===%RESET%
echo.
call :check_node
if errorlevel 1 goto pause_back
echo %WARN%Start the backend first (menu item 3).%RESET%
echo.
cd /d "%~dp0frontend"
if not exist "node_modules" (
    echo %INFO%==> npm install...%RESET%
    call npm install
    if errorlevel 1 (
        echo %ERR%npm install failed%RESET%
        cd /d "%~dp0"
        goto pause_back
    )
)
echo %INFO%==> npm run dev...%RESET%
echo %DIM%http://localhost:5173%RESET%
echo.
call npm run dev
set rc=%errorlevel%
cd /d "%~dp0"
if %rc% neq 0 (
    echo %ERR%Frontend stopped with error. Exit code: %rc%%RESET%
) else (
    echo %INFO%Frontend stopped%RESET%
)
goto pause_back

:build_only
cls
echo %TITLE%=== Build server release ===%RESET%
echo.
call :check_rust
if errorlevel 1 goto pause_back
echo %INFO%==> cargo build --release...%RESET%
cargo build --release
if errorlevel 1 (
    echo %ERR%Release build failed%RESET%
) else (
    echo %INFO%Output: target\release\codewhale-server.exe%RESET%
)
goto pause_back

:check_env
cls
echo %TITLE%=== Environment check ===%RESET%
echo.
echo %DIM%--- Rust ---%RESET%
where cargo >nul 2>&1
if errorlevel 1 (
    echo %ERR%[X] cargo was not found%RESET%
    echo %DIM%    Install Rust: https://www.rust-lang.org/tools/install%RESET%
) else (
    for /f "tokens=*" %%v in ('cargo --version') do echo %INFO%[?] %%v%RESET%
)
where rustc >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=*" %%v in ('rustc --version') do echo %INFO%[?] %%v%RESET%
)
echo.
echo %DIM%--- Node ---%RESET%
where node >nul 2>&1
if errorlevel 1 (
    echo %ERR%[X] node was not found%RESET%
) else (
    for /f "tokens=*" %%v in ('node --version') do echo %INFO%[?] node %%v%RESET%
)
where npm >nul 2>&1
if errorlevel 1 (
    echo %ERR%[X] npm was not found%RESET%
) else (
    for /f "tokens=*" %%v in ('npm --version') do echo %INFO%[?] npm %%v%RESET%
)
echo.
echo %DIM%--- Tauri CLI ---%RESET%
cd /d "%~dp0frontend"
if exist "node_modules\.bin\tauri.cmd" (
    echo %INFO%[OK] Local Tauri CLI found%RESET%
) else (
    echo %WARN%[!] Tauri CLI not found; run npm install in frontend.%RESET%
)
cd /d "%~dp0"
echo.
echo %DIM%--- Windows SDK (Mica support) ---%RESET%
if exist "%ProgramFiles(x86)%\Windows Kits\10\Include" (
    dir /b "%ProgramFiles(x86)%\Windows Kits\10\Include" 2>nul | findstr "10.0.26100" >nul
    if not errorlevel 1 (
        echo %INFO%[OK] Windows 11 SDK 10.0.26100 found%RESET%
    ) else (
        echo %WARN%[!] SDK 10.0.26100 was not found; Mica may be unavailable.%RESET%
    )
) else (
    echo %ERR%[X] Windows SDK was not found%RESET%
)
echo.
goto pause_back

:clean
cls
echo %TITLE%=== Clean build output ===%RESET%
echo.
set /p confirm="Clean cargo output and frontend dist? [y/N]: "
if /i not "%confirm%"=="y" goto menu
echo %INFO%==> cargo clean...%RESET%
cargo clean
if exist "frontend\dist" (
    echo %INFO%==> rmdir frontend\dist...%RESET%
    rmdir /s /q "frontend\dist"
)
if exist "frontend\node_modules\.vite" (
    echo %INFO%==> rmdir frontend\node_modules\.vite...%RESET%
    rmdir /s /q "frontend\node_modules\.vite"
)
echo %INFO%Clean complete%RESET%
goto pause_back

:check_rust
where cargo >nul 2>&1
if errorlevel 1 (
    echo %ERR%[X] cargo was not found. Install Rust: https://www.rust-lang.org/tools/install%RESET%
    exit /b 1
)
exit /b 0

:check_node
where node >nul 2>&1
if errorlevel 1 (
    echo %ERR%[X] node was not found. Install Node.js 18+: https://nodejs.org/%RESET%
    exit /b 1
)
exit /b 0

:pause_back
if "%NON_INTERACTIVE%"=="1" exit /b 0
echo.
pause
goto menu
