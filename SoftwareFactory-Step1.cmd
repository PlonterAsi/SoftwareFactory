@echo off
rem The SoftwareFactory step 1 home screen. It opens in your browser; closing this window closes it.
cd /d "%~dp0"
rem The watchdog runs beside it, in its own small window, and closes by itself.
start "SoftwareFactory watchdog" /min cmd /c "npm run step1 -- watchdog"
call npm run step1 -- home
pause
