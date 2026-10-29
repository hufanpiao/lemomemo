// 宽容读取测试共用的“服务器来的行”（不是测试文件本身）：模拟更新的版本写来的新列、新枚举值、repeat、隐私记行
// TC-B1-34 写的是 tests/fixtures/，但 src 下的测试按 eslint 分层不能 import tests/，样例放在这里
import { todo, uid } from './outbox-fixtures.ts';

/** 服务器上的公共列（数据字典 3.2） */
export function common(n: number, rev = 3): Record<string, unknown> {
  return {
    id: uid(n), user_id: uid(900), rev, fv: { title: rev }, synced_at: '2026-10-29T01:00:00.000Z', deleted_at: null, undone: false,
  };
}

/** 服务器上的一行 todos（可写列 + 公共列 + 系统列） */
export function serverTodo(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...todo(n), ...common(n), remind_at: null, pushed_for: null, defer_until: null, ai_status: 'none', ...over,
  };
}

/** 服务器上的一行 events */
export function serverEvent(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...common(n), title: `日程${n}`, date: '2026-11-01', time: null, tz: null, duration_min: 60, project: '', note: '', source: 'page',
    raw_text: '', location: '', short: null, short_by: null, push_show_title: null, batch_id: null, remind_min: null, remind_days: null,
    notified_for: null, snooze_at: null, created_at: 1, updated_at: 1, remind_at: null, pushed_for: null, defer_until: null,
    ai_status: 'none', ...over,
  };
}

/** 隐私记行里不该出现在本机的明文（测试断言本机缓存里找不到它） */
export const SECRET = '隐私记明文-不该进本机';

/** 服务器上的一行 notes；private 为 true 时是隐私记行（明文列为空、带密文） */
export function serverNote(n: number, priv: boolean, over: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    ...common(n), category_id: null, category_source: 'none', category_seen: false, ai_status: 'done', source: 'page', batch_id: null,
    created_at: 1, updated_at: 1, ai_meta: null, converted_to: null, tags: [],
  };
  return priv
    ? { ...base, is_private: true, title: null, body: null, raw_text: null, body_enc: 'ZW5j', enc_key_id: 'k1', ...over }
    : { ...base, is_private: false, title: `随手记${n}`, body: '正文', raw_text: '', body_enc: null, enc_key_id: null, ...over };
}

/** 服务器上的一行 note_images */
export function serverImage(n: number, bucket: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...common(n), note_id: uid(500), bucket, path: `${uid(900)}/${uid(500)}/${uid(n)}.webp`, bytes: 1000, width: 10, height: 10,
    mime: 'image/webp', has_thumb: false, taken_at: 5, ai_status: 'done', ai_desc: '图片描述', ai_tags: ['猫'], skip_reason: null,
    ai_tries: 0, ai_next_at: null, ...over,
  };
}
