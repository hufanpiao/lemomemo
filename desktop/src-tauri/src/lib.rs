//! 柠檬记电脑版外壳（B6-exe；架构 5.10、14.2、15.6、0.48）。
//!
//! 三个窗口都在这里创建（tauri.conf.json 的 app.windows 为空），每个窗口：
//! • 顶层导航按窗口限制（policy::navigation_allowed），不许开新窗口；main 里被拦下的链接限速后转交系统（导航、新窗口都只放 https；
//!   mailto、tel 和 http 只走页面调的 open_external，也限速）；
//! • 只能调 capabilities/<窗口>.json 给的命令，命令里再按窗口 label 核一遍（双保险）；
//! • 权限请求只给 main 的本地页面放行通知，其余一律拒绝。
//! 窗口分工：main 是 App 本体（托盘、自启、单实例、热键都围着它）；auth 是登录小窗口（Turnstile 只在这里）；
//! quick-add 是热键唤出的快速记录框：默认 Ctrl+Shift+空格，设置里能改（R-297，hotkey.rs、hotkey_get / hotkey_set）。

pub mod commands;
pub mod credman;
mod manifest_check;
pub mod env;
pub mod hotkey;
pub mod policy;
pub mod session;
pub mod updater;

use policy::Win;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

type Sessions = session::SessionStore<credman::PlatformStore>;

/// 现在用的快速记录热键和它有没有注册上（R-297）。热键回调、hotkey_get、hotkey_set 都读写第一个字段。
/// 第一个字段是 std Mutex，**只许在锁里读写值，不许拿着它调 register / unregister**（安全审查 B-1）：插件 2.4.1 的
/// register、unregister 是 run_on_main_thread 加 rx.recv() 阻塞等主线程，而 WM_HOTKEY 回调在主线程里调 is_current() 要同一把锁，
/// 拿着锁去注册时正好按下热键，整个 App 会卡死。所以锁只在 snapshot()、store()、status() 里各拿一下就放；
/// 主线程上的 is_current()（热键回调用）只 try_lock()，拿不到就当没按，回调里绝不阻塞等锁（代码审查 B-1）。
/// 第二个字段是异步锁，只用来让并发的两次 hotkey_set 排队（它不在主线程上拿，不会和回调互等）
struct QuickAddHotkey(std::sync::Mutex<(hotkey::Hotkey, bool)>, tauri::async_runtime::Mutex<()>);

impl QuickAddHotkey {
    fn new(hk: hotkey::Hotkey, registered: bool) -> Self {
        Self(std::sync::Mutex::new((hk, registered)), tauri::async_runtime::Mutex::new(()))
    }

    /// 锁里只读一份副本出来，出了函数锁就放了
    fn snapshot(&self) -> Option<(hotkey::Hotkey, bool)> {
        self.0.lock().ok().map(|g| g.clone())
    }

    /// 锁里只写值
    fn store(&self, hk: hotkey::Hotkey, registered: bool) {
        if let Ok(mut g) = self.0.lock() {
            *g = (hk, registered);
        }
    }

    /// 热键回调在主线程里调：只 try_lock()，锁正被别处短暂拿着（或中毒）就当这次没按，不阻塞主线程
    fn is_current(&self, s: &Shortcut) -> bool {
        self.0.try_lock().map(|g| g.0.shortcut() == *s).unwrap_or(false)
    }

    fn status(&self) -> hotkey::HotkeyStatus {
        match self.0.lock() {
            Ok(g) => hotkey::HotkeyStatus::of(&g.0, g.1),
            Err(_) => hotkey::HotkeyStatus::of(&hotkey::Hotkey::default_key(), false),
        }
    }
}

/// 热键存档的路径（应用配置目录下的 quick-add-hotkey.txt）
fn hotkey_file<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(hotkey::FILE))
}

/// 开机自启时带的参数：带它启动时主窗口先藏在托盘里
const AUTOSTART_ARG: &str = "--autostart";
/// quick-add 交给 main 的内容最长多少字符（解析在页面里做，这里只防超大载荷）
const QUICK_ADD_MAX_CHARS: usize = 2000;
/// 链接转交系统的限速：1 秒最多 1 次（X-S2）；按单调时钟算（X-S9）。顶层导航、新窗口各用一个（F5-5：
/// 免得 iframe 不停调 window.open 把用户正常点的链接挤掉）
static NAV_LINK_LIMIT: std::sync::Mutex<policy::RateLimit> =
    std::sync::Mutex::new(policy::RateLimit::new(std::time::Duration::from_millis(1000)));
