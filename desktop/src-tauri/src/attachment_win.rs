//! save_attachment、save_bytes 碰系统的部分（只在 Windows）：WinHTTP 下载（不跟随重定向、签名只放请求头）、系统“另存为”（在主线程上弹）、
//! 先写临时文件并加 Zone.Identifier（ZoneId=3）再改名，保证落到用户选的位置时一定带“来自网络”标记。
//! 只用 tauri 依赖树里已有的 windows crate，不新增第三方依赖。错误只回固定错误码，不带地址和签名。

use crate::attachment::{head_matches, sha256_matches, SaveOutcome, SaveRequest, MAX_BYTES};
use std::ffi::c_void;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
use windows::Win32::Networking::WinHttp::*;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FileSaveDialog, IFileSaveDialog, FOS_FORCEFILESYSTEM, FOS_NOREADONLYRETURN, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST,
    FOS_STRICTFILETYPES, SIGDN_FILESYSPATH,
};

const DOWNLOAD_LIMIT: Duration = Duration::from_secs(120);
const ZONE_MARK: &[u8] = b"[ZoneTransfer]\r\nZoneId=3\r\n";

/// WinHTTP 句柄，出作用域自动关
struct Handle(*mut c_void);

impl Handle {
    fn new(p: *mut c_void) -> Result<Self, &'static str> {
        if p.is_null() {
            Err("download_failed")
        } else {
            Ok(Self(p))
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY：句柄来自 WinHTTP，只关一次
        unsafe {
            let _ = WinHttpCloseHandle(self.0);
        }
    }
}

fn set_u32(h: &Handle, option: u32, value: u32) -> Result<(), &'static str> {
    // SAFETY：句柄有效，缓冲区在调用期间有效
    unsafe { WinHttpSetOption(Some(h.0 as *const c_void), option, Some(&value.to_ne_bytes())) }.map_err(|_| "download_failed")
}

fn download(req: &SaveRequest) -> Result<Vec<u8>, &'static str> {
    const FAIL: &str = "download_failed";
    let host = HSTRING::from(req.url.host_str().ok_or(FAIL)?);
    let port = req.url.port_or_known_default().ok_or(FAIL)?;
    let path = HSTRING::from(req.url.path());
    let header: Vec<u16> = format!("X-Files-Sig: {}\r\n", req.sig).encode_utf16().collect();
    let started = Instant::now();
    // SAFETY：传入的宽字符串和句柄都活到调用结束；读缓冲区长度和传给系统的一致
    unsafe {
        let session = Handle::new(WinHttpOpen(
            &HSTRING::from("lemomemo-desktop"),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        ))?;
        set_u32(&session, WINHTTP_OPTION_SECURE_PROTOCOLS, WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3)?;
        let connect = Handle::new(WinHttpConnect(session.0, &host, port, 0))?;
        let request = Handle::new(WinHttpOpenRequest(
            connect.0,
            &HSTRING::from("GET"),
            &path,
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        ))?;
        set_u32(&request, WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_NEVER)?;
        set_u32(&request, WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION)?;
        WinHttpSetTimeouts(request.0, 10_000, 10_000, 15_000, 30_000).map_err(|_| FAIL)?;
        WinHttpAddRequestHeaders(request.0, &header, WINHTTP_ADDREQ_FLAG_ADD).map_err(|_| FAIL)?;
        WinHttpSendRequest(request.0, None, None, 0, 0, 0).map_err(|_| FAIL)?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut()).map_err(|_| FAIL)?;

        let mut status = 0u32;
        let mut len = size_of::<u32>() as u32;
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut c_void),
            &mut len,
            std::ptr::null_mut(),
        )
        .map_err(|_| FAIL)?;
        if status != 200 {
            return Err("download_refused");
        }

        let mut body = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            if started.elapsed() > DOWNLOAD_LIMIT {
                return Err("download_timeout");
            }
            let mut read = 0u32;
            WinHttpReadData(request.0, chunk.as_mut_ptr() as *mut c_void, chunk.len() as u32, &mut read).map_err(|_| FAIL)?;
            if read == 0 {
                return Ok(body);
            }
            if body.len() + read as usize > MAX_BYTES {
                return Err("file_too_large");
            }
            body.extend_from_slice(&chunk[..read as usize]);
        }
    }
}

