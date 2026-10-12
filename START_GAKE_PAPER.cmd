@echo off
setlocal
set "WORKTREE=%~dp0.gake-tools\host-mark-feed-worktree-oct09"
set "STATE=%~dp0.gake-tools\host-feed-oct09"
if not exist "%WORKTREE%\start-host-reference-supervisor.mjs" (
 set "WORKTREE=%~dp0"
 set "STATE=%~dp0..\host-feed-oct09"
)
node "%WORKTREE%\start-host-reference-supervisor.mjs" --state-dir "%STATE%"
if errorlevel 1 (
 echo Startup blocked. Recheck process identity and saved state.
) else (
 echo Launcher completed. Verify publisher.json for fresh successful publications.
)
pause
endlocal
