@echo off
rem The SoftwareFactory step 1 home screen. It opens in your browser; closing this window closes it.
cd /d "%~dp0"
call npm run step1 -- home
pause
