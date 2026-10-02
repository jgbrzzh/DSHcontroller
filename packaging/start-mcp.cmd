@echo off
"%~dp0runtime\node\node.exe" --disable-warning=ExperimentalWarning "%~dp0dist\entrypoints\mcp.js" %*
