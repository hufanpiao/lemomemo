//! 安全外壳里不依赖窗口的判断（F3，架构 5.10、15.6、S-B6；架构审第一节 3.7）：
//! • 每个窗口能导航到哪些本地页面（Rust 里按窗口判断：main 不能导航到登录页，auth 只能在登录页）；
//! • `open_external` 收到的网址能不能交给系统浏览器（Rust 里再校验一遍协议）。
//! 纯函数，单测覆盖。

use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::{Duration, Instant};
use url::{Host, Url};

/// 本地页面的来源：Windows 上 Tauri 2 的默认来源，不开 useHttpsScheme（0.48 第 3 条，以后不改）
pub const LOCAL_SCHEME: &str = "http";
pub const LOCAL_HOST: &str = "tauri.localhost";

/// 三个窗口
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Win {
    Main,
    Auth,
    QuickAdd,
}

impl Win {
    pub const MAIN: &'static str = "main";
    pub const AUTH: &'static str = "auth";
    pub const QUICK_ADD: &'static str = "quick-add";

    pub fn label(self) -> &'static str {
        match self {
            Win::Main => Self::MAIN,
            Win::Auth => Self::AUTH,
            Win::QuickAdd => Self::QUICK_ADD,
        }
    }

    pub fn from_label(label: &str) -> Option<Win> {
        match label {
            Self::MAIN => Some(Win::Main),
            Self::AUTH => Some(Win::Auth),
            Self::QUICK_ADD => Some(Win::QuickAdd),
            _ => None,
        }
    }

    /// 窗口打开时加载的页面（相对本地来源；页面在安装包的 app/ 下，和网页版 /app/ 同一份产物）
    pub fn entry_path(self) -> &'static str {
        match self {
            Win::Main => "app/index.html",
            Win::Auth => "app/auth/index.html",
            // quick-add 页面入口要在 vite.config.ts 加（B6-exe 任务单冲突表），加之前窗口打开是空白页
            Win::QuickAdd => "app/desktop/quick-add.html",
        }
    }
}

/// 每个窗口能打开的确切路径（代码审查 M1、安全审查 X-2）。
/// Tauri 取页面时会先百分号解码、去掉末尾斜杠，找不到再试 `<路径>.html`、`<路径>/index.html`
/// （tauri-2.12.5 manager/mod.rs get_asset），所以不能按前缀判断：`/app/auth`、`/app/%61uth/index.html` 都会拿到登录页。
/// 这里只认原样相等的几个路径，路径里有 `%` 一律拒（本地页面的路径没有要编码的字符）。
const MAIN_PATHS: [&str; 2] = ["/app/", "/app/index.html"];
const AUTH_PATHS: [&str; 2] = ["/app/auth/", "/app/auth/index.html"];
const QUICK_ADD_PATHS: [&str; 1] = ["/app/desktop/quick-add.html"];

fn allowed_paths(win: Win) -> &'static [&'static str] {
    match win {
        Win::Main => &MAIN_PATHS,
        Win::Auth => &AUTH_PATHS,
        Win::QuickAdd => &QUICK_ADD_PATHS,
    }
}

