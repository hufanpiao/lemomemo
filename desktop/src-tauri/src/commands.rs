// 本 App 自己的命令名单（代码审查 M3）：build.rs 用 include! 读进来登记权限（allow-<命令名>），
// lib.rs 的 generate_handler! 必须和它一致（src/manifest_check.rs 的单测核对），只改这一处。
// 页面能调哪些命令只由 capabilities/<窗口>.json 按窗口给，这里只说有哪些命令。
pub const COMMANDS: &[&str] = &[
    // main：会话三件、外链、开登录小窗口、通知点击后拉到前台、“更新”按钮
    "session_get",
    "session_set",
    "session_remove",
    "open_external",
    "auth_window_open",
    "main_show",
    "app_update",
    // auth：写会话后通知 main 并关掉自己；“用邀请码注册”（不带载荷，地址写死在 Rust）
    "auth_done",
    "auth_open_signup",
    // quick-add：把打字框的结果交给 main；收起自己
    "quick_add_submit",
    "quick_add_hide",
];
