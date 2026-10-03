; 安装前：杀掉正在运行的 X-Spider 和残留 aria2c 进程
; 避免覆盖 x-spider.exe / aria2c.exe 时文件被占用
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping X-Spider..."
  nsExec::ExecToLog 'taskkill /F /IM x-spider.exe'
  nsExec::ExecToLog 'taskkill /F /IM X-Spider.exe'

  DetailPrint "Stopping aria2c..."
  nsExec::ExecToLog 'taskkill /F /IM aria2c.exe'
  nsExec::ExecToLog 'taskkill /F /IM aria2c-x86_64-pc-windows-msvc.exe'

  ; 给系统一点时间释放文件句柄
  Sleep 800
!macroend

; 卸载前：同理
!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping X-Spider..."
  nsExec::ExecToLog 'taskkill /F /IM x-spider.exe'
  nsExec::ExecToLog 'taskkill /F /IM X-Spider.exe'

  DetailPrint "Stopping aria2c..."
  nsExec::ExecToLog 'taskkill /F /IM aria2c.exe'
  nsExec::ExecToLog 'taskkill /F /IM aria2c-x86_64-pc-windows-msvc.exe'

  Sleep 800
!macroend