fn is_local(url: &Url) -> bool {
    url.scheme() == LOCAL_SCHEME
        && url.host_str() == Some(LOCAL_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

/// 窗口 `win` 的顶层导航能不能去 `url`。不能的一律取消（外链由页面拦下后调 open_external）。
/// • main：只有入口页 /app/、/app/index.html（App 是 hash 路由，翻页只改 hash，不换文档）；
/// • auth：只有 /app/auth/、/app/auth/index.html；
/// • quick-add：只有打字框那一页。
/// hash、查询串不影响判断。
pub fn navigation_allowed(win: Win, url: &Url) -> bool {
    if !is_local(url) {
        return false;
    }
    let path = url.path();
    !path.contains('%') && allowed_paths(win).contains(&path)
}

/// `open_external` 只放行这四种协议（和网页版 safeHref 一致，shared/logic/link.ts）
const EXTERNAL_SCHEMES: [&str; 4] = ["http", "https", "mailto", "tel"];
/// 网址最长多少（过长的直接拒，免得把奇怪的东西交给系统）
pub const EXTERNAL_MAX_LEN: usize = 2048;

/// mailto 只收这几个参数（代码审查 S1：个别邮件客户端认 attach= 之类的参数，能把本机文件附上）
const MAILTO_PARAMS: [&str; 5] = ["to", "cc", "bcc", "subject", "body"];

fn private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        // 100.64.0.0/10 运营商级 NAT
        || (a == 100 && (64..128).contains(&b))
}

fn private_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return private_v4(v4);
    }
    let first = ip.segments()[0];
    ip.is_loopback()
        || ip.is_unspecified()
        // fc00::/7 唯一本地、fe80::/10 链路本地
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
}

/// 本机、局域网和本 App 自己的主机（代码审查 S1）：localhost、*.localhost（含 tauri.localhost、ipc.localhost）、
/// *.local、环回、私网、链路本地、0.0.0.0；末尾带点的写法一样算
fn host_is_local(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(ip) => private_v4(*ip),
        Host::Ipv6(ip) => private_v6(*ip),
        Host::Domain(d) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d.is_empty() || d == "localhost" || d.ends_with(".localhost") || d == "local" || d.ends_with(".local")
        }
    }
}

/// 校验交给系统浏览器的网址：解析成功、协议在白名单里、不带用户名密码、不是本机和局域网地址、不超长，
/// mailto 只带白名单里的参数。通过时返回规整后的网址（交给系统的是这一份，不是页面传来的原文）。
pub fn external_url(raw: &str) -> Result<String, &'static str> {
    let raw = raw.trim();
    if raw.len() > EXTERNAL_MAX_LEN {
        return Err("url_too_long");
    }
    let url = Url::parse(raw).map_err(|_| "url_invalid")?;
    if !EXTERNAL_SCHEMES.contains(&url.scheme()) {
        return Err("scheme_not_allowed");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials_not_allowed");
    }
    match url.scheme() {
        "http" | "https" => match url.host() {
            None => return Err("url_invalid"),
            Some(h) if host_is_local(&h) => return Err("local_not_allowed"),
            Some(_) => {}
        },
        "mailto" => {
            if url.query_pairs().any(|(k, _)| !MAILTO_PARAMS.contains(&k.to_ascii_lowercase().as_str())) {
                return Err("mailto_param_not_allowed");
            }
        }
        _ => {}
    }
    Ok(url.into())
}

/// 页面里的链接没经过 open_external、被壳子拦下的两条路径
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkPath {
    /// main 顶层导航到外部地址（不带 target 的 <a>）
    Navigation,
    /// main 里 target=_blank、window.open 要开新窗口
    NewWindow,
}

/// 被拦下的链接转交系统时放行哪些协议。先过 external_url 全套检查（mailto 参数白名单、不许本机和局域网、
/// 不许带用户名密码），再按路径限协议。两条路径现在都只放 https（安全审查 F5-5、复核采纳）：
/// • 新窗口：第三方 iframe（officeapps）调 window.open('mailto:…') 不用用户点过，放开就能每秒拉起一次邮件、电话程序；
/// • 顶层导航：mailto、tel、http 也不放，**只留 open_external 一个入口**（页面在点击处理里调，R-301）。
///   作用是入口只有一个、规则只在一处管，**不是“保证用户点过”**——open_external 同样看不到用户激活，靠的是它自己的限速
///   （OPEN_EXTERNAL_LIMIT，B-3）。前端 A 的 LocationText 遇到 mailto、tel、http 要在点击处理里调 open_external。
/// 两条路径都不要求用户点过，调用方必须限速（RateLimit），而且各用各的限速器
pub fn link_external_url(raw: &str, path: LinkPath) -> Option<String> {
    let u = external_url(raw).ok()?;
    let scheme = u.split(':').next()?;
    let allowed: &[&str] = match path {
        LinkPath::Navigation => &NAV_LINK_SCHEMES,
        LinkPath::NewWindow => &NEW_WINDOW_SCHEMES,
    };
    allowed.contains(&scheme).then_some(u)
}

