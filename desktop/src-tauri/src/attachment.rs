//! exe 另存附件 save_attachment（架构 5.13 第 4 点、0.38）：这里只放不碰系统的核对，下载和写文件在 attachment_win.rs。
//!
//! • URL：来源等于本环境 site_origin，路径正好是 `/files/v1/o/files/<段>/…`；原文和解析结果逐字一致，
//!   所以 `..`、百分号编码、反斜杠、查询串、片段都过不了；
//! • sig：只认 download 用途的 `/files` v2 签名串（同 src/platform/files-url.ts 的 checkSig），不进日志和错误信息；
//! • 文件名：规则同 shared/logic/files/file-name.ts，扩展名必须是 10 种附件类型之一；
//! • sha256：页面传来行上记的哈希（64 位小写十六进制），下载完核对，对不上不写盘（同前端预览、下载的规矩，评审 13）；
//! • 文件头：写之前按类型再核一次（PDF、ZIP、OLE）。
//! save_bytes（隐私记附件：页面已经解密好的字节，没有服务器上的明文可下载）只走文件名、大小、文件头三项（prepare_bytes），
//! 之后同一条“另存为”、带来源标记写盘（11-24 独立评审必修 4）。

use crate::env::ENV;
use url::Url;

/// 单个附件上限（同 shared/logic/files/limits.ts 的 FILE_MAX_BYTES）
pub const MAX_BYTES: usize = 10_485_760;
const FILE_NAME_MAX: usize = 120;
const SIG_MAX: usize = 2048;
const PATH_PREFIX: &str = "/files/v1/o/files/";
const KINDS: [&str; 10] = ["pdf", "docx", "xlsx", "pptx", "docm", "xlsm", "pptm", "doc", "xls", "ppt"];

/// 告诉页面这次存好了还是用户取消了
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SaveOutcome {
    Saved,
    Cancelled,
}

/// 核对通过的一次另存请求
#[cfg_attr(not(windows), allow(dead_code))]
pub struct SaveRequest {
    pub url: Url,
    pub sig: String,
    pub name: String,
    pub kind: &'static str,
    pub sha256: String,
}

/// 四项一起核对；错误只回固定的错误码
pub fn prepare(url: &str, sig: &str, name: &str, sha256: &str) -> Result<SaveRequest, &'static str> {
    let url = check_url(url, ENV.site_origin)?;
    check_sig(sig)?;
    let (name, kind) = clean_name(name)?;
    if !is_sha256_hex(sha256) {
        return Err("bad_sha256");
    }
    Ok(SaveRequest { url, sig: sig.to_string(), name, kind, sha256: sha256.to_string() })
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 下载到的字节和行上记的 sha256 对得上才写盘
#[cfg_attr(not(windows), allow(dead_code))]
pub fn sha256_matches(expected: &str, bytes: &[u8]) -> bool {
    use sha2::{Digest, Sha256};
    let got: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    got == expected
}

fn is_segment(s: &str) -> bool {
    // 同 files-url.ts 的 SEGMENT：^[0-9a-z][0-9a-z_-]*(\.[0-9a-z]+)*$
    let lower = |c: char| c.is_ascii_digit() || c.is_ascii_lowercase();
    let mut parts = s.split('.');
    let head = parts.next().unwrap_or("");
    let mut chars = head.chars();
    chars.next().is_some_and(lower)
        && chars.all(|c| lower(c) || c == '_' || c == '-')
        && parts.all(|p| !p.is_empty() && p.chars().all(lower))
}

fn check_url(raw: &str, origin: &str) -> Result<Url, &'static str> {
    const BAD: &str = "bad_url";
    let u = Url::parse(raw).map_err(|_| BAD)?;
    let site = Url::parse(origin).map_err(|_| BAD)?;
    if u.scheme() != "https"
        || u.origin() != site.origin()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || raw != format!("{origin}{}", u.path())
    {
        return Err(BAD);
    }
    let rest = u.path().strip_prefix(PATH_PREFIX).ok_or(BAD)?;
    let segs: Vec<&str> = rest.split('/').collect();
    if rest.len() > 200 || !(2..=4).contains(&segs.len()) || !segs.iter().all(|s| is_segment(s)) {
        return Err(BAD);
    }
    Ok(u)
}

