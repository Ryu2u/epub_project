@echo off
echo ==============================
echo   EPUB 书库 启动中...
echo ==============================

echo [1/2] 启动后端 (uvicorn :8000)...
start "EPUB Backend" cmd /c "cd /d %~dp0backend && uv run uvicorn epub_backend.main:app --reload --port 8000"

echo [2/2] 启动前端 (vite :5173)...
start "EPUB Web" cmd /c "cd /d %~dp0web && corepack pnpm dev"

echo.
echo 后端: http://localhost:8000
echo 前端: http://localhost:5173
echo.
echo 关闭时直接关掉弹出的两个窗口即可。
pause
