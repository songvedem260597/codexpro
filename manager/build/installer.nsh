!macro customInstall
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CodexPro Manager" '"$INSTDIR\CodexPro Manager.exe" --autostart'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CodexPro Manager"
!macroend
