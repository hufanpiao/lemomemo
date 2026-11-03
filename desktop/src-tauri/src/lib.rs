//! 柠檬记电脑版外壳（B6-exe；架构 5.10、14.2、15.6、0.48）。
//!
//! 三个窗口都在这里创建（tauri.conf.json 的 app.windows 为空），每个窗口：
//! • 顶层导航按窗口限制（policy::navigation_allowed），不许开新窗口；
//! • 只能调 capabilities/<窗口>.json 给的命令，命令里再按窗口 label 核一遍（双保险）；
//! • 权限请求只给 main 的本地页面放行通知，其余一律拒绝。
//! 窗口分工：main 是 App 本体（托盘、自启、单实例、热键都围着它）；auth 是登录小窗口（Turnstile 只在这里）；
//! quick-add 是 Ctrl+Alt+空格 唤出的快速记录框。

pub mod commands;
pub mod credman;
mod manifest_check;
pub mod env;
pub mod policy;
pub mod session;
pub mod updater;

use policy::Win;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

type Sessions = session::SessionStore<credman::PlatformStore>;

/// 开机自启时带的参数：带它启动时主窗口先藏在托盘里
const AUTOSTART_ARG: &str = "--autostart";
/// quick-add 交给 main 的内容最长多少字符（解析在页面里做，这里只防超大载荷）
const QUICK_ADD_MAX_CHARS: usize = 2000;
/// 新窗口外链转交系统浏览器的限速：1 秒最多 1 次（X-S2）
static NEW_WINDOW_LIMIT: std::sync::Mutex<policy::RateLimit> = std::sync::Mutex::new(policy::RateLimit::new(1000));

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ───────────── 命令：每个都先核对调用的窗口 ─────────────
// 都是 async：不在主线程上跑，凭据管理器偶尔慢时不卡界面（代码审查 S10；SessionStore 自带锁）

fn require(webview: &Webview<impl Runtime>, allowed: &[Win]) -> Result<Win, String> {
    match Win::from_label(webview.label()) {
        Some(w) if allowed.contains(&w) => Ok(w),
        _ => Err("window_not_allowed".into()),
    }
}

#[tauri::command]
async fn session_get<R: Runtime>(webview: Webview<R>, store: State<'_, Sessions>, key: String) -> Result<Option<String>, String> {
    require(&webview, &[Win::Main])?;
    store.get(&key)
}

#[tauri::command]
async fn session_set<R: Runtime>(webview: Webview<R>, store: State<'_, Sessions>, key: String, value: String) -> Result<(), String> {
    require(&webview, &[Win::Main, Win::Auth])?;
    store.set(&key, &value)
}

#[tauri::command]
async fn session_remove<R: Runtime>(webview: Webview<R>, store: State<'_, Sessions>, key: String) -> Result<(), String> {
    require(&webview, &[Win::Main])?;
    store.remove(&key)
}

#[tauri::command]
async fn open_external<R: Runtime>(webview: Webview<R>, url: String) -> Result<(), String> {
    require(&webview, &[Win::Main])?;
    let url = policy::external_url(&url).map_err(String::from)?;
    shell_open(&url)
}

// 建窗口、关窗口的命令必须是 async：Windows 上在同步命令里建窗口会卡死（Tauri 已知问题，实测复现过）
/// 通知被点击、或页面要打开整页提醒时：把主窗口拉到前台（藏在托盘里的也显示出来）
#[tauri::command]
async fn main_show<R: Runtime>(webview: Webview<R>, app: AppHandle<R>) -> Result<(), String> {
    require(&webview, &[Win::Main])?;
    show_or_create(&app, Win::Main).map(|_| ())
}

/// “更新”按钮：交给 updater 接入点检查、下载、安装；返回值见 updater::UpdateOutcome
#[tauri::command]
async fn app_update<R: Runtime>(webview: Webview<R>, app: AppHandle<R>) -> Result<updater::UpdateOutcome, String> {
    require(&webview, &[Win::Main])?;
    Ok(updater::check_and_install(&app).await)
}

