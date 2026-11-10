@echo off
setlocal

REM Tạo owner link one-time để p2-tui.bat có thể đăng nhập làm owner.
REM Yêu cầu p2 server đang chạy (chạy p2-server.bat trước).
REM Output: một URL dạng http://127.0.0.1:8788/owner#<token> — dùng làm đối số cho --owner-link.

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "P2_DATA_DIR=%~dp0.p2-test-data"
npm run owner-link
exit /b %ERRORLEVEL%
