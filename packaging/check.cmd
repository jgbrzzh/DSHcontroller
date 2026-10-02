@echo off
"%~dp0runtime\node\node.exe" --disable-warning=ExperimentalWarning "%~dp0scripts\verify-package.mjs" "%~dp0."
set "DSH_CHECK_RESULT=%ERRORLEVEL%"
if /i "%~1"=="--no-pause" exit /b %DSH_CHECK_RESULT%
pause
exit /b %DSH_CHECK_RESULT%