/// 弹系统“另存为”；用户取消返回 None
fn ask_path(name: &str, kind: &str, owner: isize) -> Result<Option<PathBuf>, &'static str> {
    const FAIL: &str = "dialog_failed";
    // SAFETY：COM 在本线程初始化、成对释放；过滤器和文件名的宽字符串活到对话框关闭；路径用 CoTaskMemFree 释放
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if init.is_err() {
            return Err(FAIL);
        }
        let result = (|| {
            let dialog: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER).map_err(|_| FAIL)?;
            let options = dialog.GetOptions().map_err(|_| FAIL)?;
            dialog
                .SetOptions(options | FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT | FOS_PATHMUSTEXIST | FOS_NOREADONLYRETURN | FOS_STRICTFILETYPES)
                .map_err(|_| FAIL)?;
            let label = HSTRING::from(kind.to_ascii_uppercase());
            let spec = HSTRING::from(format!("*.{kind}"));
            let filter = [COMDLG_FILTERSPEC { pszName: PCWSTR(label.as_ptr()), pszSpec: PCWSTR(spec.as_ptr()) }];
            dialog.SetFileTypes(&filter).map_err(|_| FAIL)?;
            dialog.SetDefaultExtension(&HSTRING::from(kind)).map_err(|_| FAIL)?;
            dialog.SetFileName(&HSTRING::from(name)).map_err(|_| FAIL)?;
            let parent = (owner != 0).then_some(HWND(owner as *mut c_void));
            if let Err(e) = dialog.Show(parent) {
                return if e.code() == ERROR_CANCELLED.to_hresult() { Ok(None) } else { Err(FAIL) };
            }
            let item = dialog.GetResult().map_err(|_| FAIL)?;
            let raw = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|_| FAIL)?;
            let path = raw.to_string();
            CoTaskMemFree(Some(raw.0 as *const c_void));
            path.map(|p| Some(PathBuf::from(p))).map_err(|_| FAIL)
        })();
        CoUninitialize();
        result
    }
}

/// 选到的路径扩展名必须还是这个类型，文件名里不能有备用数据流
fn path_ok(path: &Path, kind: &str) -> bool {
    let name_ok = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| !n.contains(':'));
    let ext_ok = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(kind));
    name_ok && ext_ok && path.parent().is_some()
}

/// 带标记写好再改名。写不进 Zone.Identifier（比如 exFAT、FAT32 U 盘）就不落盘：宁可失败也不留没有来源标记的文件
fn write_marked(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    let temp = path.with_file_name(format!(".lemomemo-{}-{nanos}.tmp", std::process::id()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|_| "write_failed")?;
        file.write_all(bytes).map_err(|_| "write_failed")?;
        file.sync_all().map_err(|_| "write_failed")?;
        drop(file);
        let mut stream = temp.clone().into_os_string();
        stream.push(":Zone.Identifier");
        std::fs::write(&stream, ZONE_MARK).map_err(|_| "zone_mark_failed")?;
        std::fs::rename(&temp, path).map_err(|_| "write_failed")
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// 下载、核 sha256 和文件头。在阻塞线程里调
pub fn fetch(req: &SaveRequest) -> Result<Vec<u8>, &'static str> {
    let bytes = download(req)?;
    if !sha256_matches(&req.sha256, &bytes) {
        return Err("mismatch");
    }
    if !head_matches(req.kind, &bytes) {
        return Err("file_type_mismatch");
    }
    Ok(bytes)
}

/// 弹“另存为”、核选到的路径、带来源标记写盘（save_attachment、save_bytes 共用）。在阻塞线程里调：
/// 对话框交给 on_main 在主线程上弹（COM 对话框要在有消息循环的界面线程上，顺手修：原来在后台线程弹），这里阻塞等结果；写盘留在后台线程
pub fn ask_and_write(
    name: String,
    kind: &'static str,
    owner: isize,
    bytes: &[u8],
    on_main: impl FnOnce(Box<dyn FnOnce() + Send>) -> Result<(), ()>,
) -> Result<SaveOutcome, &'static str> {
    let (tx, rx) = std::sync::mpsc::channel();
    on_main(Box::new(move || {
        let _ = tx.send(ask_path(&name, kind, owner));
    }))
    .map_err(|_| "dialog_failed")?;
    let Some(path) = rx.recv().map_err(|_| "dialog_failed")?? else {
        return Ok(SaveOutcome::Cancelled);
    };
    if !path_ok(&path, kind) {
        return Err("bad_path");
    }
    write_marked(&path, bytes)?;
    Ok(SaveOutcome::Saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 写盘带来源标记_不留临时文件() {
        let dir = std::env::temp_dir().join(format!("lemomemo-attach-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("a.pdf");
        write_marked(&target, b"%PDF-1.7").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"%PDF-1.7");
        let mut stream = target.clone().into_os_string();
        stream.push(":Zone.Identifier");
        assert_eq!(std::fs::read(&stream).unwrap(), ZONE_MARK);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 选到的路径要和类型对得上() {
        assert!(path_ok(Path::new("C:\\x\\a.PDF"), "pdf"));
        assert!(!path_ok(Path::new("C:\\x\\a.exe"), "pdf"));
        assert!(!path_ok(Path::new("C:\\x\\a.pdf:evil"), "pdf"));
    }
}
