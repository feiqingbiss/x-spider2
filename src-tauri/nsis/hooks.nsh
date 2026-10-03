; 安装前：杀掉残留的 aria2c 进程，避免覆盖文件失败
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping aria2c..."
  nsExec::ExecToLog 'taskkill /F /IM aria2c.exe'
  nsExec::ExecToLog 'taskkill /F /IM aria2c-x86_64-pc-windows-msvc.exe'
  Sleep 500
!macroend

; 卸载前：同理
!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping aria2c..."
  nsExec::ExecToLog 'taskkill /F /IM aria2c.exe'
  nsExec::ExecToLog 'taskkill /F /IM aria2c-x86_64-pc-windows-msvc.exe'
  Sleep 500
!macroend