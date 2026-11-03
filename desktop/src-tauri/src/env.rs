//! 两套环境要切换的项（F8，架构 0.48 第 7 条）。
//!
//! 正式版默认编；预览版用 `--features preview` 编，并且必须同时带 `--config tauri.preview.conf.json`
//! （identifier、productName、CSP 在配置文件里）。两边对不上时 `check_identifier` 让程序启动即失败，
//! 不会出现“预览的配置配正式的会话键”这种半套的包。desktop.yml 另外在编出的 exe 里反向搜对方环境的主机名和公钥。

/// 一套环境的常量。都是公开值，没有任何密钥。
#[derive(Debug)]
pub struct EnvSpec {
    /// 环境名：production / preview
    pub name: &'static str,
    /// 安装包和单实例、自启、卸载项用的 identifier（必须和 tauri.conf.json 一致）
    pub identifier: &'static str,
    /// 网站和接口的来源（CSP connect-src 也是它）
    pub site_origin: &'static str,
    /// “没有账号？用邀请码注册”用系统浏览器打开的注册页（F6，地址写死在这里，不从页面传）
    pub signup_url: &'static str,
    /// 更新清单地址（F7 接入点用；预览版是预览 Pages 项目 desktop 分支的固定别名，Q-A1）
    pub update_url: &'static str,
    /// secureStorage 只认的会话键（supabase-js 的 storageKey 和它的 -user 附属键，14.2 第 2 点）
    pub session_keys: &'static [&'static str],
}

#[cfg(not(feature = "preview"))]
pub const ENV: EnvSpec = EnvSpec {
    name: "production",
    identifier: "com.lemomemo.app",
    site_origin: "https://lemomemo.com",
    signup_url: "https://lemomemo.com/app/auth/",
    update_url: "https://lemomemo.com/desktop/latest.json",
    session_keys: &["sb-lemomemo-auth-token", "sb-lemomemo-auth-token-user"],
};

// 预览 Pages 项目名还没定稿，更新地址先占位（F7 时由运维按 Q-A1 填真名）；预览版现在不开更新，所以不影响运行
#[cfg(feature = "preview")]
pub const ENV: EnvSpec = EnvSpec {
    name: "preview",
    identifier: "com.lemomemo.app.preview",
    site_origin: "https://preview.lemomemo.com",
    signup_url: "https://preview.lemomemo.com/app/auth/",
    update_url: "https://desktop.PREVIEW-PAGES-PROJECT.pages.dev/latest.json",
    session_keys: &["sb-preview-auth-token", "sb-preview-auth-token-user"],
};

/// 配置文件里的 identifier 必须和编进来的环境一致，否则拒绝启动
pub fn check_identifier(configured: &str) -> Result<(), String> {
    if configured == ENV.identifier {
        Ok(())
    } else {
        Err(format!(
            "环境不一致：编的是 {}（{}），配置里的 identifier 是 {}",
            ENV.name, ENV.identifier, configured
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 正式和预览的值互不串() {
        #[cfg(not(feature = "preview"))]
        {
            assert!(!ENV.signup_url.contains("preview"));
            assert!(ENV.session_keys.iter().all(|k| k.starts_with("sb-lemomemo-")));
        }
        #[cfg(feature = "preview")]
        {
            assert!(ENV.signup_url.starts_with("https://preview.lemomemo.com/"));
            assert!(ENV.session_keys.iter().all(|k| k.starts_with("sb-preview-")));
            assert!(ENV.identifier.ends_with(".preview"));
        }
        assert!(ENV.signup_url.starts_with(ENV.site_origin));
    }

    #[test]
    fn identifier_不一致就拒绝() {
        assert!(check_identifier(ENV.identifier).is_ok());
        assert!(check_identifier("com.lemomemo.other").is_err());
    }
}