fn check_sig(sig: &str) -> Result<(), &'static str> {
    const BAD: &str = "bad_sig";
    if sig.is_empty() || sig.len() > SIG_MAX || !sig.bytes().all(|b| (b'!'..=b'~').contains(&b)) {
        return Err(BAD);
    }
    let (mut p, mut e, mut d, mut s) = (None, None, None, None);
    for pair in sig.split('&') {
        let (k, v) = pair.split_once('=').ok_or(BAD)?;
        let slot = match k {
            "p" => &mut p,
            "e" => &mut e,
            "d" => &mut d,
            "s" => &mut s,
            _ => return Err(BAD),
        };
        if slot.replace(v).is_some() {
            return Err(BAD);
        }
    }
    let e = e.ok_or(BAD)?;
    if p != Some("download") || d.is_none() || s.is_none_or(str::is_empty) || e.is_empty() || e.len() > 12 || !e.bytes().all(|b| b.is_ascii_digit()) {
        return Err(BAD);
    }
    Ok(())
}

fn is_bad_char(c: char) -> bool {
    matches!(c,
        '\u{0}'..='\u{1f}' | '\u{7f}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
        | '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
}

fn is_reserved(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    if matches!(s.as_str(), "con" | "prn" | "aux" | "nul") {
        return true;
    }
    s.len() == 4 && (s.starts_with("com") || s.starts_with("lpt")) && s.as_bytes()[3].is_ascii_digit()
}

/// 清理文件名，返回（文件名，类型）。扩展名不是附件类型就拒绝，不猜
fn clean_name(raw: &str) -> Result<(String, &'static str), &'static str> {
    let last = raw.rsplit(['\\', '/']).next().unwrap_or("");
    let dot = last.rfind('.').filter(|&i| i > 0).ok_or("bad_name")?;
    let ext = last[dot + 1..].to_ascii_lowercase();
    let kind = KINDS.iter().copied().find(|k| *k == ext).ok_or("bad_name")?;
    let cleaned: String = last[..dot].chars().filter(|c| !is_bad_char(*c)).collect();
    let mut base = cleaned.trim().to_string();
    if is_reserved(base.split('.').next().unwrap_or("")) {
        base.insert(0, '_');
    }
    let room = FILE_NAME_MAX - kind.len() - 1;
    let cut: String = base.chars().take(room).collect();
    let mut base = cut.trim_end_matches(['.', ' ']).to_string();
    if base.is_empty() || base.starts_with('.') {
        base.insert_str(0, "file");
    }
    Ok((format!("{base}.{kind}"), kind))
}

/// save_bytes（隐私记附件，页面已经解密好的字节，11-24 独立评审必修 4）的请求头里文件名的写法：页面 encodeURIComponent 过（请求头只能放 ASCII），
/// 这里解回来；解不出就是空串，交给 clean_name 拒绝
pub fn decode_name(raw: &str) -> String {
    url::form_urlencoded::parse(format!("n={raw}").as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default()
}

/// save_bytes 的核对：文件名同 save_attachment 的规则；大小不超过单个附件上限；文件头和类型对得上。返回（清理过的文件名，类型）
pub fn prepare_bytes(name: &str, bytes: &[u8]) -> Result<(String, &'static str), &'static str> {
    let (name, kind) = clean_name(name)?;
    if bytes.len() > MAX_BYTES {
        return Err("file_too_large");
    }
    if !head_matches(kind, bytes) {
        return Err("file_type_mismatch");
    }
    Ok((name, kind))
}

/// 文件头和类型对得上才写盘（完整判类型在上传时由服务器做，这里是写盘前的最后一道）
#[cfg_attr(not(windows), allow(dead_code))]
pub fn head_matches(kind: &str, bytes: &[u8]) -> bool {
    match kind {
        "pdf" => bytes.starts_with(b"%PDF-"),
        "docx" | "xlsx" | "pptx" | "docm" | "xlsm" | "pptm" => bytes.starts_with(b"PK\x03\x04"),
        "doc" | "xls" | "ppt" => bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const O: &str = "https://lemomemo.com";
    const SIG: &str = "p=download&e=1790000000&d=a%20b.pdf&s=abc_DEF-123";

    #[test]
    fn url_只认本站的附件路径() {
        assert!(check_url("https://lemomemo.com/files/v1/o/files/u1/n1/id.pdf", O).is_ok());
        for bad in [
            "http://lemomemo.com/files/v1/o/files/u1/n1/id.pdf",
            "https://evil.com/files/v1/o/files/u1/n1/id.pdf",
            "https://lemomemo.com.evil.com/files/v1/o/files/u1/n1/id.pdf",
            "https://lemomemo.com:8443/files/v1/o/files/u1/n1/id.pdf",
            "https://a@lemomemo.com/files/v1/o/files/u1/n1/id.pdf",
            "https://lemomemo.com/files/v1/o/images/u1/n1/id.webp",
            "https://lemomemo.com/files/v1/o/files/u1/../id.pdf",
            "https://lemomemo.com/files/v1/o/files/u1/%2e%2e/id.pdf",
            "https://lemomemo.com/files/v1/o/files/u1%2fn1/id.pdf",
            "https://lemomemo.com/files/v1/o/files/u1%5cn1/id.pdf",
            "https://lemomemo.com/files/v1/o/files/u1\\n1/id.pdf",
            "https://lemomemo.com/files/v1/o/files/u1/n1/id.pdf?x=1",
            "https://lemomemo.com/files/v1/o/files/u1/n1/id.pdf?",
            "https://lemomemo.com/files/v1/o/files/u1/n1/id.pdf#x",
            "https://lemomemo.com/files/v1/o/files/id.pdf",
            "https://LEMOMEMO.com/files/v1/o/files/u1/n1/id.pdf",
        ] {
            assert!(check_url(bad, O).is_err(), "{bad} 应被拒");
        }
    }

    #[test]
    fn sig_只认下载用途的签名串() {
        assert!(check_sig(SIG).is_ok());
        for bad in [
            "",
            "p=view&e=1&d=a&s=x",
            "p=download&e=x&d=a&s=x",
            "p=download&e=1234567890123&d=a&s=x",
            "p=download&e=1&d=a&s=",
            "p=download&e=1&s=x",
            "p=download&e=1&d=a&s=x&z=1",
            "p=download&p=download&e=1&d=a&s=x",
            "p=download&e=1&d=a&s=x\r\nX-Evil: 1",
            "p=download&e=1&d=a b&s=x",
        ] {
            assert!(check_sig(bad).is_err(), "{bad:?} 应被拒");
        }
        assert!(check_sig(&format!("p=download&e=1&d=a&s={}", "x".repeat(SIG_MAX))).is_err());
    }

    #[test]
    fn 文件名清理和前端规则一致() {
        let n = |s: &str| clean_name(s).unwrap().0;
        assert_eq!(n("报告.pdf"), "报告.pdf");
        assert_eq!(n("C:\\x\\a.PDF"), "a.pdf");
        assert_eq!(n("../../a.docx"), "a.docx");
        assert_eq!(n("a\u{202e}b:c*.xlsx"), "abc.xlsx");
        assert_eq!(n("CON.pdf"), "_CON.pdf");
        assert_eq!(n("com1.report.doc"), "_com1.report.doc");
        assert_eq!(n("name. .pdf"), "name.pdf");
        assert_eq!(n("???.pdf"), "file.pdf");
        assert_eq!(n(&format!("{}.pdf", "柠".repeat(200))).chars().count(), FILE_NAME_MAX);
        for bad in ["a.exe", "a.pdf.exe", "noext", ".pdf", "a.pdf:evil"] {
            assert!(clean_name(bad).is_err(), "{bad} 应被拒");
        }
    }

    #[test]
    fn sha256_只认64位小写十六进制_并按内容核对() {
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(is_sha256_hex(abc));
        assert!(!is_sha256_hex(&abc.to_uppercase()));
        assert!(!is_sha256_hex(&abc[1..]));
        assert!(!is_sha256_hex(&format!("{}g", &abc[1..])));
        assert!(sha256_matches(abc, b"abc"));
        assert!(!sha256_matches(abc, b"abd"));
    }

    /// 和网页前端同读一份用例表（tests/fixtures/desktop-shared-rules.json，前端 desktop-shared-rules.test.ts）
    #[test]
    fn 共用用例表_和前端同一份规则() {
        let t: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/desktop-shared-rules.json")).unwrap();
        assert_eq!(t["limits"]["fileMaxBytes"].as_u64(), Some(MAX_BYTES as u64));
        assert_eq!(t["limits"]["fileNameMax"].as_u64(), Some(FILE_NAME_MAX as u64));
        assert_eq!(t["limits"]["quickAddMaxChars"].as_u64(), Some(crate::quick_add::MAX_CHARS as u64));
        let kinds: Vec<&str> = t["kinds"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert_eq!(kinds, KINDS);
        for row in t["fileNames"].as_array().unwrap() {
            let raw = row["raw"].as_str().unwrap();
            assert_eq!(clean_name(raw).map(|(n, _)| n), Ok(row["want"].as_str().unwrap().to_string()), "文件名 {raw:?}");
        }
        for row in t["segments"].as_array().unwrap() {
            let s = row["s"].as_str().unwrap();
            assert_eq!(is_segment(s), row["ok"].as_bool().unwrap(), "路径段 {s:?}");
        }
        for row in t["downloadSigs"].as_array().unwrap() {
            let sig = row["sig"].as_str().unwrap();
            assert_eq!(check_sig(sig).is_ok(), row["rust"].as_bool().unwrap(), "签名 {sig:?}");
        }
    }

    #[test]
    fn 隐私记字节另存_文件名解码_大小和文件头都核() {
        assert_eq!(decode_name("%E6%8A%A5%E5%91%8A%20%2B1.pdf"), "报告 +1.pdf");
        assert_eq!(decode_name(""), "");
        let pdf = b"%PDF-1.7 ...";
        assert_eq!(prepare_bytes("报告.pdf", pdf), Ok(("报告.pdf".to_string(), "pdf")));
        assert_eq!(prepare_bytes(&decode_name("..%2F..%2Fa.pdf"), pdf), Ok(("a.pdf".to_string(), "pdf")));
        assert_eq!(prepare_bytes("a.exe", pdf), Err("bad_name"));
        assert_eq!(prepare_bytes("a.docx", pdf), Err("file_type_mismatch"));
        assert_eq!(prepare_bytes("a.pdf", b""), Err("file_type_mismatch"));
        let mut big = b"%PDF-".to_vec();
        big.resize(MAX_BYTES + 1, 0);
        assert_eq!(prepare_bytes("a.pdf", &big), Err("file_too_large"));
    }

    #[test]
    fn 文件头要和类型对得上() {
        assert!(head_matches("pdf", b"%PDF-1.7"));
        assert!(head_matches("docm", b"PK\x03\x04rest"));
        assert!(head_matches("xls", &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]));
        assert!(!head_matches("pdf", b"PK\x03\x04"));
        assert!(!head_matches("docx", b"MZ\x90\x00"));
        assert!(!head_matches("doc", b"%PDF-"));
        assert!(!head_matches("exe", b"MZ"));
    }
}
