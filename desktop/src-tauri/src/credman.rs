//! Windows 凭据管理器实现（F4）：CRED_TYPE_GENERIC，CRED_PERSIST_LOCAL_MACHINE（只在本机、本用户，不随漫游配置同步）。
//! 凭据内容按当前 Windows 用户加密（DPAPI），其他用户和其他电脑读不到。

use crate::session::CredStore;

#[cfg(windows)]
mod imp {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    /// 凭据管理器单条上限
    const MAX_BLOB: usize = 2560;

    fn is_not_found(e: &windows::core::Error) -> bool {
        e.code() == ERROR_NOT_FOUND.to_hresult()
    }

    pub struct WinCredStore;

    impl super::CredStore for WinCredStore {
        fn read(&self, target: &str) -> Result<Option<Vec<u8>>, String> {
            let name = HSTRING::from(target);
            let mut p: *mut CREDENTIALW = std::ptr::null_mut();
            // SAFETY：p 由系统分配，读完用 CredFree 释放；blob 指针和长度来自同一结构
            unsafe {
                match CredReadW(&name, CRED_TYPE_GENERIC, None, &mut p) {
                    Ok(()) => {
                        let c = &*p;
                        let data = if c.CredentialBlob.is_null() || c.CredentialBlobSize == 0 {
                            Vec::new()
                        } else {
                            std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
                        };
                        CredFree(p as *const _);
                        Ok(Some(data))
                    }
                    Err(e) if is_not_found(&e) => Ok(None),
                    Err(e) => Err(format!("cred_read_failed:{:#x}", e.code().0)),
                }
            }
        }

        fn write(&self, target: &str, data: &[u8]) -> Result<(), String> {
            if data.len() > MAX_BLOB {
                return Err("blob_too_large".into());
            }
            let mut name: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
            // 用户名栏只放产品名，方便在“凭据管理器”里认出来；不放任何账号信息
            let mut user: Vec<u16> = "lemomemo".encode_utf16().chain(std::iter::once(0)).collect();
            let mut blob = data.to_vec();
            let cred = CREDENTIALW {
                Type: CRED_TYPE_GENERIC,
                TargetName: PWSTR(name.as_mut_ptr()),
                CredentialBlobSize: blob.len() as u32,
                CredentialBlob: if blob.is_empty() { std::ptr::null_mut() } else { blob.as_mut_ptr() },
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                UserName: PWSTR(user.as_mut_ptr()),
                ..Default::default()
            };
            // SAFETY：cred 里的指针在调用期间都有效（name、user、blob 活到函数结束）
            unsafe { CredWriteW(&cred, 0) }.map_err(|e| format!("cred_write_failed:{:#x}", e.code().0))
        }

        fn delete(&self, target: &str) -> Result<(), String> {
            let name = HSTRING::from(target);
            // SAFETY：只传入以 0 结尾的宽字符串
            match unsafe { CredDeleteW(&name, CRED_TYPE_GENERIC, None) } {
                Ok(()) => Ok(()),
                Err(e) if is_not_found(&e) => Ok(()),
                Err(e) => Err(format!("cred_delete_failed:{:#x}", e.code().0)),
            }
        }
    }
}

#[cfg(windows)]
pub use imp::WinCredStore;

/// 正式用的存储：Windows 上是凭据管理器；别的平台（只为能编译、跑单测）退回内存
#[cfg(windows)]
pub type PlatformStore = WinCredStore;
#[cfg(windows)]
pub fn platform_store() -> PlatformStore {
    WinCredStore
}

#[cfg(not(windows))]
pub type PlatformStore = crate::session::MemStore;
#[cfg(not(windows))]
pub fn platform_store() -> PlatformStore {
    crate::session::MemStore::default()
}

/// 真机测试：只在 Windows 上、用测试前缀的凭据名，测完核对删干净。
/// 会往当前用户的凭据管理器里写东西，默认不跑（代码审查 S6）；
/// 要跑时：`cargo test -- --include-ignored`（desktop.yml 里这样跑）
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::session::SessionStore;

    const TEST_KEYS: &[&str] = &["cargo-test-session-key"];

    #[test]
    #[ignore = "会写当前用户的凭据管理器；cargo test -- --include-ignored 时才跑"]
    fn 凭据管理器真机存取删_分段() {
        let s = SessionStore::new(WinCredStore, TEST_KEYS);
        let k = TEST_KEYS[0];
        let _ = s.remove(k);
        assert_eq!(s.get(k).unwrap(), None);

        let long = "柠檬".repeat(1500); // 9000 字节，5 段
        s.set(k, &long).unwrap();
        assert_eq!(s.get(k).unwrap().as_deref(), Some(long.as_str()));

        s.set(k, "short").unwrap();
        assert_eq!(s.get(k).unwrap().as_deref(), Some("short"));
        // 第一次写在代号 a，第二次切到 b，a 的 5 段都应清掉
        for i in 0..5 {
            let t = format!("lemomemo.session.{k}~a{i}");
            assert_eq!(WinCredStore.read(&t).unwrap(), None, "旧代号的段 {t} 应已删除");
        }

        s.remove(k).unwrap();
        assert_eq!(s.get(k).unwrap(), None);
        assert_eq!(WinCredStore.read(&format!("lemomemo.session.{k}")).unwrap(), None);
        assert_eq!(WinCredStore.read(&format!("lemomemo.session.{k}~b0")).unwrap(), None);
    }

    #[test]
    fn 删除不存在的凭据算成功() {
        assert!(WinCredStore.delete("lemomemo.session.cargo-test-never-exists").is_ok());
        assert_eq!(WinCredStore.read("lemomemo.session.cargo-test-never-exists").unwrap(), None);
    }
}
