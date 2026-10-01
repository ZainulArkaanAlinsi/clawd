@echo off
rem Control the installed Clawd desktop pet from cmd or PowerShell.
rem   clawd [show]          start Clawd or bring it back
rem   clawd hide            hide Clawd (keeps running in the tray)
rem   clawd quit            close Clawd completely
rem   clawd status          print what Clawd is doing (JSON)
rem   clawd startup on|off  enable/disable start with Windows
setlocal
set "EXE=%LOCALAPPDATA%\Programs\clawd-desktop\ClaudePet.exe"
if not exist "%EXE%" (
  echo Clawd belum terpasang: "%EXE%"
  exit /b 1
)

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=show"
if /i "%ACTION%"=="start" set "ACTION=show"

if /i "%ACTION%"=="show" goto run
if /i "%ACTION%"=="hide" goto run
if /i "%ACTION%"=="quit" goto run
if /i "%ACTION%"=="status" goto status
if /i "%ACTION%"=="startup" goto startup
goto usage

:run
start "" "%EXE%" --%ACTION%
exit /b 0

:startup
if /i "%~2"=="on" (
  start "" "%EXE%" --startup-on
  exit /b 0
)
if /i "%~2"=="off" (
  start "" "%EXE%" --startup-off
  exit /b 0
)
goto usage

:status
curl -s -m 2 http://127.0.0.1:47321/status
if errorlevel 1 (
  echo Clawd tidak berjalan.
  exit /b 1
)
echo.
exit /b 0

:usage
echo Pakai: clawd [show^|hide^|quit^|status^|startup on^|startup off]
exit /b 1
