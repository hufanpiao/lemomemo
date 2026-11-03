//! 快速记录热键（负责人 R-297）：默认 Ctrl+Shift+空格，设置里能改，注册失败时设置页提示“热键被占用”。
//!
//! 这里只放纯逻辑（解析、规整、读存档、给页面的状态），注册和注销在 lib.rs（要 AppHandle）：
//! • 写法：修饰键 + 一个键，用“+”连，不分大小写，前后空白不算。修饰键 Ctrl（Control）、Alt、Shift、Win（Super、Meta）；
//!   键 A～Z、0～9、F1～F12、Space（空格）。至少要有 Ctrl、Alt、Win 里的一个——只有 Shift 的组合打字时会误触；
//!   Ctrl 或 Alt 单独作修饰键时，必须再带 Shift、Win 或另一个修饰键（安全审查 B-2：Ctrl+C/V/X/Z/A/S/W、Ctrl+F4、Alt+F4、
//!   Alt+空格 这些系统常用键一旦注册成功就被抢走全系统的这个组合，还会写进存档）；只有 Win 的可以（Win+F12）；
//!   修饰键不许重复，键只能有一个。规整成固定顺序 Ctrl+Alt+Shift+Win+键（存档、给页面的都是规整后的写法）；
//! • 存档：应用配置目录下的 quick-add-hotkey.txt，只存一行规整后的写法；读不出、写法不对都回落到默认值；
//! • 改热键：新的注册成功才换掉旧的、才写存档；注册失败（被别的程序占了）就把旧的注册回去，返回 hotkey_in_use。

use serde::Serialize;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

/// 默认热键（R-297：原来是 Ctrl+Alt+空格）
pub const DEFAULT: &str = "Ctrl+Shift+Space";
/// 存档文件名（应用配置目录下）
pub const FILE: &str = "quick-add-hotkey.txt";
/// 写法太长直接拒（免得把奇怪的东西写进存档）
const MAX_LEN: usize = 64;

/// 页面拿到的错误码（hotkey_set 返回的 Err）
pub const ERR_INVALID: &str = "hotkey_invalid";
pub const ERR_IN_USE: &str = "hotkey_in_use";
/// 半成功：新热键已注册生效（旧的已注销），只是存档没写进去，下次启动回到旧的；调用方应重读状态
pub const ERR_SAVE: &str = "hotkey_save_failed";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hotkey {
    pub mods: Modifiers,
    pub code: Code,
    /// 规整后的写法，比如 "Ctrl+Shift+Space"
    pub text: String,
}

impl Hotkey {
    pub fn shortcut(&self) -> Shortcut {
        Shortcut::new(Some(self.mods), self.code)
    }

    pub fn default_key() -> Hotkey {
        parse(DEFAULT).expect("默认热键写法要能解析")
    }
}

const LETTERS: [Code; 26] = [
    Code::KeyA, Code::KeyB, Code::KeyC, Code::KeyD, Code::KeyE, Code::KeyF, Code::KeyG, Code::KeyH, Code::KeyI,
    Code::KeyJ, Code::KeyK, Code::KeyL, Code::KeyM, Code::KeyN, Code::KeyO, Code::KeyP, Code::KeyQ, Code::KeyR,
    Code::KeyS, Code::KeyT, Code::KeyU, Code::KeyV, Code::KeyW, Code::KeyX, Code::KeyY, Code::KeyZ,
];
const DIGITS: [Code; 10] = [
    Code::Digit0, Code::Digit1, Code::Digit2, Code::Digit3, Code::Digit4,
    Code::Digit5, Code::Digit6, Code::Digit7, Code::Digit8, Code::Digit9,
];
const FKEYS: [Code; 12] = [
    Code::F1, Code::F2, Code::F3, Code::F4, Code::F5, Code::F6, Code::F7, Code::F8, Code::F9, Code::F10, Code::F11, Code::F12,
];

