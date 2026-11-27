//! 快速记录的待取队列（评审返工第 4 条：不丢字；11-24 独立评审必修 3：跟账号走）。
//! quick-add 窗口交上来的一句先放进这里，Rust 收下就算交成功（小窗口这时才清空输入框）；
//! 再给 main 发 quick-add:pending，main 用 quick_add_take（带当前账号的 user_id）一次取走全部。main 还没载入、没在听时文字留在队列里，
//! main 载入后订阅时先取一次。只放在内存里：程序退出时还没被 main 取走的会丢（正常情况下 main 收到事件立刻取，窗口很短）。
//!
//! 跟账号走（不把上一个账号时交的字记进下一个账号）：
//! • 队列记着“上次是谁取的”（owner）。取的账号和 owner 不同：队列里的先清掉再认新账号，一句也不交出去；
//! • 退出（session_remove 删成功）时整个清空、owner 也清掉：退出后、下次登录前交的几句，交给下次登录的账号
//!   （exe 是一台电脑一个人用，没登录时按热键写的字多半就是这个人的；登录时不清，免得这几句悄悄丢掉）。
use std::collections::VecDeque;
use std::sync::Mutex;

/// 一句话最长多少字符（解析在 main 页面里做，这里只防超大载荷；和前端 QUICK_ADD_MAX_CHARS 对拍）
pub const MAX_CHARS: usize = 2000;
/// 最多攒多少句没被取走的（main 一直不取时不无限占内存）
pub const MAX_PENDING: usize = 20;
/// user_id 最长多少字节（Supabase 的 uuid 是 36；只防超大载荷）
const MAX_USER_ID: usize = 64;

#[derive(Default)]
struct Inner {
    items: VecDeque<String>,
    owner: Option<String>,
}

#[derive(Default)]
pub struct QuickAddQueue(Mutex<Inner>);

impl QuickAddQueue {
    /// 收下一句：超长回 text_too_long，攒满回 queue_full（小窗口留着原文，分别提示）
    pub fn push(&self, text: String) -> Result<(), &'static str> {
        if text.chars().count() > MAX_CHARS {
            return Err("text_too_long");
        }
        let mut q = self.0.lock().map_err(|_| "queue_failed")?;
        if q.items.len() >= MAX_PENDING {
            return Err("queue_full");
        }
        q.items.push_back(text);
        Ok(())
    }

    /// 按交上来的先后一次取走全部，记下取的账号；和上次取的账号不同就先清空、不交出去
    pub fn take_for(&self, user_id: &str) -> Result<Vec<String>, &'static str> {
        if user_id.is_empty() || user_id.len() > MAX_USER_ID {
            return Err("bad_user");
        }
        let mut q = self.0.lock().map_err(|_| "queue_failed")?;
        if q.owner.as_deref().is_some_and(|o| o != user_id) {
            q.items.clear();
        }
        q.owner = Some(user_id.to_string());
        Ok(q.items.drain(..).collect())
    }

    /// 退出时清空（session_remove 删成功以后调）
    pub fn clear(&self) {
        if let Ok(mut q) = self.0.lock() {
            q.items.clear();
            q.owner = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 按先后取走全部_取完为空() {
        let q = QuickAddQueue::default();
        q.push("一".into()).unwrap();
        q.push("二".into()).unwrap();
        assert_eq!(q.take_for("a").unwrap(), vec!["一".to_string(), "二".to_string()]);
        assert!(q.take_for("a").unwrap().is_empty());
    }

    #[test]
    fn 超长和攒满都拒收_不进队列() {
        let q = QuickAddQueue::default();
        assert_eq!(q.push("柠".repeat(MAX_CHARS + 1)), Err("text_too_long"));
        assert!(q.push("柠".repeat(MAX_CHARS)).is_ok());
        for _ in 1..MAX_PENDING {
            q.push("x".into()).unwrap();
        }
        assert_eq!(q.push("多一句".into()), Err("queue_full"));
        assert_eq!(q.take_for("a").unwrap().len(), MAX_PENDING);
        assert!(q.push("取走后又能收".into()).is_ok());
    }

    #[test]
    fn 换了账号取_上一个账号时交的不交出去() {
        let q = QuickAddQueue::default();
        q.push("A 的".into()).unwrap();
        assert_eq!(q.take_for("a").unwrap(), vec!["A 的".to_string()]);
        q.push("A 还没取走的".into()).unwrap();
        assert!(q.take_for("b").unwrap().is_empty());
        q.push("B 的".into()).unwrap();
        assert_eq!(q.take_for("b").unwrap(), vec!["B 的".to_string()]);
    }

    #[test]
    fn 退出清空_之后交的给下次登录的账号() {
        let q = QuickAddQueue::default();
        q.push("退出前".into()).unwrap();
        assert!(q.take_for("a").unwrap().len() == 1);
        q.push("退出前没取走".into()).unwrap();
        q.clear();
        q.push("退出后".into()).unwrap();
        assert_eq!(q.take_for("b").unwrap(), vec!["退出后".to_string()]);
    }

    #[test]
    fn user_id_空的或超长的拒绝_队列不动() {
        let q = QuickAddQueue::default();
        q.push("留着".into()).unwrap();
        assert_eq!(q.take_for(""), Err("bad_user"));
        assert_eq!(q.take_for(&"x".repeat(MAX_USER_ID + 1)), Err("bad_user"));
        assert_eq!(q.take_for("a").unwrap(), vec!["留着".to_string()]);
    }
}
