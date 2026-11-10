@echo off
setlocal

REM Khởi động p2 server trên 127.0.0.1:8788 với P2_DATA_DIR test directory.
REM Chạy lệnh này TRƯỚC khi chạy p2-tui.bat.
REM Server sẽ chạy nền; dùng Ctrl+C trong cửa sổ này để dừng.

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "P2_DATA_DIR=%~dp0.p2-test-data"
if not exist "%P2_DATA_DIR%" mkdir "%P2_DATA_DIR%"

echo Starting p2 server on 127.0.0.1:8788 with P2_DATA_DIR=%P2_DATA_DIR%
node --import ./src/source.ts src/hosts/server.ts
exit /b %ERRORLEVEL%
