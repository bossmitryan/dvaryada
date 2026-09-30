@echo off
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe call npm install
echo Building DvaRyada.exe (portable + installer)...
call npm run build:win
if errorlevel 1 goto fail
echo.
echo Done. Files are in the dist folder.
explorer dist
pause
goto end
:fail
echo Build failed. Send the text above to Claude.
pause
:end