/// 一个键名换成 (Code, 规整写法)；认不出返回 None
fn key_of(tok: &str) -> Option<(Code, String)> {
    let up = tok.to_ascii_uppercase();
    if up == "SPACE" {
        return Some((Code::Space, "Space".into()));
    }
    let b = up.as_bytes();
    if b.len() == 1 && b[0].is_ascii_uppercase() {
        return Some((LETTERS[(b[0] - b'A') as usize], up));
    }
    if b.len() == 1 && b[0].is_ascii_digit() {
        return Some((DIGITS[(b[0] - b'0') as usize], up));
    }
    if let Some(n) = up.strip_prefix('F').and_then(|n| n.parse::<usize>().ok()) {
        if (1..=12).contains(&n) && up == format!("F{n}") {
            return Some((FKEYS[n - 1], up));
        }
    }
    None
}

/// 解析并规整热键写法；不合规矩返回 hotkey_invalid
pub fn parse(raw: &str) -> Result<Hotkey, &'static str> {
    if raw.len() > MAX_LEN {
        return Err(ERR_INVALID);
    }
    let toks: Vec<&str> = raw.split('+').map(str::trim).collect();
    if toks.len() < 2 || toks.iter().any(|t| t.is_empty()) {
        return Err(ERR_INVALID);
    }
    let (key_tok, mod_toks) = toks.split_last().ok_or(ERR_INVALID)?;
    let mut mods = Modifiers::empty();
    for t in mod_toks {
        let m = match t.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => Modifiers::CONTROL,
            "alt" => Modifiers::ALT,
            "shift" => Modifiers::SHIFT,
            "win" | "super" | "meta" => Modifiers::SUPER,
            _ => return Err(ERR_INVALID),
        };
        if mods.contains(m) {
            return Err(ERR_INVALID);
        }
        mods |= m;
    }
    if !mods.intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER) {
        return Err(ERR_INVALID);
    }
    // B-2：只有 Ctrl 或只有 Alt 一个修饰键的不收（系统常用键都在这一类）
    if mods == Modifiers::CONTROL || mods == Modifiers::ALT {
        return Err(ERR_INVALID);
    }
    let (code, key) = key_of(key_tok).ok_or(ERR_INVALID)?;
    // Win+Space 是 Windows 切换输入法的系统热键，不收（代码审查复核建议 3）
    if mods == Modifiers::SUPER && code == Code::Space {
        return Err(ERR_INVALID);
    }
    let mut parts: Vec<&str> = Vec::new();
    for (m, name) in [(Modifiers::CONTROL, "Ctrl"), (Modifiers::ALT, "Alt"), (Modifiers::SHIFT, "Shift"), (Modifiers::SUPER, "Win")] {
        if mods.contains(m) {
            parts.push(name);
        }
    }
    parts.push(&key);
    Ok(Hotkey { mods, code, text: parts.join("+") })
}

/// 存档内容（没有存档时 None）换成要注册的热键：读不出、写法不对都回落到默认值
pub fn from_saved(saved: Option<&str>) -> Hotkey {
    saved.and_then(|s| parse(s.trim()).ok()).unwrap_or_else(Hotkey::default_key)
}

/// 给页面的状态（hotkey_get、hotkey_set 返回；字段名按 camelCase 给 JS）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    /// 现在用的热键（规整后的写法）
    pub accelerator: String,
    /// 默认热键（设置页“恢复默认”用）
    pub default_accelerator: &'static str,
    /// 现在这个热键有没有注册上；false 时设置页提示“热键被占用”（启动时就被别的程序占了的情况）
    pub registered: bool,
}

impl HotkeyStatus {
    pub fn of(hk: &Hotkey, registered: bool) -> Self {
        Self { accelerator: hk.text.clone(), default_accelerator: DEFAULT, registered }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 默认是_ctrl_shift_空格() {
        let d = Hotkey::default_key();
        assert_eq!(d.text, "Ctrl+Shift+Space");
        assert_eq!(d.mods, Modifiers::CONTROL | Modifiers::SHIFT);
        assert_eq!(d.code, Code::Space);
        assert_eq!(d.shortcut(), Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space));
    }