#[tauri::command]
async fn auth_window_open<R: Runtime>(webview: Webview<R>, app: AppHandle<R>) -> Result<(), String> {
    require(&webview, &[Win::Main])?;
    show_or_create(&app, Win::Auth).map(|_| ())
}

/// 登录小窗口写好会话后调：由 Rust 通知 main 重新读会话，再关掉小窗口（页面不能自己往别的窗口发事件）
#[tauri::command]
async fn auth_done<R: Runtime>(webview: Webview<R>, app: AppHandle<R>) -> Result<(), String> {
    require(&webview, &[Win::Auth])?;
    app.emit_to(Win::MAIN, "auth:done", ()).map_err(|e| e.to_string())?;
    if let Some(main) = app.get_webview_window(Win::MAIN) {
        show(&main);
    }
    if let Some(auth) = app.get_webview_window(Win::AUTH) {
        let _ = auth.close();
    }
    Ok(())
}

/// “没有账号？用邀请码注册”：地址按环境写死在 env.rs，不从页面传
#[tauri::command]
fn auth_open_signup<R: Runtime>(webview: Webview<R>) -> Result<(), String> {
    require(&webview, &[Win::Auth])?;
    shell_open(env::ENV.signup_url)
}

#[derive(Clone, Serialize)]
struct QuickAddPayload {
    text: String,
}

/// 快速记录框交上来的内容转给 main（main 负责解析和保存），然后收起小窗口。
/// 载荷的形状等前端 A 定了 platform 函数签名再对（现在只是一段文字）。
#[tauri::command]
async fn quick_add_submit<R: Runtime>(webview: Webview<R>, app: AppHandle<R>, text: String) -> Result<(), String> {
    require(&webview, &[Win::QuickAdd])?;
    if text.chars().count() > QUICK_ADD_MAX_CHARS {
        return Err("text_too_long".into());
    }
    app.emit_to(Win::MAIN, "quick-add:submit", QuickAddPayload { text }).map_err(|e| e.to_string())?;
    if let Some(w) = app.get_webview_window(Win::QUICK_ADD) {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
async fn quick_add_hide<R: Runtime>(webview: Webview<R>, app: AppHandle<R>) -> Result<(), String> {
    require(&webview, &[Win::QuickAdd])?;
    if let Some(w) = app.get_webview_window(Win::QUICK_ADD) {
        let _ = w.hide();
    }
    Ok(())
}

// ───────────── 系统浏览器 ─────────────

/// 用系统默认程序打开已校验过的网址（调用前必须过 policy::external_url，或是 env.rs 里写死的地址）
#[cfg(windows)]
fn shell_open(url: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let target = HSTRING::from(url);
    // SAFETY：只传以 0 结尾的宽字符串；返回值 > 32 表示成功（ShellExecute 的约定）
    let r = unsafe { ShellExecuteW(None, w!("open"), &target, None, None, SW_SHOWNORMAL) };
    if r.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("shell_open_failed:{}", r.0 as isize))
    }
}

#[cfg(not(windows))]
fn shell_open(_url: &str) -> Result<(), String> {
    Err("unsupported_platform".into())
}

// ───────────── 窗口 ─────────────

struct WinSpec {
    title: &'static str,
    width: f64,
    height: f64,
    resizable: bool,
    decorations: bool,
    always_on_top: bool,
    skip_taskbar: bool,
}

fn spec(win: Win) -> WinSpec {
    match win {
        Win::Main => WinSpec { title: "柠檬记", width: 1200.0, height: 800.0, resizable: true, decorations: true, always_on_top: false, skip_taskbar: false },
        Win::Auth => WinSpec { title: "登录柠檬记", width: 460.0, height: 680.0, resizable: false, decorations: true, always_on_top: false, skip_taskbar: false },
        Win::QuickAdd => WinSpec { title: "快速记录", width: 560.0, height: 160.0, resizable: false, decorations: false, always_on_top: true, skip_taskbar: true },
    }
}