static NEW_WINDOW_LIMIT: std::sync::Mutex<policy::RateLimit> =
    std::sync::Mutex::new(policy::RateLimit::new(std::time::Duration::from_millis(1000)));
/// open_external 的限速（安全审查 B-3）：1 秒最多 1 次，超出返回 rate_limited；和上面两个分开，互不挤占
static OPEN_EXTERNAL_LIMIT: std::sync::Mutex<policy::RateLimit> =
    std::sync::Mutex::new(policy::RateLimit::new(std::time::Duration::from_millis(1000)));

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

/// 快速记录热键现在是什么、有没有注册上（设置页打开时调；registered 为 false 时提示“热键被占用”）
#[tauri::command]
async fn hotkey_get<R: Runtime>(webview: Webview<R>, state: State<'_, QuickAddHotkey>) -> Result<hotkey::HotkeyStatus, String> {
    require(&webview, &[Win::Main])?;
    Ok(state.status())
}

/// 改快速记录热键（R-297）。写法不对 → hotkey_invalid；被别的程序占了 → hotkey_in_use（旧的照样注册回去，存档不动）；
/// 注册上了但存档写不进去 → Err(hotkey_save_failed)。注意这是“半成功”：**热键已经换成新的、旧的已注销**，
/// 状态里记的也是新的，只是下次启动会回到旧存档（代码审查建议 ④ 选了“文档写明”，不改返回形状：前端 A 的
/// useQuickAddHotkey 收到 save_failed 会重读 hotkey_get，显示现在生效的新热键并提示没保存下来）。成功返回新状态
#[tauri::command]
async fn hotkey_set<R: Runtime>(
    webview: Webview<R>,
    app: AppHandle<R>,
    state: State<'_, QuickAddHotkey>,
    accelerator: String,
) -> Result<hotkey::HotkeyStatus, String> {
    require(&webview, &[Win::Main])?;
    let new = hotkey::parse(&accelerator).map_err(String::from)?;
    // 两次 hotkey_set 并发时排队（异步锁，不在主线程上拿）
    let _serial = state.1.lock().await;
    let (old, old_registered) = state.snapshot().ok_or_else(|| "hotkey_state_poisoned".to_string())?;
    if old == new && old_registered {
        return Ok(hotkey::HotkeyStatus::of(&old, true));
    }
    // 下面的 register / unregister 都在 std 锁外面调（B-1）：它们要等主线程，主线程上的热键回调要拿 std 锁
    let gs = app.global_shortcut();
    if old_registered {
        let _ = gs.unregister(old.shortcut());
    }
    if gs.register(new.shortcut()).is_err() {
        // 被占了：旧的注册回去（旧的本来就没注册上时不动），存档不动
        let back = old_registered && gs.register(old.shortcut()).is_ok();
        state.store(old, back);
        return Err(hotkey::ERR_IN_USE.into());
    }
    state.store(new.clone(), true);
    let saved = hotkey_file(&app).and_then(|p| {
        std::fs::create_dir_all(p.parent()?).ok()?;
        std::fs::write(&p, format!("{}\n", new.text)).ok()
    });
    if saved.is_none() {
        return Err(hotkey::ERR_SAVE.into());
    }
    Ok(hotkey::HotkeyStatus::of(&new, true))
}

#[tauri::command]
async fn open_external<R: Runtime>(webview: Webview<R>, url: String) -> Result<(), String> {
    require(&webview, &[Win::Main])?;
    // 先校验再限速：写法不对的不占名额
    let url = policy::external_url(&url).map_err(String::from)?;
    // 1 秒最多 1 次（安全审查 B-3）：页面脚本连调也只能每秒拉起一次系统程序
    let ok = OPEN_EXTERNAL_LIMIT.lock().map(|mut l| l.allow(std::time::Instant::now())).unwrap_or(false);
    if !ok {
        return Err("rate_limited".into());
    }
    // 和 hand_link_to_system 一样另起线程打开：ShellExecute 可能要等协议处理程序，不占着命令线程池。
    // 打开失败只能记日志，页面拿不到（以前能拿到 shell_open_failed，目前页面也没用它）
    std::thread::spawn(move || {
        if let Err(e) = shell_open(&url) {
            eprintln!("外链打开失败：{e}");
        }
    });
    Ok(())
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

/// 本线程的 COM 初始化，离开作用域时配对 CoUninitialize（只在这次 CoInitializeEx 成功时才配对）。
/// 第二个字段让它既不是 Send 也不是 Sync：编译器保证它不跨线程（CoUninitialize 必须在初始化的那个线程上调；代码审查 S7）
#[cfg(windows)]
struct ComGuard(bool, std::marker::PhantomData<*const ()>);

#[cfg(windows)]
impl ComGuard {
    fn sta() -> Self {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
        // SAFETY：保留参数传 None；S_OK、S_FALSE（本线程已初始化过）都要配对 CoUninitialize；
        // RPC_E_CHANGED_MODE（本线程已是 MTA）不配对，ShellExecute 照样能用
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        Self(hr.is_ok(), std::marker::PhantomData)
    }
}

#[cfg(windows)]
impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY：和 sta() 里成功的那次 CoInitializeEx 配对，同一线程（ComGuard 不是 Send，编译器保证不跨线程）
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }
}

