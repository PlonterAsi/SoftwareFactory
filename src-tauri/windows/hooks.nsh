; SoftwareFactory installer hooks (Tauri NSIS).
;
; The app ships its own Node.js at $INSTDIR\node\node.exe. The core runs on it, and so do
; the processes the core starts: plugins, finished apps' servers, Claude Code (cli.js).
; While any of them runs, Windows keeps node.exe locked and the installer stops with
; "Error opening file for writing: ...\node\node.exe". So before files are copied (and
; before an uninstall removes them), stop every process that runs THIS install's node.exe.
; Only processes started from $INSTDIR are touched: a Node.js installed elsewhere on the
; PC, and its programs, are left alone.

!macro SF_STOP_BUNDLED_NODE
  DetailPrint "Stopping SoftwareFactory's background processes..."
  nsExec::ExecToLog "$\"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $\"$$n = Join-Path '$INSTDIR' 'node\node.exe'; $$p = @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and ($$_.Path -ieq $$n) }); if ($$p.Count) { Write-Output ('Stopping ' + $$p.Count + ' process(es) using ' + $$n); $$p | Stop-Process -Force -ErrorAction SilentlyContinue; $$p | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue } else { Write-Output 'Nothing is using the bundled Node.js' }$\""
  Pop $0
  ; Windows can hold the file a moment after the process is gone.
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SF_STOP_BUNDLED_NODE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro SF_STOP_BUNDLED_NODE
!macroend
