//! 自动更新的接入点（F7，架构 8.2、0.48）。现在只留位置，不加 tauri-plugin-updater 依赖、不配公钥、不生成钥。
//!
//! 接入时（负责人生成好签名钥、公钥进了配置之后）：
//! 1. Cargo.toml 加 tauri-plugin-updater（版本发布满两周）；
//! 2. tauri.conf.json 加 `plugins.updater.pubkey`（只放公钥）和 `bundle.createUpdaterArtifacts: true`；
//!    预览版的公钥放 tauri.preview.conf.json，两套公钥不同；
//! 3. 在下面的 `init` 里注册插件，地址只用 `endpoint()`（env.rs 里按环境写死），不从页面传；
//! 4. 更新检查只在 Rust 里做，不给任何窗口开 updater 的 JS 权限（capabilities 不加 updater:*）。
//! 私钥和私钥密码只在负责人手里，构建时由 CI 的密文注入，AI 不经手。

use crate::env::ENV;

/// 这套环境的更新清单地址
#[allow(dead_code)]
pub fn endpoint() -> &'static str {
    ENV.update_url
}

/// 接入点：现在什么也不做
pub fn init<R: tauri::Runtime>(_app: &tauri::App<R>) {}

/// 一次“更新”的结果。页面一侧（src/platform/desktop.ts 的 toSwUpdateResult）折算成网页版同一套 SwUpdateResult：
/// installing → 'reloading'，up_to_date → 'no_update'，error / not_configured → 'failed'，timeout → 'takeover_timeout'
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateOutcome {
    /// 已下载好、马上重启安装
    Installing,
    /// 没有新版
    UpToDate,
    /// 检查或下载出错
    Error,
    /// 下载或安装超时
    Timeout,
    /// updater 还没接入（公钥没配）
    NotConfigured,
}

/// 检查、下载、安装。接入 tauri-plugin-updater 之前一律返回 NotConfigured
pub async fn check_and_install<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> UpdateOutcome {
    UpdateOutcome::NotConfigured
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 结果按蛇形命名传给页面() {
        let names: Vec<String> = [
            UpdateOutcome::Installing,
            UpdateOutcome::UpToDate,
            UpdateOutcome::Error,
            UpdateOutcome::Timeout,
            UpdateOutcome::NotConfigured,
        ]
        .iter()
        .map(|o| serde_json::to_string(o).unwrap())
        .collect();
        assert_eq!(names, ["\"installing\"", "\"up_to_date\"", "\"error\"", "\"timeout\"", "\"not_configured\""]);
    }
}
