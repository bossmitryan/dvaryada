@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
if exist node_modules\electron\dist\electron.exe goto run
echo First run: installing Electron and ffmpeg, this takes 2-5 minutes...
call npm install
if errorlevel 1 goto fail
:run
call npm start
goto end
:nonode
echo Node.js not found. Install the LTS version from https://nodejs.org and run this file again.
pause
goto end
:fail
echo.
echo npm install failed. Send the text above to Claude.
pause
:end