/// 顶层导航被拦下时转交系统的协议（复核采纳：只留 https，mailto、tel 只走 open_external）
const NAV_LINK_SCHEMES: [&str; 1] = ["https"];
/// 新窗口转交系统的协议（F5-5）
const NEW_WINDOW_SCHEMES: [&str; 1] = ["https"];

/// 拉起系统程序的限速：lib.rs 里有三个各自独立的限速器——顶层导航 NAV_LINK_LIMIT、新窗口 NEW_WINDOW_LIMIT、
/// 页面调的 open_external 用 OPEN_EXTERNAL_LIMIT（B-3），互不挤占。两次之间至少隔 `min_gap`，超出的直接丢掉（X-S2）。
/// 用单调时钟 Instant，不用系统时间：系统时间往回调以后，按系统时间算会一直被丢掉，直到时间追上上一次（复核 X-S9）
pub struct RateLimit {
    min_gap: Duration,
    last: Option<Instant>,
}

impl RateLimit {
    pub const fn new(min_gap: Duration) -> Self {
        Self { min_gap, last: None }
    }

    /// now 时刻这一次放不放行（放行时记下时刻）；now 由调用方传 Instant::now()，测试里传构造好的时刻
    pub fn allow(&mut self, now: Instant) -> bool {
        match self.last {
            // Instant 单调不减；万一调用方传了更早的时刻，saturating_duration_since 记 0，照样不放行
            Some(last) if now.saturating_duration_since(last) < self.min_gap => false,
            _ => {
                self.last = Some(now);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn main_能在_app_里走_不能去登录页和打字框() {
        assert!(navigation_allowed(Win::Main, &u("http://tauri.localhost/app/index.html")));
        assert!(navigation_allowed(Win::Main, &u("http://tauri.localhost/app/index.html#/cal/month/2026-11")));
        assert!(navigation_allowed(Win::Main, &u("http://tauri.localhost/app/")));
        assert!(!navigation_allowed(Win::Main, &u("http://tauri.localhost/app/auth/index.html")));
        assert!(!navigation_allowed(Win::Main, &u("http://tauri.localhost/app/auth/")));
        assert!(!navigation_allowed(Win::Main, &u("http://tauri.localhost/app/desktop/quick-add.html")));
        assert!(!navigation_allowed(Win::Main, &u("http://tauri.localhost/index.html")));
    }

    #[test]
    fn main_只能去入口页_app_下别的页面一律不行() {
        assert!(navigation_allowed(Win::Main, &u("http://tauri.localhost/app/index.html?x=1#/remind/todo/t1?due=5")));
        for s in [
            "http://tauri.localhost/app/preview.html",
            "http://tauri.localhost/app/manifest.webmanifest",
            "http://tauri.localhost/app/assets/x.html",
            "http://tauri.localhost/app/index.htm",
            "http://tauri.localhost/app/index.html/",
            "http://tauri.localhost/app",
        ] {
            assert!(!navigation_allowed(Win::Main, &u(s)), "{s}");
        }
    }

    #[test]
    fn 路径里绕的写法也拦得住() {
        // Url 会把 .. 和 %2e%2e 规整掉，规整后再判断
        assert!(!navigation_allowed(Win::Main, &u("http://tauri.localhost/app/x/../auth/index.html")));
        assert!(!navigation_allowed(Win::Main, &u("http://tauri.localhost/app/%2e%2e/app/auth/")));
        assert!(!navigation_allowed(Win::Auth, &u("http://tauri.localhost/app/auth/../index.html")));
    }

    /// 代码审查 M1 复现过的写法（Tauri 解码、去末尾斜杠、补 .html / index.html 后会拿到登录页或打字框页），
    /// 外加大小写、反斜杠、编码的斜杠和点；三个窗口各跑一遍，除了各自的确切入口一律拒
    #[test]
    fn 审查复现的绕法三个窗口一律拒() {
        let tricks = [
            "http://tauri.localhost/app/auth",
            "http://tauri.localhost/app/%61uth/index.html",
            "http://tauri.localhost/app/auth%2Findex.html",
            "http://tauri.localhost/app/auth%2findex.html",
            "http://tauri.localhost/app/desktop/quick-add",
            "http://tauri.localhost/app/desktop/quick-add%2Ehtml",
            "http://tauri.localhost/app/desktop/quick-add.html/",
            "http://tauri.localhost/app/AUTH/",
            "http://tauri.localhost/APP/",
            r"http://tauri.localhost/app\auth\index.html",
            "http://tauri.localhost/app/auth/index",
            "http://tauri.localhost/app/auth/index.html/",
            "http://tauri.localhost/app/index",
            "http://tauri.localhost/app/index.html/",
            "http://tauri.localhost/app/%69ndex.html",
            "http://tauri.localhost/app",
            "http://tauri.localhost/app//",
            "http://tauri.localhost/app//index.html",
            "http://tauri.localhost/app/./auth/",
            "http://tauri.localhost/app/preview.html",
        ];
        for w in [Win::Main, Win::Auth, Win::QuickAdd] {
            for s in tricks {
                let url = u(s);
                let own = allowed_paths(w).contains(&url.path());
                assert_eq!(navigation_allowed(w, &url), own, "{w:?} {s} → path {}", url.path());
            }
        }
        // 上面能放行的只可能是“规整后正好是自己的入口”的写法（反斜杠、./ 会被 Url 规整成 /app/auth/）
        assert!(navigation_allowed(Win::Auth, &u("http://tauri.localhost/app/./auth/")));
        assert!(!navigation_allowed(Win::Main, &u("http://tauri.localhost/app/./auth/")));
        assert!(!navigation_allowed(Win::Main, &u(r"http://tauri.localhost/app\auth\index.html")));
    }

    #[test]
    fn auth_和_quick_add_只能在自己的页面() {
        assert!(navigation_allowed(Win::Auth, &u("http://tauri.localhost/app/auth/index.html")));
        assert!(navigation_allowed(Win::Auth, &u("http://tauri.localhost/app/auth/")));
        assert!(!navigation_allowed(Win::Auth, &u("http://tauri.localhost/app/auth/other.html")));
        assert!(!navigation_allowed(Win::Auth, &u("http://tauri.localhost/app/index.html")));
        assert!(navigation_allowed(Win::QuickAdd, &u("http://tauri.localhost/app/desktop/quick-add.html")));
        assert!(!navigation_allowed(Win::QuickAdd, &u("http://tauri.localhost/app/index.html")));
    }

    #[test]
    fn 外站_https_来源_带端口_带账号的一律不许导航() {
        for w in [Win::Main, Win::Auth, Win::QuickAdd] {
            for s in [
                "https://lemomemo.com/app/index.html",
                "https://tauri.localhost/app/index.html",
                "http://tauri.localhost:8080/app/index.html",
                "http://user@tauri.localhost/app/index.html",
                "http://tauri.localhost.evil.com/app/index.html",
                "https://challenges.cloudflare.com/",
                "javascript:alert(1)",
                "data:text/html,hi",
                "file:///C:/Windows/win.ini",
            ] {
                assert!(!navigation_allowed(w, &u(s)), "{w:?} {s}");
            }
        }
    }

    #[test]
    fn 窗口标签和入口页() {
        for w in [Win::Main, Win::Auth, Win::QuickAdd] {
            assert_eq!(Win::from_label(w.label()), Some(w));
            let url = u(&format!("http://tauri.localhost/{}", w.entry_path()));
            assert!(navigation_allowed(w, &url), "{w:?} 自己的入口页要能打开");
        }
        assert_eq!(Win::from_label("other"), None);
    }

    #[test]
    fn 外链放行四种协议并规整() {
        assert_eq!(external_url("https://lemomemo.com/app/auth/").unwrap(), "https://lemomemo.com/app/auth/");
        assert_eq!(external_url("  HTTPS://Example.com  ").unwrap(), "https://example.com/");
        assert!(external_url("http://example.com/a?b=1").is_ok());
        assert!(external_url("mailto:someone@lemomemo.test").is_ok());
        assert!(external_url("tel:+82-10-1234-5678").is_ok());
    }

    /// 代码审查 S1 复现过会放行的写法，现在一律拒
    #[test]
    fn 外链拒绝本机和局域网地址() {
        for s in [
            "http://localhost:5173/",
            "http://LOCALHOST./",
            "http://127.0.0.1/",
            "http://0x7f.1/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fe80::1]/",
            "http://[fd00::1]/",
            "http://192.168.0.1/",
            "http://10.0.0.8:8080/",
            "http://172.16.5.4/",
            "http://169.254.169.254/latest/meta-data",
            "http://100.64.1.1/",
            "http://0.0.0.0/",
            "https://tauri.localhost/",
            "http://tauri.localhost:8080/",
            "http://ipc.localhost./x",
            "http://printer.local/",
            "http://foo.localhost/",
        ] {
            assert_eq!(external_url(s), Err("local_not_allowed"), "{s}");
        }
        // 公网地址照常放行
        assert!(external_url("http://8.8.8.8/").is_ok());
        assert!(external_url("https://[2606:4700::1111]/").is_ok());
        assert!(external_url("https://localhost.example.com/").is_ok());
    }

    #[test]
    fn mailto_只收白名单参数() {
        assert!(external_url("mailto:a@b.test?subject=hi&body=x&cc=c@d.test").is_ok());
        assert!(external_url("mailto:a@b.test?Subject=hi").is_ok());
        assert_eq!(external_url("mailto:a@b.test?attach=C:/x.txt"), Err("mailto_param_not_allowed"));
        assert_eq!(external_url("mailto:a@b.test?subject=x&attachment=y"), Err("mailto_param_not_allowed"));
    }

    #[test]
    fn 先去空格再判长度() {
        let pad = " ".repeat(100);
        let body = "a".repeat(EXTERNAL_MAX_LEN - "https://example.com/".len());
        assert!(external_url(&format!("{pad}https://example.com/{body}{pad}")).is_ok());
    }

    #[test]
    fn 顶层导航转交只放_https() {
        let nav = |s: &str| link_external_url(s, LinkPath::Navigation);
        assert_eq!(nav("https://example.com/a").as_deref(), Some("https://example.com/a"));
        assert_eq!(nav(" HTTPS://Example.com/b ").as_deref(), Some("https://example.com/b"));
        // mailto、tel、http 只走 open_external（复核采纳、R-301）；其余协议、本机地址、带用户名密码的照旧拒绝
        for s in [
            "mailto:a@b.test?subject=hi",
            "tel:+821012345678",
            "http://example.com/",
            "javascript:alert(1)",
            "file:///C:/Windows/win.ini",
            "ms-settings:privacy",
            "sms:+821012345678",
            "https://tauri.localhost/app/index.html",
            "https://192.168.0.1/",
            "https://u:p@example.com/",
            "mailto:a@b.test?attach=C:/x.txt",
            "about:blank",
        ] {
            assert_eq!(nav(s), None, "{s}");
        }
    }

    #[test]
    fn 新窗口转交只放_https() {
        // F5-5：iframe 里的 window.open('mailto:…') 不用点就能触发，新窗口不放 mailto、tel
        let nw = |s: &str| link_external_url(s, LinkPath::NewWindow);
        assert_eq!(nw("https://example.com/a").as_deref(), Some("https://example.com/a"));
        for s in ["mailto:a@b.test", "tel:+821012345678", "http://example.com/", "javascript:alert(1)", "https://127.0.0.1/"] {
            assert_eq!(nw(s), None, "{s}");
        }
    }

    #[test]
    fn 导航和新窗口两条路径都经_link_external_url_和各自的限速器() {
        // 结构核对：main 被拦下的顶层导航按 LinkPath::Navigation、target=_blank 新窗口按 LinkPath::NewWindow 调 hand_link_to_system，
        // 它先过 link_external_url 再按路径挑限速器（两个，F5-5），新窗口一律 Deny
        let lib = include_str!("lib.rs");
        let nav = &lib[lib.find(".on_navigation(").unwrap()..lib.find(".on_new_window(").unwrap()];
        assert!(nav.contains("navigation_allowed(win, url)") && nav.contains("LinkPath::Navigation"), "{nav}");
        let nw = &lib[lib.find(".on_new_window(").unwrap()..lib.find(".on_permission_request(").unwrap()];
        assert!(nw.contains("LinkPath::NewWindow") && nw.contains("NewWindowResponse::Deny") && !nw.contains("Allow"), "{nw}");
        assert!(!nw.contains("LinkPath::Navigation") && !nav.contains("LinkPath::NewWindow"));
        assert!(lib.contains("LinkPath::Navigation => &NAV_LINK_LIMIT") && lib.contains("LinkPath::NewWindow => &NEW_WINDOW_LIMIT"));
        let h = &lib[lib.find("fn hand_link_to_system").unwrap()..];
        let h = &h[..h.find("\n}\n").unwrap()];
        let (check, limit, open) = (h.find("link_external_url(").unwrap(), h.find("limit.lock()").unwrap(), h.find("shell_open(").unwrap());
        assert!(check < limit && limit < open, "{h}");
    }

    #[test]
    fn open_external_先校验再限速_另起线程打开() {
        // 安全审查 B-3：open_external 用自己的限速器（和导航、新窗口分开），超出返回 rate_limited，shell_open 在新线程里调
        let lib = include_str!("lib.rs");
        let f = &lib[lib.find("async fn open_external").unwrap()..];
        let f = &f[..f.find("\n}\n").unwrap()];
        let (check, limit, rl, spawn, open) = (
            f.find("policy::external_url(").unwrap(),
            f.find("OPEN_EXTERNAL_LIMIT.lock()").unwrap(),
            f.find("\"rate_limited\"").unwrap(),
            f.find("std::thread::spawn").unwrap(),
            f.find("shell_open(").unwrap(),
        );
        assert!(check < limit && limit < rl && rl < spawn && spawn < open, "{f}");
        assert!(!f.contains("NAV_LINK_LIMIT") && !f.contains("NEW_WINDOW_LIMIT"));
        let line = f.lines().find(|l| l.contains("OPEN_EXTERNAL_LIMIT.lock()")).unwrap();
        assert!(line.contains("Instant::now()"), "{line}");
        // open_external 照旧放 http、https、mailto、tel（R-301）
        for s in ["http://example.com/", "https://example.com/", "mailto:a@b.test", "tel:+821012345678"] {
            assert!(external_url(s).is_ok(), "{s}");
        }
    }

    #[test]
    fn 热键回调里不阻塞等锁() {
        // 代码审查 B-1：主线程上的热键回调（with_handler 闭包和它调的 is_current）里不许出现 .lock()，只许 try_lock()
        let lib = include_str!("lib.rs");
        let h = &lib[lib.find(".with_handler(").unwrap()..];
        let h = &h[..h.find(".build()").unwrap()];
        assert!(h.contains("is_current(") && !h.contains(".lock()"), "{h}");
        let f = &lib[lib.find("fn is_current(").unwrap()..];
        let f = &f[..f.find("\n    }\n").unwrap()];
        assert!(f.contains(".try_lock()") && !f.contains(".lock()"), "{f}");
        // 三个限速器各不相同
        for name in ["NAV_LINK_LIMIT", "NEW_WINDOW_LIMIT", "OPEN_EXTERNAL_LIMIT"] {
            assert_eq!(lib.matches(&format!("static {name}:")).count(), 1, "{name}");
        }
    }

    #[test]
    fn hotkey_set_不拿着状态锁调注册() {
        // 安全审查 B-1：std 锁只在 snapshot / store / is_current / status 里拿；hotkey_set 里不直接 .0.lock()，
        // register / unregister 都在 snapshot() 之后、store() 之前（锁外），并发调用靠异步锁 .1.lock().await 排队
        let lib = include_str!("lib.rs");
        let f = &lib[lib.find("async fn hotkey_set").unwrap()..];
        let f = &f[..f.find("\n}\n").unwrap()];
        assert!(!f.contains(".0.lock()"), "{f}");
        let serial = f.find("state.1.lock().await").unwrap();
        let snap = f.find("state.snapshot()").unwrap();
        let first_reg = f.find("gs.unregister(").unwrap().min(f.find("gs.register(").unwrap());
        let first_store = f.find("state.store(").unwrap();
        assert!(serial < snap && snap < first_reg && first_reg < first_store, "{f}");
        // 拿 std 锁的几个小函数里都不调注册
        let imp = &lib[lib.find("impl QuickAddHotkey").unwrap()..];
        let imp = &imp[..imp.find("\n}\n").unwrap()];
        assert!(!imp.contains("register(") && !imp.contains("global_shortcut"), "{imp}");
        // 启动时也是先注册、再 store
        let setup = &lib[lib.find("let hk = hotkey::from_saved(").unwrap()..];
        assert!(setup.find("register(hk.shortcut())").unwrap() < setup.find(".store(hk, ok)").unwrap());
    }

    #[test]
    fn 限速_一秒最多一次() {
        let t0 = Instant::now();
        let ms = |n: u64| t0 + Duration::from_millis(n);
        let mut r = RateLimit::new(Duration::from_millis(1000));
        assert!(r.allow(ms(10_000)));
        assert!(!r.allow(ms(10_500)));
        assert!(!r.allow(ms(10_999)));
        assert!(r.allow(ms(11_000)));
        assert!(!r.allow(ms(11_001)));
        // 传了更早的时刻也不放行（saturating_duration_since 记 0）
        assert!(!r.allow(ms(5_000)));
        assert!(r.allow(ms(12_000)));
    }

    #[test]
    fn 限速_不看系统时间() {
        // X-S9：RateLimit 只收 Instant，签名上就拿不到系统时间；源码里也不许出现 SystemTime
        let src = include_str!("policy.rs");
        let body = &src[src.find("pub struct RateLimit").unwrap()..src.find("#[cfg(test)]").unwrap()];
        assert!(!body.contains(concat!("System", "Time")));
        let lib = include_str!("lib.rs");
        let line = lib.lines().find(|l| l.contains("limit.lock()")).unwrap();
        assert!(line.contains("Instant::now()"), "{line}");
    }

    #[test]
    fn 外链拒绝的情况() {
        assert_eq!(external_url("javascript:alert(1)"), Err("scheme_not_allowed"));
        assert_eq!(external_url("file:///C:/Windows/win.ini"), Err("scheme_not_allowed"));
        assert_eq!(external_url("ms-settings:privacy"), Err("scheme_not_allowed"));
        assert_eq!(external_url("data:text/html,x"), Err("scheme_not_allowed"));
        assert_eq!(external_url("https://user:pw@example.com/"), Err("credentials_not_allowed"));
        assert_eq!(external_url("http://tauri.localhost/app/index.html"), Err("local_not_allowed"));
        assert_eq!(external_url("http://ipc.localhost/x"), Err("local_not_allowed"));
        assert_eq!(external_url("https://user:pw@example.com/"), Err("credentials_not_allowed"));
        assert_eq!(external_url("not a url"), Err("url_invalid"));
        assert_eq!(external_url(&format!("https://example.com/{}", "a".repeat(EXTERNAL_MAX_LEN))), Err("url_too_long"));
    }
}
