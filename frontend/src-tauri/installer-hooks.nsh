!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\CodeWhale.lnk" "$INSTDIR\CodeWhale.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\CodeWhale.lnk"
!macroend
