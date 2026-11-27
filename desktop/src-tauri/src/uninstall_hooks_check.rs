//! 卸载脚本 windows/uninstall-hooks.nsh 里写死的会话键、凭据前缀、段数，和 env.rs、session.rs 对拍（只有单测）。
//! 正式、预览两套 feature 各跑一遍（desktop.yml 两套都跑 cargo test），所以两套 identifier 和会话键都会核到。

#[cfg(test)]
mod tests {
    use crate::env::ENV;
    use crate::session::{MAX_CHUNKS, TARGET_PREFIX};

    const NSH: &str = include_str!("../windows/uninstall-hooks.nsh");

    #[test]
    fn 本环境的_identifier_对应本环境的会话键() {
        let [key, user] = ENV.session_keys else { panic!("env.rs 的 session_keys 应该正好两个") };
        assert_eq!(*user, format!("{key}-user"), "-user 键由脚本自己拼，env.rs 改了写法要一起改脚本");
        let branch = format!("\"${{BUNDLEID}}\" == \"{}\"", ENV.identifier);
        let at = NSH.find(&branch).unwrap_or_else(|| panic!("卸载脚本没有 {} 这一支", ENV.identifier));
        let next = NSH[at..].lines().nth(1).unwrap_or("").trim();
        assert_eq!(next, format!("!insertmacro LEMO_UNINSTALL_CLEANUP \"{key}\""), "{} 这一支删的会话键不对", ENV.identifier);
    }

    #[test]
    fn 凭据名前缀和段数和_session_rs_一致() {
        assert!(NSH.contains(&format!("\"{TARGET_PREFIX}${{KEY}}\"")), "头部凭据名前缀和 TARGET_PREFIX 不一致");
        for gen in ['a', 'b'] {
            assert!(NSH.contains(&format!("\"{TARGET_PREFIX}${{KEY}}~{gen}$R8\"")), "代号 {gen} 的段名不一致");
        }
        assert!(NSH.contains(&format!("${{For}} $R8 0 {}", MAX_CHUNKS - 1)), "两套代号的段要删 0..MAX_CHUNKS-1");
        assert!(NSH.contains(&format!("${{For}} $R8 1 {MAX_CHUNKS}")), "旧格式的段要删 1..=MAX_CHUNKS");
        assert!(NSH.contains(&format!("\"{TARGET_PREFIX}${{KEY}}~$R8\"")), "旧格式段名不一致");
    }

    #[test]
    fn 脚本里没有测试用的后门开关() {
        assert!(!NSH.contains("!ifdef LEMO_TEST"), "正式脚本不许带测试开关");
    }
}
