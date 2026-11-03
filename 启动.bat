@echo off
chcp 65001 >nul
title 工时记录 worklog
echo.
echo   正在启动工时记录（WSL 里的 Vite 开发服务）...
echo.
start "worklog dev server" wsl.exe -d Ubuntu -u rot bash -lc "cd '/home/rot/project manaje' && pnpm dev"
timeout /t 5 /nobreak >nul
start "" http://localhost:5173
echo   浏览器已打开 http://localhost:5173
echo   关闭那个 worklog dev server 窗口即可停止服务。
timeout /t 3 /nobreak >nul
