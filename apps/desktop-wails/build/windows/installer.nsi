; Wails-only, per-user package. Never touch Tauri's profile or registration.
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

!ifndef BUNDLE_DIR
  !error "Pass /DBUNDLE_DIR with the verified portable build directory"
!endif
!ifndef OUTPUT_FILE
  !error "Pass /DOUTPUT_FILE with the installer output path"
!endif
!ifndef PRODUCT_VERSION
  !error "Pass /DPRODUCT_VERSION with the package version"
!endif
!define PRODUCT_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\BetterComms-Wails"
!define WEBVIEW_KEY "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
Name "BetterComms (Wails)"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\BetterComms-Wails"
InstallDirRegKey HKCU "${PRODUCT_KEY}" "InstallLocation"
SetCompressor /SOLID lzma
SetOverwrite on
Icon "icon.ico"
UninstallIcon "icon.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Check every existing payload before making any change, not only the host:
; FFmpeg can outlive the window while an export is finishing. FileOpen in
; append mode tests write access without changing existing bytes.
!macro CheckWritable FILE
  ${If} ${FileExists} "$INSTDIR\${FILE}"
    ClearErrors
    FileOpen $0 "$INSTDIR\${FILE}" a
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "Close BetterComms (Wails) and its media/export tasks, and check write access before trying again. No package files have been changed." /SD IDOK
      SetErrorLevel 67
      Abort
    ${EndIf}
    FileClose $0
  ${EndIf}
!macroend

!macro CheckPayloadWritable
  !insertmacro CheckWritable "bettercomms-wails.exe"
  !insertmacro CheckWritable "ffmpeg\ffmpeg.exe"
  !insertmacro CheckWritable "ffmpeg\LICENSE"
  !insertmacro CheckWritable "ffmpeg\SOURCE.txt"
  !insertmacro CheckWritable "ffmpeg\setup.json"
!macroend

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "BetterComms requires Windows 10 or later." /SD IDOK
    SetErrorLevel 64
    Abort
  ${EndIf}
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_OK|MB_ICONSTOP "This package requires x64 Windows." /SD IDOK
    SetErrorLevel 65
    Abort
  ${EndIf}
  ; Microsoft documents the machine key in the 32-bit registry view and the
  ; user key in HKCU. A zero version is not an installed Evergreen runtime.
  SetRegView 32
  ReadRegStr $0 HKLM "${WEBVIEW_KEY}" "pv"
  SetRegView 64
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ReadRegStr $0 HKCU "${WEBVIEW_KEY}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    MessageBox MB_OK|MB_ICONSTOP "Install Microsoft Edge WebView2 Evergreen Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ and run this installer again. No application files have been changed." /SD IDOK
    SetErrorLevel 66
    Abort
  ${EndIf}
FunctionEnd

Section "BetterComms (Wails)" Main
  ; Never kill a user's call or media process to perform an update.
  !insertmacro CheckPayloadWritable
  SetOutPath "$INSTDIR"
  File "${BUNDLE_DIR}\bettercomms-wails.exe"
  SetOutPath "$INSTDIR\ffmpeg"
  File "${BUNDLE_DIR}\ffmpeg\ffmpeg.exe"
  File "${BUNDLE_DIR}\ffmpeg\LICENSE"
  File "${BUNDLE_DIR}\ffmpeg\SOURCE.txt"
  File "${BUNDLE_DIR}\ffmpeg\setup.json"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortcut "$SMPROGRAMS\BetterComms (Wails).lnk" "$INSTDIR\bettercomms-wails.exe"
  WriteRegStr HKCU "${PRODUCT_KEY}" "DisplayName" "BetterComms (Wails)"
  WriteRegStr HKCU "${PRODUCT_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${PRODUCT_KEY}" "Publisher" "BetterComms"
  WriteRegStr HKCU "${PRODUCT_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${PRODUCT_KEY}" "DisplayIcon" "$INSTDIR\bettercomms-wails.exe"
  WriteRegStr HKCU "${PRODUCT_KEY}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "${PRODUCT_KEY}" "QuietUninstallString" '$\"$INSTDIR\uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${PRODUCT_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${PRODUCT_KEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
FunctionEnd

Section "Uninstall"
  !insertmacro CheckPayloadWritable
  ClearErrors
  Delete "$INSTDIR\bettercomms-wails.exe"
  IfErrors running
  ; Exact owned files only. Never recursively remove an installation directory,
  ; webview profile, credentials, optional DSP runtimes or recording libraries.
  Delete "$INSTDIR\ffmpeg\ffmpeg.exe"
  Delete "$INSTDIR\ffmpeg\LICENSE"
  Delete "$INSTDIR\ffmpeg\SOURCE.txt"
  Delete "$INSTDIR\ffmpeg\setup.json"
  RMDir "$INSTDIR\ffmpeg"
  Delete "$SMPROGRAMS\BetterComms (Wails).lnk"
  DeleteRegKey HKCU "${PRODUCT_KEY}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Goto done
running:
  MessageBox MB_OK|MB_ICONSTOP "Close BetterComms (Wails), then run uninstall again." /SD IDOK
  SetErrorLevel 67
  Abort
done:
SectionEnd
