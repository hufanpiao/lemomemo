//! secureStorage（F4，架构 14.2、5.10）：会话只存在 Windows 凭据管理器里，不落 WebView2 的 localStorage。
//!
//! • 只认环境白名单里的键（env.rs 的 session_keys），别的键一律拒绝；
//! • 凭据管理器单条最多 2560 字节，会话 JSON 可能更长，所以分段存，而且**两套段轮换**（代码审查 M2）：
//!   头部 `lemomemo.session.<key>` 只放 `lemo2;<代号 a/b>;<段数>;<总字节数>;<SHA-256 十六进制>`；
//!   内容放在 `lemomemo.session.<key>~<代号><i>`（i = 0..段数），每段最多 CHUNK 字节，最多 MAX_CHUNKS 段；
//! • 写：新值写进“不是当前代号”的那一套段，全部写好以后才写头部切换过去，最后清掉旧代号的段和多出来的孤段。
//!   中途哪一步失败，头部还指着旧的那套，读回的是完整的旧会话，不会新旧拼接；
//!   收尾只删确实可能存在的凭据（复核 N3 收窄）：旧头部记的那几段，加上两套代号各自从“该有的段数”往后、
//!   挨个读到第一个不存在的为止；不再每次写都把两套 32 段和旧格式段全删一遍。
//!   这样能清干净的前提是“留下的段总是从 0 连着往后排”：写入失败留下的段本来就是 0..k；删旧段从大到小删、第一次失败就停
//!   （代码审查 S1），删除失败留下的也是 0..k；trim 先只读探到最高一段再从高往低删、失败就停，读出错就不删（复核 R2），留下的同样连着；
//! • 读：按头部的代号取齐各段，核对总长度、SHA-256 和 UTF-8，任何一项不对都当没有（返回 None，页面走重新登录）；
//! • 删：先删头部，再把两套代号的段和旧格式的段全删一遍（不存在算成功），不留孤段（代码审查 S2）——只有退出登录时走这一步。
//! 存储层抽成 trait：正式用凭据管理器（credman.rs），单测用内存实现。

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;

/// 凭据名前缀（卸载清理、排查都按“前缀 + 键名”找，不能只按前缀，否则会删到另一套环境的会话）
pub const TARGET_PREFIX: &str = "lemomemo.session.";
/// 每段最多多少字节（凭据管理器上限 2560，留余量）
pub const CHUNK: usize = 2000;
/// 最多多少段（总上限约 64 KB，会话 JSON 远小于此）
pub const MAX_CHUNKS: usize = 32;
const HEADER_TAG: &str = "lemo2";
const GENS: [char; 2] = ['a', 'b'];

/// 凭据存储的最小接口
pub trait CredStore: Send + Sync {
    fn read(&self, target: &str) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, target: &str, data: &[u8]) -> Result<(), String>;
    /// 不存在也算成功
    fn delete(&self, target: &str) -> Result<(), String>;
}

fn header_name(key: &str) -> String {
    format!("{TARGET_PREFIX}{key}")
}

fn seg_name(key: &str, gen: char, index: usize) -> String {
    format!("{TARGET_PREFIX}{key}~{gen}{index}")
}

/// 旧格式（lemo1）的段名，只为清理
fn legacy_seg_name(key: &str, index: usize) -> String {
    format!("{TARGET_PREFIX}{key}~{index}")
}

fn sha_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, PartialEq, Eq)]
struct Header {
    gen: char,
    n: usize,
    len: usize,
    sha: String,
}

impl Header {
    fn encode(&self) -> String {
        format!("{HEADER_TAG};{};{};{};{}", self.gen, self.n, self.len, self.sha)
    }

    fn parse(raw: &[u8]) -> Option<Header> {
        let s = std::str::from_utf8(raw).ok()?;
        let mut parts = s.split(';');
        if parts.next()? != HEADER_TAG {
            return None;
        }
        let mut gen_chars = parts.next()?.chars();
        let gen = gen_chars.next()?;
        if gen_chars.next().is_some() || !GENS.contains(&gen) {
            return None;
        }
        let n: usize = parts.next()?.parse().ok()?;
        let len: usize = parts.next()?.parse().ok()?;
        let sha = parts.next()?.to_string();
        if parts.next().is_some() || n == 0 || n > MAX_CHUNKS || len > CHUNK * n || sha.len() != 64 {
            return None;
        }
        Some(Header { gen, n, len, sha })
    }
}