/// 用系统默认程序打开已校验过的网址（调用前必须过 policy::external_url，或是 env.rs 里写死的地址）。
/// ShellExecuteW 要求调用线程先初始化 COM（微软文档：有的协议处理程序靠 COM 拉起）；open_external 是 async 命令，
/// 跑在 tokio 线程池里，线程没初始化过，所以每次调用前在本线程初始化成 STA、用完配对释放（复核 N3）
#[cfg(windows)]
fn shell_open(url: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let _com = ComGuard::sta();
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

/// 被壳子拦下的链接转交系统：协议按路径限（policy::link_external_url：导航、新窗口都只放 https；mailto、tel、http 只走 open_external），
/// 每条路径 1 秒最多 1 次，超出的直接丢掉、不记地址。
/// 导航、新窗口回调跑在界面线程上，ShellExecute 可能要等协议处理程序，所以另起一个线程去打开（线程里自己初始化 COM）
fn hand_link_to_system(raw: &str, path: policy::LinkPath) {
    let Some(u) = policy::link_external_url(raw, path) else { return };
    let limit = match path {
        policy::LinkPath::Navigation => &NAV_LINK_LIMIT,
        policy::LinkPath::NewWindow => &NEW_WINDOW_LIMIT,
    };
    let ok = limit.lock().map(|mut l| l.allow(std::time::Instant::now())).unwrap_or(false);
    if ok {
        std::thread::spawn(move || {
            let _ = shell_open(&u);
        });
    }
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
        .on_navigation(move |url| {
            // 入口页以外的顶层导航一律取消；main 里点了不带 target 的 https 外链时，取消的同时限速转交系统。
            // 导航只放 https，mailto、tel、http 只走页面调的 open_external（复核采纳：只留一个入口）
            if policy::navigation_allowed(win, url) {
                return true;
            }
            if win == Win::Main {
                hand_link_to_system(url.as_str(), policy::LinkPath::Navigation);
            }
            false
        })
        .on_new_window(move |url, _features| {
            // 一律不开新窗口；main 里 target=_blank 的链接（前端 A 的 LocationText 用 target=_blank、rel=noopener noreferrer）
            // 只放 https，限速后转交系统；mailto、tel 不从这里走（F5-5：iframe 的 window.open 不用点就能触发）。其余窗口的一律丢掉
            if win == Win::Main {
                hand_link_to_system(url.as_str(), policy::LinkPath::NewWindow);
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
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && app.state::<QuickAddHotkey>().is_current(shortcut) {
                        toggle_quick_add(app);
                    }
                })
                .build(),
        )
        .manage::<Sessions>(session::SessionStore::new(credman::platform_store(), env::ENV.session_keys))
        .manage(QuickAddHotkey::new(hotkey::Hotkey::default_key(), false))
        .setup(move |app| {
            if let Err(why) = check_env(app) {
                env_check_failed(app, &why);
            }
            let autostarted = std::env::args().any(|a| a == AUTOSTART_ARG);
            build_window(app.handle(), Win::Main, !autostarted)?;
            setup_tray(app)?;
            // 热键按存档注册（没有存档、写法不对用默认 Ctrl+Shift+空格，R-297）。被别的程序占了不影响启动，
            // 只是没有快速记录；registered 记成 false，设置页打开时据此提示“热键被占用”
            let saved = hotkey_file(app.handle()).and_then(|p| std::fs::read_to_string(p).ok());
            let hk = hotkey::from_saved(saved.as_deref());
            let ok = match app.global_shortcut().register(hk.shortcut()) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("快速记录热键 {} 注册失败：{e}", hk.text);
                    false
                }
            };
            app.state::<QuickAddHotkey>().store(hk, ok);
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
            app_update,
            hotkey_get,
            hotkey_set
        ])
        .run(tauri::generate_context!())
        .expect("柠檬记启动失败");
}
