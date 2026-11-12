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
  ; The installer is a 32-bit program. A 32-bit PowerShell cannot read the path of a 64-bit
  ; process through Get-Process (it comes back empty), so use the 64-bit PowerShell
  ; (Sysnative) when there is one, and ask WMI (Win32_Process.ExecutablePath), which works
  ; across 32/64-bit either way. What it did goes to %TEMP%\SoftwareFactory-installer.log.
  Push $R9
  StrCpy $R9 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
    StrCpy $R9 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::ExecToLog "$\"$R9$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $\"$$log = Join-Path $$env:TEMP 'SoftwareFactory-installer.log'; $$n = Join-Path '$INSTDIR' 'node\node.exe'; $$p = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ($$_.ExecutablePath -ieq $$n) }); $$m = (Get-Date -Format o) + ' ' + $$p.Count + ' process(es) using ' + $$n + ': ' + (($$p | ForEach-Object { $$_.ProcessId }) -join ','); Write-Output $$m; Add-Content -Path $$log -Value $$m -ErrorAction SilentlyContinue; foreach ($$x in $$p) { Stop-Process -Id $$x.ProcessId -Force -ErrorAction SilentlyContinue }; foreach ($$x in $$p) { Wait-Process -Id $$x.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }$\""
  Pop $0
  Pop $R9
  ; Windows can hold the file a moment after the process is gone.
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SF_STOP_BUNDLED_NODE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro SF_STOP_BUNDLED_NODE
!macroend