/// 会话存取：白名单 + 两套段轮换 + 互斥
pub struct SessionStore<S: CredStore> {
    store: S,
    allowed: &'static [&'static str],
    lock: Mutex<()>,
}

impl<S: CredStore> SessionStore<S> {
    pub fn new(store: S, allowed: &'static [&'static str]) -> Self {
        Self { store, allowed, lock: Mutex::new(()) }
    }

    fn check_key(&self, key: &str) -> Result<(), String> {
        if self.allowed.contains(&key) {
            Ok(())
        } else {
            Err("key_not_allowed".into())
        }
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        // 某次操作 panic 后锁会“中毒”，数据本身在凭据管理器里，继续用不会坏
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn header(&self, key: &str) -> Result<Option<Header>, String> {
        Ok(self.store.read(&header_name(key))?.and_then(|raw| Header::parse(&raw)))
    }

    /// 删掉某一代号从 from 起的所有段，再删旧格式的段；尽量都删，返回第一个错误
    fn sweep(&self, key: &str, gens: &[(char, usize)]) -> Result<(), String> {
        let mut first_err = None;
        let mut del = |name: String| {
            if let Err(e) = self.store.delete(&name) {
                first_err.get_or_insert(e);
            }
        };
        for &(gen, from) in gens {
            for i in from..MAX_CHUNKS {
                del(seg_name(key, gen, i));
            }
        }
        for i in 1..=MAX_CHUNKS {
            del(legacy_seg_name(key, i));
        }
        first_err.map_or(Ok(()), Err)
    }

    /// 写入收尾：gen 这一套从 from 段起往后的多余段。先只读、往上探到第一个不存在的，得到最高一段；
    /// 再从高往低删，第一次删失败就停（复核 R2：原来从低往高删，中途失败会在 from 和失败那段之间留下空档，
    /// 空档后面的段下次从 from 探不到，成了孤段）。这样留下的总是 from..k 连着的一截，下次还能探到。
    /// 探的时候读出错就一段都不删（不知道上面还有没有，删了反而可能造出空档），留给下次写或删。返回删了几段
    fn trim(&self, key: &str, gen: char, from: usize) -> usize {
        let mut top = from;
        while top < MAX_CHUNKS {
            match self.store.read(&seg_name(key, gen, top)) {
                Ok(Some(_)) => top += 1,
                Ok(None) => break,
                Err(_) => return 0,
            }
        }
        let mut n = 0;
        for i in (from..top).rev() {
            if self.store.delete(&seg_name(key, gen, i)).is_err() {
                break;
            }
            n += 1;
        }
        n
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        self.check_key(key)?;
        let _g = self.guard();
        let Some(h) = self.header(key)? else {
            return Ok(None);
        };
        let mut all = Vec::with_capacity(h.len);
        for i in 0..h.n {
            match self.store.read(&seg_name(key, h.gen, i))? {
                Some(part) => all.extend_from_slice(&part),
                None => return Ok(None),
            }
        }
        if all.len() != h.len || sha_hex(&all) != h.sha {
            return Ok(None);
        }
        Ok(String::from_utf8(all).ok())
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.check_key(key)?;
        let bytes = value.as_bytes();
        let n = bytes.len().div_ceil(CHUNK).max(1);
        if n > MAX_CHUNKS {
            return Err("value_too_large".into());
        }
        let _g = self.guard();
        let old = self.header(key)?;
        let gen = if old.as_ref().map(|h| h.gen) == Some('a') { 'b' } else { 'a' };
        let chunks: Vec<&[u8]> = if bytes.is_empty() { vec![&[][..]] } else { bytes.chunks(CHUNK).collect() };
        for (i, part) in chunks.iter().enumerate() {
            self.store.write(&seg_name(key, gen, i), part)?;
        }
        let h = Header { gen, n, len: bytes.len(), sha: sha_hex(bytes) };
        self.store.write(&header_name(key), h.encode().as_bytes())?;
        // 头部已经切过去，新值已生效；收尾清理失败不影响这次写入，留下的段下次写或删时再清。
        // 只删收窄后的名单（N3）：旧头部记的 0..旧段数，再从旧段数、新段数往后各探到第一个不存在的
        let other = if gen == 'a' { 'b' } else { 'a' };
        let old_n = old.map_or(0, |h| h.n);
        // 从大到小删、第一次失败就停（代码审查 S1、安全审查建议 4）：剩下的段总是 0..k 连着的前缀，
        // 下次往这套代号写时会覆盖 0..新段数，再由 trim 从新段数往后探着清掉，不会留下“中间断开”的孤段
        for i in (0..old_n).rev() {
            if self.store.delete(&seg_name(key, other, i)).is_err() {
                break;
            }
        }
        self.trim(key, other, old_n);
        self.trim(key, gen, n);
        Ok(())
    }

    pub fn remove(&self, key: &str) -> Result<(), String> {
        self.check_key(key)?;
        let _g = self.guard();
        // 先删头部：之后哪一步失败，读到的都是“没有”
        self.store.delete(&header_name(key))?;
        self.sweep(key, &[('a', 0), ('b', 0)])
    }
}

