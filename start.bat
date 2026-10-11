@echo off
rem ===========================================================================
rem  Honkai: Star Rail - Character Info Viewer  /  one-click launcher
rem
rem  Double-click this file to start the app and open the browser.
rem  Close this window (or press Ctrl+C) to stop the app.
rem
rem  Optional environment variables (set them before running):
rem    DSH_HSR_PORT          default 8360
rem    DSH_HSR_HOST          default 127.0.0.1
rem    DSH_HSR_OPEN          set to 0 to skip opening the browser
rem    DSH_HSR_OPEN_TIMEOUT  seconds to wait for the server (default 60)
rem
rem  NOTE: this file is deliberately ASCII-only. cmd.exe reads .bat/.cmd files
rem  with the OEM codepage (GBK on zh-CN Windows), so UTF-8 without a BOM gets
rem  mis-parsed and breaks the script. For the same reason the name is .bat
rem  rather than .cmd: both are parsed the same way, and the project now ships
rem  exactly one launcher, so there is no second copy to keep in sync.
rem ===========================================================================

setlocal EnableExtensions

rem Set a title before anything can fail, so a missing Node.js is still obvious
rem in the taskbar; it is re-set with the version number further down.
title Honkai Star Rail - Character Info Viewer

rem Switch the console to UTF-8 so the server's Chinese output is readable.
rem This is safe for this script because the file itself is pure ASCII; a
rem launcher containing non-ASCII would be re-interpreted under the new codepage.
chcp 65001 >nul 2>nul

rem Work from this script's own folder so double-click and CLI both work.
cd /d "%~dp0"

set "PORT=%DSH_HSR_PORT%"
if not defined PORT set "PORT=8360"
set "HOST=%DSH_HSR_HOST%"
if not defined HOST set "HOST=127.0.0.1"

rem %1 lets `start.bat 0.0.0.0` or `start.bat 9000` override the environment.
set "ARG1=%~1"
if defined ARG1 (
  echo %ARG1%| findstr /r "^[0-9][0-9]*$" >nul
  if not errorlevel 1 (set "PORT=%ARG1%") else (set "HOST=%ARG1%")
)

rem A wildcard bind address is not a browsable one.
set "URLHOST=%HOST%"
if "%URLHOST%"=="0.0.0.0" set "URLHOST=127.0.0.1"
if "%URLHOST%"=="::" set "URLHOST=[::1]"
echo %URLHOST%| findstr /c:":" >nul
if not errorlevel 1 (
  if not "%URLHOST:~0,1%"=="[" set "URLHOST=[%URLHOST%]"
)
set "URL=http://%URLHOST%:%PORT%/"

rem Host the readiness probe dials: the URL host without brackets, or plain IPv4
rem loopback when the server was told to bind every interface.
set "PROBE_HOST=%URLHOST%"
if "%PROBE_HOST%"=="0.0.0.0" set "PROBE_HOST=127.0.0.1"
if "%PROBE_HOST:~0,1%"=="[" set "PROBE_HOST=%PROBE_HOST:~1,-1%"

rem ------------------------------------------------------------ sanity checks
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js was not found on PATH.
  echo   This app needs Node.js 18.17 or newer: https://nodejs.org/
  echo.
  echo   Version: unknown
  echo.
  pause
  exit /b 1
)

if not exist "bin\serve.mjs" (
  echo.
  echo   [ERROR] bin\serve.mjs is missing.
  echo   Keep this .bat next to the bin, src and public folders.
  echo.
  pause
  exit /b 1
)

if not exist "bin\open-when-ready.ps1" (
  echo.
  echo   [ERROR] bin\open-when-ready.ps1 is missing.
  echo   Keep this .bat next to the bin, src and public folders.
  echo.
  pause
  exit /b 1
)

rem ------------------------------------------------------------- version number
rem Ask the code for the version instead of writing one here: src/version.js keeps
rem the only copy (HANDOFF 4.4, "one number, one place"). A hard-coded string would
rem silently go stale on the next release and the window title would lie.
rem Read it AFTER the checks above and BEFORE the "port already in use" exit below,
rem so both paths - a fresh start and an already-running instance - show it.
rem Any failure (missing file, unreadable, import error) leaves VERSION undefined;
rem it must not take the launcher down, hence the unknown fallback with no error text.
rem `2^>nul` swallows node's own error output, and only the first line is kept.
set "VERSION="
for /f "delims=" %%V in ('node bin\version.mjs 2^>nul') do if not defined VERSION set "VERSION=%%V"
if not defined VERSION set "VERSION=unknown"

title Honkai Star Rail - Character Info Viewer   v%VERSION%

echo.
echo   Honkai: Star Rail - Character Info Viewer   v%VERSION%
echo.

rem ------------------------------------------------- reuse a running instance
call :portpid %PORT%
if defined PORT_PID (
  echo   Port %PORT% is already serving ^(PID %PORT_PID%^).
  echo   Opening the UI only; the existing window keeps running the server.
  if not "%DSH_HSR_OPEN%"=="0" start "" "%URL%"
  echo.
  echo   Press any key to close this launcher ...
  pause >nul
  endlocal
  exit /b 0
)

rem --------------------------------- open the browser once the port is listening
rem The waiter runs with `start /b` in THIS console rather than in a detached
rem hidden window: it prints its own status next to the server output, so a
rem failure to open the browser is visible here instead of being swallowed.
if not "%DSH_HSR_OPEN%"=="0" (
  set "DSH_HSR_URL=%URL%"
  set "DSH_HSR_HOSTV=%PROBE_HOST%"
  set "DSH_HSR_PORTV=%PORT%"
  echo   Will open %URL% in the browser as soon as the server answers ...
  start /b "" powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\bin\open-when-ready.ps1"
)

rem ------------------------------------------------------------------ run it
echo.
echo   Starting the server on http://%HOST%:%PORT%/ ...
echo   Close this window (or press Ctrl+C) to stop it.
echo.

rem Run node in THIS console: closing the window or pressing Ctrl+C reaches it
rem directly, and the server's own watchdog exits if this shell is killed hard.
node bin\serve.mjs --port %PORT% --host %HOST%

set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" (
  echo   [WARN] The server exited with code %EXITCODE%.
  echo   If it reported the port is in use, set DSH_HSR_PORT to another port.
  echo.
)
echo   Server stopped.
pause
endlocal
exit /b %EXITCODE%

rem ===========================================================================
rem  :portpid <port>   ->  sets PORT_PID to the PID listening on that port
rem
rem  Literal patterns anchored by what follows the port in `netstat -ano` output:
rem  a blank before the PID (IPv4 "127.0.0.1:8360") or "]" for IPv6
rem  ("[::1]:8360"). A plain substring match would also hit ESTABLISHED rows
rem  (whose PID is the client, not the server) and ports such as 83600.
rem  tasklist then confirms the PID still exists, so a stale netstat row cannot
rem  make the launcher believe a server is already running.
rem ===========================================================================
:portpid
set "PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano -p TCP ^| findstr /c:"LISTENING" ^| findstr /c:":%~1 " /c:":%~1]"') do (
  if not defined PORT_PID (
    tasklist /fi "PID eq %%P" 2>nul | findstr /c:"%%P" >nul
    if not errorlevel 1 set "PORT_PID=%%P"
  )
)
exit /b 0
