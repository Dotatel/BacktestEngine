; The bundled SDK creates an empty metadata directory during ordinary use.
; Remove these known empty directories after Tauri removes the packaged files.
; Plain RMDir preserves any unexpected file or nonempty user-created directory.
!macro NSIS_HOOK_POSTUNINSTALL
  RMDir "$INSTDIR\runtimes\dotnet\metadata"
  RMDir "$INSTDIR\runtimes\dotnet"
  RMDir "$INSTDIR\runtimes"
  RMDir "$INSTDIR"
!macroend