/// 单测和非 Windows 编译用的内存实现
#[derive(Default)]
pub struct MemStore {
    pub map: Mutex<HashMap<String, Vec<u8>>>,
}

impl CredStore for MemStore {
    fn read(&self, target: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.map.lock().unwrap().get(target).cloned())
    }
    fn write(&self, target: &str, data: &[u8]) -> Result<(), String> {
        if data.len() > 2560 {
            return Err("blob_too_large".into());
        }
        self.map.lock().unwrap().insert(target.to_string(), data.to_vec());
        Ok(())
    }
    fn delete(&self, target: &str) -> Result<(), String> {
        self.map.lock().unwrap().remove(target);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const KEYS: &[&str] = &["sb-test-auth-token", "sb-test-auth-token-user"];
    const H: &str = "lemomemo.session.sb-test-auth-token";

    fn store() -> SessionStore<MemStore> {
        SessionStore::new(MemStore::default(), KEYS)
    }

    fn names(s: &SessionStore<MemStore>) -> Vec<String> {
        let mut v: Vec<String> = s.store.map.lock().unwrap().keys().cloned().collect();
        v.sort();
        v
    }

    /// 第 fail_at 次写（从 1 数）和之后的写全部失败；删除照常
    struct FailingStore {
        inner: MemStore,
        writes: AtomicUsize,
        fail_at: AtomicUsize,
    }

    impl CredStore for FailingStore {
        fn read(&self, t: &str) -> Result<Option<Vec<u8>>, String> {
            self.inner.read(t)
        }
        fn write(&self, t: &str, d: &[u8]) -> Result<(), String> {
            let k = self.writes.fetch_add(1, Ordering::SeqCst) + 1;
            if k >= self.fail_at.load(Ordering::SeqCst) {
                return Err("injected".into());
            }
            self.inner.write(t, d)
        }
        fn delete(&self, t: &str) -> Result<(), String> {
            self.inner.delete(t)
        }
    }

    #[test]
    fn 白名单外的键一律拒绝() {
        let s = store();
        assert_eq!(s.set("other", "x"), Err("key_not_allowed".into()));
        assert_eq!(s.get("sb-lemomemo-auth-token"), Err("key_not_allowed".into()));
        assert_eq!(s.remove(""), Err("key_not_allowed".into()));
        assert!(names(&s).is_empty());
    }

    #[test]
    fn 短值存取删() {
        let s = store();
        assert_eq!(s.get(KEYS[0]).unwrap(), None);
        s.set(KEYS[0], r#"{"access_token":"a"}"#).unwrap();
        assert_eq!(s.get(KEYS[0]).unwrap().as_deref(), Some(r#"{"access_token":"a"}"#));
        assert_eq!(names(&s), vec![H.to_string(), format!("{H}~a0")]);
        s.remove(KEYS[0]).unwrap();
        assert_eq!(s.get(KEYS[0]).unwrap(), None);
        assert!(names(&s).is_empty());
    }

    #[test]
    fn 空字符串也能存() {
        let s = store();
        s.set(KEYS[1], "").unwrap();
        assert_eq!(s.get(KEYS[1]).unwrap().as_deref(), Some(""));
    }

    #[test]
    fn 长值分段_含多字节字符跨段() {
        let s = store();
        // 每个“柠”3 字节，2000 不是 3 的倍数，必有字符被切在段边界上
        let long = "柠".repeat(3000);
        s.set(KEYS[0], &long).unwrap();
        assert_eq!(names(&s).len(), 1 + long.len().div_ceil(CHUNK));
        assert_eq!(s.get(KEYS[0]).unwrap().as_deref(), Some(long.as_str()));
    }

    #[test]
    fn 两套代号轮换_旧代号的段写完就清掉() {
        let s = store();
        s.set(KEYS[0], &"a".repeat(CHUNK * 5)).unwrap();
        assert!(names(&s).iter().all(|n| n == H || n.contains("~a")));
        s.set(KEYS[0], "short").unwrap();
        assert_eq!(names(&s), vec![H.to_string(), format!("{H}~b0")]);
        assert_eq!(s.get(KEYS[0]).unwrap().as_deref(), Some("short"));
        s.set(KEYS[0], &"c".repeat(CHUNK * 3 + 1)).unwrap();
        assert!(names(&s).iter().all(|n| n == H || n.contains("~a")));
        assert_eq!(names(&s).len(), 5);
        s.remove(KEYS[0]).unwrap();
        assert!(names(&s).is_empty());
    }

    /// 代码审查 M2：旧值、新值段数和总长度都一样，第 i 次写失败——读回的要么是完整旧值，绝不是拼接的
    #[test]
    fn 写到一半失败_读回完整旧值_不会新旧拼接() {
        let old = format!("{}{}{}", "A".repeat(CHUNK), "B".repeat(CHUNK), "C".repeat(1500));
        let new = format!("{}{}{}", "a".repeat(CHUNK), "b".repeat(CHUNK), "c".repeat(1500));
        // 新值 3 段 + 头部 = 4 次写；第 1～4 次各失败一遍
        for fail_at in 1..=4 {
            let s = SessionStore::new(
                FailingStore { inner: MemStore::default(), writes: AtomicUsize::new(0), fail_at: AtomicUsize::new(usize::MAX) },
                KEYS,
            );
            s.set(KEYS[0], &old).unwrap();
            s.store.writes.store(0, Ordering::SeqCst);
            s.store.fail_at.store(fail_at, Ordering::SeqCst);
            assert!(s.set(KEYS[0], &new).is_err(), "第 {fail_at} 次写失败时 set 应报错");
            assert_eq!(s.get(KEYS[0]).unwrap().as_deref(), Some(old.as_str()), "第 {fail_at} 次写失败后应读回完整旧值");
            // 恢复以后再写一次，能正常切到新值
            s.store.fail_at.store(usize::MAX, Ordering::SeqCst);
            s.set(KEYS[0], &new).unwrap();
            assert_eq!(s.get(KEYS[0]).unwrap().as_deref(), Some(new.as_str()));
        }
    }

    #[test]
    fn 超过上限拒绝() {
        let s = store();
        assert_eq!(s.set(KEYS[0], &"a".repeat(CHUNK * MAX_CHUNKS + 1)), Err("value_too_large".into()));
        assert!(s.set(KEYS[0], &"a".repeat(CHUNK * MAX_CHUNKS)).is_ok());
    }

    #[test]
    fn 段缺了_被改了_长度不对_头部坏了都当没有() {
        let s = store();
        s.set(KEYS[0], &"x".repeat(CHUNK * 2 + 10)).unwrap();
        s.store.delete(&format!("{H}~a2")).unwrap();
        assert_eq!(s.get(KEYS[0]).unwrap(), None);

        s.set(KEYS[0], &"x".repeat(CHUNK + 10)).unwrap(); // 切到 b
        // 同样长度但内容不同：长度对得上，哈希对不上
        s.store.write(&format!("{H}~b1"), &b"y".repeat(10)).unwrap();
        assert_eq!(s.get(KEYS[0]).unwrap(), None);
        s.store.write(&format!("{H}~b1"), b"short").unwrap();
        assert_eq!(s.get(KEYS[0]).unwrap(), None);

        for bad in [&b"garbage"[..], b"lemo2;c;1;1;00", b"lemo2;a;99;1;00", b"lemo1;1;2\nxx"] {
            s.store.write(H, bad).unwrap();
            assert_eq!(s.get(KEYS[0]).unwrap(), None);
        }
    }

    #[test]
    fn 坏_utf8_当没有() {
        let s = store();
        let bad = [0xffu8, 0xfe];
        s.store.write(&format!("{H}~a0"), &bad).unwrap();
        let h = Header { gen: 'a', n: 1, len: 2, sha: sha_hex(&bad) };
        s.store.write(H, h.encode().as_bytes()).unwrap();
        assert_eq!(s.get(KEYS[0]).unwrap(), None);
    }

    /// 代码审查 S2：头部坏了、或之前清理没做完留下的孤段（两套代号、旧格式），remove 都清得掉
    #[test]
    fn 删除时清掉所有孤段() {
        let s = store();
        for n in [format!("{H}~a7"), format!("{H}~b31"), format!("{H}~3"), format!("{H}~32"), H.to_string()] {
            s.store.write(&n, b"stale").unwrap();
        }
        s.remove(KEYS[0]).unwrap();
        assert!(names(&s).is_empty());
        // 只清这个键，不碰另一个键（也就碰不到另一套环境的键）
        s.set(KEYS[1], "keep").unwrap();
        s.remove(KEYS[0]).unwrap();
        assert_eq!(s.get(KEYS[1]).unwrap().as_deref(), Some("keep"));
    }

    /// 只数删除次数的存储
    #[derive(Default)]
    struct CountingStore {
        inner: MemStore,
        deletes: Mutex<Vec<String>>,
    }

    impl CredStore for CountingStore {
        fn read(&self, t: &str) -> Result<Option<Vec<u8>>, String> {
            self.inner.read(t)
        }
        fn write(&self, t: &str, d: &[u8]) -> Result<(), String> {
            self.inner.write(t, d)
        }
        fn delete(&self, t: &str) -> Result<(), String> {
            self.deletes.lock().unwrap().push(t.to_string());
            self.inner.delete(t)
        }
    }

    /// 复核 N3：写会话收尾只删真有的段，不再每次把两套 32 段、旧格式 32 段全删一遍
    #[test]
    fn 写入收尾只删旧头部记的段() {
        let s = SessionStore::new(CountingStore::default(), KEYS);
        s.set(KEYS[0], &"x".repeat(CHUNK * 3)).unwrap(); // a0..a2
        assert!(s.store.deletes.lock().unwrap().is_empty(), "第一次写没有旧段，一个都不删");
        s.set(KEYS[0], "short").unwrap(); // b0，从大到小删 a2..a0（S1）
        assert_eq!(*s.store.deletes.lock().unwrap(), vec![format!("{H}~a2"), format!("{H}~a1"), format!("{H}~a0")]);
        s.store.deletes.lock().unwrap().clear();
        s.set(KEYS[0], "again").unwrap(); // a0，删 b0
        assert_eq!(*s.store.deletes.lock().unwrap(), vec![format!("{H}~b0")]);
        // 删的名字都是这个键自己的段，碰不到头部、另一个键
        s.set(KEYS[1], "keep").unwrap();
        s.set(KEYS[0], "third").unwrap();
        assert!(s.store.deletes.lock().unwrap().iter().all(|n| n.starts_with(&format!("{H}~"))));
        assert_eq!(s.get(KEYS[1]).unwrap().as_deref(), Some("keep"));
    }

    /// 中途失败留下的段（从 0 连着往后）下一次成功写入时清掉，不留孤段
    #[test]
    fn 写入收尾清掉中途失败留下的段() {
        let s = store();
        s.set(KEYS[0], "old").unwrap(); // 头部指 a，n=1
        for i in 0..4 {
            s.store.write(&format!("{H}~b{i}"), b"half").unwrap(); // 上一次往 b 写了 4 段没切头部
        }
        s.set(KEYS[0], "new").unwrap(); // 写 b0，切头部，删 a0，再把 b1..b3 探着删掉
        assert_eq!(names(&s), vec![H.to_string(), format!("{H}~b0")]);
        assert_eq!(s.get(KEYS[0]).unwrap().as_deref(), Some("new"));
        // 头部坏了（读不出旧代号）时：写 a，b 那套从 0 探着删
        s.store.write(H, b"garbage").unwrap();
        s.set(KEYS[0], "after-bad-header").unwrap();
        assert_eq!(names(&s), vec![H.to_string(), format!("{H}~a0")]);
    }

    /// 删除到某个名字时失败一次（之后照常）；记下删除的顺序
    struct FlakyDeleteStore {
        inner: MemStore,
        fail_on: Mutex<Option<String>>,
        deletes: Mutex<Vec<String>>,
    }

    impl CredStore for FlakyDeleteStore {
        fn read(&self, t: &str) -> Result<Option<Vec<u8>>, String> {
            self.inner.read(t)
        }
        fn write(&self, t: &str, d: &[u8]) -> Result<(), String> {
            self.inner.write(t, d)
        }
        fn delete(&self, t: &str) -> Result<(), String> {
            self.deletes.lock().unwrap().push(t.to_string());
            let mut f = self.fail_on.lock().unwrap();
            if f.as_deref() == Some(t) {
                *f = None;
                return Err("injected".into());
            }
            self.inner.delete(t)
        }
    }

    /// 代码审查 S1：删旧段中途失败时，从大到小删、失败就停，留下的是 0..k 连着的前缀，下次写这套代号时能清干净
    #[test]
    fn 删旧段中途失败_不留中间断开的孤段() {
        let s = SessionStore::new(
            FlakyDeleteStore { inner: MemStore::default(), fail_on: Mutex::new(None), deletes: Mutex::new(vec![]) },
            KEYS,
        );
        s.set(KEYS[0], &"x".repeat(CHUNK * 5)).unwrap(); // a0..a4
        *s.store.fail_on.lock().unwrap() = Some(format!("{H}~a2"));
        s.set(KEYS[0], "short").unwrap(); // 写 b0、切头部，删 a4、a3，删 a2 失败就停
        assert_eq!(
            *s.store.deletes.lock().unwrap(),
            vec![format!("{H}~a4"), format!("{H}~a3"), format!("{H}~a2")],
            "从大到小删，第一次失败就停"
        );
        assert_eq!(s.get(KEYS[0]).unwrap().as_deref(), Some("short"), "新值照样生效");
        let left: Vec<String> = {
            let mut v: Vec<String> = s.store.inner.map.lock().unwrap().keys().filter(|k| k.contains("~a")).cloned().collect();
            v.sort();
            v
        };
        assert_eq!(left, vec![format!("{H}~a0"), format!("{H}~a1"), format!("{H}~a2")], "留下的是 0..k 连着的前缀");
        // 下一次写回到 a 这套（只有 1 段）：覆盖 a0，trim 从 1 往后探，a1、a2 都清掉；旧 b0 也删掉
        s.set(KEYS[0], "again").unwrap();
        let mut all: Vec<String> = s.store.inner.map.lock().unwrap().keys().cloned().collect();
        all.sort();
        assert_eq!(all, vec![H.to_string(), format!("{H}~a0")]);
        assert_eq!(s.get(KEYS[0]).unwrap().as_deref(), Some("again"));
    }

    /// 复核 R2：trim 清多余段时中途删失败，也不留中间断开的孤段（先探到最高一段，再从高往低删）
    #[test]
    fn 清多余段中途失败_不留中间断开的孤段() {
        let s = SessionStore::new(
            FlakyDeleteStore { inner: MemStore::default(), fail_on: Mutex::new(None), deletes: Mutex::new(vec![]) },
            KEYS,
        );
        s.set(KEYS[0], "old").unwrap(); // 头部指 a，a0
        for i in 0..5 {
            s.store.inner.write(&format!("{H}~b{i}"), b"half").unwrap(); // 上一次往 b 写了 5 段没切头部
        }
        s.store.deletes.lock().unwrap().clear();
        *s.store.fail_on.lock().unwrap() = Some(format!("{H}~b2"));
        s.set(KEYS[0], "new").unwrap(); // 写 b0、切头部、删 a0；trim(b, 1)：探到 b4，删 b4、b3，删 b2 失败就停
        let deletes = s.store.deletes.lock().unwrap().clone();
        let b_deletes: Vec<&String> = deletes.iter().filter(|d| d.contains("~b")).collect();
        assert_eq!(b_deletes, vec![&format!("{H}~b4"), &format!("{H}~b3"), &format!("{H}~b2")], "从高往低删，失败就停");
        let left_b = || -> Vec<String> {
            let mut v: Vec<String> = s.store.inner.map.lock().unwrap().keys().filter(|k| k.contains("~b")).cloned().collect();
            v.sort();
            v
        };
        assert_eq!(left_b(), vec![format!("{H}~b0"), format!("{H}~b1"), format!("{H}~b2")], "留下的是连着的一截");
        assert_eq!(s.get(KEYS[0]).unwrap().as_deref(), Some("new"));
        // 下一次写回 a：删旧 b0，再从 1 往上探到 b2，b1、b2 都清掉
        s.set(KEYS[0], "again").unwrap();
        let mut all: Vec<String> = s.store.inner.map.lock().unwrap().keys().cloned().collect();
        all.sort();
        assert_eq!(all, vec![H.to_string(), format!("{H}~a0")]);
        assert_eq!(s.get(KEYS[0]).unwrap().as_deref(), Some("again"));
    }

    #[test]
    fn 两个键互不影响() {
        let s = store();
        s.set(KEYS[0], "a").unwrap();
        s.set(KEYS[1], "b").unwrap();
        s.remove(KEYS[0]).unwrap();
        assert_eq!(s.get(KEYS[1]).unwrap().as_deref(), Some("b"));
    }
}
