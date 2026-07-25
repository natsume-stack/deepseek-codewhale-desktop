@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: ============================================================
::  CodeWhale Desktop ???
::  ??: dev / release / backend / frontend / build
:: ============================================================

title CodeWhale Desktop Launcher

cd /d "%~dp0"

:: ????
set "INFO=[92m"
set "WARN=[93m"
set "ERR=[91m"
set "TITLE=[96m"
set "DIM=[90m"
set "RESET=[0m"

:: ?????????: start.bat dev|release|backend|frontend|build|check|clean
:: ?????: ?????????????? pause
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
    echo %ERR%????: %~1%RESET%
    echo %DIM%??: start.bat [dev^|release^|backend^|frontend^|build^|check^|clean]%RESET%
    exit /b 1
)

:menu
cls
echo %TITLE%============================================================%RESET%
echo %TITLE%               CodeWhale Desktop Launcher                 %RESET%
echo %TITLE%============================================================%RESET%
echo.
echo  %DIM%DeepSeek ????? AI ?? Agent ? Tauri2 + Rust + React%RESET%
echo.
echo  %INFO%[1]%RESET% ???? (Tauri Dev)      %DIM%??????????%RESET%
echo  %INFO%[2]%RESET% Release ?? (??+??)  %DIM%release ???? + ?? + Tauri%RESET%
echo  %INFO%[3]%RESET% ??? (Rust)            %DIM%cargo run??? 127.0.0.1:8787%RESET%
echo  %INFO%[4]%RESET% ??? (Vite)            %DIM%???????http://localhost:5173%RESET%
echo  %INFO%[5]%RESET% ?? Release ???      %DIM%cargo build --release%RESET%
echo  %INFO%[6]%RESET% ????                 %DIM%Rust / Node / Tauri ??%RESET%
echo  %INFO%[7]%RESET% ??????             %DIM%cargo clean + rmdir dist%RESET%
echo.
echo  %WARN%[0]%RESET% ??
echo.
set /p choice="??? [0-7]: "

if "%choice%"=="1" goto tauri_dev
if "%choice%"=="2" goto release
if "%choice%"=="3" goto backend
if "%choice%"=="4" goto frontend
if "%choice%"=="5" goto build_only
if "%choice%"=="6" goto check_env
if "%choice%"=="7" goto clean
if "%choice%"=="0" exit /b 0
echo %ERR%????%RESET%
timeout /t 1 >nul
goto menu

:tauri_dev
cls
echo %TITLE%=== ???? (Tauri Dev) ===%RESET%
echo.
call :check_rust
if errorlevel 1 goto pause_back
call :check_node
if errorlevel 1 goto pause_back
echo %INFO%==> ?? frontend ??...%RESET%
cd /d "%~dp0frontend"
if not exist "node_modules" (
    echo %WARN%==> ???? node_modules??? npm install...%RESET%
    call npm install
    if errorlevel 1 (
        echo %ERR%npm install ??%RESET%
        goto pause_back
    )
)
echo %INFO%==> ?? Tauri ?????? sidecar ?? + ???? + ?? + ????...%RESET%
echo %DIM%????????????...%RESET%
echo.
call npm run tauri:dev
set rc=%errorlevel%
cd /d "%~dp0"
if %rc% neq 0 (
    echo %ERR%???? (exit %rc%)%RESET%
) else (
    echo %INFO%???%RESET%
)
goto pause_back

:release
cls
echo %TITLE%=== Release ?? ===%RESET%
echo.
call :check_rust
if errorlevel 1 goto pause_back
call :check_node
if errorlevel 1 goto pause_back
echo %INFO%==> 1/3 ???? release...%RESET%
cargo build --release
if errorlevel 1 (
    echo %ERR%??????%RESET%
    goto pause_back
)
echo %INFO%==> 2/3 ???? sidecar...%RESET%
cd /d "%~dp0frontend"
if not exist "node_modules" (
    call npm install
)
call npm run tauri:prep
if errorlevel 1 (
    echo %ERR%sidecar ????%RESET%
    cd /d "%~dp0"
    goto pause_back
)
echo %INFO%==> 3/3 ?? Tauri release...%RESET%
call npx tauri build
set rc=%errorlevel%
cd /d "%~dp0"
if %rc% neq 0 (
    echo %ERR%???? (exit %rc%)%RESET%
) else (
    echo %INFO%????????? frontend/src-tauri/target/release/bundle/%RESET%
)
goto pause_back