fn build_window<R: Runtime>(app: &AppHandle<R>, win: Win, visible: bool) -> tauri::Result<WebviewWindow<R>> {
    let s = spec(win);
    let mut b = WebviewWindowBuilder::new(app, win.label(), WebviewUrl::App(win.entry_path().into()))
        .title(s.title)
        .inner_size(s.width, s.height)
        .resizable(s.resizable)
        .decorations(s.decorations)
        .always_on_top(s.always_on_top)
        .skip_taskbar(s.skip_taskbar)
        .visible(visible)
        .center()
        // 拖进来的文件交给页面自己的拖放处理（附件上传），不让 WebView2 当成导航打开
        .disable_drag_drop_handler()
        .on_navigation(move |url| policy::navigation_allowed(win, url))
        .on_new_window(move |url, _features| {
            // 一律不开新窗口；main 里 target=_blank 的外链只放 http、https，限速后交系统浏览器（X-S2）。
            // 超出限速的直接丢掉，不记地址
            if win == Win::Main {
                if let Some(u) = policy::new_window_external_url(url.as_str()) {
                    let ok = NEW_WINDOW_LIMIT.lock().map(|mut l| l.allow(now_ms())).unwrap_or(false);
                    if ok {
                        let _ = shell_open(&u);
                    }
                }
            }
            NewWindowResponse::Deny
        })
        .on_permission_request(move |webview, kind| permission(win, &webview, kind));
    if win == Win::Main {
        b = b.min_inner_size(800.0, 560.0);
    }
    b.build()
}

/// 权限请求：只给 main 的本地页面放行通知（提醒用），其余一律拒绝（摄像头、麦克风、定位、剪贴板读取等）
fn permission<R: Runtime>(win: Win, webview: &Webview<R>, kind: PermissionKind) -> PermissionResponse {
    let local = webview
        .url()
        .map(|u| u.scheme() == policy::LOCAL_SCHEME && u.host_str() == Some(policy::LOCAL_HOST))
        .unwrap_or(false);
    match kind {
        PermissionKind::Notifications if win == Win::Main && local => PermissionResponse::Allow,
        _ => PermissionResponse::Deny,
    }
}

fn show<R: Runtime>(w: &WebviewWindow<R>) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn show_or_create<R: Runtime>(app: &AppHandle<R>, win: Win) -> Result<WebviewWindow<R>, String> {
    if let Some(w) = app.get_webview_window(win.label()) {
        show(&w);
        return Ok(w);
    }
    let w = build_window(app, win, true).map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(w)
}

fn toggle_quick_add<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(Win::QUICK_ADD) {
        Some(w) if w.is_visible().unwrap_or(false) => {
            let _ = w.hide();
        }
        _ => {
            let _ = show_or_create(app, Win::QuickAdd);
        }
    }
}

// ───────────── 托盘 ─────────────

fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    // 托盘菜单文字先只有中文，多语言等 i18n 方案（回报里列为待定）
    let show_i = MenuItem::with_id(app, "show", "显示柠檬记", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(spec(Win::Main).title)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let _ = show_or_create(app, Win::Main);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let _ = show_or_create(tray.app_handle(), Win::Main);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

// ───────────── 启动核对 ─────────────

/// 配置（identifier）、编译特性（env.rs）、打包的页面（desktop-env.json）三者必须是同一套环境
fn check_env<R: Runtime>(app: &tauri::App<R>) -> Result<(), String> {
    env::check_identifier(&app.config().identifier)?;
    let asset = app
        .asset_resolver()
        .get("app/desktop-env.json".into())
        .ok_or("安装包里缺 app/desktop-env.json（没经过 stage-web.mjs 暂存）")?;
    let v: serde_json::Value = serde_json::from_slice(&asset.bytes).map_err(|e| e.to_string())?;
    check_marker(&v, cfg!(debug_assertions))
}

/// desktop-env.json 的核对：环境名一致；发布版还要求暂存时做过产物核对（envCheck = "passed"，代码审查 M4）。
/// debug 版允许 "skipped"（本地冒烟用 --skip-env-check 暂存的页面）
fn check_marker(v: &serde_json::Value, debug: bool) -> Result<(), String> {
    match v.get("env").and_then(|x| x.as_str()) {
        Some(name) if name == env::ENV.name => {}
        other => return Err(format!("页面是按 {:?} 暂存的，程序编的是 {}", other, env::ENV.name)),
    }
    match v.get("envCheck").and_then(|x| x.as_str()) {
        Some("passed") => Ok(()),
        Some("skipped") if debug => {
            eprintln!("【只限本地冒烟】页面暂存时跳过了环境核对");
            Ok(())
        }
        other => Err(format!("页面暂存时没有通过环境核对（envCheck = {other:?}）")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 发布版只认通过核对的页面() {
        let e = env::ENV.name;
        assert!(check_marker(&json!({ "env": e, "envCheck": "passed" }), false).is_ok());
        assert!(check_marker(&json!({ "env": e, "envCheck": "skipped" }), false).is_err());
        assert!(check_marker(&json!({ "env": e }), false).is_err());
        assert!(check_marker(&json!({ "env": e, "envCheck": "skipped" }), true).is_ok());
        assert!(check_marker(&json!({ "env": e }), true).is_err());
        assert!(check_marker(&json!({ "env": "other", "envCheck": "passed" }), true).is_err());
    }
}

/// 环境核对失败（X-S1）：写一行日志（只在应用数据目录，含原因），弹固定文案的提示框（不带路径和值），固定退出码 78 退出
fn env_check_failed<R: Runtime>(app: &tauri::App<R>, why: &str) -> ! {
    eprintln!("启动核对失败：{why}");
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("startup.log")) {
            let _ = writeln!(f, "{} 启动核对失败：{why}", now_ms());
        }
    }
    alert("柠檬记", "安装包和运行环境不一致，无法启动。请到官网重新下载安装。");
    std::process::exit(78);
}

#[cfg(windows)]
fn alert(title: &str, text: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    // SAFETY：只传以 0 结尾的宽字符串，没有父窗口
    unsafe {
        MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(title), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn alert(_title: &str, _text: &str) {}

pub fn run() {
    let quick_add_key = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);

    tauri::Builder::default()
        // 单实例必须第一个注册：第二次启动时唤出已有的主窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_or_create(app, Win::Main);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &quick_add_key && event.state() == ShortcutState::Pressed {
                        toggle_quick_add(app);
                    }
                })
                .build(),
        )
        .manage::<Sessions>(session::SessionStore::new(credman::platform_store(), env::ENV.session_keys))
        .setup(move |app| {
            if let Err(why) = check_env(app) {
                env_check_failed(app, &why);
            }
            let autostarted = std::env::args().any(|a| a == AUTOSTART_ARG);
            build_window(app.handle(), Win::Main, !autostarted)?;
            setup_tray(app)?;
            // 热键被别的程序占了不影响启动，只是没有快速记录
            if let Err(e) = app.global_shortcut().register(quick_add_key) {
                eprintln!("快速记录热键注册失败：{e}");
            }
            updater::init(app);
            Ok(())
        })
        .on_window_event(|window, event| match (Win::from_label(window.label()), event) {
            // 关主窗口只是藏到托盘；真正退出走托盘菜单
            (Some(Win::Main), WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            // 快速记录框：关掉或失去焦点都只是收起，下次热键直接再显示
            (Some(Win::QuickAdd), WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            (Some(Win::QuickAdd), WindowEvent::Focused(false)) => {
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            session_get,
            session_set,
            session_remove,
            open_external,
            auth_window_open,
            auth_done,
            auth_open_signup,
            quick_add_submit,
            quick_add_hide,
            main_show,
            app_update
        ])
        .run(tauri::generate_context!())
        .expect("柠檬记启动失败");
}