    #[test]
    fn 写法规整_不分大小写_顺序固定() {
        for (raw, want) in [
            ("ctrl+shift+space", "Ctrl+Shift+Space"),
            (" Shift + Control + SPACE ", "Ctrl+Shift+Space"),
            ("alt+ctrl+k", "Ctrl+Alt+K"),
            ("Win+Shift+7", "Shift+Win+7"),
            ("Super+F12", "Win+F12"),
            ("meta+alt+f1", "Alt+Win+F1"),
            ("Ctrl+Alt+Space", "Ctrl+Alt+Space"),
        ] {
            assert_eq!(parse(raw).map(|h| h.text).as_deref(), Ok(want), "{raw}");
        }
        assert_eq!(parse("ctrl+alt+k").unwrap().code, Code::KeyK);
        // B-2：再带 Shift、Win 或另一个修饰键的可以
        for ok in ["Ctrl+Shift+C", "Ctrl+Win+V", "Alt+Shift+F4", "Ctrl+Alt+Z", "Win+F12", "Ctrl+Win+Space"] {
            assert!(parse(ok).is_ok(), "{ok}");
        }
        assert_eq!(parse("ctrl+alt+0").unwrap().code, Code::Digit0);
        assert_eq!(parse("ctrl+alt+f10").unwrap().code, Code::F10);
    }

    #[test]
    fn 不合规矩的写法一律_hotkey_invalid() {
        for raw in [
            "",
            "Space",
            "K",
            "Shift+K",           // 只有 Shift：打字会误触
            "Shift+Space",
            "Ctrl+Ctrl+K",       // 修饰键重复
            "Ctrl+K+J",          // 两个键
            "Ctrl+",
            "+K",
            "Ctrl++K",
            "Ctrl+Shift",        // 没有键
            "Ctrl+Hyper+K",      // 认不出的修饰键
            "Ctrl+Enter",        // 不在键名单里
            "Ctrl+F0",
            "Ctrl+F13",
            "Ctrl+F01",
            "Ctrl+ä",
            "Ctrl+空格",
            "Ctrl+Alt+Delete",
            // B-2：Ctrl 或 Alt 单独作修饰键的系统常用键
            "Ctrl+C",
            "Ctrl+V",
            "Ctrl+X",
            "Ctrl+Z",
            "Ctrl+A",
            "Ctrl+S",
            "Ctrl+W",
            "Ctrl+F4",
            "Ctrl+Space",
            "Ctrl+K",
            "Alt+F4",
            "Alt+Space",
            "Alt+Tab",
            "alt+k",
            // Win+Space 切换输入法
            "Win+Space",
            "super+space",
        ] {
            assert_eq!(parse(raw), Err(ERR_INVALID), "{raw:?}");
        }
        assert_eq!(parse(&format!("Ctrl+{}", "K".repeat(MAX_LEN))), Err(ERR_INVALID));
    }

    #[test]
    fn 存档读不出_写法不对都回落到默认() {
        assert_eq!(from_saved(None).text, DEFAULT);
        assert_eq!(from_saved(Some("")).text, DEFAULT);
        assert_eq!(from_saved(Some("Shift+K")).text, DEFAULT);
        assert_eq!(from_saved(Some("Ctrl+C")).text, DEFAULT, "老存档里的系统常用键也回落到默认");
        assert_eq!(from_saved(Some("garbage")).text, DEFAULT);
        assert_eq!(from_saved(Some("ctrl+alt+k\r\n")).text, "Ctrl+Alt+K");
    }

    #[test]
    fn 给页面的状态是_camel_case() {
        let s = HotkeyStatus::of(&parse("Ctrl+Alt+K").unwrap(), false);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v, serde_json::json!({ "accelerator": "Ctrl+Alt+K", "defaultAccelerator": "Ctrl+Shift+Space", "registered": false }));
    }
}