:backend
cls
echo %TITLE%=== ??? (Rust) ===%RESET%
echo.
call :check_rust
if errorlevel 1 goto pause_back
if not exist ".env" (
    if exist ".env.example" (
        echo %WARN%==> ???? .env???????????? API Key%RESET%
    )
)
set "RUST_LOG=info,codewhale_server=debug"
echo %INFO%==> cargo run (debug)...%RESET%
echo %DIM%?? http://127.0.0.1:8787%RESET%
echo %DIM%? Ctrl+C ??%RESET%
echo.
cargo run
set rc=%errorlevel%
if %rc% neq 0 (
    echo %ERR%???? (exit %rc%)%RESET%
) else (
    echo %INFO%???%RESET%
)
goto pause_back

:frontend
cls
echo %TITLE%=== ??? (Vite) ===%RESET%
echo.
call :check_node
if errorlevel 1 goto pause_back
echo %WARN%???????? (?? 3)%RESET%
echo.
cd /d "%~dp0frontend"
if not exist "node_modules" (
    echo %INFO%==> npm install...%RESET%
    call npm install
    if errorlevel 1 (
        echo %ERR%npm install ??%RESET%
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
    echo %ERR%???? (exit %rc%)%RESET%
) else (
    echo %INFO%???%RESET%
)
goto pause_back

:build_only
cls
echo %TITLE%=== ?? Release ??? ===%RESET%
echo.
call :check_rust
if errorlevel 1 goto pause_back
echo %INFO%==> cargo build --release...%RESET%
cargo build --release
if errorlevel 1 (
    echo %ERR%????%RESET%
) else (
    echo %INFO%????: target\release\codewhale-server.exe%RESET%
)
goto pause_back

:check_env
cls
echo %TITLE%=== ???? ===%RESET%
echo.
echo %DIM%--- Rust ---%RESET%
where cargo >nul 2>&1
if errorlevel 1 (
    echo %ERR%[X] cargo ???%RESET%
    echo %DIM%    ??: https://www.rust-lang.org/tools/install%RESET%
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
    echo %ERR%[X] node ???%RESET%
) else (
    for /f "tokens=*" %%v in ('node --version') do echo %INFO%[?] node %%v%RESET%
)
where npm >nul 2>&1
if errorlevel 1 (
    echo %ERR%[X] npm ???%RESET%
) else (
    for /f "tokens=*" %%v in ('npm --version') do echo %INFO%[?] npm %%v%RESET%
)
echo.
echo %DIM%--- Tauri CLI ---%RESET%
cd /d "%~dp0frontend"
if exist "node_modules\.bin\tauri.cmd" (
    echo %INFO%[?] Tauri CLI ??? (local)%RESET%
) else (
    echo %WARN%[!] Tauri CLI ?????????????%RESET%
)
cd /d "%~dp0"
echo.
echo %DIM%--- Windows SDK (Mica ??) ---%RESET%
if exist "%ProgramFiles(x86)%\Windows Kits\10\Include" (
    dir /b "%ProgramFiles(x86)%\Windows Kits\10\Include" 2>nul | findstr "10.0.26100" >nul
    if not errorlevel 1 (
        echo %INFO%[?] Windows 11 SDK 10.0.26100 ???%RESET%
    ) else (
        echo %WARN%[!] ???? 10.0.26100 SDK?Mica ??????%RESET%
    )
) else (
    echo %ERR%[X] Windows SDK ???%RESET%
)
echo.
goto pause_back

:clean
cls
echo %TITLE%=== ?????? ===%RESET%
echo.
set /p confirm="????? (cargo clean + rmdir dist) [y/N]: "
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
echo %INFO%????%RESET%
goto pause_back

:check_rust
where cargo >nul 2>&1
if errorlevel 1 (
    echo %ERR%[X] cargo ???????? Rust: https://www.rust-lang.org/tools/install%RESET%
    exit /b 1
)
exit /b 0

:check_node
where node >nul 2>&1
if errorlevel 1 (
    echo %ERR%[X] node ???????? Node.js 18+: https://nodejs.org/%RESET%
    exit /b 1
)
exit /b 0

:pause_back
if "%NON_INTERACTIVE%"=="1" exit /b 0
echo.
pause
goto menu
