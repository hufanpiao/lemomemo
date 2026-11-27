//! 自动更新接入点（F7，架构 8.2、0.48）。现在还没接：不加 tauri-plugin-updater 依赖、不配公钥、不生成钥，
//! 所以“更新”按钮一律得到 NotConfigured（页面 src/platform/desktop.ts 的 toSwUpdateResult 折成 'failed'）。
//!
//! 接入时（负责人生成好签名钥、公钥进了配置之后）：
//! 1. Cargo.toml 加 tauri-plugin-updater（版本发布满两周）；
//! 2. tauri.conf.json 加 `plugins.updater.pubkey`（只放公钥）和 `bundle.createUpdaterArtifacts: true`；
//!    预览版的公钥放 tauri.preview.conf.json，两套公钥不同；desktop.yml 现在不许产物里有 .sig、更新包，要同步放开；
//! 3. 在 lib.rs 的 setup 里注册插件，清单地址只用 `env::ENV.update_url`（按环境写死），不从页面传；
//! 4. 在 `check_and_install` 里用插件检查 → 没新版回 up_to_date → 有新版下载、验签（验签失败回 error，不能继续安装）、
//!    启动安装回 installing；超时回 timeout。UpdateOutcome 照这几种加上（页面已经认这几个蛇形名字）；
//! 5. 更新检查只在 Rust 里做，不给任何窗口开 updater 的 JS 权限（capabilities 不加 updater:*）。
//! 【留空】私钥和私钥密码只在负责人手里，AI 不经手；本文件和配置里都没有任何密钥。

/// 一次“更新”的结果，按蛇形名字传给页面。接入后再加 installing、up_to_date、error、timeout（见文件头第 4 步）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateOutcome {
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
    use serde_json::json;

    #[test]
    fn 没公钥时不出更新包_窗口没有更新权限() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let has_pubkey = conf.pointer("/plugins/updater/pubkey").and_then(|k| k.as_str()).is_some_and(|k| !k.trim().is_empty());
        if !has_pubkey {
            assert_eq!(conf.pointer("/bundle/createUpdaterArtifacts"), Some(&json!(false)));
        }
        for caps in [
            include_str!("../capabilities/main.json"),
            include_str!("../capabilities/auth.json"),
            include_str!("../capabilities/quick-add.json"),
        ] {
            assert!(!caps.contains("updater:"));
        }
    }

    #[test]
    fn 结果按蛇形命名传给页面() {
        assert_eq!(serde_json::to_string(&UpdateOutcome::NotConfigured).unwrap(), "\"not_configured\"");
    }
}
