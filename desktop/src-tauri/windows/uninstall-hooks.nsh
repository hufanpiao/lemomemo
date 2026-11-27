; A19（架构 0.50 第 11 条）：卸载时删本机缓存、设置和会话。云端数据不动。
; 本文件必须是带 BOM 的 UTF-8，否则 makensis 按系统代码页读，中韩文会乱码。
; 会话键、凭据前缀、段数和 env.rs、session.rs 对拍：src/uninstall_hooks_check.rs 的单测（正式、预览两套 feature 各跑一遍）。
;
; 什么时候删：用户卸载（界面卸载、uninstall.exe /S 都算），三样一起删，只有这一种结果：
;   %LOCALAPPDATA%\<identifier>（WebView2 数据、日志）、%APPDATA%\<identifier>（热键存档）、本环境的会话凭据。
; 什么时候不删：
;   1. 自动更新：带 /UPDATE，$UpdateMode = 1；
;   2. 手动运行新安装包覆盖安装：Tauri 模板调旧卸载程序时不带 /UPDATE，但带 _?=<安装目录>。
;      带 _?= 时卸载程序不复制到临时目录，$EXEDIR 就是 $INSTDIR；正常卸载时它在临时目录运行。
;      判断不准时宁可留下数据，不能把还没同步的改动删掉。

; 模板的卸载确认页（un.ConfirmShow）会加一个“删除应用数据”勾选框，它的样式直接用 ${__NSD_CheckBox_STYLE}。
; 我们卸载时一律删，这个框勾不勾都一样，留着会让界面和行为对不上，所以把它建成不可见（去掉 WS_VISIBLE、WS_TABSTOP）。
; 只影响这一个框：完成页的勾选框用的是 nsDialogs 引入时就定好的 ${NSD_CreateCheckbox}，不读这里。
; 框不可见、读回的状态是 0，模板自己那段删除不会跑，删除全部由下面的 NSIS_HOOK_POSTUNINSTALL 做。
!define /redef __NSD_CheckBox_STYLE ${WS_CHILD}|${WS_CLIPSIBLINGS}|${BS_TEXT}|${BS_VCENTER}|${BS_AUTOCHECKBOX}|${BS_MULTILINE}

; 安装包界面是英文，提示写英、中、韩各一行（这块只显示得下三行，每行都不能折行，改字后要截图核对）
!define MUI_UNCONFIRMPAGE_TEXT_TOP "Removes local cache, settings and sign-in. Cloud data stays; unsynced edits are lost.$\r$\n本机缓存、设置和登录状态会删除，云端数据不受影响；未同步的改动会丢失。$\r$\nPC의 캐시·설정·로그인을 지웁니다. 클라우드는 유지, 동기화 안 된 변경은 사라져요."

; 一个会话键的全部凭据：头部、两套代号各 MAX_CHUNKS 段（0..31）、旧格式 1..32 段（session.rs）。不存在的删除会失败，直接忽略
!macro LEMO_DELETE_SESSION_KEY KEY
  System::Call 'advapi32::CredDeleteW(w "lemomemo.session.${KEY}", i 1, i 0) i'
  ${For} $R8 0 31
    System::Call 'advapi32::CredDeleteW(w "lemomemo.session.${KEY}~a$R8", i 1, i 0) i'
    System::Call 'advapi32::CredDeleteW(w "lemomemo.session.${KEY}~b$R8", i 1, i 0) i'
  ${Next}
  ${For} $R8 1 32
    System::Call 'advapi32::CredDeleteW(w "lemomemo.session.${KEY}~$R8", i 1, i 0) i'
  ${Next}
!macroend

; 卸载清理本体：会话键（storageKey 和它的 -user）+ 两个数据目录。
; 拆成带参数的宏，是为了实测脚本能用假键、假 identifier 跑同一段代码，不碰真实环境的会话
!macro LEMO_UNINSTALL_CLEANUP SESSION_KEY
  Push $R8
  !insertmacro LEMO_DELETE_SESSION_KEY "${SESSION_KEY}"
  !insertmacro LEMO_DELETE_SESSION_KEY "${SESSION_KEY}-user"
  Pop $R8
  SetShellVarContext current
  ${If} $LOCALAPPDATA != ""
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}
  ${If} $APPDATA != ""
    RmDir /r "$APPDATA\${BUNDLEID}"
  ${EndIf}
!macroend

; 放在卸载收尾：模板这时已确认程序退出，WebView2 不再占着数据目录。
; 会话键按 identifier 精确选（env.rs），不按前缀扫，不会删到另一套环境的会话
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
  ${AndIf} $EXEDIR != $INSTDIR
    !if "${BUNDLEID}" == "com.lemomemo.app"
      !insertmacro LEMO_UNINSTALL_CLEANUP "sb-lemomemo-auth-token"
    !else if "${BUNDLEID}" == "com.lemomemo.app.preview"
      !insertmacro LEMO_UNINSTALL_CLEANUP "sb-preview-auth-token"
    !else
      !error "uninstall-hooks.nsh: unknown BUNDLEID ${BUNDLEID}"
    !endif
  ${EndIf}
!macroend
